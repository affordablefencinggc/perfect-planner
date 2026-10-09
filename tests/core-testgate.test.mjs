import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, mkdir, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTestGate, testGateState, commandFromEntry, parseCommandString, normalizeCommand,
  resolveCommand, runTestCommand, scrubEnvironment, TESTGATE_ACTOR, findSecretArgument, baseTaskId,
} from "../src/core/testgate/index.mjs";

// ---------- in-memory fake of the shared Ledger interface ----------
// The task.done guard mirrors src/core/ledger rules.doneBlocker: the CURRENT definition
// must be approved, and the last run must be a pass after that approval, after the last
// commit.observed and after any reopen. Subjects match on the base task id.
const baseId = (subject) => String(subject).replace(/\.a\d+$/, "");
function fakeLedger({ refuseDone = false } = {}) {
  const list = [];
  const subs = new Set();
  const err = (code, message) => Object.assign(new Error(message), { code });
  return {
    async append({ actor, type, subject, summary, reason, evidence = [], refs = [], corrects = null, data }) {
      if (!actor || !type || !subject || typeof summary !== "string" || !summary.trim() || /\n/.test(summary) || summary === "TBD") throw err("LEDGER_RULE", "invalid entry");
      if (evidence.some((v) => typeof v !== "string" || !v.trim())) throw err("LEDGER_RULE", "evidence must be non-empty strings");
      if (actor.kind === "jev" && !["review.verdict", "question.asked"].includes(type)) throw err("LEDGER_RULE", "jev-scope");
      if (["correction", "task.reopened"].includes(type) && !(typeof reason === "string" && reason.trim())) throw err("LEDGER_RULE", `${type} needs a reason`);
      if (type === "task.done") {
        if (refuseDone) throw err("LEDGER_RULE", "refused by test");
        const mine = list.filter((e) => baseId(e.subject) === baseId(subject));
        const last = (t) => mine.map((e) => e.type).lastIndexOf(t);
        const definedAt = last("test.defined"), approvedAt = last("test.approved");
        const runs = mine.map((e, i) => (e.type === "test.passed" || e.type === "test.failed" ? i : -1)).filter((i) => i >= 0);
        const lastRun = runs.at(-1) ?? -1;
        if (definedAt < 0 || approvedAt < definedAt) throw err("LEDGER_RULE", "task.done needs the current test approved");
        if (lastRun < 0 || mine[lastRun].type !== "test.passed" || lastRun < Math.max(approvedAt, last("commit.observed"), last("task.reopened"))) throw err("LEDGER_RULE", "task.done needs test.passed after approval and last commit");
      }
      const n = `L-${String(list.length + 1).padStart(6, "0")}`;
      const entry = Object.freeze({ n, at: new Date().toISOString(), actor, type, subject, summary, reason: reason ?? null, evidence: Object.freeze([...evidence]), refs: Object.freeze([...refs]), corrects, ...(data ? { data } : {}), prev: null, hash: "0".repeat(64) });
      list.push(entry);
      for (const fn of subs) fn(entry);
      return entry;
    },
    entries: () => [...list],
    nextId: (series) => `${series}-${list.filter((e) => e.type === "task.created").length + 1}`,
    verify: () => ({ ok: true }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    close() {},
  };
}

const JEV = { kind: "jev", id: "jev", model: "reviewer-model" };
/** A Jev review.verdict in the format src/core/jev/reviewer.mjs writes. */
const jevReview = (ledger, task, { phase = "test", verdict = "approve", confidence = 0.9, reason = "Looks right." } = {}) => ledger.append({
  actor: JEV, type: "review.verdict", subject: task, reason,
  summary: `Jev ${phase} review of ${task}: ${verdict}`,
  evidence: [`phase:${phase}`, `verdict:${verdict}`, `model:${JEV.model}`, "cost:0", `confidence:${confidence ?? "none"}`],
});
/** Approve with an approving Jev test review. */
async function approveWithJev(gate, ledger, task, actor = { kind: "person", id: "owner" }) {
  const review = await jevReview(ledger, task);
  return gate.approveTest(task, actor, { jevVerdict: { entry: review.n } });
}
const worktreeCreated = (ledger, task, dir) => ledger.append({ actor: TESTGATE_ACTOR, type: "worktree.created", subject: task, summary: `Worktree for ${task}`, evidence: [`branch:pp/${task}`, `path:${dir}`] });
const commitObserved = (ledger, task, sha = "abc123") => ledger.append({ actor: TESTGATE_ACTOR, type: "commit.observed", subject: task, summary: `commit ${sha}`, evidence: [sha] });
const mergeDone = (ledger, task) => ledger.append({ actor: TESTGATE_ACTOR, type: "merge.done", subject: task, summary: `${task} merged`, evidence: ["merged-into:main"] });
/** Diff review + merge after a passing worktree run. */
async function reviewAndMerge(ledger, task) { await jevReview(ledger, task, { phase: "diff" }); await mergeDone(ledger, task); }

const owner = { kind: "person", id: "owner" };
const agent = { kind: "agent", id: "worker-1", model: "x" };
const ev = (entry, key) => entry.evidence.find((v) => v.startsWith(key + ":"))?.slice(key.length + 1);

async function tmp(prefix = "pp-testgate-") { return mkdtemp(path.join(os.tmpdir(), prefix)); }

// A test script that passes only when done.txt exists in its cwd.
const CHECK = `import { existsSync } from "node:fs"; if (!existsSync("done.txt")) { console.error("not done yet"); process.exit(3); } console.log("ok");`;

async function fixture() {
  const root = await tmp();
  const before = path.join(root, "before"), worktree = path.join(root, "worktree"), integration = path.join(root, "integration");
  for (const dir of [before, worktree, integration]) { await mkdir(dir); await writeFile(path.join(dir, "check.mjs"), CHECK); }
  await writeFile(path.join(worktree, "done.txt"), "x");
  await writeFile(path.join(integration, "done.txt"), "x");
  return { root, before, worktree, integration, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } }
async function waitDead(pid, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (!pidAlive(pid)) return true; await new Promise((r) => setTimeout(r, 100)); } return !pidAlive(pid); }

// ---------- command parsing ----------
test("parseCommandString splits words and honours quotes", () => {
  assert.deepEqual(parseCommandString("npm test"), ["npm", "test"]);
  assert.deepEqual(parseCommandString(`node --test "tests/a b.test.mjs" 'x y'`), ["node", "--test", "tests/a b.test.mjs", "x y"]);
  assert.deepEqual(parseCommandString(`node "say \\"hi\\""`), ["node", 'say "hi"']);
  assert.deepEqual(parseCommandString(String.raw`C:\tools\run.exe "C:\a dir\x"`), [String.raw`C:\tools\run.exe`, String.raw`C:\a dir\x`]);
  assert.deepEqual(parseCommandString(`node ""`), ["node", ""]);
  assert.deepEqual(parseCommandString(`node "a|b"`), ["node", "a|b"], "quoted operators are literal args, no shell");
});

