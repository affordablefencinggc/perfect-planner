import assert from "node:assert/strict";
import test from "node:test";

import { addProofItem, isQuotaError, latestMergedTest, planTaskIds, proofCoverage, proofItems, proofScope, removeProofItem, saveErrorMessage, signOffRecord, validateProofItem } from "../src/project/proofRecords.js";
import { receiptDerivers } from "../src/project/receipts/proof.js";
import { deriveWorkRecordReceipt } from "../src/project/workRecordReceipts.js";
import { collisionSummary, ownerSummary } from "../src/project/integritySummary.js";
import { readSection, writeSection } from "../src/project/projectWorkRecords.js";

const AT = "2026-10-01T10:00:00.000Z";
const draft = (id, extra = {}) => ({ id, title: `Task ${id}`, description: "", owner: "", acceptance: "", recovery: "", claims: [], dependsOn: [], archived: false, ...extra });
const ledger = (...tasks) => ({ revision: 3, tasks });
let counter = 0;
const item = (kind, extra = {}) => ({ id: `P-${++counter}`, kind, format: kind === "screenshot" ? "link" : "text", label: "", value: kind === "screenshot" ? "https://example.test/shot.png" : "output", addedAt: AT, addedBy: "Dana", ...(kind === "test" ? { outcome: "passed" } : {}), ...extra });
const record = (data, revision = 1, recordedAt = AT) => ({ revision, recordedAt, data });

function memoryStorage({ quotaAfter = Infinity } = {}) {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => {
      if (String(value).length > quotaAfter) { const error = new Error("full"); error.name = "QuotaExceededError"; throw error; }
      values.set(key, String(value));
    },
  };
}

function build(sections, taskId, kinds, scope) {
  let next = sections;
  for (const kind of kinds) next = { ...next, proof: record(addProofItem(next, taskId, item(kind), scope)) };
  return next;
}

test("scope prefers the approved plan, then live drafts, then the last seen task list", () => {
  const plan = record({ tasks: [{ id: "T0001" }, { id: "T0003", archived: true }, "T0002"], digest: "plan-abc" }, 4);
  assert.deepEqual(planTaskIds(plan), ["T0001", "T0002"]);
  assert.deepEqual(proofScope({ planAuthority: plan }, ledger(draft("T0009"))), { source: "plan", taskIds: ["T0001", "T0002"], digest: "plan-abc", seenAt: AT });
  assert.equal(proofScope({ planAuthority: record({ taskIds: ["T0001"] }, 7) }).digest, "plan-revision-7");

  const live = proofScope({}, ledger(draft("T0001"), draft("T0002", { archived: true })));
  assert.equal(live.source, "drafts");
  assert.deepEqual(live.taskIds, ["T0001"]);
  assert.notEqual(live.digest, proofScope({}, ledger(draft("T0001", { title: "Renamed" }))).digest);

  assert.deepEqual(proofScope({}), { source: "none", taskIds: [], digest: null, seenAt: null });
  const sections = { proof: record({ items: {}, scope: { source: "drafts", taskIds: ["T0001"], digest: "fp-old" } }, 1, "2026-10-01T00:00:00.000Z"), review: record({ planDigest: "fp-new", planSource: "drafts", taskIds: ["T0001", "T0002"], reviewer: "Ana", signedAt: AT }, 1, "2026-10-02T00:00:00.000Z") };
  assert.equal(proofScope(sections).digest, "fp-new");
  assert.equal(proofScope(sections).source, "snapshot");
});

test("validation refuses unusable proof and keeps only clean fields", () => {
  assert.throws(() => validateProofItem(item("screenshot", { addedBy: " " })), /who is adding/);
  assert.throws(() => validateProofItem(item("diff", { format: "link", value: "javascript:alert(1)" })), /https/);
  assert.throws(() => validateProofItem(item("screenshot", { format: "image", value: "data:text/html;base64,AAAA" })), /PNG/);
  assert.throws(() => validateProofItem(item("test", { outcome: undefined })), /passed or failed/);
  assert.throws(() => validateProofItem(item("skip", { covers: "note" })), /Choose which/);
  assert.throws(() => validateProofItem(item("note", { value: "x".repeat(20_001) })), /limited/);
  assert.throws(() => validateProofItem(item("diff", { format: "image" })), /cannot be stored/);
  const clean = validateProofItem({ ...item("test", { merged: true }), extra: "dropped" });
  assert.equal(clean.extra, undefined);
  assert.equal(clean.merged, true);
  assert.equal(validateProofItem(item("screenshot", { format: "image", value: "data:image/png;base64,iVBORw0KGgo=" })).format, "image");
});

