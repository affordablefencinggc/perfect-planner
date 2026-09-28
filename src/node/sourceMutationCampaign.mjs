import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const within = (root, candidate) => { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); };

async function atomicReplace(filePath, bytes, mode) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.mutation-tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode });
  await rename(temporary, filePath);
}

async function inspectTarget(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (!within(root, absolute)) throw new Error("Mutation target must be a contained file below the isolated workspace root.");
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Mutation target must be a physical regular file.");
  const bytes = await readFile(absolute);
  return { absolute, bytes, hash: sha256(bytes), mode: info.mode };
}

export async function runSourceMutationCampaign(input = {}) {
  const root = path.resolve(input.workspaceRoot ?? "");
  if (input.workspaceKind !== "isolated-copy") throw new Error("Source mutation requires an explicitly isolated-copy workspace.");
  if (typeof input.inspectClean !== "function") throw new Error("Source mutation requires a clean-workspace inspector.");
  const initialInspection = await input.inspectClean({ workspaceRoot: root, phase: "before" });
  if (initialInspection?.clean !== true || (initialInspection.dirtyPaths?.length ?? 0) > 0) throw new Error("Source mutation refuses a dirty workspace.");
  const mutations = input.mutations ?? [];
  if (!mutations.length) return { verdict: "BLOCKED", blockers: ["Source mutation campaign contains no implementation mutations."], results: [], totals: { total: 0, killed: 0, survived: 0, errors: 0 }, coverage: { required: input.requiredGuarantees?.length ?? 0, covered: 0, missing: input.requiredGuarantees ?? [] }, restored: true };
  const ids = new Set(); const results = [];
  for (const mutation of mutations) {
    if (!mutation.id || ids.has(mutation.id) || !mutation.guarantee || !mutation.file || !/^[a-f0-9]{64}$/.test(mutation.expectedSha256 ?? "") || typeof mutation.apply !== "function" || typeof mutation.probe !== "function") throw new Error("Each source mutation requires a unique id, guarantee, file, expected SHA-256, apply function, and probe function.");
    ids.add(mutation.id);
    const original = await inspectTarget(root, mutation.file);
    if (original.hash !== mutation.expectedSha256) throw new Error(`Source mutation refuses dirty target ${mutation.file}.`);
    let mutatedHash = null; let state = "ERROR"; let note = "Mutation did not complete.";
    try {
      const changed = await mutation.apply(Buffer.from(original.bytes));
      const mutatedBytes = Buffer.isBuffer(changed) ? changed : Buffer.from(changed ?? "");
      mutatedHash = sha256(mutatedBytes);
      if (!mutatedBytes.length || mutatedHash === original.hash) throw new Error("Implementation mutation must produce different nonempty source bytes.");
      await atomicReplace(original.absolute, mutatedBytes, original.mode);
      const installed = await inspectTarget(root, mutation.file);
      if (installed.hash !== mutatedHash) throw new Error("Implementation mutation was not installed exactly.");
      const detected = await mutation.probe({ workspaceRoot: root, file: mutation.file, expectedOriginalSha256: original.hash, mutatedSha256: mutatedHash });
      state = detected === true ? "KILLED" : "SURVIVED";
      note = detected === true ? "The focused probe detected the installed source mutation." : "The focused probe stayed green with the source mutation installed.";
    } catch (error) {
      state = "ERROR"; note = `Source mutation or probe failed: ${error.message}`;
    } finally {
      const current = await inspectTarget(root, mutation.file);
      if (mutatedHash && current.hash !== mutatedHash && current.hash !== original.hash) throw new Error(`Source mutation target ${mutation.file} was concurrently changed; refusing to overwrite it during restoration.`);
      if (current.hash === mutatedHash) await atomicReplace(original.absolute, original.bytes, original.mode);
      const restored = await inspectTarget(root, mutation.file);
      if (restored.hash !== original.hash) throw new Error(`Source mutation target ${mutation.file} failed restoration.`);
    }
    results.push({ id: mutation.id, guarantee: mutation.guarantee, file: mutation.file, state, note, originalSha256: original.hash, mutatedSha256: mutatedHash, restored: true });
  }
  const finalInspection = await input.inspectClean({ workspaceRoot: root, phase: "after" });
  if (finalInspection?.clean !== true || (finalInspection.dirtyPaths?.length ?? 0) > 0) throw new Error("Source mutation restoration did not return the isolated workspace to clean state.");
  const required = [...new Set(input.requiredGuarantees ?? [])]; const covered = new Set(results.map((result) => result.guarantee)); const missing = required.filter((item) => !covered.has(item));
  const totals = { total: results.length, killed: results.filter((item) => item.state === "KILLED").length, survived: results.filter((item) => item.state === "SURVIVED").length, errors: results.filter((item) => item.state === "ERROR").length };
  const blockers = [];
  if (totals.survived) blockers.push(`${totals.survived} source mutation(s) survived.`);
  if (totals.errors) blockers.push(`${totals.errors} source mutation/probe error(s) are unresolved.`);
  if (missing.length) blockers.push(`Source mutation coverage is missing: ${missing.join(", ")}.`);
  return { verdict: blockers.length ? "BLOCKED" : "CERTIFIED", blockers, results, totals, coverage: { required: required.length, covered: required.length - missing.length, missing }, restored: true };
}