test("parseCommandString refuses shell operators, newlines and bad quotes", () => {
  for (const bad of ["npm test && rm -rf x", "a | b", "a; b", "a > out", "echo $(id)", "echo `id`", "a\nb", `node "x`, "", "   "]) {
    assert.throws(() => parseCommandString(bad), (e) => e.code === "TEST_COMMAND_INVALID", bad);
  }
  assert.throws(() => normalizeCommand([]), (e) => e.code === "TEST_COMMAND_INVALID");
  assert.throws(() => normalizeCommand(["node", 3]), (e) => e.code === "TEST_COMMAND_INVALID");
  assert.deepEqual(normalizeCommand(["node", "a && b"]), ["node", "a && b"]);
});

// ---------- cross-platform resolution ----------
test("node always resolves to the running Node executable", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const plan = resolveCommand(["node", "--test"], { platform, env: { PATH: "" }, nodePath: "/opt/node/bin/node" });
    assert.deepEqual([plan.file, plan.args, plan.via], ["/opt/node/bin/node", ["--test"], "node"]);
  }
});

test("Windows: npm and npx resolve through their .cmd shims to node + cli.js without a shell", async () => {
  const dir = await tmp();
  try {
    await mkdir(path.join(dir, "node_modules", "npm", "bin"), { recursive: true });
    await writeFile(path.join(dir, "npm.cmd"), "@echo off\r\n");
    await writeFile(path.join(dir, "npx.cmd"), "@echo off\r\n");
    await writeFile(path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), "");
    await writeFile(path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"), "");
    const env = { Path: `C:\\nowhere;${dir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    const npm = resolveCommand("npm run test -- --x", { platform: "win32", env, nodePath: "NODE" });
    assert.equal(npm.file, "NODE", "no sibling node.exe → running node");
    assert.deepEqual(npm.args, [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), "run", "test", "--", "--x"]);
    assert.equal(npm.via, "npm-cli");
    assert.equal(npm.windowsVerbatimArguments, false);
    await writeFile(path.join(dir, "node.exe"), "");
    const npx = resolveCommand(["npx", "vitest", "run"], { platform: "win32", env, nodePath: "NODE" });
    assert.equal(npx.file, path.join(dir, "node.exe"), "sibling node.exe preferred");
    assert.deepEqual(npx.args, [path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"), "vitest", "run"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Windows: other .cmd shims go through cmd.exe /d /s /c only with safe arguments", async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, "tool.cmd"), "@echo off\r\n");
    await writeFile(path.join(dir, "real.exe"), "");
    const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" };
    const plan = resolveCommand(["tool", "a b", "c"], { platform: "win32", env });
    assert.equal(plan.file, path.join("C:\\Windows", "System32", "cmd.exe"));
    assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
    const shim = path.join(dir, "tool.cmd"), quoted = /\s/.test(shim) ? `"${shim}"` : shim;
    assert.equal(plan.args[3], `"${quoted} "a b" c"`);
    assert.equal(plan.windowsVerbatimArguments, true);
    for (const bad of ["a&b", "%PATH%", "x|y", "q\"", "!v!", "(x)"]) {
      assert.throws(() => resolveCommand(["tool", bad], { platform: "win32", env }), (e) => e.code === "TEST_COMMAND_INVALID", bad);
    }
    const exe = resolveCommand(["real", "--flag"], { platform: "win32", env });
    assert.deepEqual([exe.file, exe.args, exe.via], [path.join(dir, "real.exe"), ["--flag"], "path"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("POSIX: PATH lookup requires the executable bit; relative paths resolve against cwd", { skip: process.platform === "win32" && "POSIX permission bits are not enforced on Windows" }, async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, "runner"), "#!/bin/sh\necho hi\n");
    assert.throws(() => resolveCommand(["runner"], { platform: process.platform, env: { PATH: dir } }), (e) => e.code === "TEST_COMMAND_NOT_FOUND");
    await chmod(path.join(dir, "runner"), 0o755);
    assert.equal(resolveCommand(["runner"], { platform: process.platform, env: { PATH: dir } }).file, path.join(dir, "runner"));
    assert.equal(resolveCommand(["./runner"], { platform: process.platform, env: { PATH: "" }, cwd: dir }).file, path.join(dir, "runner"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unknown commands report TEST_COMMAND_NOT_FOUND on every platform", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    assert.throws(() => resolveCommand(["definitely-not-a-real-tool-xyz"], { platform, env: { PATH: os.tmpdir() } }), (e) => e.code === "TEST_COMMAND_NOT_FOUND", platform);
  }
});

test("real run: a Windows .cmd shim executes, a POSIX script executes", async () => {
  const dir = await tmp();
  try {
    if (process.platform === "win32") {
      await writeFile(path.join(dir, "shim.cmd"), "@echo off\r\necho shim-ok %1\r\nexit /b 0\r\n");
      const result = await runTestCommand(["shim", "arg1"], { cwd: dir, env: { ...scrubEnvironment(), PATH: `${dir};${process.env.PATH}` }, timeoutMs: 20_000 });
      assert.equal(result.exitCode, 0, result.outputTail);
      assert.match(result.outputTail, /shim-ok arg1/);
      assert.equal(result.resolved.via, "cmd-shim");
    } else {
      await writeFile(path.join(dir, "run.sh"), "#!/bin/sh\necho script-ok \"$1\"\n");
      await chmod(path.join(dir, "run.sh"), 0o755);
      const result = await runTestCommand(["./run.sh", "a b"], { cwd: dir, timeoutMs: 20_000 });
      assert.equal(result.exitCode, 0);
      assert.match(result.outputTail, /script-ok a b/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real run: npm resolves and runs without a shell when npm is installed", async (t) => {
  let plan;
  try { plan = resolveCommand(["npm", "--version"], {}); } catch { t.skip("npm not on PATH"); return; }
  if (process.platform === "win32") assert.notEqual(plan.via, "cmd-shim", "npm on Windows should run via node + npm-cli.js");
  const result = await runTestCommand(["npm", "--version"], { cwd: os.tmpdir(), timeoutMs: 60_000 });
  assert.equal(result.exitCode, 0, result.outputTail);
  assert.match(result.outputTail, /\d+\.\d+\.\d+/);
});

// ---------- bounded runner ----------
test("output cap keeps only the last 64KB while hashing the full stream", async () => {
  const dir = await tmp();
  try {
    const script = `const line = "x".repeat(1023) + "\\n"; let s = ""; for (let i = 0; i < 300; i++) s += line; process.stdout.write(s); process.stdout.write("END-MARKER\\n");`;
    await writeFile(path.join(dir, "noisy.mjs"), script);
    const result = await runTestCommand(["node", "noisy.mjs"], { cwd: dir, timeoutMs: 30_000 });
    const expected = "x".repeat(1023).concat("\n").repeat(300) + "END-MARKER\n";
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputBytes, Buffer.byteLength(expected));
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.outputTail) <= 64 * 1024);
    assert.ok(Buffer.byteLength(result.outputTail) > 60 * 1024);
    assert.ok(result.outputTail.endsWith("END-MARKER\n"));
    assert.equal(result.outputSha256, createHash("sha256").update(expected).digest("hex"));
    const small = await runTestCommand(["node", "-e", "console.log('tiny')"], { cwd: dir, timeoutMs: 30_000, maxTailBytes: 3 });
    assert.equal(small.outputTail, "ny\n");
    assert.equal(small.truncated, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("timeout kills the whole process tree including grandchildren", async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, "grandchild.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("grandchild.pid", String(process.pid)); setInterval(() => {}, 1000);`);
    await writeFile(path.join(dir, "hang.mjs"), `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
      writeFileSync("child.pid", String(process.pid));
      spawn(process.execPath, ["grandchild.mjs"], { stdio: "inherit" });
      console.log("started"); setInterval(() => {}, 1000);`);
    const started = Date.now();
    const result = await runTestCommand(["node", "hang.mjs"], { cwd: dir, timeoutMs: 2_500 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.ok(Date.now() - started < 12_000, "returns promptly after the kill");
    assert.match(result.outputTail, /started/);
    const childPid = Number(await readFile(path.join(dir, "child.pid"), "utf8"));
    const grandPid = Number(await readFile(path.join(dir, "grandchild.pid"), "utf8"));
    assert.ok(await waitDead(childPid), "child killed");
    assert.ok(await waitDead(grandPid), "grandchild killed with the tree");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("secret-looking environment variables never reach the test command", async () => {
  const dir = await tmp();
  process.env.PP_TESTGATE_FAKE_API_KEY = "placeholder-not-a-secret";
  process.env.PP_TESTGATE_PLAIN = "visible";
  try {
    const result = await runTestCommand(["node", "-e", "console.log(JSON.stringify([process.env.PP_TESTGATE_FAKE_API_KEY ?? null, process.env.PP_TESTGATE_PLAIN]))"], { cwd: dir, timeoutMs: 30_000 });
    assert.deepEqual(JSON.parse(result.outputTail.trim()), [null, "visible"]);
    assert.equal(scrubEnvironment({ GITHUB_TOKEN: "x", Path: "p", DB_PASSWORD: "y", JEV_API_KEY: "z" }).Path, "p");
    assert.deepEqual(Object.keys(scrubEnvironment({ GITHUB_TOKEN: "x", Path: "p", DB_PASSWORD: "y", JEV_API_KEY: "z" })), ["Path"]);
  } finally { delete process.env.PP_TESTGATE_FAKE_API_KEY; delete process.env.PP_TESTGATE_PLAIN; await rm(dir, { recursive: true, force: true }); }
});

test("runner validates cwd and bounds", async () => {
  await assert.rejects(runTestCommand(["node"], { cwd: "relative" }), (e) => e.code === "TEST_CWD_INVALID");
  await assert.rejects(runTestCommand(["node"], { cwd: os.tmpdir(), timeoutMs: 0 }), (e) => e.code === "TEST_TIMEOUT_INVALID");
  const missing = await runTestCommand(["no-such-tool-xyz"], { cwd: os.tmpdir() });
  assert.equal(missing.error, "TEST_COMMAND_NOT_FOUND");
  assert.equal(missing.exitCode, null);
});

test("a process that exits before the timeout is never recorded as timed out, even if pipes close late", async () => {
  const dir = await tmp();
  try {
    // The child exits at once with 0; a grandchild holds the inherited pipes for ~1.5s (past
    // the 500ms timeout, inside the 2s Windows grace). The late timer must not fire.
    await writeFile(path.join(dir, "holder.mjs"), `setTimeout(() => {}, 1500);`);
    await writeFile(path.join(dir, "quick.mjs"), `import { spawn } from "node:child_process"; spawn(process.execPath, ["holder.mjs"], { stdio: "inherit" }); console.log("quick-done"); process.exit(0);`);
    const result = await runTestCommand(["node", "quick.mjs"], { cwd: dir, timeoutMs: 500 });
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.match(result.outputTail, /quick-done/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("background processes left after a normal exit are killed and the run is marked incomplete", async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, "server.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("server.pid", String(process.pid)); setInterval(() => {}, 1000);`);
    await writeFile(path.join(dir, "leaky.mjs"), `import { spawn } from "node:child_process"; import { existsSync } from "node:fs";
      // Windows: libuv already kills non-detached children with their parent, so a real leak is a
      // detached one (outside the parent's job). POSIX: a child in the test's process group.
      spawn(process.execPath, ["server.mjs"], { stdio: "inherit", detached: process.platform === "win32", windowsHide: true });
      const wait = () => existsSync("server.pid") ? process.exit(0) : setTimeout(wait, 50); wait();`);
    const result = await runTestCommand(["node", "leaky.mjs"], { cwd: dir, timeoutMs: 30_000 });
    assert.equal(result.timedOut, false);
    const serverPid = Number(await readFile(path.join(dir, "server.pid"), "utf8"));
    assert.ok(await waitDead(serverPid, 10_000), "the leftover server process is killed");
    if (process.platform === "win32") assert.equal(result.cleanupComplete, false, "Windows records that cleanup was needed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Windows: .cmd shims under paths with parentheses (Program Files (x86)) resolve and run", async () => {
  const root = await tmp();
  const dir = path.join(root, "Program Files (x86)", "Tool");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "paren.cmd"), "@echo off\r\necho paren-ok %1\r\nexit /b 0\r\n");
    const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" };
    const plan = resolveCommand(["paren", "arg1"], { platform: "win32", env });
    assert.equal(plan.args[3], `""${path.join(dir, "paren.cmd")}" arg1"`);
    assert.throws(() => resolveCommand(["paren", "(x)"], { platform: "win32", env }), (e) => e.code === "TEST_COMMAND_INVALID", "arguments keep the strict check");
    const pct = path.join(root, "100%dir");
    await mkdir(pct);
    await writeFile(path.join(pct, "pct.cmd"), "@echo off\r\n");
    assert.throws(() => resolveCommand(["pct"], { platform: "win32", env: { ...env, PATH: pct } }), (e) => e.code === "TEST_COMMAND_INVALID", "% in the shim path would expand");
    if (process.platform === "win32") {
      const result = await runTestCommand(["paren", "arg1"], { cwd: root, env: { ...scrubEnvironment(), PATH: `${dir};${process.env.PATH}` }, timeoutMs: 20_000 });
      assert.equal(result.exitCode, 0, result.outputTail);
      assert.match(result.outputTail, /paren-ok arg1/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scrubEnvironment drops more credential shapes and keeps harmless look-alikes", () => {
  const env = {
    OPENAI_KEY: "1", GH_PAT: "2", DATABASE_URL: "3", SENTRY_DSN: "4", MY_COOKIE: "5", APP_SESSION: "6", NPM_CONFIG__AUTH: "7",
    GITHUB_TOKEN: "8", DB_PASSWORD: "9", JEV_API_KEY: "10", REDIS: "redis://user:pw@host:6379", SESSION_ID: "11",
    AUTHOR: "a", KEYBOARD_LAYOUT: "b", PATH: "c", PATHEXT: "d", SESSIONNAME: "Console", HOME: "e", LOCALAPPDATA: "f", SITE_URL: "https://example.com/x",
  };
  assert.deepEqual(Object.keys(scrubEnvironment(env)).sort(), ["AUTHOR", "HOME", "KEYBOARD_LAYOUT", "LOCALAPPDATA", "PATH", "PATHEXT", "SESSIONNAME", "SITE_URL"]);
});

test("findSecretArgument and baseTaskId", () => {
  assert.equal(findSecretArgument(["node", "x", "--github-token", "t"]), 2);
  assert.equal(findSecretArgument(["node", "x", "DB_PASSWORD=y"]), 2);
  assert.equal(findSecretArgument(["node", "--test", "tests/auth.test.mjs"]), null);
  assert.equal(baseTaskId("T-14.a2"), "T-14");
  assert.equal(baseTaskId("T-14"), "T-14");
});

// ---------- the gate ----------
test("full loop: define → fails first → Jev review → approve → worktree pass → diff review → merge → integration pass → task.done", async () => {
  const fx = await fixture();
  const ledger = fakeLedger();
  const gate = createTestGate({ ledger, timeoutMs: 30_000 });
  try {
    const defined = await gate.defineTest("T-1", "node check.mjs", owner, { refs: ["P-1 §3.1"] });
    assert.equal(defined.type, "test.defined");
    assert.deepEqual(commandFromEntry(defined), ["node", "check.mjs"]);
    assert.deepEqual(defined.refs, ["P-1 §3.1"]);
    await assert.rejects(gate.approveTest("T-1", owner), (e) => e.code === "TEST_NOT_CONFIRMED");
    await assert.rejects(gate.runInWorktree("T-1", fx.worktree), (e) => e.code === "TEST_NOT_APPROVED");

    const first = await gate.confirmFailsFirst("T-1", fx.before);
    assert.equal(first.failedFirst, true);
    assert.equal(first.entry.type, "test.failed");
    assert.equal(ev(first.entry, "phase"), "fails-first");
    assert.equal(ev(first.entry, "exit"), "3");
    assert.equal(ev(first.entry, "definition"), defined.n);
    assert.match(first.result.outputTail, /not done yet/);

    await assert.rejects(gate.approveTest("T-1", owner), (e) => e.code === "TEST_JEV_VERDICT_REQUIRED", "Jev review is mandatory");
    const review = await jevReview(ledger, "T-1", { confidence: 0.82 });
    const approved = await gate.approveTest("T-1", owner, { jevVerdict: { entry: review.n } });
    assert.equal(approved.type, "test.approved");
    assert.ok(approved.evidence.includes(`fails-first:${first.entry.n}`));
    assert.ok(approved.evidence.includes(`jev-verdict:${review.n}`));
    assert.ok(approved.evidence.includes("jev-confidence:0.82"));
    assert.ok(approved.evidence.includes(`jev-model:${JEV.model}`));
    await assert.rejects(gate.afterMerge("T-1", fx.integration), (e) => e.code === "TEST_WORKTREE_NOT_PASSED");

    await assert.rejects(gate.runInWorktree("T-1", fx.worktree), (e) => e.code === "TEST_WORKTREE_UNKNOWN");
    await worktreeCreated(ledger, "T-1", fx.worktree);
    await assert.rejects(gate.runInWorktree("T-1", fx.integration), (e) => e.code === "TEST_WORKTREE_MISMATCH");
    const run = await gate.runInWorktree("T-1", fx.worktree);
    assert.equal(run.passed, true);
    assert.equal(run.entry.type, "test.passed");
    assert.equal(run.entry.actor, TESTGATE_ACTOR, "Perfect Planner runs the test itself");
    for (const key of ["exit", "duration-ms", "output-sha256", "output-bytes", "timed-out"]) assert.ok(ev(run.entry, key) !== undefined, key);
    assert.match(ev(run.entry, "output-sha256"), /^[0-9a-f]{64}$/);

    await assert.rejects(gate.afterMerge("T-1", fx.integration), (e) => e.code === "TEST_DIFF_NOT_REVIEWED");
    const diff = await jevReview(ledger, "T-1", { phase: "diff" });
    await assert.rejects(gate.afterMerge("T-1", fx.integration), (e) => e.code === "TEST_NOT_MERGED");
    const merge = await mergeDone(ledger, "T-1");
    await commitObserved(ledger, "T-1", "merge-commit"); // the merge commit itself, observed after merge.done
    const merged = await gate.afterMerge("T-1", fx.integration);
    assert.equal(merged.passed, true);
    assert.equal(merged.done.type, "task.done");
    for (const item of [`test-passed:${merged.entry.n}`, `approved:${approved.n}`, `worktree-passed:${run.entry.n}`, `merge:${merge.n}`, `diff-review:${diff.n}`]) assert.ok(merged.done.evidence.includes(item), item);
    assert.deepEqual(ledger.entries().map((e) => e.type), ["test.defined", "test.failed", "review.verdict", "test.approved", "worktree.created", "test.passed", "review.verdict", "merge.done", "commit.observed", "test.passed", "task.done"]);
    assert.ok(gate.state("T-1").done);
    await assert.rejects(gate.afterMerge("T-1", fx.integration), (e) => e.code === "TEST_TASK_DONE");
    await assert.rejects(gate.defineTest("T-1", "node check.mjs", owner), (e) => e.code === "TEST_TASK_DONE");
  } finally { await fx.cleanup(); }
});

test("a test that passes before any work cannot be approved (TEST_NOT_FAILING)", async () => {
  const fx = await fixture();
  const gate = createTestGate({ ledger: fakeLedger(), timeoutMs: 30_000 });
  try {
    await gate.defineTest("T-2", ["node", "check.mjs"], owner);
    const first = await gate.confirmFailsFirst("T-2", fx.worktree);
    assert.equal(first.passed, true);
    assert.equal(first.failedFirst, false);
    await assert.rejects(gate.approveTest("T-2", owner), (e) => e.code === "TEST_NOT_FAILING");
    // A trivially-true command is refused the same way.
    await gate.defineTest("T-2", ["node", "-e", "process.exit(0)"], owner);
    await gate.confirmFailsFirst("T-2", fx.before);
    await assert.rejects(gate.approveTest("T-2", owner), (e) => e.code === "TEST_NOT_FAILING");
  } finally { await fx.cleanup(); }
});

test("an unrunnable or hanging test does not count as failing first", async () => {
  const fx = await fixture();
  const gate = createTestGate({ ledger: fakeLedger() });
  try {
    await gate.defineTest("T-3", "no-such-tool-xyz --run", owner);
    const missing = await gate.confirmFailsFirst("T-3", fx.before);
    assert.equal(missing.failedFirst, false);
    assert.equal(ev(missing.entry, "error"), "TEST_COMMAND_NOT_FOUND");
    await assert.rejects(gate.approveTest("T-3", owner), (e) => e.code === "TEST_FAILS_FIRST_INVALID");
    await gate.defineTest("T-3", ["node", "-e", "setInterval(()=>{},1000)"], owner);
    const hung = await gate.confirmFailsFirst("T-3", fx.before, { timeoutMs: 800 });
    assert.equal(ev(hung.entry, "timed-out"), "true");
    await assert.rejects(gate.approveTest("T-3", owner), (e) => e.code === "TEST_FAILS_FIRST_INVALID");
  } finally { await fx.cleanup(); }
});

test("a failing worktree run records test.failed with evidence and blocks the merge rerun", async () => {
  const fx = await fixture();
  const ledger = fakeLedger();
  const gate = createTestGate({ ledger, timeoutMs: 30_000 });
  try {
    await gate.defineTest("T-4", "node check.mjs", owner);
    await gate.confirmFailsFirst("T-4", fx.before);
    await approveWithJev(gate, ledger, "T-4");
    await worktreeCreated(ledger, "T-4", fx.before);
    const run = await gate.runInWorktree("T-4", fx.before);
    assert.equal(run.passed, false);
    assert.equal(run.entry.type, "test.failed");
    assert.equal(ev(run.entry, "exit"), "3");
    assert.equal(ev(run.entry, "phase"), "worktree");
    await reviewAndMerge(ledger, "T-4");
    await assert.rejects(gate.afterMerge("T-4", fx.integration), (e) => e.code === "TEST_WORKTREE_NOT_PASSED");
  } finally { await fx.cleanup(); }
});

test("a failing integration rerun never writes task.done; a ledger refusal propagates", async () => {
  const fx = await fixture();
  try {
    const ledger = fakeLedger();
    const gate = createTestGate({ ledger, timeoutMs: 30_000 });
    await gate.defineTest("T-5", "node check.mjs", owner);
    await gate.confirmFailsFirst("T-5", fx.before);
    await approveWithJev(gate, ledger, "T-5");
    await worktreeCreated(ledger, "T-5", fx.worktree);
    await gate.runInWorktree("T-5", fx.worktree);
    await reviewAndMerge(ledger, "T-5");
    const merged = await gate.afterMerge("T-5", fx.before);
    assert.equal(merged.passed, false);
    assert.equal(merged.done, null);
    assert.equal(ledger.entries().some((e) => e.type === "task.done"), false);

    const strict = fakeLedger({ refuseDone: true });
    const gate2 = createTestGate({ ledger: strict, timeoutMs: 30_000 });
    await gate2.defineTest("T-6", "node check.mjs", owner);
    await gate2.confirmFailsFirst("T-6", fx.before);
    await approveWithJev(gate2, strict, "T-6");
    await worktreeCreated(strict, "T-6", fx.worktree);
    await gate2.runInWorktree("T-6", fx.worktree);
    await reviewAndMerge(strict, "T-6");
    await assert.rejects(gate2.afterMerge("T-6", fx.integration), (e) => e.code === "LEDGER_RULE");
  } finally { await fx.cleanup(); }
});

test("approval rules: only a person or system approves, Jev rejection blocks, redefinition voids approval", async () => {
  const fx = await fixture();
  const ledger = fakeLedger();
  const gate = createTestGate({ ledger, timeoutMs: 30_000 });
  try {
    await gate.defineTest("T-7", "node check.mjs", agent);
    await gate.confirmFailsFirst("T-7", fx.before);
    const good = await jevReview(ledger, "T-7");
    await assert.rejects(gate.approveTest("T-7", agent, { jevVerdict: { entry: good.n } }), (e) => e.code === "TEST_APPROVER_REFUSED");
    await assert.rejects(gate.approveTest("T-7", JEV, { jevVerdict: { entry: good.n } }), (e) => e.code === "TEST_APPROVER_REFUSED", "Jev reviews, it never approves");
    const rejected = await jevReview(ledger, "T-7", { verdict: "reject", reason: "does not cover §3.2", confidence: 1 });
    await assert.rejects(gate.approveTest("T-7", owner, { jevVerdict: { entry: rejected.n } }), (e) => e.code === "TEST_JEV_REJECTED" && /§3\.2/.test(e.message));
    await gate.approveTest("T-7", owner, { jevVerdict: { entry: good.n } });
    await assert.rejects(gate.approveTest("T-7", owner, { jevVerdict: { entry: good.n } }), (e) => e.code === "TEST_ALREADY_APPROVED");
    await assert.rejects(gate.confirmFailsFirst("T-7", fx.before), (e) => e.code === "TEST_ALREADY_APPROVED");
    await gate.defineTest("T-7", "node check.mjs --strict", owner);
    assert.equal(gate.state("T-7").approved, null);
    await assert.rejects(gate.runInWorktree("T-7", fx.worktree), (e) => e.code === "TEST_NOT_APPROVED");
  } finally { await fx.cleanup(); }
});

test("the Jev verdict must be a real, current, confident Jev test review; otherwise the owner overrides with a reason", async () => {
  const fx = await fixture();
  const ledger = fakeLedger();
  const gate = createTestGate({ ledger, timeoutMs: 30_000 });
  try {
    await gate.defineTest("T-10", "node check.mjs", owner);
    const stale = await jevReview(ledger, "T-10"); // reviews the first definition
    await gate.defineTest("T-10", "node check.mjs --v2", owner);
    await gate.confirmFailsFirst("T-10", fx.before);
    await assert.rejects(gate.approveTest("T-10", owner, { jevVerdict: { verdict: "approve" } }), (e) => e.code === "TEST_JEV_VERDICT_INVALID", "a bare object is not a verdict");
    await assert.rejects(gate.approveTest("T-10", owner, { jevVerdict: { entry: "L-999999" } }), (e) => e.code === "TEST_JEV_VERDICT_INVALID", "unknown entry");
    await assert.rejects(gate.approveTest("T-10", owner, { jevVerdict: { entry: stale.n } }), (e) => e.code === "TEST_JEV_VERDICT_STALE");
    const forged = await ledger.append({ actor: agent, type: "review.verdict", subject: "T-10", summary: "fake approve", evidence: ["phase:test", "verdict:approve", "confidence:1"] });
    await assert.rejects(gate.approveTest("T-10", owner, { jevVerdict: { entry: forged.n } }), (e) => e.code === "TEST_JEV_VERDICT_INVALID", "only Jev's own review counts");
    const otherTask = await jevReview(ledger, "T-11");
    await assert.rejects(gate.approveTest("T-10", owner, { jevVerdict: { entry: otherTask.n } }), (e) => e.code === "TEST_JEV_VERDICT_INVALID");
    const diffPhase = await jevReview(ledger, "T-10", { phase: "diff" });
    await assert.rejects(gate.approveTest("T-10", owner, { jevVerdict: { entry: diffPhase.n } }), (e) => e.code === "TEST_JEV_VERDICT_INVALID");
    const unsure = await jevReview(ledger, "T-10", { confidence: 0.4 });
    await assert.rejects(gate.approveTest("T-10", owner, { jevVerdict: { entry: unsure.n } }), (e) => e.code === "TEST_JEV_LOW_CONFIDENCE");
    const noConfidence = await jevReview(ledger, "T-10", { confidence: null });
    await assert.rejects(gate.approveTest("T-10", owner, { jevVerdict: noConfidence.n }), (e) => e.code === "TEST_JEV_LOW_CONFIDENCE");
    // Owner override: person only, reason required, recorded.
    await assert.rejects(gate.approveTest("T-10", { kind: "system", id: "auto" }, { override: { reason: "x" } }), (e) => e.code === "TEST_OVERRIDE_REFUSED");
    await assert.rejects(gate.approveTest("T-10", owner, { override: {} }), (e) => e.code === "TEST_OVERRIDE_REASON_REQUIRED");
    await assert.rejects(gate.approveTest("T-10", owner, { override: { reason: "  " } }), (e) => e.code === "TEST_OVERRIDE_REASON_REQUIRED");
    const approved = await gate.approveTest("T-10", owner, { override: { reason: "Jev was unsure; I checked the test covers §2 myself" } });
    assert.ok(approved.evidence.includes("jev-override:owner"));
    assert.match(approved.reason, /covers §2/);
    // A stricter threshold is configurable.
    assert.throws(() => createTestGate({ ledger, minJevConfidence: 2 }), (e) => e.code === "TEST_CONFIG_INVALID");
  } finally { await fx.cleanup(); }
});

test("only Perfect Planner's own runs count: forged test.failed / test.passed / test.approved entries are ignored", async () => {
  const fx = await fixture();
  const ledger = fakeLedger();
  const gate = createTestGate({ ledger, timeoutMs: 30_000 });
  try {
    const defined = await gate.defineTest("T-12", ["node", "-e", "process.exit(0)"], owner); // trivially passing
    const forgedFail = await ledger.append({ actor: agent, type: "test.failed", subject: "T-12", summary: "forged fails-first", evidence: ["phase:fails-first", `definition:${defined.n}`, "exit:1", "fails-first-eligible:true"] });
    assert.equal(gate.state("T-12").failsFirst, null);
    const review = await jevReview(ledger, "T-12");
    await assert.rejects(gate.approveTest("T-12", owner, { jevVerdict: { entry: review.n } }), (e) => e.code === "TEST_NOT_CONFIRMED", `forged ${forgedFail.n} must not count`);
    await ledger.append({ actor: { kind: "system", id: "someone-else" }, type: "test.failed", subject: "T-12", summary: "other system", evidence: ["phase:fails-first", `definition:${defined.n}`, "fails-first-eligible:true"] });
    assert.equal(gate.state("T-12").failsFirst, null, "a different system actor is not the test gate");
    await ledger.append({ actor: JEV, type: "review.verdict", subject: "T-12", summary: "x", evidence: ["phase:test"] });

    // A fresh, honest task: forged worktree pass does not open afterMerge; forged approval does not count.
    await gate.defineTest("T-13", "node check.mjs", owner);
    const d13 = gate.state("T-13").definition.n;
    await ledger.append({ actor: agent, type: "test.approved", subject: "T-13", summary: "self-approved", evidence: [`definition:${d13}`] });
    assert.equal(gate.state("T-13").approved, null, "an agent-written approval is ignored");
    await gate.confirmFailsFirst("T-13", fx.before);
    await approveWithJev(gate, ledger, "T-13");
    await ledger.append({ actor: agent, type: "test.passed", subject: "T-13", summary: "trust me", evidence: ["phase:worktree", `definition:${d13}`, "exit:0"] });
    await reviewAndMerge(ledger, "T-13");
    await assert.rejects(gate.afterMerge("T-13", fx.integration), (e) => e.code === "TEST_WORKTREE_NOT_PASSED");
  } finally { await fx.cleanup(); }
});

test("a commit after the worktree pass voids it (and the diff review) until the test passes again", async () => {
  const fx = await fixture();
  const ledger = fakeLedger();
  const gate = createTestGate({ ledger, timeoutMs: 30_000 });
  try {
    await gate.defineTest("T-14", "node check.mjs", owner);
    await gate.confirmFailsFirst("T-14", fx.before);
    await approveWithJev(gate, ledger, "T-14");
    await worktreeCreated(ledger, "T-14", fx.worktree);
    await gate.runInWorktree("T-14", fx.worktree);
    await jevReview(ledger, "T-14", { phase: "diff" });
    await commitObserved(ledger, "T-14", "untested");
    assert.equal(gate.state("T-14").lastWorktreeRun, null);
    assert.equal(gate.state("T-14").diffReview, null);
    await mergeDone(ledger, "T-14");
    await assert.rejects(gate.afterMerge("T-14", fx.integration), (e) => e.code === "TEST_WORKTREE_NOT_PASSED");
    // Rerun, re-review, re-merge: now it may finish.
    await gate.runInWorktree("T-14", fx.worktree);
    await assert.rejects(gate.afterMerge("T-14", fx.integration), (e) => e.code === "TEST_DIFF_NOT_REVIEWED");
    await jevReview(ledger, "T-14", { phase: "diff", verdict: "reject" });
    await assert.rejects(gate.afterMerge("T-14", fx.integration), (e) => e.code === "TEST_DIFF_NOT_REVIEWED", "a rejecting diff review does not count");
    await jevReview(ledger, "T-14", { phase: "diff", confidence: 0.3 });
    await assert.rejects(gate.afterMerge("T-14", fx.integration), (e) => e.code === "TEST_DIFF_NOT_REVIEWED", "a low-confidence Jev approval goes to the owner");
    await ledger.append({ actor: owner, type: "review.verdict", subject: "T-14", summary: "owner reviewed the diff", evidence: ["phase:diff", "verdict:approve"] });
    await assert.rejects(gate.afterMerge("T-14", fx.integration), (e) => e.code === "TEST_NOT_MERGED", "the earlier merge predates this worktree pass");
    await mergeDone(ledger, "T-14");
    const merged = await gate.afterMerge("T-14", fx.integration);
    assert.equal(merged.done.type, "task.done");
  } finally { await fx.cleanup(); }
});

test("corrections from a person or system remove the corrected entry from the derived state", async () => {
  const fx = await fixture();
  const ledger = fakeLedger();
  const gate = createTestGate({ ledger, timeoutMs: 30_000 });
  try {
    await gate.defineTest("T-15", "node check.mjs", owner);
    await gate.confirmFailsFirst("T-15", fx.before);
    const approved = await approveWithJev(gate, ledger, "T-15");
    await worktreeCreated(ledger, "T-15", fx.worktree);
    const { entry: pass } = await gate.runInWorktree("T-15", fx.worktree);
    // An agent cannot void evidence.
    await ledger.append({ actor: agent, type: "correction", subject: approved.n, corrects: approved.n, summary: "nope", reason: "agent tries" });
    assert.ok(gate.state("T-15").approved);
    // The worktree pass is corrected: afterMerge refuses.
    await ledger.append({ actor: owner, type: "correction", subject: pass.n, corrects: pass.n, summary: "wrong checkout", reason: "run was against a stale checkout" });
    assert.equal(gate.state("T-15").lastWorktreeRun, null);
    await reviewAndMerge(ledger, "T-15");
    await assert.rejects(gate.afterMerge("T-15", fx.integration), (e) => e.code === "TEST_WORKTREE_NOT_PASSED");
    // The approval is corrected: runs are refused until re-approved.
    await ledger.append({ actor: owner, type: "correction", subject: approved.n, corrects: approved.n, summary: "approved by mistake", reason: "wrong test" });
    assert.equal(gate.state("T-15").approved, null);
    await assert.rejects(gate.runInWorktree("T-15", fx.worktree), (e) => e.code === "TEST_NOT_APPROVED");
    // A corrected redefinition falls back to the previous definition.
    const redefined = await gate.defineTest("T-15", "node other.mjs", owner);
    assert.deepEqual(gate.state("T-15").command, ["node", "other.mjs"]);
    await ledger.append({ actor: owner, type: "correction", subject: redefined.n, corrects: redefined.n, summary: "typo", reason: "redefined by mistake" });
    assert.deepEqual(gate.state("T-15").command, ["node", "check.mjs"]);
    // A corrected Jev review cannot be cited.
    await gate.defineTest("T-16", "node check.mjs", owner);
    await gate.confirmFailsFirst("T-16", fx.before);
    const review = await jevReview(ledger, "T-16");
    await ledger.append({ actor: owner, type: "correction", subject: review.n, corrects: review.n, summary: "bad review", reason: "reviewed the wrong file" });
    await assert.rejects(gate.approveTest("T-16", owner, { jevVerdict: { entry: review.n } }), (e) => e.code === "TEST_JEV_VERDICT_INVALID");
  } finally { await fx.cleanup(); }
});

test("attempt subjects (T-n.aK) belong to the same task as T-n, as in core/mcp and the ledger", async () => {
  const fx = await fixture();
  const ledger = fakeLedger();
  const gate = createTestGate({ ledger, timeoutMs: 30_000 });
  try {
    await gate.defineTest("T-17", "node check.mjs", owner);
    await gate.confirmFailsFirst("T-17", fx.before);
    await approveWithJev(gate, ledger, "T-17");
    assert.ok(gate.state("T-17.a2").approved, "approval written under T-17 is visible to attempt T-17.a2");
    await worktreeCreated(ledger, "T-17", fx.worktree);
    await gate.runInWorktree("T-17", fx.worktree);
    await reviewAndMerge(ledger, "T-17");
    const merged = await gate.afterMerge("T-17", fx.integration);
    assert.ok(merged.done);
    await ledger.append({ actor: owner, type: "task.reopened", subject: "T-17", summary: "regression", reason: "bug found" });
    const s = gate.state("T-17.a2");
    assert.equal(s.done, null);
    assert.ok(s.approved, "approval survives reopen (ledger keeps it too)");
    assert.equal(s.lastWorktreeRun, null);
    await worktreeCreated(ledger, "T-17.a2", fx.worktree);
    const rerun = await gate.runInWorktree("T-17.a2", fx.worktree);
    assert.equal(rerun.entry.subject, "T-17.a2");
    assert.ok(gate.state("T-17").lastWorktreeRun, "attempt run is visible from the base id");
  } finally { await fx.cleanup(); }
});

test("worktree path must be the task's recorded worktree; relative paths resolve against repoRoot", async () => {
  const fx = await fixture();
  const ledger = fakeLedger();
  const runner = async () => ({ exitCode: 0, signal: null, timedOut: false, durationMs: 1, outputBytes: 0, outputSha256: "0".repeat(64), truncated: false, error: null, cleanupComplete: true });
  try {
    const noRoot = createTestGate({ ledger, runner });
    await noRoot.defineTest("T-18", "node a", owner);
    await ledger.append({ actor: TESTGATE_ACTOR, type: "test.failed", subject: "T-18", summary: "ff", evidence: ["phase:fails-first", `definition:${noRoot.state("T-18").definition.n}`, "exit:1", "fails-first-eligible:true"] });
    await approveWithJev(noRoot, ledger, "T-18");
    await worktreeCreated(ledger, "T-18", ".perfect-planner/worktrees/T-18");
    const expected = path.join(fx.root, ".perfect-planner", "worktrees", "T-18");
    await assert.rejects(noRoot.runInWorktree("T-18", expected), (e) => e.code === "TEST_REPO_ROOT_REQUIRED");
    const gate = createTestGate({ ledger, runner, repoRoot: fx.root });
    await assert.rejects(gate.runInWorktree("T-18", path.join(fx.root, "elsewhere")), (e) => e.code === "TEST_WORKTREE_MISMATCH");
    assert.equal((await gate.runInWorktree("T-18", expected + path.sep)).passed, true, "trailing separator is the same path");
    await ledger.append({ actor: TESTGATE_ACTOR, type: "worktree.removed", subject: "T-18", summary: "removed" });
    await assert.rejects(gate.runInWorktree("T-18", expected), (e) => e.code === "TEST_WORKTREE_UNKNOWN");
  } finally { await fx.cleanup(); }
});

test("a run that leaves processes behind (cleanup-complete:false) is never a pass and never a clean fail", async () => {
  const ledger = fakeLedger();
  let next = { exitCode: 0, cleanupComplete: false };
  const runner = async () => ({ signal: null, timedOut: false, durationMs: 1, outputBytes: 0, outputSha256: "0".repeat(64), truncated: false, error: null, ...next });
  const gate = createTestGate({ ledger, runner });
  await gate.defineTest("T-19", "node a", owner);
  next = { exitCode: 1, cleanupComplete: false };
  const first = await gate.confirmFailsFirst("T-19", os.tmpdir());
  assert.equal(first.failedFirst, false);
  assert.ok(first.entry.evidence.includes("cleanup-complete:false"));
  await gate.defineTest("T-19", "node a --x", owner);
  next = { exitCode: 1, cleanupComplete: true };
  await gate.confirmFailsFirst("T-19", os.tmpdir());
  await approveWithJev(gate, ledger, "T-19");
  await worktreeCreated(ledger, "T-19", os.tmpdir());
  next = { exitCode: 0, cleanupComplete: false };
  const run = await gate.runInWorktree("T-19", os.tmpdir());
  assert.equal(run.passed, false);
  assert.equal(run.entry.type, "test.failed");
  assert.match(run.entry.summary, /left processes running/);
});

test("secret-looking test command arguments are refused before they reach the ledger", async () => {
  const ledger = fakeLedger();
  const gate = createTestGate({ ledger, runner: async () => ({}) });
  for (const bad of [["node", "t.mjs", "--token=abc123"], ["node", "t.mjs", "--api-key", "x"], ["npx", "x", "GITHUB_TOKEN=abc"], ["node", "t.mjs", "https://user:pw@db.example/x"], ["node", "t.mjs", "ghp_abcdefghijklmnopqrstuvwxyz0123"], "node t.mjs --password hunter2"]) {
    await assert.rejects(gate.defineTest("T-20", bad, owner), (e) => e.code === "TEST_COMMAND_SECRET", JSON.stringify(bad));
  }
  await assert.rejects(gate.defineTest("T-20", "node t.mjs", owner, { note: "--token=abc" }), (e) => e.code === "TEST_COMMAND_SECRET");
  assert.equal(ledger.entries().length, 0, "nothing written");
  for (const ok of [["node", "--test", "tests/auth.test.mjs"], ["npm", "test", "--", "--author", "me"], ["node", "--test-name-pattern=token refresh", "t.mjs"], ["node", "t.mjs", "--no-auth"]]) {
    await gate.defineTest("T-20", ok, owner);
    assert.equal(findSecretArgument(ok), null, JSON.stringify(ok));
  }
});

test("input validation and single in-flight run per task", async () => {
  let release;
  const runner = () => new Promise((resolve) => { release = () => resolve({ exitCode: 1, signal: null, timedOut: false, durationMs: 5, outputTail: "", outputBytes: 0, outputSha256: "0".repeat(64), truncated: false, error: null }); });
  const gate = createTestGate({ ledger: fakeLedger(), runner });
  await assert.rejects(gate.defineTest("X-1", "node a", owner), (e) => e.code === "TEST_TASK_INVALID");
  await assert.rejects(gate.defineTest("T-1", "node a", { kind: "robot", id: "r" }), (e) => e.code === "TEST_ACTOR_INVALID");
  await assert.rejects(gate.defineTest("T-1", "node a && b", owner), (e) => e.code === "TEST_COMMAND_INVALID");
  await assert.rejects(gate.confirmFailsFirst("T-1", os.tmpdir()), (e) => e.code === "TEST_NOT_DEFINED");
  await gate.defineTest("T-1.a2", "node a", owner);
  const pending = gate.confirmFailsFirst("T-1.a2", os.tmpdir());
  await assert.rejects(gate.confirmFailsFirst("T-1.a2", os.tmpdir()), (e) => e.code === "TEST_RUN_IN_PROGRESS");
  release();
  assert.equal((await pending).failedFirst, true);
  assert.throws(() => createTestGate({}), (e) => e.code === "TEST_LEDGER_REQUIRED");
});

test("testGateState ignores runs bound to an older definition and resets on reopen", () => {
  const e = (n, type, evidence = [], subject = "T-9") => ({ n, type, subject, evidence, actor: type.startsWith("test.") && type !== "test.defined" && type !== "test.approved" ? TESTGATE_ACTOR : { kind: "person", id: "owner" } });
  const entries = [
    e("L-000001", "test.defined", ['command:["node","a"]']),
    e("L-000002", "test.failed", ["phase:fails-first", "definition:L-000001", "fails-first-eligible:true"]),
    e("L-000003", "test.defined", ['command:["node","b"]']),
    e("L-000004", "test.approved", ["definition:L-000001"]),
    e("L-000005", "test.passed", ["phase:worktree", "definition:L-000003"], "T-8"),
  ];
  const s = testGateState(entries, "T-9");
  assert.deepEqual(s.command, ["node", "b"]);
  assert.equal(s.failsFirst, null);
  assert.equal(s.approved, null, "approval of an older definition does not carry over");
  assert.ok(testGateState([e("L-1", "test.defined", ['command:["node","a"]']), e("L-2", "test.passed", ["phase:worktree", "definition:L-1"])], "T-9").lastWorktreeRun, "the gate's own worktree pass counts before the reopen");
  const reopened = testGateState([
    e("L-1", "test.defined", ['command:["node","a"]']), e("L-2", "test.passed", ["phase:worktree", "definition:L-1"]),
    e("L-3", "task.done"), e("L-4", "task.reopened"),
  ], "T-9");
  assert.equal(reopened.done, null);
  assert.equal(reopened.lastWorktreeRun, null);
  assert.equal(commandFromEntry({ evidence: ["command:not json"] }), null);
  assert.ok(existsSync(os.tmpdir()));
});
