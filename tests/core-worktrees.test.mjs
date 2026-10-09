import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { activeWorktrees, createWorktreeManager, IGNORE_LINE, isPortFree } from "../src/core/worktrees/index.mjs";
import { placeholderEnv, placeholderFor, isEnvFileName } from "../src/core/worktrees/envPlaceholders.mjs";
import { scanText } from "../src/core/worktrees/bundledSecretScan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Fake credentials are assembled at runtime so this file never holds one literally.
const FAKE_AWS = "AKIA" + "0".repeat(16);
const FAKE_VALUE = "s3cr3t" + "Value".repeat(4);

// Minimal in-memory ledger implementing the shared Ledger interface.
function fakeLedger({ failOn } = {}) {
  const list = [];
  const subs = new Set();
  let counter = 0;
  return {
    async append(input) {
      if (failOn && failOn(input)) { const e = new Error("locked"); e.code = "LEDGER_LOCKED"; throw e; }
      if (!input.summary || !input.type || !input.subject) { const e = new Error("rule"); e.code = "LEDGER_RULE"; throw e; }
      counter += 1;
      const entry = Object.freeze({ n: "L-" + String(counter).padStart(6, "0"), at: new Date().toISOString(), reason: null, evidence: [], refs: [], corrects: null, prev: null, hash: "x", ...input });
      list.push(entry);
      for (const fn of subs) fn(entry);
      return entry;
    },
    entries: () => [...list],
    nextId: (series) => `${series}-${list.length + 1}`,
    verify: () => ({ ok: true }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    close() {},
  };
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitTry = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

async function makeRepo({ withDeps = true, envFiles = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pp-wt-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "PP Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n.env\n");
  await fs.writeFile(path.join(root, "app.js"), "export const x = 1;\n");
  if (envFiles) await fs.writeFile(path.join(root, ".env.example"), "# sample\nAPI_KEY=\nPORT=3000\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  if (envFiles) await fs.writeFile(path.join(root, ".env"), `API_KEY=${FAKE_VALUE}\nexport DB_PASSWORD="${FAKE_VALUE}"\n# keep me\n\nPORT=3000\n`);
  if (withDeps) {
    await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 42;\n");
  }
  return root;
}

const cleanup = (root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});

test("envPlaceholders replaces every value and keeps keys, comments and blanks", () => {
  const input = `# header\nAPI_KEY=${FAKE_VALUE}\nexport TOKEN='${FAKE_VALUE}'\n\nmulti="line one\nline two"\nname: ${FAKE_VALUE}\ngarbage ${FAKE_VALUE}\n`;
  const out = placeholderEnv(input);
  assert.ok(!out.includes(FAKE_VALUE), "no real value may survive");
  assert.ok(!out.includes("line two"));
  assert.match(out, /^# header$/m);
  assert.match(out, /^API_KEY=PLACEHOLDER_API_KEY$/m);
  assert.match(out, /^export TOKEN=PLACEHOLDER_TOKEN$/m);
  assert.match(out, /^multi=PLACEHOLDER_MULTI$/m);
  assert.match(out, /^name: PLACEHOLDER_NAME$/m);
  assert.equal(placeholderFor("db.url"), "PLACEHOLDER_DB_URL");
  assert.ok(isEnvFileName(".env") && isEnvFileName(".env.local") && isEnvFileName(".env.example"));
  assert.ok(!isEnvFileName("env") && !isEnvFileName(".environment.js.swp"));
});

test("bundled scan flags a planted AWS key and ignores placeholders", () => {
  assert.equal(scanText("a.js", `const k = "${FAKE_AWS}";`)[0].rule, "aws-access-key");
  assert.deepEqual(scanText(".env", "API_KEY=PLACEHOLDER_API_KEY_LONG_ENOUGH\n"), []);
  const finding = scanText("x", `line\nAPI_TOKEN=${FAKE_VALUE}\n`)[0];
  assert.equal(finding.line, 2);
  assert.ok(!JSON.stringify(finding).includes(FAKE_VALUE), "findings never carry the match");
});

test("launch creates branch, worktree, linked deps, free port, placeholder settings, hook and ledger entry", async () => {
  const root = await makeRepo();
  const ledger = fakeLedger();
  const manager = createWorktreeManager({ repoRoot: root, ledger });
  try {
    const result = await manager.launch("T-14", { baseBranch: "main" });
    const wt = path.join(root, ".perfect-planner", "worktrees", "T-14");
    assert.equal(result.path, wt);
    assert.equal(result.branch, "pp/T-14");
    assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "pp/T-14");
    assert.equal(git(root, "rev-parse", "pp/T-14"), git(root, "rev-parse", "main"));

    // Shared dependency cache: a link, not a copy, and it resolves to the main checkout.
    const link = path.join(wt, "node_modules");
    assert.ok((await fs.lstat(link)).isSymbolicLink());
    assert.equal(await fs.realpath(link), await fs.realpath(path.join(root, "node_modules")));
    assert.equal(readFileSync(path.join(link, "dep", "index.js"), "utf8"), "module.exports = 42;\n");

    // Port is inside the range and was actually free.
    assert.ok(result.port >= 5300 && result.port <= 5399);

    // Local settings: .env copied with placeholders only.
    const env = await fs.readFile(path.join(wt, ".env"), "utf8");
    assert.ok(!env.includes(FAKE_VALUE));
    assert.match(env, /^API_KEY=PLACEHOLDER_API_KEY$/m);
    assert.match(env, /^export DB_PASSWORD=PLACEHOLDER_DB_PASSWORD$/m);
    assert.match(env, /^# keep me$/m);
    assert.deepEqual(result.settings, [".env"]);
    // Tracked example stays as checked out.
    assert.equal(await fs.readFile(path.join(wt, ".env.example"), "utf8"), "# sample\nAPI_KEY=\nPORT=3000\n");

    // Worktree-local hooks path, not the shared one.
    const hooksPath = git(wt, "config", "--worktree", "--get", "core.hooksPath");
    assert.ok(hooksPath.includes("pp-hooks"));
    assert.equal(gitTry(root, "config", "--worktree", "--get", "core.hooksPath").status, 1, "main checkout hooks untouched");

    // The worktree starts clean: the dependency link is excluded.
    assert.equal(git(wt, "status", "--porcelain"), "");

    // .gitignore got the worktrees line exactly once.
    assert.equal((await fs.readFile(path.join(root, ".gitignore"), "utf8")).split(IGNORE_LINE).length - 1, 1);
    assert.equal(gitTry(root, "check-ignore", "-q", ".perfect-planner/worktrees/T-14/app.js").status, 0);

    // Ledger entry.
    const [entry] = ledger.entries();
    assert.equal(entry.type, "worktree.created");
    assert.equal(entry.subject, "T-14");
    assert.deepEqual(entry.actor, { kind: "system", id: "perfect-planner" });
    assert.ok(entry.evidence.includes("branch:pp/T-14"));
    assert.ok(entry.evidence.includes(`port:${result.port}`));
    assert.ok(entry.evidence.includes("path:.perfect-planner/worktrees/T-14"));
    assert.ok(!JSON.stringify(entry).includes(FAKE_VALUE));
    // The hook is recorded by path and sha256 so a later step can check it was not altered.
    const hookEvidence = entry.evidence.find((e) => e.startsWith("hook:")).slice("hook:".length);
    const hookFile = path.join(root, hookEvidence);
    assert.equal(hookFile, result.hook);
    const digest = createHash("sha256").update(readFileSync(hookFile)).digest("hex");
    assert.ok(entry.evidence.includes(`hook-sha256:${digest}`));
    assert.equal(result.hookSha256, digest);
    assert.ok(entry.evidence.some((e) => /^scan-sha256:[0-9a-f]{64}$/.test(e)));
    // Nothing was written to the shared info/exclude of the main checkout.
    const sharedExclude = path.join(root, ".git", "info", "exclude");
    const sharedText = await fs.readFile(sharedExclude, "utf8").catch(() => "");
    assert.ok(!sharedText.includes("/node_modules"), "shared info/exclude untouched");

    const listed = await manager.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].taskId, "T-14");
    assert.equal(listed[0].port, result.port);
    assert.equal(listed[0].present, true);

    await assert.rejects(manager.launch("T-14", { baseBranch: "main" }), { code: "WORKTREE_EXISTS" });
    await assert.rejects(manager.launch("14"), { code: "WORKTREE_BAD_TASK" });
    await assert.rejects(manager.launch("T-15", { baseBranch: "nope" }), { code: "WORKTREE_BAD_BASE" });

    // A second launch does not duplicate the ignore line and gets a different port.
    const second = await manager.launch("T-15");
    assert.notEqual(second.port, result.port);
    assert.equal(second.baseBranch, "main");
    assert.equal(second.ignoredAdded, false);
    assert.equal((await fs.readFile(path.join(root, ".gitignore"), "utf8")).split(IGNORE_LINE).length - 1, 1);
  } finally { await cleanup(root); }
});

test("pre-commit hook blocks a planted fake AWS key and allows a clean commit (bundled scan)", async () => {
  const root = await makeRepo({ withDeps: false });
  const manager = createWorktreeManager({ repoRoot: root, ledger: fakeLedger() });
  try {
    const { path: wt } = await manager.launch("T-1", { baseBranch: "main" });
    await fs.writeFile(path.join(wt, "leak.js"), `export const key = "${FAKE_AWS}";\n`);
    git(wt, "add", "leak.js");
    const blocked = gitTry(wt, "commit", "-m", "leak");
    assert.notEqual(blocked.status, 0, "commit with a fake key must be refused");
    assert.match(blocked.stderr, /aws-access-key/);
    assert.ok(!blocked.stderr.includes(FAKE_AWS), "the hook never echoes the secret");
    assert.equal(gitTry(wt, "rev-parse", "--verify", "HEAD").stdout.trim(), git(root, "rev-parse", "main"));

    await fs.writeFile(path.join(wt, "leak.js"), "export const key = process.env.KEY;\n");
    git(wt, "add", "leak.js");
    const ok = gitTry(wt, "commit", "-m", "clean");
    assert.equal(ok.status, 0, ok.stderr);
  } finally { await cleanup(root); }
});

test("pre-commit hook prefers the project's scripts/verify-secrets.mjs when present", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  await fs.mkdir(path.join(root, "scripts"));
  await fs.copyFile(path.join(here, "..", "scripts", "verify-secrets.mjs"), path.join(root, "scripts", "verify-secrets.mjs"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "add scanner");
  const manager = createWorktreeManager({ repoRoot: root, ledger: fakeLedger() });
  try {
    const { path: wt } = await manager.launch("T-2", { baseBranch: "main" });
    // Prove which scanner ran: stub out the bundled copy (it always passes) so only the project's can block.
    const hooksDir = git(wt, "config", "--worktree", "--get", "core.hooksPath");
    await fs.writeFile(path.join(hooksDir, "pp-secret-scan.mjs"), "process.exitCode = 0;\n");
    await fs.writeFile(path.join(wt, "leak.txt"), `${FAKE_AWS}\n`);
    git(wt, "add", "leak.txt");
    const blocked = gitTry(wt, "commit", "-m", "leak");
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /verify-secrets/);

    git(wt, "rm", "-q", "--cached", "leak.txt");
    await fs.rm(path.join(wt, "leak.txt"));
    await fs.writeFile(path.join(wt, "fine.txt"), "hello\n");
    git(wt, "add", "fine.txt");
    const ok = gitTry(wt, "commit", "-m", "fine");
    assert.equal(ok.status, 0, ok.stderr);
  } finally { await cleanup(root); }
});

