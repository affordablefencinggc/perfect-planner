import test from "node:test";
import assert from "node:assert/strict";
import { appendLedgerEntry, assessCollisions, claimsConflict, normalizeSurface, validateManifest, verifyLedger } from "../src/engine/collisionEngine.js";
import { collisionSeedManifests } from "../src/engine/collisionSeed.js";
import { deriveExecutionMap } from '../src/engine/executionEngine.js';

test('duplicate plan IDs cannot hide conflicting work through same-plan filtering', () => {
  const manifest = taskId => ({schemaVersion:1,planId:'P',tasks:[{taskId,claims:[{kind:'file',surface:'src/shared.ts',access:'write'}]}]});
  const result = assessCollisions([manifest('A'),manifest('B')]);
  assert.ok(result.manifestErrors.some(item => item.message.includes('Duplicate plan')));
  assert.deepEqual(result.safeClaims,[]);
  for (const input of [null,{},'not-an-array']) assert.ok(assessCollisions(input).manifestErrors.length > 0);
});

test('invalid ordering metadata is rejected before the collision comparator', () => {
  const manifest = {schemaVersion:1,planId:'P',tasks:[{taskId:'A',claims:[{kind:'file',surface:'src/a.ts',access:'write'}]}]};
  for (const override of [{createdAt:123},{createdAt:'not-a-date'},{createdAt:'2026-09-09'},{priority:'1'},{priority:Infinity}]) {
    assert.ok(validateManifest({...manifest,...override}).length > 0);
    assert.ok(assessCollisions([{...manifest,...override},{...manifest,planId:'Q'}]).manifestErrors.length > 0);
  }
});

test('malformed manifests return rejection errors rather than throwing or scheduling', () => {
  const task = { taskId: 'A', dependsOn: [], claims: [] };
  for (const input of [null, [], {}, {schemaVersion:1,planId:'P',tasks:{}},
    ...[null, [], { ...task, claims: {} }, { ...task, claims: [null] }, { ...task, dependsOn: 'MISSING' }, { ...task, dependsOn: [null] }, { ...task, taskId: 1 }].map(value => ({schemaVersion:1,planId:'P',tasks:[value]}))]) {
    assert.ok(validateManifest(input).length > 0);
    const result = deriveExecutionMap(input);
    assert.equal(result.valid,false); assert.deepEqual(result.waves,[]);
  }
});

test('unknown and repeated dependencies cannot silently become ready work', () => {
  for (const dependsOn of [['MISSING'], ['A','A']]) {
    const manifest = {schemaVersion:1,planId:'P',tasks:[{taskId:'A',claims:[]},{taskId:'B',claims:[],dependsOn}]};
    assert.ok(validateManifest(manifest).length > 0);
    assert.equal(deriveExecutionMap(manifest).valid,false);
    assert.ok(assessCollisions([manifest]).manifestErrors.length > 0);
  }
});

test('unsupported wildcard and unsafe file claims are refused before collision assessment', () => {
  const manifest = surface => ({schemaVersion:1,planId:'P',tasks:[{taskId:'A',claims:[{kind:'file',surface,access:'write'}]}]});
  for (const surface of ['*','src/*.ts','src/**/index.ts','src/[ab].ts','src/{a,b}.ts','src/../shared.ts','src/./shared.ts','/src/a.ts','C:\\src\\a.ts','src//a.ts','src/?','src./shared.ts','src/dir /file.ts']) {
    assert.ok(validateManifest(manifest(surface)).length > 0,surface);
    assert.equal(deriveExecutionMap(manifest(surface)).valid,false,surface);
  }
  for (const surface of ['src/a.ts','src/*','src/**','.\\SRC\\shared.ts','src/nested/']) assert.deepEqual(validateManifest(manifest(surface)),[],surface);
});

test('nested file and glob claims overlap symmetrically without sibling-prefix matches', () => {
  const claim = surface => ({ kind: 'file', surface, access: 'write' });
  for (const [a,b,expected] of [
    ['src/*','src/nested/*',true], ['src/**','src/nested/**',true],
    ['src/*','src/nested/file.ts',true], ['src','src/nested/*',true],
    ['src/a/*','src/ab/*',false], ['src/a/**','src/b/**',false],
    ['.\\SRC\\*','src/nested/**',true],
  ]) {
    assert.equal(claimsConflict(claim(a),claim(b)),expected,`${a}/${b}`);
    assert.equal(claimsConflict(claim(b),claim(a)),expected,`${b}/${a}`);
  }
});

test("normalizes Windows and POSIX claim paths to the same surface", () => {
  assert.equal(normalizeSurface("file", ".\\SRC\\sync\\plan.ts"), "src/sync/plan.ts");
});

test("finds write/write and write/read collisions while leaving read/read safe", () => {
  const result = assessCollisions(collisionSeedManifests);
  assert.equal(result.manifestErrors.length, 0);
  assert.equal(result.collisions.length, 3);
  assert.equal(result.hardStops, 1);
  assert.deepEqual(result.collisions.map((collision) => collision.severity).sort(), ["hard-stop", "ordered", "ordered"]);
  assert.ok(result.safeClaims.some((claim) => claim.surface === "src/review/results.ts"));
});

test("orders overlapping plans deterministically by priority, time, and stable id", () => {
  const result = assessCollisions(collisionSeedManifests);
  assert.ok(result.collisions.every((collision) => collision.first.planId === "PP-014"));
  assert.ok(result.collisions.every((collision) => collision.then.planId !== collision.first.planId));
});

test("rejects malformed manifests and dependency cycles before assessment", () => {
  const invalid = {
    schemaVersion: 1,
    planId: "PP-BAD",
    tasks: [
      { taskId: "A", dependsOn: ["B"], claims: [{ kind: "file", surface: "src/a.ts", access: "write" }] },
      { taskId: "B", dependsOn: ["A"], claims: [{ kind: "file", surface: "src/b.ts", access: "write" }] },
    ],
  };
  assert.ok(validateManifest(invalid).some((error) => error.includes("Dependency cycle")));
  assert.ok(assessCollisions([invalid]).manifestErrors.length > 0);
});

test("creates and verifies a cryptographically chained append-only ledger", async () => {
  let ledger = [];
  ledger = await appendLedgerEntry(ledger, "collision.assessed", { collisions: 3 }, { timestamp: "2026-09-02T01:00:00.000Z" });
  ledger = await appendLedgerEntry(ledger, "collision.order-approved", { collisionId: "COL-001" }, { timestamp: "2026-09-02T01:01:00.000Z" });
  assert.deepEqual(await verifyLedger(ledger), { valid: true, brokenAt: null });
  const tampered = structuredClone(ledger);
  tampered[0].payload.collisions = 0;
  assert.deepEqual(await verifyLedger(tampered), { valid: false, brokenAt: 1 });
});
