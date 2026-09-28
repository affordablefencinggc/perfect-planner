import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { runGuardedGit } from "./guardedGitRunner.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_BRANCHES = 500;
const MAX_WORKTREES = 128;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const oid = (value) => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const ref = (value) => typeof value === "string" && value.startsWith("refs/heads/") && value.length <= 1024 && !/[\s\x00-\x1f\x7f\ufffd]/.test(value);
const samePath = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === "";
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const stamp = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

export function parseGitWorktrees(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES || !text.endsWith("\0\0")) fail("MCP_GIT_OUTPUT_INVALID");
  const blocks = text.slice(0, -2).split("\0\0");
  if (blocks.length > MAX_WORKTREES) fail("MCP_GIT_INVENTORY_LIMIT");
  const paths = new Set();
  return blocks.map((block) => {
    const tokens = block.split("\0");
    const first = tokens.shift();
    if (!first.startsWith("worktree ")) fail("MCP_GIT_OUTPUT_INVALID");
    const location = first.slice(9);
    if (!path.isAbsolute(location) || location.length > 4096 || /[\x00-\x1f\x7f\ufffd]/.test(location)) fail("MCP_GIT_OUTPUT_INVALID");
    const key = process.platform === "win32" ? path.resolve(location).toLowerCase() : path.resolve(location);
    if (paths.has(key)) fail("MCP_GIT_OUTPUT_INVALID");
    paths.add(key);
    const values = new Map();
    for (const token of tokens) {
      const split = token.indexOf(" ");
      const name = split < 0 ? token : token.slice(0, split);
      const value = split < 0 ? null : token.slice(split + 1);
      if (!["HEAD", "branch", "bare", "detached", "locked", "prunable"].includes(name) || values.has(name)) fail("MCP_GIT_OUTPUT_INVALID");
      values.set(name, value);
    }
    const bare = values.has("bare"), detached = values.has("detached");
    if ((bare && (values.size !== 1 || values.get("bare") !== null))
      || (!bare && (!oid(values.get("HEAD")) || (detached ? values.has("branch") || values.get("detached") !== null : !ref(values.get("branch")))))) fail("MCP_GIT_OUTPUT_INVALID");
    return Object.freeze({ path: location, headSha: bare ? null : values.get("HEAD"), branchRef: values.get("branch") ?? null,
      mode: bare ? "bare" : detached ? "detached" : "branch", locked: values.has("locked"), prunable: values.has("prunable"),
      cleanState: "not-inspected", canAutomaticallyDelete: false });
  });
}

export function parseGitBranches(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES || (text && !text.endsWith("\n"))) fail("MCP_GIT_OUTPUT_INVALID");
  const lines = text ? text.slice(0, -1).split("\n") : [];
  if (lines.length > MAX_BRANCHES) fail("MCP_GIT_INVENTORY_LIMIT");
  const seen = new Set();
  return lines.map((line) => {
    const fields = line.split("\0");
    if (fields.length !== 2 || !ref(fields[0]) || !oid(fields[1]) || seen.has(fields[0])) fail("MCP_GIT_OUTPUT_INVALID");
    seen.add(fields[0]);
    return Object.freeze({ ref: fields[0], headSha: fields[1] });
  });
}

async function marker(root) {
  const target = path.join(root, ".git");
  const stat = await lstat(target).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!stat) return null;
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || !samePath(target, await realpath(target))) fail("MCP_GIT_MARKER_REFUSED");
  return stamp(stat);
}

// Authority-only adapter. The public MCP layer resolves/validates registration;
// neither a path nor a custom command/runner can be supplied by a tool client.
export async function readGitWorkspaceInventory(root, { gitRunner = runGuardedGit, gitExecutable, check = () => {} } = {}) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  check();
  const canonical = await realpath(root);
  if (!samePath(root, canonical)) fail("MCP_GIT_ROOT_REFUSED");
  const rootBefore = stamp(await lstat(root));
  const markerBefore = await marker(root);
  const facts = { schemaVersion: 1, startedAt, kind: "git-inventory", localOnly: true, cleanState: "not-inspected",
    ciState: "not-inspected", productionState: "not-inspected", promotionAuthority: false, canAutomaticallyDelete: false };
  if (markerBefore === null) {
    check();
    if (await marker(root) !== null || stamp(await lstat(root)) !== rootBefore || !samePath(root, await realpath(root))) fail("MCP_GIT_INVENTORY_CHANGED");
    return Object.freeze({ ...facts, state: "no-git-marker", observedAt: new Date().toISOString(), worktrees: [], branches: [], consistency: "root-marker-observation" });
  }
  let consumed = 0;
  const run = async (args) => {
    check();
    const remainingMs = Math.floor(20_000 - (performance.now() - started));
    if (remainingMs <= 0) fail("MCP_GIT_TIMEOUT");
    if (consumed >= MAX_BYTES) fail("MCP_GIT_INVENTORY_LIMIT");
    let result;
    try { result = await gitRunner(canonical, args, { timeoutMs: Math.min(10_000, remainingMs), maxBytes: MAX_BYTES - consumed, gitExecutable }); }
    catch (error) {
      if (error?.code === "GIT_PROCESS_UNCERTAIN" || error?.code === "MCP_GIT_PROCESS_UNCERTAIN" || error?.cleanupComplete === false) fail("MCP_GIT_PROCESS_UNCERTAIN");
      fail("MCP_GIT_UNAVAILABLE");
    }
    if (result.cleanupComplete !== true) fail("MCP_GIT_PROCESS_UNCERTAIN");
    check();
    if (result.reason || result.exit !== 0 || result.outputComplete !== true || typeof result.stdout !== "string"
      || !Number.isSafeInteger(result.outputBytes) || result.outputBytes < Buffer.byteLength(result.stdout)) fail("MCP_GIT_COMMAND_FAILED");
    consumed += result.outputBytes;
    if (consumed > MAX_BYTES) fail("MCP_GIT_INVENTORY_LIMIT");
    return result.stdout;
  };
  const read = async () => {
    const top = await run(["rev-parse", "--show-toplevel"]);
    if (!top.endsWith("\n") || /[\x00-\x1f\x7f]/.test(top.slice(0, -1)) || !samePath(top.slice(0, -1), canonical)) fail("MCP_GIT_ROOT_MISMATCH");
    const worktrees = await run(["worktree", "list", "--porcelain", "-z"]);
    const branches = await run(["for-each-ref", "--sort=refname", "--count=501", "--format=%(refname)%00%(objectname)", "refs/heads/"]);
    return { worktrees, branches };
  };
  const first = await read();
  const worktrees = parseGitWorktrees(first.worktrees), branches = parseGitBranches(first.branches);
  if (!worktrees.some((entry) => samePath(entry.path, canonical))) fail("MCP_GIT_ROOT_MISMATCH");
  const second = await read();
  if (JSON.stringify(first) !== JSON.stringify(second) || await marker(root) !== markerBefore
    || stamp(await lstat(root)) !== rootBefore || !samePath(root, await realpath(root))) fail("MCP_GIT_INVENTORY_CHANGED");
  check();
  if (performance.now() - started >= 20_000) fail("MCP_GIT_TIMEOUT");
  return Object.freeze({ ...facts, state: "observed", observedAt: new Date().toISOString(), worktrees, branches,
    digest: hash(JSON.stringify(first)), consistency: "two-matching-reads-not-atomic", outputBytes: consumed });
}