test("remove refuses unmerged and dirty work, then removes merged work without touching shared deps", async () => {
  const root = await makeRepo();
  const ledger = fakeLedger();
  const manager = createWorktreeManager({ repoRoot: root, ledger });
  try {
    const { path: wt } = await manager.launch("T-3", { baseBranch: "main" });
    await fs.writeFile(path.join(wt, "feature.js"), "export const f = 2;\n");
    git(wt, "add", "feature.js");
    git(wt, "commit", "-q", "-m", "feature\n\nImplements: P-1 §1 (T-3)");

    await assert.rejects(manager.remove("T-3"), { code: "WORKTREE_UNMERGED" });
    assert.ok(await fs.stat(wt));
    assert.equal(gitTry(root, "rev-parse", "--verify", "pp/T-3").status, 0);
    assert.equal(ledger.entries().filter((e) => e.type === "worktree.removed").length, 0);

    git(root, "merge", "-q", "--no-ff", "-m", "merge T-3", "pp/T-3");

    await fs.writeFile(path.join(wt, "scratch.js"), "uncommitted\n");
    await assert.rejects(manager.remove("T-3"), { code: "WORKTREE_DIRTY" });
    assert.equal(gitTry(root, "rev-parse", "--verify", "pp/T-3").status, 0, "branch kept when dirty");
    // A refused removal leaves the worktree intact: deps link and placeholder settings are still there.
    assert.ok((await fs.lstat(path.join(wt, "node_modules"))).isSymbolicLink(), "deps link kept when dirty");
    assert.match(await fs.readFile(path.join(wt, ".env"), "utf8"), /^API_KEY=PLACEHOLDER_API_KEY$/m, "settings kept when dirty");
    // A tracked modification is refused just the same, again without touching anything.
    await fs.rm(path.join(wt, "scratch.js"));
    await fs.writeFile(path.join(wt, "app.js"), "export const x = 3;\n");
    await assert.rejects(manager.remove("T-3"), { code: "WORKTREE_DIRTY" });
    assert.ok((await fs.lstat(path.join(wt, "node_modules"))).isSymbolicLink());
    assert.ok(await fs.stat(path.join(wt, ".env")));
    git(wt, "checkout", "--", "app.js");
    await fs.writeFile(path.join(wt, "scratch.js"), "uncommitted\n");
    await fs.rm(path.join(wt, "scratch.js"));

    const removed = await manager.remove("T-3");
    assert.equal(removed.mergedInto, "main");
    assert.notEqual(gitTry(root, "rev-parse", "--verify", "refs/heads/pp/T-3").status, 0, "branch deleted");
    await assert.rejects(fs.lstat(wt), { code: "ENOENT" });
    assert.equal(readFileSync(path.join(root, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 42;\n", "shared deps survive");
    const last = ledger.entries().at(-1);
    assert.equal(last.type, "worktree.removed");
    assert.equal(last.subject, "T-3");
    assert.deepEqual(await manager.list(), []);
    await assert.rejects(manager.remove("T-3"), { code: "WORKTREE_UNKNOWN" });
  } finally { await cleanup(root); }
});

test("maxParallel is enforced, including for concurrent launches, and frees up after removal", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  const ledger = fakeLedger();
  const manager = createWorktreeManager({ repoRoot: root, ledger, maxParallel: 2 });
  try {
    const results = await Promise.allSettled([manager.launch("T-1"), manager.launch("T-2"), manager.launch("T-3")]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, "WORKTREE_CAP");
    assert.equal(gitTry(root, "rev-parse", "--verify", "refs/heads/pp/T-3").status === 0, false, "no branch made for the refused task");

    // Nothing to merge: the branch tip already is main, so it counts as merged.
    await manager.remove("T-1");
    const third = await manager.launch("T-3");
    assert.equal(third.taskId, "T-3");
    assert.equal(activeWorktrees(ledger.entries()).length, 2);
  } finally { await cleanup(root); }
});

test("an occupied port is skipped by a real bind probe", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen({ port: 0, host: "127.0.0.1" }, resolve));
  const busy = blocker.address().port;
  try {
    assert.equal(await isPortFree(busy), false);
    const manager = createWorktreeManager({ repoRoot: root, ledger: fakeLedger(), portRange: [busy, Math.min(busy + 5, 65535)] });
    const result = await manager.launch("T-9");
    assert.notEqual(result.port, busy);
    const none = createWorktreeManager({ repoRoot: root, ledger: fakeLedger(), portRange: [busy, busy] });
    await assert.rejects(none.launch("T-10"), { code: "WORKTREE_NO_PORT" });
    assert.notEqual(gitTry(root, "rev-parse", "--verify", "refs/heads/pp/T-10").status, 0);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await cleanup(root);
  }
});

