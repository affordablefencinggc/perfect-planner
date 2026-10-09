// One git worktree per task (Core Specs §5).
//
// launch(T) creates branch pp/<T> and a worktree at
// <repo>/.perfect-planner/worktrees/<T>, links the main checkout's node_modules
// as the shared dependency cache, assigns a free dev port, copies local
// settings with placeholder values, installs a commit-time secret scan and
// records worktree.created. remove(T) only removes merged, clean work and
// records worktree.removed. The ledger is the source of truth for which
// worktrees are active; this module keeps no state of its own beyond a lock
// that serialises its own git operations.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeholderEnv, isEnvFileName } from "./envPlaceholders.mjs";

export const WORKTREE_DIR = path.join(".perfect-planner", "worktrees");
export const IGNORE_LINE = ".perfect-planner/worktrees/";
const ACTOR = Object.freeze({ kind: "system", id: "perfect-planner" });
const TASK_ID = /^T-[1-9]\d*$/;
const HOOK_MARKER = "pp-worktree-hook v1";
const BUNDLED_SCAN = fileURLToPath(new URL("./bundledSecretScan.mjs", import.meta.url));
const GIT_ROUTING = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];

function fail(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) if (GIT_ROUTING.includes(key.toUpperCase())) delete env[key];
  return env;
}

