import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyLocalPush, runBoundedCommand, inspectLocalPushCommandContract } from "../scripts/verify-local-push.mjs";

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t, mode = "pass") {
  const base = await mkdtemp(path.join(tmpdir(), "pp-local-push-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  const npmRoot = path.join(base, "fixture-npm");
  const npmCliPath = path.join(npmRoot, "bin", "npm-cli.js");
  await mkdir(root);
  await mkdir(path.dirname(npmCliPath), { recursive: true });
  await writeFile(path.join(npmRoot, "package.json"), JSON.stringify({ name: "npm", type: "module" }));
  // This isolated script driver substitutes for npm only in these temporary test fixtures.
  await writeFile(npmCliPath, `import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const mode = JSON.parse(readFileSync('package.json')).pushFixtureMode;
if (mode === 'dirty') writeFileSync('untracked-after-build.txt', 'changed');
if (mode === 'head-change') spawnSync('git', ['commit', '--allow-empty', '-m', 'during build']);
process.stdout.write('fixture command: ' + process.argv.slice(2).join(' '));
if (mode === 'fail') { process.stderr.write('ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'); process.exitCode = 2; }
`);
  git(root, ["init"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "push-test", pushFixtureMode: mode }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ name: "push-test", lockfileVersion: 3 }));
  await writeFile(path.join(root, "source.js"), "export const ready = true;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const input = `refs/heads/main ${head} refs/heads/main ${"0".repeat(40)}\n`;
  const contract = await inspectLocalPushCommandContract(root);
  const commandApprovalPath = path.join(base, "approved-command-contract.json");
  await writeFile(commandApprovalPath, JSON.stringify({ schemaVersion: 1, kind: "perfect-planner-local-push-command-approval", contractDigest: contract.contractDigest, approvedBy: "fixture-reviewer", approvedAt: "2026-09-05T00:00:00.000Z" }));
  return { base, root, npmCliPath, head, input, commandApprovalPath };
}

test("local push proof verifies the proposed HEAD through scanner, build, core, and UI commands", async (t) => {
  const f = await fixture(t);
  const proof = await verifyLocalPush(f);
  assert.equal(proof.state, "passed", JSON.stringify(proof));
  assert.equal(proof.head, f.head);
  assert.deepEqual(proof.checks.map((check) => check.name), ["outgoing-secrets", "build", "tests", "ui-tests"]);
  for (const check of proof.checks) assert.match(check.outputHash, /^[a-f0-9]{64}$/);
  assert.equal(proof.malwareVerdict, "not-assessed");
  assert.equal(proof.productionVerdict, "not-assessed");
  assert.equal(JSON.stringify(proof).includes("fixture command:"), false);
});

test("local push guard refuses dirty and untracked changes before executing any checks", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "private-untracked.txt"), "untracked");
  const proof = await verifyLocalPush(f);
  assert.equal(proof.reason, "checkout-is-dirty");
  assert.equal(proof.checks.length, 0);
  await rm(path.join(f.root, "private-untracked.txt"));
  await writeFile(path.join(f.root, "source.js"), "modified");
  assert.equal((await verifyLocalPush(f)).reason, "checkout-is-dirty");
});

test("local push guard refuses another outgoing commit even among multiple proposed refs", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "next.js"), "next"); git(f.root, ["add", "."]); git(f.root, ["commit", "-m", "next"]);
  const current = git(f.root, ["rev-parse", "HEAD"]);
  const input = `refs/heads/main ${current} refs/heads/main ${"0".repeat(40)}\n${f.input}`;
  const proof = await verifyLocalPush({ ...f, input });
  assert.equal(proof.reason, "proposed-ref-does-not-resolve-to-head");
  assert.equal(proof.checks.length, 0);
});

test("command execution requires an external exact approval and fails closed on manifest drift", async (t) => {
  const f = await fixture(t);
  assert.equal((await verifyLocalPush({ ...f, commandApprovalPath: null })).reason, "external-command-approval-required");
  await writeFile(path.join(f.root, "package.json"), JSON.stringify({ name: "push-test", pushFixtureMode: "pass", scripts: { build: "exit 0", test: "exit 0", "test:ui": "exit 0" } }));
  git(f.root, ["add", "."]); git(f.root, ["commit", "-m", "change command definitions"]);
  const head = git(f.root, ["rev-parse", "HEAD"]);
  const proof = await verifyLocalPush({ ...f, head, input: `refs/heads/main ${head} refs/heads/main ${f.head}\n` });
  assert.equal(proof.reason, "command-approval-drift");
  assert.equal(proof.checks.length, 0);
});

