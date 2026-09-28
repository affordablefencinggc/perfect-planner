import test from "node:test";
import assert from "node:assert/strict";
import { createCollisionAuthorityClient } from "../src/engine/collisionAuthorityClient.js";
import { appendLedgerEntry, collisionCensusDigest } from "../src/engine/collisionEngine.js";

const planId = "PP-TEST";
const censusA = await collisionCensusDigest([{ schemaVersion: 1, planId: "A", tasks: [] }]);
const censusB = await collisionCensusDigest([{ schemaVersion: 1, planId: "B", tasks: [] }]);

async function snapshot(censusDigest, ids = []) {
  let ledger = [];
  for (const id of ids) ledger = await appendLedgerEntry(ledger, "collision.order-approved", { collisionId: id, censusDigest }, { actor: "native-authority", timestamp: `2026-09-02T00:00:0${ledger.length}.000Z` });
  return { schemaVersion: 1, planId, censusDigest, authority: "native-journal", authoritative: true, revision: ledger.length, headHash: ledger.at(-1)?.hash ?? "GENESIS", approvedIds: ids, ledger };
}

test("no native adapter is explicitly unavailable and never authoritative", async () => {
  const client = createCollisionAuthorityClient({ planId });
  const result = await client.inspect(censusA);
  assert.equal(client.available, false); assert.equal(result.authoritative, false); assert.deepEqual(result.approvedIds, []); assert.match(result.reason, /unavailable/i);
});

test("an approval is accepted only when a native journal proves it", async () => {
  const client = createCollisionAuthorityClient({ planId, adapter: { approve: ({ censusDigest }) => snapshot(censusDigest, ["COL-001"]) } });
  const result = await client.approve(censusA, { id: "COL-001" });
  assert.equal(result.authoritative, true); assert.deepEqual(result.approvedIds, ["COL-001"]); assert.equal(result.revision, 1);
});

test("approval from a different census is rejected fail closed", async () => {
  const client = createCollisionAuthorityClient({ planId, adapter: { inspect: () => snapshot(censusB, ["COL-001"]) } });
  const result = await client.inspect(censusA);
  assert.equal(result.authoritative, false); assert.match(result.reason, /different plan census/i);
});

test("claimed approval without a matching journal record is rejected", async () => {
  const client = createCollisionAuthorityClient({ planId, adapter: { inspect: async () => ({ ...await snapshot(censusA), approvedIds: ["COL-999"] }) } });
  const result = await client.inspect(censusA);
  assert.equal(result.authoritative, false); assert.match(result.reason, /absent from its ledger/i);
});

test("stale revisions and conflicting heads cannot replace accepted authority", async () => {
  const first = await snapshot(censusA, ["COL-001"]); let calls = 0;
  const client = createCollisionAuthorityClient({ planId, adapter: { inspect: async () => calls++ === 0 ? first : { ...await snapshot(censusA), headHash: "f".repeat(64) } } });
  assert.equal((await client.inspect(censusA)).authoritative, true);
  const rejected = await client.inspect(censusA); assert.equal(rejected.authoritative, false); assert.match(rejected.reason, /head hash/i);
});