test("coverage needs a screenshot, code change and passing test per task, with explicit not-needed reasons", () => {
  const scope = { source: "drafts", taskIds: ["T0001", "T0002", "T0003"], digest: "fp-1" };
  let sections = build({}, "T0001", ["screenshot", "diff", "test"], scope);
  sections = build(sections, "T0002", ["diff"], scope);
  sections = { ...sections, proof: record(addProofItem(sections, "T0002", item("test", { outcome: "failed" }), scope)) };
  sections = { ...sections, proof: record(addProofItem(sections, "T0002", item("skip", { covers: "screenshot", value: "Back-end only" }), scope)) };
  const coverage = proofCoverage(scope, proofItems(sections));
  assert.deepEqual(coverage.tasks.map((task) => task.status), ["complete", "partial", "none"]);
  assert.equal(coverage.tasks[1].kinds.test, "failed");
  assert.equal(coverage.tasks[1].kinds.screenshot, "skipped");
  assert.deepEqual(coverage.byKind.test.missing, ["T0002", "T0003"]);

  const removed = removeProofItem(sections, "T0001", proofItems(sections).T0001[0].id, scope);
  assert.equal(removed.items.T0001.length, 2);
  assert.deepEqual(removed.scope, { source: "drafts", taskIds: scope.taskIds, digest: "fp-1" });
});

test("receipts stay unanswered until proof is recorded and report partial coverage as needing review", () => {
  assert.equal(deriveWorkRecordReceipt("PROOF-SCREENSHOT", { sections: {} }), null);
  assert.equal(deriveWorkRecordReceipt("INT-REVIEW", { sections: {} }), null);
  assert.equal(deriveWorkRecordReceipt("INT-MERGED", { sections: {} }), null);

  const scope = { source: "drafts", taskIds: ["T0001", "T0002"], digest: "fp-1" };
  let sections = build({}, "T0001", ["screenshot", "diff", "test"], scope);
  const partial = deriveWorkRecordReceipt("PROOF-SCREENSHOT", { sections });
  assert.equal(partial.state, "review");
  assert.match(partial.detail, /1 of 2 tasks have a screenshot\. Missing: T0002/);
  assert.equal(deriveWorkRecordReceipt("INT-PROOF", { sections }).state, "review");

  sections = build(sections, "T0002", ["screenshot", "diff", "test"], scope);
  for (const id of ["PROOF-SCREENSHOT", "PROOF-DIFF", "PROOF-TEST", "INT-PROOF"]) assert.equal(deriveWorkRecordReceipt(id, { sections }).state, "recorded", id);
  assert.equal(deriveWorkRecordReceipt("INT-MERGED", { sections }), null);

  const empty = { proof: record({ items: {}, scope: { source: "drafts", taskIds: [], digest: "fp-0" } }) };
  assert.equal(receiptDerivers["INT-PROOF"](empty).state, "unanswered");
});

test("the approved plan decides which tasks count", () => {
  const scope = { source: "drafts", taskIds: ["T0001"], digest: "fp-1" };
  const sections = { ...build({}, "T0001", ["screenshot", "diff", "test"], scope), planAuthority: record({ taskIds: ["T0001", "T0004"] }, 2) };
  const result = deriveWorkRecordReceipt("INT-PROOF", { sections });
  assert.equal(result.state, "review");
  assert.match(result.detail, /1 of 2 tasks.*approved plan/);
});

test("sign-off is current only for the plan version it covered", () => {
  const scope = { source: "drafts", taskIds: ["T0001"], digest: "fp-1" };
  assert.throws(() => signOffRecord({ scope, reviewer: "" }), /reviewer/);
  assert.throws(() => signOffRecord({ scope: { ...scope, taskIds: [] }, reviewer: "Ana" }), /no tasks/);
  const review = signOffRecord({ scope, reviewer: " Ana Ruiz ", notes: "Looks right", now: AT });
  assert.deepEqual(review, { planDigest: "fp-1", planSource: "drafts", taskIds: ["T0001"], reviewer: "Ana Ruiz", signedAt: AT, notes: "Looks right" });

  const signed = { review: record(review, 1, "2026-10-02T00:00:00.000Z") };
  assert.equal(deriveWorkRecordReceipt("INT-REVIEW", { sections: signed }).state, "recorded");
  // Proof added later against a changed task list makes the sign-off stale.
  const changed = { ...signed, proof: record({ items: {}, scope: { source: "drafts", taskIds: ["T0001", "T0002"], digest: "fp-2" } }, 1, "2026-10-03T00:00:00.000Z") };
  const stale = deriveWorkRecordReceipt("INT-REVIEW", { sections: changed });
  assert.equal(stale.state, "stale");
  assert.match(stale.detail, /changed since/);
  const planned = { ...signed, planAuthority: record({ taskIds: ["T0001"], digest: "plan-x" }) };
  assert.equal(deriveWorkRecordReceipt("INT-REVIEW", { sections: planned }).state, "stale");
});