test("an annotated tag resolving to exact HEAD is accepted and its object reaches the scanner", async (t) => {
  const f = await fixture(t);
  git(f.root, ["tag", "-a", "reviewed", "-m", "safe tag"]);
  const tag = git(f.root, ["rev-parse", "reviewed"]);
  const proof = await verifyLocalPush({ ...f, input: `refs/tags/reviewed ${tag} refs/tags/reviewed ${"0".repeat(40)}\n` });
  assert.equal(proof.state, "passed", JSON.stringify(proof));
});

test("a build that dirties the checkout invalidates proof before later tests run", async (t) => {
  const f = await fixture(t, "dirty");
  const proof = await verifyLocalPush(f);
  assert.equal(proof.state, "blocked");
  assert.equal(proof.reason, "checkout-is-dirty");
  assert.deepEqual(proof.checks.map((check) => check.name), ["outgoing-secrets", "build"]);
});

test("failed checks stop the chain and never return command output credentials", async (t) => {
  const f = await fixture(t, "fail");
  const proof = await verifyLocalPush(f);
  assert.equal(proof.reason, "build-failed");
  assert.equal(proof.checks.at(-1).exitCode, 2);
  assert.equal(JSON.stringify(proof).includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"), false);
});

test("changing HEAD during a successful command invalidates the original commit proof", async (t) => {
  const f = await fixture(t, "head-change");
  const proof = await verifyLocalPush(f);
  assert.equal(proof.reason, "head-changed-during-proof");
  assert.equal(proof.head, f.head);
  assert.equal(proof.checks.length, 2);
});

test("secrets in outgoing commits block execution of build and tests", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "source.js"), "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
  git(f.root, ["add", "."]); git(f.root, ["commit", "-m", "synthetic leak"]);
  const head = git(f.root, ["rev-parse", "HEAD"]);
  const proof = await verifyLocalPush({ ...f, input: `refs/heads/main ${head} refs/heads/main ${f.head}\n` });
  assert.equal(proof.reason, "outgoing-secrets-failed");
  assert.equal(proof.checks.length, 1);
  assert.equal(JSON.stringify(proof).includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"), false);
});

test("missing npm, malformed refs, and nested checkout invocation cannot produce passing proof", async (t) => {
  const f = await fixture(t);
  assert.equal((await verifyLocalPush({ ...f, npmCliPath: null })).reason, "npm-cli-unavailable-run-through-npm");
  assert.equal((await verifyLocalPush({ ...f, input: "invalid" })).reason, "invalid-push-refs");
  await mkdir(path.join(f.root, "nested"));
  assert.equal((await verifyLocalPush({ ...f, root: path.join(f.root, "nested") })).reason, "run-from-repository-root");
});

test("deletion-only pushes have no build proof and are explicitly not applicable", async (t) => {
  const f = await fixture(t);
  const proof = await verifyLocalPush({ ...f, input: `(delete) ${"0".repeat(40)} refs/heads/old ${f.head}\n` });
  assert.equal(proof.state, "not-applicable");
  assert.equal(proof.checks.length, 0);
});

test("command time and output limits stop execution without returning unbounded output", async (t) => {
  const f = await fixture(t);
  const timeout = await runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { root: f.root, timeoutMs: 100 });
  assert.equal(timeout.reason, "command-time-limit");
  const overflow = await runBoundedCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { root: f.root, timeoutMs: 2000, maxBytes: 128 });
  assert.equal(overflow.reason, "command-output-limit");
  assert.equal(overflow.outputComplete, false);
  assert.equal(overflow.stdout.length, 0);
});

test("Windows timeout ignores poisoned SystemRoot and kills the descendant tree", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.base, "descendant-survived.txt");
  const original = process.env.SystemRoot;
  process.env.SystemRoot = path.join(f.base, "poisoned-system-root");
  t.after(() => { if (original === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = original; });
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 700)`;
  const encoded = Buffer.from(descendant).toString("base64");
  const parent = `require('node:child_process').spawn(process.execPath,['-e',Buffer.from('${encoded}','base64').toString()],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const result = await runBoundedCommand(process.execPath, ["-e", parent], { root: f.root, timeoutMs: 100 });
  assert.equal(result.reason, "command-time-limit");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(await lstat(marker).then(() => true, () => false), false);
});
