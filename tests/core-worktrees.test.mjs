import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
    // Prove which scanner ran: remove the bundled copy so only the project's can act.
    const hooksDir = git(wt, "config", "--worktree", "--get", "core.hooksPath");
    await fs.rm(path.join(hooksDir, "pp-secret-scan.mjs"));
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
