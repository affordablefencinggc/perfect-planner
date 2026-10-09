import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, mkdir, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTestGate, testGateState, commandFromEntry, parseCommandString, normalizeCommand,
  resolveCommand, runTestCommand, scrubEnvironment, TESTGATE_ACTOR,
} from "../src/core/testgate/index.mjs";

// ---------- in-memory fake of the shared Ledger interface ----------
function fakeLedger({ refuseDone = false } = {}) {
  const list = [];
  const subs = new Set();
  const err = (code, message) => Object.assign(new Error(message), { code });
  return {
    async append({ actor, type, subject, summary, reason, evidence = [], refs = [], corrects = null }) {
      if (!actor || !type || !subject || typeof summary !== "string" || !summary.trim() || /\n/.test(summary) || summary === "TBD") throw err("LEDGER_RULE", "invalid entry");
      if (type === "task.done") {
        if (refuseDone) throw err("LEDGER_RULE", "refused by test");
        const mine = list.filter((e) => e.subject === subject);
        const lastCommit = mine.map((e) => e.type).lastIndexOf("commit.observed");
        const approvedAt = mine.map((e) => e.type).lastIndexOf("test.approved");
        const passAt = mine.map((e) => e.type).lastIndexOf("test.passed");
        if (approvedAt < 0 || passAt < Math.max(lastCommit, approvedAt)) throw err("LEDGER_RULE", "task.done needs test.passed after last commit");
      }
      const n = `L-${String(list.length + 1).padStart(6, "0")}`;
      const entry = Object.freeze({ n, at: new Date().toISOString(), actor, type, subject, summary, reason: reason ?? null, evidence: Object.freeze([...evidence]), refs: Object.freeze([...refs]), corrects, prev: null, hash: "0".repeat(64) });
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
    assert.equal(small.outputTail, "y\n".slice(-3).padStart(3, "n"));
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

// ---------- the gate ----------
test("full loop: define → fails first → approve → pass in worktree → pass after merge → task.done", async () => {
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

    const approved = await gate.approveTest("T-1", owner, { jevVerdict: { verdict: "approve", entry: "L-000099" } });
    assert.equal(approved.type, "test.approved");
    assert.ok(approved.evidence.includes(`fails-first:${first.entry.n}`));
    assert.ok(approved.evidence.includes("jev-verdict:L-000099"));
    await assert.rejects(gate.afterMerge("T-1", fx.integration), (e) => e.code === "TEST_WORKTREE_NOT_PASSED");

    const run = await gate.runInWorktree("T-1", fx.worktree);
    assert.equal(run.passed, true);
    assert.equal(run.entry.type, "test.passed");
    assert.equal(run.entry.actor, TESTGATE_ACTOR, "Perfect Planner runs the test itself");
    for (const key of ["exit", "duration-ms", "output-sha256", "output-bytes", "timed-out"]) assert.ok(ev(run.entry, key) !== undefined, key);
    assert.match(ev(run.entry, "output-sha256"), /^[0-9a-f]{64}$/);

    await ledger.append({ actor: TESTGATE_ACTOR, type: "commit.observed", subject: "T-1", summary: "merge commit" });
    const merged = await gate.afterMerge("T-1", fx.integration);
    assert.equal(merged.passed, true);
    assert.equal(merged.done.type, "task.done");
    assert.ok(merged.done.evidence.includes(`test-passed:${merged.entry.n}`));
    assert.deepEqual(ledger.entries().map((e) => e.type), ["test.defined", "test.failed", "test.approved", "test.passed", "commit.observed", "test.passed", "task.done"]);
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
    await gate.approveTest("T-4", owner);
    const run = await gate.runInWorktree("T-4", fx.before);
    assert.equal(run.passed, false);
    assert.equal(run.entry.type, "test.failed");
    assert.equal(ev(run.entry, "exit"), "3");
    assert.equal(ev(run.entry, "phase"), "worktree");
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
    await gate.approveTest("T-5", owner);
    await gate.runInWorktree("T-5", fx.worktree);
    const merged = await gate.afterMerge("T-5", fx.before);
    assert.equal(merged.passed, false);
    assert.equal(merged.done, null);
    assert.equal(ledger.entries().some((e) => e.type === "task.done"), false);

    const strict = fakeLedger({ refuseDone: true });
    const gate2 = createTestGate({ ledger: strict, timeoutMs: 30_000 });
    await gate2.defineTest("T-6", "node check.mjs", owner);
    await gate2.confirmFailsFirst("T-6", fx.before);
    await gate2.approveTest("T-6", owner);
    await gate2.runInWorktree("T-6", fx.worktree);
    await assert.rejects(gate2.afterMerge("T-6", fx.integration), (e) => e.code === "LEDGER_RULE");
  } finally { await fx.cleanup(); }
});

test("approval rules: agents cannot approve, Jev rejection blocks, redefinition voids approval", async () => {
  const fx = await fixture();
  const gate = createTestGate({ ledger: fakeLedger(), timeoutMs: 30_000 });
  try {
    await gate.defineTest("T-7", "node check.mjs", agent);
    await gate.confirmFailsFirst("T-7", fx.before);
    await assert.rejects(gate.approveTest("T-7", agent), (e) => e.code === "TEST_APPROVER_REFUSED");
    await assert.rejects(gate.approveTest("T-7", owner, { jevVerdict: { verdict: "reject", reason: "does not cover §3.2" } }), (e) => e.code === "TEST_JEV_REJECTED" && /§3\.2/.test(e.message));
    await gate.approveTest("T-7", owner);
    await assert.rejects(gate.approveTest("T-7", owner), (e) => e.code === "TEST_ALREADY_APPROVED");
    await assert.rejects(gate.confirmFailsFirst("T-7", fx.before), (e) => e.code === "TEST_ALREADY_APPROVED");
    await gate.defineTest("T-7", "node check.mjs --strict", owner);
    assert.equal(gate.state("T-7").approved, null);
    await assert.rejects(gate.runInWorktree("T-7", fx.worktree), (e) => e.code === "TEST_NOT_APPROVED");
  } finally { await fx.cleanup(); }
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
  const e = (n, type, evidence = [], subject = "T-9") => ({ n, type, subject, evidence });
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
  const reopened = testGateState([
    e("L-1", "test.defined", ['command:["node","a"]']), e("L-2", "test.passed", ["phase:worktree", "definition:L-1"]),
    e("L-3", "task.done"), e("L-4", "task.reopened"),
  ], "T-9");
  assert.equal(reopened.done, null);
  assert.equal(reopened.lastWorktreeRun, null);
  assert.equal(commandFromEntry({ evidence: ["command:not json"] }), null);
  assert.ok(existsSync(os.tmpdir()));
});