test("a refused ledger write rolls the fresh worktree back", async () => {
  const root = await makeRepo();
  const ledger = fakeLedger({ failOn: (input) => input.type === "worktree.created" });
  const manager = createWorktreeManager({ repoRoot: root, ledger });
  try {
    await assert.rejects(manager.launch("T-4"), { code: "LEDGER_LOCKED" });
    await assert.rejects(fs.lstat(path.join(root, ".perfect-planner", "worktrees", "T-4")), { code: "ENOENT" });
    assert.notEqual(gitTry(root, "rev-parse", "--verify", "refs/heads/pp/T-4").status, 0);
    assert.equal(readFileSync(path.join(root, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 42;\n");
    assert.deepEqual(ledger.entries(), []);
  } finally { await cleanup(root); }
});

test("an existing pp/<T> branch (reopened task) is reused rather than recreated", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  const manager = createWorktreeManager({ repoRoot: root, ledger: fakeLedger() });
  try {
    git(root, "branch", "pp/T-5");
    const tipBefore = git(root, "rev-parse", "pp/T-5");
    const result = await manager.launch("T-5");
    assert.equal(git(result.path, "rev-parse", "HEAD"), tipBefore);
  } finally { await cleanup(root); }
});

test("missing .gitignore is created, an existing covering rule is respected, and *.example templates fill gaps", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  try {
    await fs.rm(path.join(root, ".gitignore"));
    git(root, "commit", "-qam", "drop ignore");
    await fs.writeFile(path.join(root, ".env.local.example"), `SERVICE_TOKEN=${FAKE_VALUE}\n`);
    const manager = createWorktreeManager({ repoRoot: root, ledger: fakeLedger() });
    const result = await manager.launch("T-6");
    assert.equal(result.ignoredAdded, true);
    assert.match(await fs.readFile(path.join(root, ".gitignore"), "utf8"), /^\.perfect-planner\/worktrees\/$/m);
    assert.ok(result.settings.includes(".env.local"));
    assert.equal((await fs.readFile(path.join(result.path, ".env.local"), "utf8")).trim(), "SERVICE_TOKEN=PLACEHOLDER_SERVICE_TOKEN");

    const other = await makeRepo({ withDeps: false, envFiles: false });
    try {
      await fs.writeFile(path.join(other, ".gitignore"), "/.perfect-planner/\n");
      const before = await fs.readFile(path.join(other, ".gitignore"), "utf8");
      const r2 = await createWorktreeManager({ repoRoot: other, ledger: fakeLedger() }).launch("T-1");
      assert.equal(r2.ignoredAdded, false);
      assert.equal(await fs.readFile(path.join(other, ".gitignore"), "utf8"), before);
    } finally { await cleanup(other); }
  } finally { await cleanup(root); }
});

test("configuration is validated", () => {
  assert.throws(() => createWorktreeManager({ ledger: fakeLedger() }), { code: "WORKTREE_CONFIG" });
  assert.throws(() => createWorktreeManager({ repoRoot: os.tmpdir() }), { code: "WORKTREE_CONFIG" });
  assert.throws(() => createWorktreeManager({ repoRoot: os.tmpdir(), ledger: fakeLedger(), maxParallel: 0 }), { code: "WORKTREE_CONFIG" });
  assert.throws(() => createWorktreeManager({ repoRoot: os.tmpdir(), ledger: fakeLedger(), portRange: [10, 5] }), { code: "WORKTREE_CONFIG" });
});

async function listenOn(options) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options, resolve); });
  return server;
}
const closeServer = (server) => new Promise((resolve) => server.close(resolve));

