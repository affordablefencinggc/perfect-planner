import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessComponentPlans } from "../engine/componentPlanEngine.js";
import { censusRepository } from "./repositoryCensus.mjs";
import { withPlanLock } from "./planLock.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const slash = (value) => value.split(path.sep).join("/");
const stableId = (planId, componentId, filePath) => `IDX-${hash(`${planId}:${componentId}:${filePath.toLowerCase()}`).slice(0, 16).toUpperCase()}`;
const tokens = (value) => [...new Set(String(value ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z][a-z0-9_-]{1,63}/g) ?? [])].sort();
const isSource = (file) => ["source", "interface", "configuration", "test", "document"].includes(file.category);

async function lexicalTerms(root, file, maxBytes) {
  const absolute = path.resolve(root, file.path); const base = path.resolve(root); if (!absolute.startsWith(`${base}${path.sep}`)) throw new Error(`Indexed path escapes root: ${file.path}.`); const stat = await lstat(absolute); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Indexed source is not a regular file: ${file.path}.`); if (stat.size > maxBytes) return [];
  return tokens(await readFile(absolute, "utf8")).slice(0, 20_000);
}

export async function buildComponentSourceIndex(rootPath, catalog, options = {}) {
  const assessment = assessComponentPlans(catalog); if (!assessment.ready) throw new Error(`Cannot index an invalid component catalog: ${assessment.blockers.join(" ")}`); const root = path.resolve(rootPath); const census = await censusRepository(root, { maxFiles: options.maxFiles ?? 10_000, maxBytes: options.maxBytes ?? 1_000_000, ignored: options.ignored }); const observed = new Map(census.files.map((file) => [file.path.toLowerCase(), file])); const claimed = new Map(); const entries = [];
  for (const component of catalog.components) for (const claim of component.fileClaims) { const key = slash(claim.path).toLowerCase(); const file = observed.get(key) ?? null; const entry = { sourceId: stableId(catalog.planId, component.id, claim.path), planId: catalog.planId, componentId: component.id, componentName: component.name, scopeLabel: component.scopeLabel, taskId: component.taskId, path: slash(claim.path), access: claim.access, reason: claim.reason, state: file ? "indexed" : "planned-missing", category: file?.category ?? null, size: file?.size ?? 0, sha256: file?.sha256 ?? null, terms: [...new Set([...tokens(component.name), ...tokens(component.scopeLabel), ...tokens(component.definition), ...tokens(claim.path), ...(file ? await lexicalTerms(root, file, options.maxLexicalBytes ?? 500_000) : [])])].sort() }; entries.push(entry); claimed.set(key, entry); }
  const unclaimed = census.files.filter((file) => isSource(file) && !claimed.has(file.path.toLowerCase())).map((file) => ({ sourceId: `UNCLAIMED-${hash(`${catalog.planId}:${file.path.toLowerCase()}`).slice(0, 12).toUpperCase()}`, path: file.path, category: file.category, size: file.size, sha256: file.sha256, state: "unclaimed" })); entries.sort((left, right) => left.componentId.localeCompare(right.componentId) || left.path.localeCompare(right.path)); const termIndex = {};
  for (const entry of entries) for (const term of entry.terms) (termIndex[term] ??= []).push(entry.sourceId);
  const body = { schemaVersion: 1, planId: catalog.planId, architectureDigest: catalog.architectureDigest, catalogState: assessment.verdict, generatedAt: options.generatedAt ?? new Date().toISOString(), root, censusDigest: census.digest, entries, unclaimed, refused: census.skipped, termIndex }; return { ...body, state: unclaimed.length || census.skipped.length ? "INCOMPLETE" : "READY", blockers: [...(unclaimed.length ? [`${unclaimed.length} readable project files have no component claim.`] : []), ...(census.skipped.length ? [`${census.skipped.length} paths were refused by the census.`] : [])], digest: hash(JSON.stringify(body)) };
}

export function searchComponentSourceIndex(index, query, options = {}) {
  const requested = tokens(query); if (!requested.length) return []; const byId = new Map(index.entries.map((entry) => [entry.sourceId, entry])); const scores = new Map();
  for (const term of requested) for (const [indexedTerm, ids] of Object.entries(index.termIndex ?? {})) if (indexedTerm === term || indexedTerm.includes(term) || term.includes(indexedTerm)) for (const id of ids) scores.set(id, (scores.get(id) ?? 0) + (indexedTerm === term ? 4 : 1));
  return [...scores].map(([id, score]) => ({ ...byId.get(id), score })).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, options.limit ?? 30);
}

async function readPrevious(indexPath) { try { const value = JSON.parse(await readFile(indexPath, "utf8")); if (value?.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error("Component source index is malformed."); return value; } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function atomicWrite(indexPath, value) { await mkdir(path.dirname(path.resolve(indexPath)), { recursive: true }); const temporary = `${indexPath}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, indexPath); }

export async function reconcileComponentSourceIndex(indexPath, root, catalog, options = {}) {
  await mkdir(path.dirname(path.resolve(indexPath)), { recursive: true });
  return withPlanLock(indexPath, { actor: options.actor ?? "component-indexer", timeoutMs: options.timeoutMs ?? 5000, retryMs: 10 }, async () => { const previous = await readPrevious(indexPath); const next = await buildComponentSourceIndex(root, catalog, options); const prior = new Map((previous?.entries ?? []).map((entry) => [entry.sourceId, entry])); const events = [];
    for (const entry of next.entries) { const before = prior.get(entry.sourceId); if (!before) events.push({ action: "added", sourceId: entry.sourceId, componentId: entry.componentId, path: entry.path }); else if (before.sha256 !== entry.sha256 || before.state !== entry.state) events.push({ action: entry.state === "planned-missing" ? "missing" : before.state === "planned-missing" ? "materialized" : "changed", sourceId: entry.sourceId, componentId: entry.componentId, path: entry.path, sha256: entry.sha256 }); prior.delete(entry.sourceId); } for (const entry of prior.values()) events.push({ action: "claim-removed", sourceId: entry.sourceId, componentId: entry.componentId, path: entry.path }); const generation = (previous?.generation ?? 0) + 1; const stored = { ...next, generation, events }; await atomicWrite(indexPath, stored); return stored; });
}

export function startComponentSourceIndexer(indexPath, root, catalogProvider, options = {}) { const intervalMs = Math.max(250, Number(options.intervalMs ?? 3000)); let stopped = false; let running = null; const runNow = async () => { if (stopped) throw new Error("Component source indexer is stopped."); if (running) return running; const catalog = typeof catalogProvider === "function" ? await catalogProvider() : catalogProvider; running = reconcileComponentSourceIndex(indexPath, root, catalog, options).then((result) => { options.onUpdate?.(result); return result; }).catch((error) => { options.onError?.(error); throw error; }).finally(() => { running = null; }); return running; }; const timer = setInterval(() => { runNow().catch(() => {}); }, intervalMs); if (options.unref !== false) timer.unref?.(); return { runNow, stop: () => { stopped = true; clearInterval(timer); }, get stopped() { return stopped; }, get running() { return running !== null; } }; }