test("merged-code tests use the latest merged run", () => {
  const scope = { source: "drafts", taskIds: ["T0001"], digest: "fp-1" };
  let sections = { proof: record(addProofItem({}, "T0001", item("test", { merged: true, addedAt: "2026-10-01T00:00:00.000Z", label: "CI on main" }), scope)) };
  assert.equal(deriveWorkRecordReceipt("INT-MERGED", { sections }).state, "recorded");
  assert.match(deriveWorkRecordReceipt("INT-MERGED", { sections }).detail, /CI on main/);
  sections = { proof: record(addProofItem(sections, "T0001", item("test", { merged: true, outcome: "failed", addedAt: "2026-10-02T00:00:00.000Z" }), scope)) };
  assert.equal(latestMergedTest(proofItems(sections)).outcome, "failed");
  assert.equal(deriveWorkRecordReceipt("INT-MERGED", { sections }).state, "review");
});

test("a full browser store reports a clear message and keeps earlier proof", () => {
  const storage = memoryStorage({ quotaAfter: 2000 });
  const scope = { source: "drafts", taskIds: ["T0001"], digest: "fp-1" };
  writeSection("pp_proof_quota", "proof", addProofItem({}, "T0001", item("note"), scope), { storage, now: () => AT });
  const big = addProofItem({ proof: readSection("pp_proof_quota", "proof", storage) }, "T0001", item("note", { value: "x".repeat(5000) }), scope);
  let caught;
  try { writeSection("pp_proof_quota", "proof", big, { storage }); } catch (error) { caught = error; }
  assert.ok(isQuotaError(caught));
  assert.match(saveErrorMessage(caught), /storage for this project is full, so nothing was saved/);
  assert.equal(readSection("pp_proof_quota", "proof", storage).data.items.T0001.length, 1);
  assert.match(saveErrorMessage(new Error("WORK_RECORDS_UNREADABLE")), /could not be read/);
});

test("integrity summaries never claim resolution or ownership from unknown shapes", () => {
  assert.match(collisionSummary(null).text, /not been checked/);
  assert.equal(collisionSummary(record({ collisions: [] })).state, "done");
  assert.equal(collisionSummary(record({ collisions: [{ status: "resolved" }, { status: "open" }] })).state, "open");
  assert.equal(collisionSummary(record({ something: 1 })).state, "unknown");
  // The Collision page's own record: decisions live in resolutions and must match the collision's signature.
  const pair = { key: "T0001|T0002", tasks: ["T0001", "T0002"], signature: "sig-1", severity: "hard-stop", paths: ["src/notes"] };
  assert.equal(collisionSummary(record({ collisions: [pair], resolutions: {} })).state, "open");
  assert.equal(collisionSummary(record({ collisions: [pair], resolutions: { "T0001|T0002": { choice: "order", first: "T0001", signature: "sig-1" } } })).state, "done");
  assert.equal(collisionSummary(record({ collisions: [pair], resolutions: { "T0001|T0002": { choice: "order", first: "T0001", signature: "older" } } })).state, "open");
  assert.equal(ownerSummary(record({ owners: { T0001: "Ana", T0002: "" } }), ["T0001", "T0002"]).text, "1 of 2 tasks have an owner assigned in Allocation.");
  assert.equal(ownerSummary(record({ owners: [{ taskId: "T0001", owner: "Ana" }] }), ["T0001"]).state, "done");
  assert.equal(ownerSummary(record({ weird: true }), ["T0001"]).state, "unknown");
  assert.match(ownerSummary(null, ["T0001", "T0002"], ledger(draft("T0001", { owner: "Bo" }), draft("T0002"))).text, /1 of 2 task drafts name an owner/);
});
