import test from "node:test";
import assert from "node:assert/strict";
import fs, { appendFile, link, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { currentComponentPlanInput } from "../src/engine/componentPlanSeed.js";
import { inspectComponentPlans, publishComponentPlans as publishBoundComponentPlans, withStoredComponentPlans } from "../src/node/componentPlanStore.mjs";
import { bindComponentParents } from "./fixtures/componentParents.mjs";

// These existing cases exercise catalog persistence; provision real parents first.
const publishComponentPlans = async (root, source, request, options) => publishBoundComponentPlans(root, await bindComponentParents(root, source), request, options);

const fixture = () => mkdtemp(path.join(os.tmpdir(), "pp-component-store-"));
const input = () => {
  const value = structuredClone(currentComponentPlanInput);
  for (const component of value.components) component.handover.openQuestions = [];
  return value;
};
const genesis = { planId: "PP-CLEANROOM", expectedRevision: 0, expectedHeadDigest: "GENESIS" };
test("first publication creates a verified complete component catalog", async (t) => { const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const resolved = input(); const result = await publishComponentPlans(root, resolved, genesis, { actor: "danie", timestamp: "2026-09-02T00:00:00.000Z" }); const state = await inspectComponentPlans(root, "PP-CLEANROOM"); assert.equal(result.revision, 1); assert.equal(state.head.componentCount, resolved.components.length); assert.equal(state.head.claimCount, resolved.components.flatMap((component) => component.fileClaims).length); });
test("stale and identical publications are refused", async (t) => { const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await publishComponentPlans(root, input(), genesis, { actor: "danie" }); await assert.rejects(() => publishComponentPlans(root, input(), genesis, { actor: "danie" }), /compare-and-swap/); const state = await inspectComponentPlans(root, "PP-CLEANROOM"); await assert.rejects(() => publishComponentPlans(root, input(), { planId: "PP-CLEANROOM", expectedRevision: 1, expectedHeadDigest: state.head.contractDigest }, { actor: "danie" }), /already registered/); });
test("tampering blocks reads and every successor", async (t) => { const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await publishComponentPlans(root, input(), genesis, { actor: "danie" }); const directory = path.join(root, "component-catalogs", (await readdir(path.join(root, "component-catalogs")))[0]); const file = path.join(directory, "00000001.json"); const value = JSON.parse(await readFile(file, "utf8")); value.contract.components[0].purpose = "attacker"; await writeFile(file, JSON.stringify(value)); await assert.rejects(() => inspectComponentPlans(root, "PP-CLEANROOM"), /hash is invalid|failed verification/); });
test("concurrent successors serialize to exactly one catalog head", async (t) => { const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await publishComponentPlans(root, input(), genesis, { actor: "danie" }); const state = await inspectComponentPlans(root, "PP-CLEANROOM"); const request = { planId: "PP-CLEANROOM", expectedRevision: 1, expectedHeadDigest: state.head.contractDigest }; const results = await Promise.allSettled(["one", "two", "three"].map((value) => { const next = input(); next.components[0].purpose = `${next.components[0].purpose} ${value}`; return publishComponentPlans(root, next, request, { actor: value }); })); assert.equal(results.filter((result) => result.status === "fulfilled").length, 1); assert.equal((await inspectComponentPlans(root, "PP-CLEANROOM")).revision, 2); });

async function storedFixture() {
  const root = await fixture(); const source = input();
  const published = await publishComponentPlans(root, source, genesis, { actor: "fixture-owner" });
  const directory = path.join(root, "component-catalogs", (await readdir(path.join(root, "component-catalogs")))[0]);
  return { root, source, published, directory, file: path.join(directory, "00000001.json") };
}

// Intercept the real handle's read boundary, then mutate real fixture files.
// No production test hook or substituted registration data is involved.
async function atFirstRead(t, file, change, operation) {
  const actualOpen = fs.open, actualReadFile = fs.readFile; let changed = false, readBytes = 0, closed = 0;
  // Also exercise the old unbounded implementation in the before-control run.
  const fileMock = t.mock.method(fs, "readFile", async (...args) => {
    if (String(args[0]) === file && !changed) { changed = true; await change(); }
    const bytes = await actualReadFile(...args);
    if (String(args[0]) === file) readBytes += Buffer.byteLength(bytes);
    return bytes;
  });
  const mock = t.mock.method(fs, "open", async (...args) => {
    const handle = await actualOpen(...args);
    if (String(args[0]) === file) {
      const actualRead = handle.read.bind(handle);
      const actualClose = handle.close.bind(handle);
      handle.close = async () => { closed++; return actualClose(); };
      handle.read = async (...readArgs) => {
        if (!changed) { changed = true; await change(); }
        const result = await actualRead(...readArgs); readBytes += result.bytesRead; return result;
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try { await operation(); return { changed, readBytes, closed }; }
  finally { mock.mock.restore(); fileMock.mock.restore(); syncBuiltinESMExports(); }
}

test("growing history records are refused after bounded reads and never repaired", async t => {
  const f = await storedFixture(); const original = await readFile(f.file);
  const result = await atFirstRead(t, f.file, () => appendFile(f.file, " ".repeat(5_000_000)),
    () => assert.rejects(inspectComponentPlans(f.root, genesis.planId), /changed during read/));
  assert.equal(result.changed, true); assert.ok(result.readBytes <= original.length + 1); assert.equal(result.closed, 1);
  assert.equal((await fs.stat(f.file)).size, original.length + 5_000_000);
});

test("replacement after open refuses old-handle bytes even if the replacement is identical", async t => {
  const f = await storedFixture(); const original = await readFile(f.file);
  const preserved = f.file + ".preserved";
  await atFirstRead(t, f.file, async () => { await rename(f.file, preserved); await writeFile(f.file, original); },
    () => assert.rejects(inspectComponentPlans(f.root, genesis.planId), /changed during read/));
  assert.deepEqual(await readFile(preserved), original); assert.deepEqual(await readFile(f.file), original);
});

test("shrinking history records are refused without changing the remaining bytes", async t => {
  const f = await storedFixture();
  await atFirstRead(t, f.file, () => writeFile(f.file, "{}"),
    () => assert.rejects(inspectComponentPlans(f.root, genesis.planId), /changed during read/));
  assert.equal(await readFile(f.file, "utf8"), "{}");
});

test("an earlier record replaced during a later read invalidates the complete history", async t => {
  const f = await storedFixture(); f.source.components[0].purpose += " Follow-up.";
  await publishComponentPlans(f.root, f.source, { planId: genesis.planId, expectedRevision: 1, expectedHeadDigest: f.published.head.contractDigest }, { actor: "fixture-owner" });
  const original = await readFile(f.file);
  await atFirstRead(t, path.join(f.directory, "00000002.json"), async () => { await rename(f.file, f.file + ".preserved"); await writeFile(f.file, original); },
    () => assert.rejects(inspectComponentPlans(f.root, genesis.planId), /changed during history verification/));
});

test("a changed revision inventory cannot be returned as a complete verified history", async t => {
  const f = await storedFixture();
  await atFirstRead(t, f.file, () => writeFile(path.join(f.directory, "00000002.json"), "{}"),
    () => assert.rejects(inspectComponentPlans(f.root, genesis.planId), /inventory changed/));
  assert.equal(await readFile(path.join(f.directory, "00000002.json"), "utf8"), "{}");
});

test("redirected ancestors and multiply linked history records are refused by inspection and handoff", async () => {
  const f = await storedFixture(); const alias = f.root + "-redirected";
  await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(inspectComponentPlans(alias, genesis.planId), /redirected/);
  const expected = { planId: genesis.planId, catalogRevision: 1, contractDigest: f.published.head.contractDigest };
  await assert.rejects(withStoredComponentPlans(alias, expected, () => assert.fail("Do not hand off redirected source")), /redirected/);
  await link(f.file, f.file + ".linked");
  await assert.rejects(inspectComponentPlans(f.root, genesis.planId), /bounded regular file/);
  await assert.rejects(withStoredComponentPlans(f.root, expected, () => assert.fail("Do not hand off linked source")), /bounded regular file/);
});

test("invalid inspection limits cannot remove the hard byte and revision ceilings", async () => {
  const f = await storedFixture();
  for (const options of [{ maxBytes: Infinity }, { maxBytes: -1 }, { maxBytes: 4_000_001 }, { maxRevisions: 1001 }, { maxRevisions: "1" }])
    await assert.rejects(inspectComponentPlans(f.root, genesis.planId, options), /limits are invalid/);
  await assert.rejects(inspectComponentPlans(f.root, genesis.planId, { maxBytes: 1 }), /bounded regular file/);
});

test("changed history blocks the worker callback rather than handing off a stale contract", async t => {
  const f = await storedFixture(); let called = false;
  await atFirstRead(t, f.file, () => appendFile(f.file, " "), () => assert.rejects(withStoredComponentPlans(f.root,
    { planId: genesis.planId, catalogRevision: 1, contractDigest: f.published.head.contractDigest }, () => { called = true; }), /changed/));
  assert.equal(called, false);
});

test("a same-length metadata change is refused even when the contract bytes remain valid", async t => {
  const f = await storedFixture(); const before = await fs.stat(f.file); const bytes = await readFile(f.file);
  await atFirstRead(t, f.file, () => fs.utimes(f.file, before.atime, new Date(before.mtimeMs + 1000)),
    () => assert.rejects(inspectComponentPlans(f.root, genesis.planId), /changed during read/));
  assert.deepEqual(await readFile(f.file), bytes);
});

test("publication byte and revision ceilings preserve the previous readable history", async () => {
  const f = await storedFixture(); const original = await readFile(f.file);
  const request = { planId: genesis.planId, expectedRevision: 1, expectedHeadDigest: f.published.head.contractDigest };
  f.source.components[0].purpose += " A distinct successor.";
  // Runtime policy may tighten, but cannot raise, the shared hard limits.
  await assert.rejects(publishComponentPlans(f.root, f.source, request, { actor: "fixture-owner", maxRevisions: 1 }), /publication exceeds its revision limit/);
  f.source.components[0].purpose += "x".repeat(4_000_000);
  await assert.rejects(publishComponentPlans(f.root, f.source, request, { actor: "fixture-owner" }), /publication exceeds its byte limit/);
  const state = await inspectComponentPlans(f.root, genesis.planId);
  assert.equal(state.revision, 1); assert.equal(state.head.contractDigest, f.published.head.contractDigest);
  assert.deepEqual(await readFile(f.file), original);
  assert.deepEqual(await readdir(f.directory), ["00000001.json"]);
});