test("a port held on the wildcard address (0.0.0.0 or Node's default listen) is not reported free", async () => {
  const wildcard = await listenOn({ port: 0, host: "0.0.0.0" });
  try {
    assert.equal(await isPortFree(wildcard.address().port), false, "0.0.0.0 holder");
  } finally { await closeServer(wildcard); }
  const defaultHost = await listenOn({ port: 0 });
  try {
    const port = defaultHost.address().port;
    assert.equal(await isPortFree(port), false, "listen(port) with no host");
    const root = await makeRepo({ withDeps: false, envFiles: false });
    try {
      const result = await createWorktreeManager({ repoRoot: root, ledger: fakeLedger(), portRange: [port, Math.min(port + 5, 65535)] }).launch("T-1");
      assert.notEqual(result.port, port);
    } finally { await cleanup(root); }
  } finally { await closeServer(defaultHost); }
  // And a port nobody holds is still free.
  const probe = await listenOn({ port: 0 });
  const freePort = probe.address().port;
  await closeServer(probe);
  assert.equal(await isPortFree(freePort), true);
});

test("git commit -a and partial commits are scanned and work when the project has scripts/verify-secrets.mjs", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  await fs.mkdir(path.join(root, "scripts"));
  await fs.copyFile(path.join(here, "..", "scripts", "verify-secrets.mjs"), path.join(root, "scripts", "verify-secrets.mjs"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "add scanner");
  const manager = createWorktreeManager({ repoRoot: root, ledger: fakeLedger() });
  try {
    const { path: wt } = await manager.launch("T-7", { baseBranch: "main" });
    const head = git(wt, "rev-parse", "HEAD");
    // The gate that decides whether the project scanner runs too: normal index yes, any other index no.
    const scan = path.join(git(wt, "config", "--worktree", "--get", "core.hooksPath"), "pp-secret-scan.mjs");
    const baseEnv = { ...process.env };
    for (const key of Object.keys(baseEnv)) if (key.toUpperCase().startsWith("GIT_")) delete baseEnv[key];
    const gate = (extra) => spawnSync(process.execPath, [scan, "--index-is-normal"], { cwd: wt, env: { ...baseEnv, ...extra }, windowsHide: true }).status;
    const normalIndex = path.resolve(wt, git(wt, "rev-parse", "--git-path", "index"));
    assert.equal(gate({}), 0, "unset GIT_INDEX_FILE counts as the normal index");
    assert.equal(gate({ GIT_INDEX_FILE: normalIndex }), 0, "the normal index");
    assert.equal(gate({ GIT_INDEX_FILE: normalIndex + ".lock" }), 1, "a temporary index");
    assert.equal(gate({ GIT_INDEX_FILE: "" }), 1, "an empty override");
    // A tracked file changed but not staged: commit -a must still catch the key (temporary index).
    await fs.writeFile(path.join(wt, "app.js"), `export const key = "${FAKE_AWS}";\n`);
    const blocked = gitTry(wt, "commit", "-am", "leak");
    assert.notEqual(blocked.status, 0, "commit -am with a fake key must be refused");
    assert.match(blocked.stderr, /aws-access-key/);
    assert.ok(!blocked.stderr.includes(FAKE_AWS));
    assert.equal(git(wt, "rev-parse", "HEAD"), head);
    // A partial commit (pathspec) uses a temporary index too.
    const partial = gitTry(wt, "commit", "-m", "leak", "--", "app.js");
    assert.notEqual(partial.status, 0, "partial commit with a fake key must be refused");
    assert.equal(git(wt, "rev-parse", "HEAD"), head);

    await fs.writeFile(path.join(wt, "app.js"), "export const x = 2;\n");
    const ok = gitTry(wt, "commit", "-am", "clean change");
    assert.equal(ok.status, 0, ok.stderr);
    assert.notEqual(git(wt, "rev-parse", "HEAD"), head);
    await fs.writeFile(path.join(wt, "app.js"), "export const x = 3;\n");
    const okPartial = gitTry(wt, "commit", "-m", "clean partial", "--", "app.js");
    assert.equal(okPartial.status, 0, okPartial.stderr);
  } finally { await cleanup(root); }
});