function runGit(git, cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(git, args, { cwd, env: gitEnv(), windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && !allowFail) {
        const wrapped = new Error(`git ${args[0]} failed: ${String(stderr || error.message).trim()}`);
        wrapped.code = "WORKTREE_GIT";
        wrapped.stderr = stderr;
        return reject(wrapped);
      }
      resolve({ ok: !error, code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch { return false; }
}

// Probe both loopback families; a port counts as free only if neither is held.
function probePort(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT" ? "n/a" : false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function isPortFree(port) {
  const v4 = await probePort(port, "127.0.0.1");
  if (v4 !== true) return false;
  const v6 = await probePort(port, "::1");
  return v6 !== false;
}

function parseEvidence(evidence = []) {
  const out = {};
  for (const item of evidence) {
    const text = String(item);
    const at = text.indexOf(":");
    if (at > 0) out[text.slice(0, at)] = text.slice(at + 1);
  }
  return out;
}

// Active worktrees according to the ledger: last worktree.created per subject
// not followed by a worktree.removed.
export function activeWorktrees(entries) {
  const active = new Map();
  for (const entry of entries) {
    if (entry.type === "worktree.created") {
      const ev = parseEvidence(entry.evidence);
      active.set(entry.subject, {
        taskId: entry.subject,
        branch: ev.branch,
        path: ev.path,
        port: ev.port ? Number(ev.port) : null,
        baseBranch: ev.base,
        baseCommit: ev.head,
        createdAt: entry.at,
        entry: entry.n,
      });
    } else if (entry.type === "worktree.removed") {
      active.delete(entry.subject);
    }
  }
  return [...active.values()];
}

function hookScript(nodePath, scanPath) {
  const q = (p) => `'${p.split(path.sep).join("/").replace(/'/g, "'\\''")}'`;
  return [
    "#!/bin/sh",
    `# ${HOOK_MARKER}: block commits that stage likely secrets`,
    'root="$(git rev-parse --show-toplevel)" || exit 1',
    'cd "$root" || exit 1',
    // Git exports GIT_DIR to hooks in a linked worktree; the project scanner
    // refuses routing overrides, so drop it once rediscovery proves it is the same repo.
    'before="$(git rev-parse --absolute-git-dir)" || exit 1',
    "unset GIT_DIR GIT_WORK_TREE",
    'after="$(git rev-parse --absolute-git-dir)" || exit 1',
    'if [ "$before" != "$after" ]; then echo "Perfect Planner: commit blocked, git directory mismatch" >&2; exit 1; fi',
    'if [ -f "scripts/verify-secrets.mjs" ]; then',
    `  ${q(nodePath)} scripts/verify-secrets.mjs --staged >/dev/null`,
    "  status=$?",
    '  if [ "$status" -ne 0 ]; then echo "Perfect Planner: commit blocked by scripts/verify-secrets.mjs (exit $status: 2 = possible secret staged, 3 = scan incomplete)" >&2; exit 1; fi',
    "  exit 0",
    "fi",
    `exec ${q(nodePath)} ${q(scanPath)}`,
    "",
  ].join("\n");
}

export function createWorktreeManager({ repoRoot, ledger, maxParallel = 4, portRange = [5300, 5399], git = "git", portProbe = isPortFree } = {}) {
  if (!repoRoot) fail("WORKTREE_CONFIG", "repoRoot is required");
  if (!ledger || typeof ledger.append !== "function" || typeof ledger.entries !== "function") fail("WORKTREE_CONFIG", "a ledger is required");
  if (!Number.isInteger(maxParallel) || maxParallel < 1) fail("WORKTREE_CONFIG", "maxParallel must be a positive integer");
  const [portLow, portHigh] = portRange;
  if (!Number.isInteger(portLow) || !Number.isInteger(portHigh) || portLow < 1 || portHigh > 65535 || portLow > portHigh) fail("WORKTREE_CONFIG", "portRange must be [low, high] within 1-65535");
  const root = path.resolve(repoRoot);
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const worktreePath = (taskId) => path.join(root, WORKTREE_DIR, taskId);
  const branchName = (taskId) => `pp/${taskId}`;
  const relative = (absolute) => path.relative(root, absolute).split(path.sep).join("/");
  const checkTask = (taskId) => { if (typeof taskId !== "string" || !TASK_ID.test(taskId)) fail("WORKTREE_BAD_TASK", `not a task id: ${taskId}`); };

  async function ensureIgnored() {
    const probe = `${IGNORE_LINE}T-0/probe`;
    const check = await runGit(git, root, ["check-ignore", "--no-index", "-q", probe], { allowFail: true });
    if (check.code === 0) return false;
    const file = path.join(root, ".gitignore");
    let text = "";
    try { text = await fs.readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const prefix = text && !text.endsWith("\n") ? eol : "";
    await fs.writeFile(file, `${text}${prefix}# Perfect Planner task worktrees${eol}${IGNORE_LINE}${eol}`);
    return true;
  }

  // Symlinks and junctions show up as untracked files (a trailing-slash
  // "node_modules/" rule only matches real directories), so exclude the link
  // name locally for every worktree via the shared info/exclude file.
  async function excludeLocally(names) {
    const common = (await runGit(git, root, ["rev-parse", "--git-common-dir"])).stdout.trim();
    const file = path.join(path.resolve(root, common), "info", "exclude");
    let text = "";
    try { text = await fs.readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const lines = new Set(text.split(/\r?\n/));
    const missing = names.filter((name) => !lines.has(name));
    if (!missing.length) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const prefix = text && !text.endsWith("\n") ? "\n" : "";
    await fs.writeFile(file, `${text}${prefix}# Perfect Planner worktree local links${"\n"}${missing.join("\n")}\n`);
  }

  async function linkDependencies(target) {
    const source = path.join(root, "node_modules");
    let stat;
    try { stat = await fs.stat(source); } catch { return null; }
    if (!stat.isDirectory()) return null;
    const link = path.join(target, "node_modules");
    if (await exists(link)) return null; // tracked or already present; leave it alone
    await fs.symlink(source, link, process.platform === "win32" ? "junction" : "dir");
    return link;
  }

  async function pickPort(taken) {
    for (let port = portLow; port <= portHigh; port++) {
      if (taken.has(port)) continue;
      if (await portProbe(port)) return port;
    }
    fail("WORKTREE_NO_PORT", `no free port in ${portLow}-${portHigh}`);
  }

  async function copySettings(target, written) {
    const names = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isFile() && isEnvFileName(d.name)).map((d) => d.name).sort();
    const writeIfAbsent = async (name, sourceName) => {
      const dest = path.join(target, name);
      if (await exists(dest)) return;
      const text = await fs.readFile(path.join(root, sourceName), "utf8");
      await fs.writeFile(dest, placeholderEnv(text) + "\n");
      written.push(name);
    };
    // Real local settings first (same name), then fill gaps from *.example templates.
    for (const name of names.filter((n) => !n.endsWith(".example"))) await writeIfAbsent(name, name);
    for (const name of names.filter((n) => n.endsWith(".example"))) await writeIfAbsent(name.slice(0, -".example".length), name);
    return written;
  }

  async function installHook(target) {
    await runGit(git, root, ["config", "extensions.worktreeConfig", "true"]);
    const gitDir = (await runGit(git, target, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    const hooksDir = path.join(gitDir, "pp-hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    const scanPath = path.join(hooksDir, "pp-secret-scan.mjs");
    await fs.copyFile(BUNDLED_SCAN, scanPath);
    const hook = path.join(hooksDir, "pre-commit");
    await fs.writeFile(hook, hookScript(process.execPath, scanPath), { mode: 0o755 });
    if (process.platform !== "win32") await fs.chmod(hook, 0o755);
    await runGit(git, target, ["config", "--worktree", "core.hooksPath", hooksDir.split(path.sep).join("/")]);
    return hook;
  }

  async function branchExists(branch) {
    return (await runGit(git, root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true })).ok;
  }

  async function launch(taskId, { baseBranch } = {}) {
    checkTask(taskId);
    return serial(async () => {
      const active = activeWorktrees(ledger.entries());
      if (active.some((w) => w.taskId === taskId)) fail("WORKTREE_EXISTS", `${taskId} already has a worktree`);
      if (active.length >= maxParallel) fail("WORKTREE_CAP", `at most ${maxParallel} task worktrees may run at once`, { active: active.map((w) => w.taskId) });
      const base = baseBranch || (await runGit(git, root, ["symbolic-ref", "--short", "HEAD"]).catch(() => fail("WORKTREE_BAD_BASE", "main checkout is not on a branch; pass baseBranch"))).stdout.trim();
      const baseCommit = (await runGit(git, root, ["rev-parse", "--verify", `${base}^{commit}`]).catch(() => fail("WORKTREE_BAD_BASE", `unknown base branch: ${base}`))).stdout.trim();
      const target = worktreePath(taskId);
      if (await exists(target)) fail("WORKTREE_PATH_IN_USE", `${relative(target)} already exists on disk`);
      const branch = branchName(taskId);
      const reuseBranch = await branchExists(branch);

      const ignoredAdded = await ensureIgnored();
      await fs.mkdir(path.dirname(target), { recursive: true });
      const port = await pickPort(new Set(active.map((w) => w.port)));
      await runGit(git, root, reuseBranch ? ["worktree", "add", target, branch] : ["worktree", "add", "-b", branch, target, baseCommit]);
      let link = null;
      const settings = [];
      try {
        link = await linkDependencies(target);
        if (link) await excludeLocally(["/node_modules"]);
        await copySettings(target, settings);
        const hook = await installHook(target);
        const evidence = [`branch:${branch}`, `path:${relative(target)}`, `port:${port}`, `base:${base}`, `head:${baseCommit}`];
        if (link) evidence.push("deps:node_modules");
        for (const name of settings) evidence.push(`settings:${name}`);
        const entry = await ledger.append({
          actor: ACTOR,
          type: "worktree.created",
          subject: taskId,
          summary: `Worktree for ${taskId} on ${branch} from ${base} (port ${port})`,
          evidence,
        });
        return { taskId, branch, path: target, port, baseBranch: base, baseCommit, dependencies: link ? "linked" : "none", settings, hook, ignoredAdded, entry };
      } catch (error) {
        // Nothing has been worked on yet: undo exactly what launch() added so
        // the ledger and the disk agree. No force flags: if git sees anything
        // else in the worktree it stays put and the error says so.
        if (link) await fs.unlink(link).catch(() => {});
        for (const name of settings) await fs.rm(path.join(target, name), { force: true }).catch(() => {});
        const undone = await runGit(git, root, ["worktree", "remove", target], { allowFail: true });
        if (undone.ok && !reuseBranch) await runGit(git, root, ["update-ref", "-d", `refs/heads/${branch}`, baseCommit], { allowFail: true });
        if (!undone.ok) error.rollback = `worktree kept at ${relative(target)}: ${undone.stderr.trim()}`;
        throw error;
      }
    });
  }

  async function remove(taskId, { into } = {}) {
    checkTask(taskId);
    return serial(async () => {
      const record = activeWorktrees(ledger.entries()).find((w) => w.taskId === taskId);
      if (!record) fail("WORKTREE_UNKNOWN", `${taskId} has no active worktree`);
      const target = worktreePath(taskId);
      const branch = record.branch || branchName(taskId);
      const integration = into || record.baseBranch;
      const tip = (await runGit(git, root, ["rev-parse", "--verify", `refs/heads/${branch}`]).catch(() => fail("WORKTREE_UNKNOWN", `branch ${branch} is missing`))).stdout.trim();
      const merged = await runGit(git, root, ["merge-base", "--is-ancestor", tip, integration], { allowFail: true });
      if (!merged.ok) fail("WORKTREE_UNMERGED", `${branch} is not merged into ${integration}; refusing to remove unmerged work`, { branch, into: integration });

      if (await exists(target)) {
        // Remove only what launch() added locally: the dependency link (never
        // following it) and the placeholder settings copies.
        const link = path.join(target, "node_modules");
        try {
          const stat = await fs.lstat(link);
          if (stat.isSymbolicLink()) await fs.unlink(link); // junctions report as links too
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        const settingNames = (ledger.entries().filter((e) => e.type === "worktree.created" && e.subject === taskId).at(-1)?.evidence ?? [])
          .filter((e) => String(e).startsWith("settings:")).map((e) => String(e).slice("settings:".length));
        for (const name of settingNames) {
          const tracked = await runGit(git, target, ["ls-files", "--error-unmatch", "--", name], { allowFail: true });
          if (!tracked.ok) await fs.rm(path.join(target, name), { force: true });
        }
        const status = (await runGit(git, target, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
        if (status) fail("WORKTREE_DIRTY", `${relative(target)} has uncommitted changes; refusing to remove`, { changes: status.split(/\r?\n/) });
        await runGit(git, root, ["worktree", "remove", target]);
      } else {
        await runGit(git, root, ["worktree", "prune"]);
      }
      // Delete the branch only if it still points at the commit verified as merged.
      await runGit(git, root, ["update-ref", "-d", `refs/heads/${branch}`, tip]);
      const entry = await ledger.append({
        actor: ACTOR,
        type: "worktree.removed",
        subject: taskId,
        summary: `Removed merged worktree and branch ${branch} for ${taskId}`,
        evidence: [`branch:${branch}`, `path:${relative(target)}`, `merged-into:${integration}`, `head:${tip}`],
      });
      return { taskId, branch, mergedInto: integration, head: tip, entry };
    });
  }

  async function list() {
    const listed = (await runGit(git, root, ["worktree", "list", "--porcelain"])).stdout;
    const caseless = process.platform === "win32" || process.platform === "darwin";
    const onDisk = new Set(listed.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).map((l) => path.resolve(l.slice("worktree ".length))));
    return activeWorktrees(ledger.entries()).map((w) => {
      const absolute = path.resolve(root, w.path || path.join(WORKTREE_DIR, w.taskId));
      return { ...w, path: absolute, present: [...onDisk].some((p) => (caseless ? p.toLowerCase() === absolute.toLowerCase() : p === absolute)) };
    });
  }

  return { launch, remove, list, ensureIgnored, worktreePath, branchName, maxParallel, portRange: [portLow, portHigh] };
}
