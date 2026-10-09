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
import { createHash } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeholderEnv, isEnvFileName } from "./envPlaceholders.mjs";
import { scanText } from "./bundledSecretScan.mjs";

export const WORKTREE_DIR = path.join(".perfect-planner", "worktrees");
export const IGNORE_LINE = ".perfect-planner/worktrees/";
const ACTOR = Object.freeze({ kind: "system", id: "perfect-planner" });
// A task id, optionally with the attempt suffix of a reopened task (T-14.a2).
// Every attempt shares the base task's branch, worktree and ledger subject.
const TASK_ID = /^(T-[1-9]\d*)(?:\.a(?:[2-9]\d*|1\d+))?$/;
const HOOK_MARKER = "pp-worktree-hook v2";
const BUNDLED_SCAN = fileURLToPath(new URL("./bundledSecretScan.mjs", import.meta.url));
const GIT_ROUTING = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];

function realOrResolved(p, base) {
  const absolute = base === undefined ? path.resolve(p) : path.resolve(base, p);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

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

function probePort(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT" ? "n/a" : false));
    const options = host === undefined ? { port, exclusive: true } : { port, host, exclusive: true };
    server.listen(options, () => server.close(() => resolve(true)));
  });
}

// A port counts as free only if every probe binds. On Windows (and likely
// macOS) a loopback bind still succeeds while another process holds the port
// on the wildcard address, so probe both loopbacks, 0.0.0.0, and Node's default
// listen(port) with no host, which is what most dev servers use. An address
// family the machine lacks ("n/a") does not count against the port.
const PROBE_HOSTS = ["127.0.0.1", "::1", "0.0.0.0", undefined];
export async function isPortFree(port) {
  let bound = false;
  for (const host of PROBE_HOSTS) {
    const result = await probePort(port, host);
    if (result === false) return false;
    if (result === true) bound = true;
  }
  return bound;
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

// The pre-commit hook. It always runs the bundled scan, which reads whatever
// index git hands the hook (GIT_INDEX_FILE), so `git commit -a` and partial
// commits are covered. The project's own scripts/verify-secrets.mjs runs as
// well, but only when the index is the checkout's normal one: it refuses any
// other index, and simply dropping the variable would make it read stale data.
//
// Client-side hooks are advisory: a worker can pass --no-verify, rewrite
// config.worktree or edit this file. launch() records the hook's path and
// sha256 in the worktree.created entry so a later step can check them, and the
// merge step must re-run the secret scan on the branch diff before merging
// (Core Specs §6(b)).
function hookScript(nodePath, scanPath) {
  const q = (p) => `'${p.split(path.sep).join("/").replace(/'/g, "'\\''")}'`;
  return [
    "#!/bin/sh",
    `# ${HOOK_MARKER}: block commits that stage likely secrets`,
    `node_bin=${q(nodePath)}`,
    // The recorded runtime may have moved: fall back to node on PATH, otherwise fail closed with a clear reason.
    'if [ ! -x "$node_bin" ]; then',
    '  node_bin="$(command -v node 2>/dev/null)"',
    '  if [ -z "$node_bin" ]; then echo "Perfect Planner: commit blocked, no Node.js runtime for the secret scan (recorded runtime missing and node is not on PATH)" >&2; exit 1; fi',
    "fi",
    `scan=${q(scanPath)}`,
    'root="$(git rev-parse --show-toplevel)" || exit 1',
    'cd "$root" || exit 1',
    // Git exports GIT_DIR to hooks in a linked worktree; the project scanner
    // refuses routing overrides, so drop it once rediscovery proves it is the same repo.
    'before="$(git rev-parse --absolute-git-dir)" || exit 1',
    "unset GIT_DIR GIT_WORK_TREE",
    'after="$(git rev-parse --absolute-git-dir)" || exit 1',
    'if [ "$before" != "$after" ]; then echo "Perfect Planner: commit blocked, git directory mismatch" >&2; exit 1; fi',
    '"$node_bin" "$scan" || exit 1',
    'if [ -f "scripts/verify-secrets.mjs" ] && "$node_bin" "$scan" --index-is-normal; then',
    '  "$node_bin" scripts/verify-secrets.mjs --staged >/dev/null',
    "  status=$?",
    '  if [ "$status" -ne 0 ]; then echo "Perfect Planner: commit blocked by scripts/verify-secrets.mjs (exit $status: 2 = possible secret staged, 3 = scan incomplete)" >&2; exit 1; fi',
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

export function createWorktreeManager({ repoRoot, ledger, maxParallel = 4, portRange = [5300, 5399], git = "git", portProbe = isPortFree } = {}) {
  if (!repoRoot) fail("WORKTREE_CONFIG", "repoRoot is required");
  if (!ledger || typeof ledger.append !== "function" || typeof ledger.entries !== "function") fail("WORKTREE_CONFIG", "a ledger is required");
  if (!Number.isInteger(maxParallel) || maxParallel < 1) fail("WORKTREE_CONFIG", "maxParallel must be a positive integer");
  const [portLow, portHigh] = portRange;
  if (!Number.isInteger(portLow) || !Number.isInteger(portHigh) || portLow < 1 || portHigh > 65535 || portLow > portHigh) fail("WORKTREE_CONFIG", "portRange must be [low, high] within 1-65535");
  // git prints real paths (e.g. /private/tmp on macOS), so work from the real one.
  const root = realOrResolved(repoRoot);
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const baseTask = (taskId) => TASK_ID.exec(String(taskId))?.[1] ?? taskId;
  const worktreePath = (taskId) => path.join(root, WORKTREE_DIR, baseTask(taskId));
  const branchName = (taskId) => `pp/${baseTask(taskId)}`;
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

  // The excludes file git would otherwise use for this worktree (core.excludesFile
  // or the XDG default), so a worktree-private excludes file keeps the user's rules.
  async function inheritedExcludes(target) {
    const configured = await runGit(git, target, ["config", "--path", "--get", "core.excludesFile"], { allowFail: true });
    const file = configured.ok && configured.stdout.trim()
      ? configured.stdout.trim()
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "git", "ignore");
    try { return await fs.readFile(file, "utf8"); } catch { return ""; }
  }

  // Everything this writes lives in the worktree's private git dir or in its
  // config.worktree, so the main checkout and the shared info/exclude never
  // change. The dependency link and the placeholder settings are excluded for
  // this worktree only: a trailing-slash "node_modules/" rule does not match a
  // link, and the project may not ignore the copied settings names, so without
  // this a worker's `git add -A` would commit them into the task branch.
  async function installWorktreeConfig(target, { excludes }) {
    await runGit(git, root, ["config", "extensions.worktreeConfig", "true"]);
    const gitDir = (await runGit(git, target, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    const hooksDir = path.join(gitDir, "pp-hooks");
    await fs.mkdir(hooksDir, { recursive: true });

    const excludeFile = path.join(hooksDir, "exclude");
    const inherited = await inheritedExcludes(target);
    const own = excludes.map((name) => "/" + name.replace(/[\\*?[\]!#]/g, "\\$&"));
    const inheritedBlock = inherited ? `# inherited excludes\n${inherited}${inherited.endsWith("\n") ? "" : "\n"}` : "";
    await fs.writeFile(excludeFile, `${inheritedBlock}# Perfect Planner: files launch() added to this worktree\n${own.map((line) => `${line}\n`).join("")}`);
    await runGit(git, target, ["config", "--worktree", "core.excludesFile", excludeFile.split(path.sep).join("/")]);

    const scanPath = path.join(hooksDir, "pp-secret-scan.mjs");
    await fs.copyFile(BUNDLED_SCAN, scanPath);
    const hook = path.join(hooksDir, "pre-commit");
    const hookText = hookScript(process.execPath, scanPath);
    await fs.writeFile(hook, hookText, { mode: 0o755 });
    if (process.platform !== "win32") await fs.chmod(hook, 0o755);
    await runGit(git, target, ["config", "--worktree", "core.hooksPath", hooksDir.split(path.sep).join("/")]);
    return { hook, hookSha256: sha256(hookText), scanSha256: sha256(await fs.readFile(scanPath)) };
  }

  // Resolve a caller-supplied revision to a commit without letting it be read as an option.
  async function resolveCommit(rev, what) {
    if (typeof rev !== "string" || !rev || rev.startsWith("-") || /[\0\r\n]/.test(rev)) fail("WORKTREE_BAD_BASE", `not a usable ${what}: ${String(rev)}`);
    const resolved = await runGit(git, root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], { allowFail: true });
    const commit = resolved.stdout.trim();
    if (!resolved.ok || !commit) fail("WORKTREE_BAD_BASE", `unknown ${what}: ${rev}`);
    return commit;
  }

  async function branchExists(branch) {
    return (await runGit(git, root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true })).ok;
  }

  async function launch(requestedId, { baseBranch } = {}) {
    checkTask(requestedId);
    const taskId = baseTask(requestedId);
    return serial(async () => {
      const active = activeWorktrees(ledger.entries());
      if (active.some((w) => w.taskId === taskId)) fail("WORKTREE_EXISTS", `${taskId} already has a worktree`);
      if (active.length >= maxParallel) fail("WORKTREE_CAP", `at most ${maxParallel} task worktrees may run at once`, { active: active.map((w) => w.taskId) });
      const base = baseBranch || (await runGit(git, root, ["symbolic-ref", "--short", "HEAD"]).catch(() => fail("WORKTREE_BAD_BASE", "main checkout is not on a branch; pass baseBranch"))).stdout.trim();
      const baseCommit = await resolveCommit(base, "base branch");
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
        await copySettings(target, settings);
        const { hook, hookSha256, scanSha256 } = await installWorktreeConfig(target, { excludes: [...(link ? ["node_modules"] : []), ...settings] });
        const evidence = [`branch:${branch}`, `path:${relative(target)}`, `port:${port}`, `base:${base}`, `head:${baseCommit}`];
        if (requestedId !== taskId) evidence.push(`attempt:${requestedId}`);
        if (link) evidence.push("deps:node_modules");
        for (const name of settings) evidence.push(`settings:${name}`);
        evidence.push(`hook:${relative(hook)}`, `hook-sha256:${hookSha256}`, `scan-sha256:${scanSha256}`);
        const entry = await ledger.append({
          actor: ACTOR,
          type: "worktree.created",
          subject: taskId,
          summary: `Worktree for ${taskId} on ${branch} from ${base} (port ${port})`,
          evidence,
          // The strict ledger's replay reads the worktree from data (board task.worktree).
          data: { path: relative(target), branch, port, base, head: baseCommit, ...(requestedId !== taskId ? { attempt: requestedId } : {}), hookSha256 },
        });
        return { taskId, attempt: requestedId, branch, path: target, port, baseBranch: base, baseCommit, dependencies: link ? "linked" : "none", settings, hook, hookSha256, ignoredAdded, entry };
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

  async function remove(requestedId, { into } = {}) {
    checkTask(requestedId);
    const taskId = baseTask(requestedId);
    return serial(async () => {
      const record = activeWorktrees(ledger.entries()).find((w) => w.taskId === taskId);
      if (!record) fail("WORKTREE_UNKNOWN", `${taskId} has no active worktree`);
      const target = worktreePath(taskId);
      const branch = record.branch || branchName(taskId);
      const integration = into === undefined ? record.baseBranch : into;
      const integrationCommit = await resolveCommit(integration, "integration branch");
      const tip = (await runGit(git, root, ["rev-parse", "--verify", `refs/heads/${branch}`]).catch(() => fail("WORKTREE_UNKNOWN", `branch ${branch} is missing`))).stdout.trim();
      const merged = await runGit(git, root, ["merge-base", "--is-ancestor", tip, integrationCommit], { allowFail: true });
      if (!merged.ok) fail("WORKTREE_UNMERGED", `${branch} is not merged into ${integration}; refusing to remove unmerged work`, { branch, into: integration });

      if (await exists(target)) {
        const link = path.join(target, "node_modules");
        let linkIsOurs = false;
        try { linkIsOurs = (await fs.lstat(link)).isSymbolicLink(); } // junctions report as links too
        catch (error) { if (error.code !== "ENOENT") throw error; }
        const settingNames = (ledger.entries().filter((e) => e.type === "worktree.created" && e.subject === taskId).at(-1)?.evidence ?? [])
          .filter((e) => String(e).startsWith("settings:")).map((e) => String(e).slice("settings:".length));
        const ownedSettings = [];
        for (const name of settingNames) {
          const tracked = await runGit(git, target, ["ls-files", "--error-unmatch", "--", name], { allowFail: true });
          if (!tracked.ok) ownedSettings.push(name);
        }
        // Check for uncommitted work before touching anything, so a refused
        // removal leaves the worktree exactly as it was. Only what launch()
        // added (the dependency link and untracked placeholder settings) may
        // be present.
        const owned = new Set([...(linkIsOurs ? ["node_modules", "node_modules/"] : []), ...ownedSettings]);
        const changes = (await runGit(git, target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout
          .split("\0").filter(Boolean)
          .filter((line) => !(line.startsWith("?? ") && owned.has(line.slice(3))));
        if (changes.length) fail("WORKTREE_DIRTY", `${relative(target)} has uncommitted changes; refusing to remove`, { changes });
        // Now remove only what launch() added: the dependency link (never
        // following it) and the placeholder settings copies.
        if (linkIsOurs) await fs.unlink(link);
        for (const name of ownedSettings) await fs.rm(path.join(target, name), { force: true });
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
        data: { branch, path: relative(target), into: integration, head: tip },
      });
      return { taskId, branch, mergedInto: integration, head: tip, entry };
    });
  }

  /**
   * merge(T, { into, integrationPath, actor? }) merges pp/<T> into the integration
   * branch checked out at integrationPath (--no-ff) and records merge.done. Before
   * merging it re-runs the secret scan on every line the branch adds (the commit
   * hook is advisory, see hookScript), and refuses a dirty or wrong checkout.
   */
  async function merge(requestedId, { into, integrationPath, actor = ACTOR } = {}) {
    checkTask(requestedId);
    const taskId = baseTask(requestedId);
    return serial(async () => {
      if (typeof integrationPath !== "string" || !integrationPath) fail("WORKTREE_CONFIG", "merge needs integrationPath, a checkout of the integration branch");
      const record = activeWorktrees(ledger.entries()).find((w) => w.taskId === taskId);
      if (!record) fail("WORKTREE_UNKNOWN", `${taskId} has no active worktree`);
      const branch = record.branch || branchName(taskId);
      const target = into ?? (await runGit(git, integrationPath, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
      await resolveCommit(target, "integration branch");
      const checkedOut = (await runGit(git, integrationPath, ["symbolic-ref", "--short", "HEAD"], { allowFail: true })).stdout.trim();
      if (checkedOut !== target) fail("WORKTREE_BAD_BASE", `${integrationPath} is on ${checkedOut || "a detached HEAD"}, not ${target}`);
      const dirty = (await runGit(git, integrationPath, ["status", "--porcelain=v1", "-z", "--untracked-files=no"])).stdout;
      if (dirty) fail("WORKTREE_DIRTY", `${integrationPath} has uncommitted changes; refusing to merge`);
      const tip = (await runGit(git, root, ["rev-parse", "--verify", `refs/heads/${branch}`])).stdout.trim();
      // Every commit the merge would bring in, not just the net diff: a key added and
      // later deleted on the branch would still land in the integration history.
      const diff = (await runGit(git, integrationPath, ["log", "--no-color", "-p", "--unified=0", "--format=commit %H", "--end-of-options", `${target}..${tip}`])).stdout;
      const findings = [];
      let file = null;
      for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith("+++ ")) { file = line.slice(4).replace(/^b\//, ""); continue; }
        if (line.startsWith("+") && file) for (const finding of scanText(file, line.slice(1))) findings.push({ path: finding.path, rule: finding.rule });
      }
      if (findings.length) fail("WORKTREE_SECRET", `${branch} adds what looks like a secret (${findings.map((f) => `${f.path}: ${f.rule}`).join(", ")}); refusing to merge`, { findings });
      const merged = await runGit(git, integrationPath, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} (${taskId})`, tip], { allowFail: true });
      if (!merged.ok) {
        await runGit(git, integrationPath, ["merge", "--abort"], { allowFail: true });
        fail("WORKTREE_MERGE_CONFLICT", `${branch} does not merge cleanly into ${target}: ${merged.stdout.trim() || merged.stderr.trim()}`);
      }
      const commit = (await runGit(git, integrationPath, ["rev-parse", "HEAD"])).stdout.trim();
      const entry = await ledger.append({
        actor,
        type: "merge.done",
        subject: requestedId,
        summary: `Merged ${branch} into ${target} for ${taskId}`,
        evidence: [commit, `branch:${branch}`, `into:${target}`, `head:${tip}`],
        data: { commit, into: target, branch, head: tip },
      });
      return { taskId, branch, into: target, commit, head: tip, entry };
    });
  }

  async function list() {
    const listed = (await runGit(git, root, ["worktree", "list", "--porcelain"])).stdout;
    const caseless = process.platform === "win32" || process.platform === "darwin";
    const onDisk = new Set(listed.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).map((l) => realOrResolved(l.slice("worktree ".length))));
    return activeWorktrees(ledger.entries()).map((w) => {
      const absolute = realOrResolved(w.path || path.join(WORKTREE_DIR, w.taskId), root);
      return { ...w, path: absolute, present: [...onDisk].some((p) => (caseless ? p.toLowerCase() === absolute.toLowerCase() : p === absolute)) };
    });
  }

  return { launch, remove, merge, list, ensureIgnored, worktreePath, branchName, maxParallel, portRange: [portLow, portHigh] };
}