test("a missing bundled scan blocks commits (fail closed)", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  const manager = createWorktreeManager({ repoRoot: root, ledger: fakeLedger() });
  try {
    const { path: wt } = await manager.launch("T-8");
    await fs.rm(path.join(git(wt, "config", "--worktree", "--get", "core.hooksPath"), "pp-secret-scan.mjs"));
    await fs.writeFile(path.join(wt, "fine.txt"), "hello\n");
    git(wt, "add", "fine.txt");
    assert.notEqual(gitTry(wt, "commit", "-m", "fine").status, 0);
  } finally { await cleanup(root); }
});

test("the hook falls back to node on PATH when the recorded runtime is gone", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  const manager = createWorktreeManager({ repoRoot: root, ledger: fakeLedger() });
  try {
    const { path: wt, hook } = await manager.launch("T-11");
    const text = await fs.readFile(hook, "utf8");
    assert.match(text, /^node_bin='.+'$/m);
    await fs.writeFile(hook, text.replace(/^node_bin='.+'$/m, "node_bin='/nonexistent/pp-node/node'"));
    // Make sure the test's own runtime directory is on PATH for the fallback.
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
    await fs.writeFile(path.join(wt, "leak.js"), `export const key = "${FAKE_AWS}";\n`);
    git(wt, "add", "leak.js");
    const blocked = spawnSync("git", ["commit", "-m", "leak"], { cwd: wt, encoding: "utf8", windowsHide: true, env });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /aws-access-key/, "the fallback runtime ran the scan");
    await fs.writeFile(path.join(wt, "leak.js"), "export const key = process.env.KEY;\n");
    git(wt, "add", "leak.js");
    const ok = spawnSync("git", ["commit", "-m", "clean"], { cwd: wt, encoding: "utf8", windowsHide: true, env });
    assert.equal(ok.status, 0, ok.stderr);
  } finally { await cleanup(root); }
});

