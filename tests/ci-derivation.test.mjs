import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assessCiTier3, deriveCiPlan, fetchRemoteCiStatus } from "../src/node/ciDerivation.mjs";

async function fixture(workflows = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-ci-"));
  if (Object.keys(workflows).length) await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await Promise.all(Object.entries(workflows).map(([name, content]) => writeFile(path.join(root, ".github", "workflows", name), content)));
  return root;
}

test("no workflow directory is honest grey, never green", async () => {
  const result = await deriveCiPlan(await fixture());
  assert.equal(result.state, "grey");
  assert.match(result.reason, /no workflow directory/);
});

test("push-only workflows are not misrepresented as pull-request gates", async () => {
  const root = await fixture({ "push.yml": "name: Push\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    steps:\n      - run: npm test\n" });
  const result = await deriveCiPlan(root);
  assert.equal(result.state, "grey");
  assert.equal(result.gates.length, 0);
});

test("simple pull-request jobs derive explicit no-shell command candidates", async () => {
  const root = await fixture({ "ci.yml": "name: CI\non: pull_request\njobs:\n  test:\n    name: Tests\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n  advisory:\n    continue-on-error: true\n    steps:\n      - run: npm run lint\n" });
  const result = await deriveCiPlan(root);
  assert.equal(result.state, "derived");
  assert.equal(result.gates.length, 1);
  assert.deepEqual(result.gates[0].commands[0], { executable: "npm", args: ["test"], sourceLine: 8 });
});

test("shell composition and unknown executables force grey", async () => {
  const root = await fixture({ "ci.yaml": "on: pull_request\njobs:\n  test:\n    steps:\n      - run: npm ci && npm test\n      - run: curl https://example.invalid\n" });
  const result = await deriveCiPlan(root);
  assert.equal(result.state, "grey");
  assert.ok(result.gates[0].warnings.some((warning) => warning.includes("shell composition")));
  assert.ok(result.gates[0].warnings.some((warning) => warning.includes("unapproved executable")));
});

test("workflow symbolic links are refused", async (t) => {
  const root = await fixture();
  const directory = path.join(root, ".github", "workflows");
  await mkdir(directory, { recursive: true });
  const target = path.join(root, "outside-workflow-directory");
  await mkdir(target);
  try { await symlink(target, path.join(directory, "linked.yml"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Host policy prevents creating any link fixture"); return; } throw error; }
  await assert.rejects(() => deriveCiPlan(root), /refused symbolic link/);
});

const remoteRequest = { providerId: "fixture", repository: "owner/repo", targetRef: "refs/heads/main", sourceRef: "refs/heads/feature", targetSha: "a".repeat(40), sourceSha: "b".repeat(40), checkNames: ["test", "lint"], credentialHandle: "secret://ci/fixture" };
const remoteResponse = { ...remoteRequest, credentialHandle: undefined, checks: [{ name: "test", state: "success" }, { name: "lint", state: "success" }] };
const boundary = (capture = {}) => ({
  providers: [{ id: "fixture", origin: "https://ci.example.invalid", statusPath: "/v1/status" }],
  resolveCredential: async (identity) => { capture.identity = identity; return "transport-only-secret"; },
  fetchImpl: async (url, options) => { capture.url = url; capture.options = options; return { ok: true, status: 200, text: async () => JSON.stringify(remoteResponse) }; },
});

test("remote status binds exact HTTPS identities and redacts credentials outside transport", async () => {
  const capture = {}; const result = await fetchRemoteCiStatus(remoteRequest, boundary(capture));
  assert.equal(result.state, "green"); assert.equal(capture.url, "https://ci.example.invalid/v1/status");
  assert.equal(capture.options.redirect, "error");
  assert.equal(capture.options.headers.authorization, "Bearer transport-only-secret");
  assert.equal(JSON.parse(capture.options.body).credentialHandle, undefined);
  assert.equal(result.credential, "REDACTED"); assert.doesNotMatch(JSON.stringify(result), /transport-only-secret|secret:\/\//);
  assert.deepEqual(capture.identity, { handle: "secret://ci/fixture", providerId: "fixture", origin: "https://ci.example.invalid" });
});

test("remote status refuses unsafe boundaries and mismatched provider truth", async () => {
  await assert.rejects(() => fetchRemoteCiStatus(remoteRequest, { ...boundary(), providers: [{ id: "fixture", origin: "http://ci.example.invalid" }] }), /HTTPS origin/);
  await assert.rejects(() => fetchRemoteCiStatus(remoteRequest, { ...boundary(), providers: [{ id: "fixture", origin: "https://ci.example.invalid", statusPath: "https://escape.example.invalid/status" }] }), /cannot leave/);
  await assert.rejects(() => fetchRemoteCiStatus({ ...remoteRequest, sourceRef: "feature;bad" }, boundary()), /safe exact ref/);
  await assert.rejects(() => fetchRemoteCiStatus({ ...remoteRequest, sourceSha: "abc" }, boundary()), /40-character/);
  await assert.rejects(() => fetchRemoteCiStatus({ ...remoteRequest, checkNames: ["test", "test"] }, boundary()), /unique bounded/);
  const mismatch = boundary(); mismatch.fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ...remoteResponse, sourceSha: "c".repeat(40) }) });
  await assert.rejects(() => fetchRemoteCiStatus(remoteRequest, mismatch), /identity mismatch/);
  const missing = boundary(); missing.fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ...remoteResponse, checks: [{ name: "test", state: "success" }] }) });
  await assert.rejects(() => fetchRemoteCiStatus(remoteRequest, missing), /incomplete or duplicated/);
  const redirected = boundary(); redirected.fetchImpl = async () => ({ ok: true, status: 200, url: "https://escape.example.invalid/status", text: async () => JSON.stringify(remoteResponse) });
  await assert.rejects(() => fetchRemoteCiStatus(remoteRequest, redirected), /left the exact/);
  const oversized = boundary(); oversized.maxResponseBytes = 8; oversized.fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => "999" }, text: async () => "must-not-read" });
  await assert.rejects(() => fetchRemoteCiStatus(remoteRequest, oversized), /byte limit/);
});

test("matching local and remote green input SHAs are not exact-candidate promotion authority", () => {
  const local = { state: "green", targetSha: "a".repeat(40), sourceSha: "b".repeat(40) };
  assert.deepEqual(assessCiTier3(local, { ...local }), { exactMergedTruth: false, ciTier3: "grey" });
  assert.deepEqual(assessCiTier3(local, { ...local, sourceSha: "c".repeat(40) }), { exactMergedTruth: false, ciTier3: "grey" });
  assert.deepEqual(assessCiTier3(local, { ...local, state: "red" }), { exactMergedTruth: false, ciTier3: "red" });
  assert.deepEqual(assessCiTier3({ ...local, proofScope: "local-rehearsal", promotionAuthority: false }, { ...local }), { exactMergedTruth: false, ciTier3: "grey" });
  assert.deepEqual(assessCiTier3({ ...local, promotionAuthority: true }, { ...local, promotionAuthority: true }), { exactMergedTruth: false, ciTier3: "grey" });
  assert.deepEqual(assessCiTier3({ state: "green" }, { state: "green" }), { exactMergedTruth: false, ciTier3: "grey" });
});