test("placeholder settings and the deps link are excluded per worktree, so git add -A cannot commit them", async () => {
  const root = await makeRepo({ envFiles: false });
  try {
    // No ignore rule at all for the settings names.
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    await fs.writeFile(path.join(root, ".env.local.example"), `SERVICE_TOKEN=${FAKE_VALUE}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "template");
    await fs.writeFile(path.join(root, ".env"), `API_KEY=${FAKE_VALUE}\n`);
    const sharedExclude = path.join(root, ".git", "info", "exclude");
    const sharedBefore = await fs.readFile(sharedExclude, "utf8").catch(() => null);
    const ledger = fakeLedger();
    const manager = createWorktreeManager({ repoRoot: root, ledger });
    const result = await manager.launch("T-12");
    assert.deepEqual([...result.settings].sort(), [".env", ".env.local"]);
    assert.equal(result.dependencies, "linked");
    assert.equal(git(result.path, "status", "--porcelain", "--untracked-files=all"), "", "worktree starts clean");
    git(result.path, "add", "-A");
    assert.equal(git(result.path, "diff", "--cached", "--name-only"), "", "git add -A stages nothing launch() added");
    assert.equal(await fs.readFile(sharedExclude, "utf8").catch(() => null), sharedBefore, "shared info/exclude unchanged");
    // The main checkout still sees its own untracked .env: the per-worktree exclude does not leak.
    assert.match(git(root, "status", "--porcelain"), /^\?\? \.env$/m);
    // Removal of the (trivially merged) worktree still cleans up the owned files.
    await manager.remove("T-12");
    await assert.rejects(fs.lstat(result.path), { code: "ENOENT" });
  } finally { await cleanup(root); }
});

test("remove validates the integration branch instead of passing it to git as an option", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  const manager = createWorktreeManager({ repoRoot: root, ledger: fakeLedger() });
  try {
    await manager.launch("T-13");
    await assert.rejects(manager.remove("T-13", { into: "--all" }), { code: "WORKTREE_BAD_BASE" });
    await assert.rejects(manager.remove("T-13", { into: "-h" }), { code: "WORKTREE_BAD_BASE" });
    await assert.rejects(manager.remove("T-13", { into: "no-such-branch" }), { code: "WORKTREE_BAD_BASE" });
    await assert.rejects(manager.remove("T-13", { into: "" }), { code: "WORKTREE_BAD_BASE" });
    await assert.rejects(manager.launch("T-20", { baseBranch: "--all" }), { code: "WORKTREE_BAD_BASE" });
    assert.equal(gitTry(root, "rev-parse", "--verify", "refs/heads/pp/T-13").status, 0, "nothing removed");
    const removed = await manager.remove("T-13", { into: "main" });
    assert.equal(removed.mergedInto, "main");
  } finally { await cleanup(root); }
});

test("list().present is right when repoRoot goes through a link", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  const alias = path.join(path.dirname(root), path.basename(root) + "-alias");
  await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    const manager = createWorktreeManager({ repoRoot: alias, ledger: fakeLedger() });
    const result = await manager.launch("T-16");
    assert.equal(result.path, path.join(root, ".perfect-planner", "worktrees", "T-16"), "paths use the real repo root");
    const [listed] = await manager.list();
    assert.equal(listed.present, true);
  } finally {
    await fs.unlink(alias).catch(() => {});
    await cleanup(root);
  }
});

test("reopened task ids with an attempt suffix share the base task's branch and worktree", async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  const ledger = fakeLedger();
  const manager = createWorktreeManager({ repoRoot: root, ledger });
  try {
    for (const bad of ["T-14.a1", "T-14.a0", "T-14.a", "T-14.b2", "T-14.a02"]) {
      await assert.rejects(manager.launch(bad), { code: "WORKTREE_BAD_TASK" }, bad);
    }
    const result = await manager.launch("T-14.a2");
    assert.equal(result.taskId, "T-14");
    assert.equal(result.attempt, "T-14.a2");
    assert.equal(result.branch, "pp/T-14");
    assert.equal(result.path, path.join(root, ".perfect-planner", "worktrees", "T-14"));
    const entry = ledger.entries().at(-1);
    assert.equal(entry.subject, "T-14");
    assert.ok(entry.evidence.includes("attempt:T-14.a2"));
    await assert.rejects(manager.launch("T-14.a3"), { code: "WORKTREE_EXISTS" });
    await assert.rejects(manager.launch("T-14"), { code: "WORKTREE_EXISTS" });
    assert.equal(manager.branchName("T-14.a10"), "pp/T-14");
    const removed = await manager.remove("T-14.a2");
    assert.equal(removed.taskId, "T-14");
  } finally { await cleanup(root); }
});

test("envPlaceholders drops continuation lines of single-quoted and backtick multi-line values", () => {
  const input = [
    "A='first",
    `# looks like a comment ${FAKE_VALUE}`,
    "still inside'",
    "B=`one",
    `#${FAKE_VALUE}`,
    "two`  # trailing comment",
    'C="x\\"',
    `# inside double ${FAKE_VALUE}`,
    '"',
    "# real comment",
    "D=done",
  ].join("\n");
  const out = placeholderEnv(input);
  assert.ok(!out.includes(FAKE_VALUE), out);
  assert.ok(!out.includes("still inside") && !out.includes("two"));
  assert.match(out, /^A=PLACEHOLDER_A$/m);
  assert.match(out, /^B=PLACEHOLDER_B$/m);
  assert.match(out, /^C=PLACEHOLDER_C$/m);
  assert.match(out, /^# real comment$/m);
  assert.match(out, /^D=PLACEHOLDER_D$/m);
  // A single-quoted value closed on its own line does not swallow what follows.
  assert.match(placeholderEnv(`E='${FAKE_VALUE}'\nF=1`), /^F=PLACEHOLDER_F$/m);
});

test("the pre-commit hook is executable on POSIX", { skip: process.platform === "win32" && "POSIX-only check" }, async () => {
  const root = await makeRepo({ withDeps: false, envFiles: false });
  try {
    const { hook } = await createWorktreeManager({ repoRoot: root, ledger: fakeLedger() }).launch("T-17");
    assert.ok(((await fs.stat(hook)).mode & 0o111) !== 0, "hook has an execute bit");
  } finally { await cleanup(root); }
});
