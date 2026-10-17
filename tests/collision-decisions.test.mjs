// Gaps 18 and 21: decisions saved on the Collision page flow back to Plan,
// Ledger and Home, and a "split" decision only settles an overlap once the two
// tasks' file scopes really stop overlapping.
import test from "node:test";
import assert from "node:assert/strict";
import { emptyTaskDraftLedger, updateTaskDraft } from "../src/project/taskDraftLedger.js";
import { buildCollisionRecord, collisionStatus, createResolution, overlapFileLines, overlapReview, overlapReviewText, resolutionState } from "../src/project/taskCoordination.js";
import { deriveWorkRecordReceipt } from "../src/project/workRecordReceipts.js";
import { collisionSummary } from "../src/project/integritySummary.js";
import { recordedCollisions } from "../src/project/workRecordReaders.js";

const binding = { projectId: "pp_coord_decisions", rootIdentity: "a".repeat(64), censusDigest: "b".repeat(64) };
const project = { census: { digest: binding.censusDigest } };
const task = (title, claims = []) => ({ id: null, title, description: "d", owner: "o", acceptance: "a", recovery: "r", claims: claims.map(([access, path]) => ({ access, path })), dependsOn: [], archived: false });
const ledgerOf = (...tasks) => tasks.reduce((ledger, item) => updateTaskDraft(ledger, item, "2026-10-01T00:00:00.000Z"), emptyTaskDraftLedger(binding));
const edit = (ledger, id, claims) => updateTaskDraft(ledger, { ...ledger.tasks.find((item) => item.id === id), claims: claims.map(([access, path]) => ({ access, path })) });
const decide = (record, key, choice, first) => ({ ...record, resolutions: { ...(record.resolutions ?? {}), [key]: createResolution(record.collisions.find((item) => item.key === key), choice, first) } });

// Three overlapping pairs: T1/T2 (shared write), T1/T3 (write vs read), T2/T4 (shared write).
const base = ledgerOf(
  task("Login", [["write", "src/auth.js"], ["read", "src/api.js"]]),
  task("Session", [["write", "src/auth.js"], ["write", "src/store.js"]]),
  task("API", [["write", "src/api.js"]]),
  task("Store", [["write", "src/store.js"]]),
);
const record = buildCollisionRecord({ ledger: base, censusDigest: binding.censusDigest });

test("with no decisions every overlap is open and labelled as an overlap, not a missing detail", () => {
  const review = overlapReview(base, record);
  assert.equal(review.total, 3);
  assert.equal(review.settled, 0);
  assert.equal(review.otherFindings.length, 0, "overlaps are not task-detail findings");
  assert.equal(overlapReviewText(review).headline, "3 of 3 overlaps still need a decision");
});

test("order and accept decisions settle overlaps immediately and flow to counts", () => {
  let decided = decide(record, "T0001|T0002", "order", "T0002");
  decided = decide(decided, "T0001|T0003", "accept");
  const partial = overlapReview(base, decided);
  assert.equal(partial.settled, 2);
  assert.equal(overlapReviewText(partial).headline, "1 of 3 overlaps still needs a decision");
  decided = decide(decided, "T0002|T0004", "order", "T0002");
  const all = overlapReview(base, decided);
  assert.equal(all.settled, 3);
  assert.equal(overlapReviewText(all).headline, "3 overlaps decided");
  assert.equal(collisionStatus(decided).decided, 3);
  assert.equal(collisionStatus(decided).openHardStops, 0);
});

test("a split decision stays open until the two tasks' scopes no longer overlap", () => {
  const split = decide(record, "T0002|T0004", "split");
  const collision = record.collisions.find((item) => item.key === "T0002|T0004");
  assert.equal(resolutionState(collision, split.resolutions[collision.key]), "split-pending");
  const status = collisionStatus(split);
  assert.equal(status.decided, 0);
  assert.equal(status.splitPending, 1);
  assert.equal(status.openHardStops, status.hardStops, "a pending split does not clear a must-not-overlap conflict");
  const review = overlapReview(base, split);
  assert.equal(review.settled, 0);
  const text = overlapReviewText(review);
  assert.ok(text.lines.includes("Split chosen: edit the file scopes of T0002 or T0004 so they no longer overlap."));
  assert.match(deriveWorkRecordReceipt("ALLOC-CLEARANCE", { sections: { collisions: { revision: 1, data: split } } }, { project }).detail, /split/i);
  assert.equal(collisionSummary({ data: split, recordedAt: "2026-10-01T00:00:00.000Z" }).state, "open");
  assert.equal(recordedCollisions({ collisions: { data: split } }).find((item) => item.taskIds.join() === "T0002,T0004").resolved, false);

  // The user edits T0004 so it no longer touches src/store.js: the split is done.
  const separated = edit(base, "T0004", [["write", "src/store-cache.js"]]);
  const after = overlapReview(separated, split);
  assert.equal(after.total, 3);
  assert.equal(after.items.find((item) => item.key === "T0002|T0004").state, "separated");
  assert.equal(after.settled, 1);
  // Re-checking keeps nothing stale: the overlap is simply gone.
  const rechecked = buildCollisionRecord({ ledger: separated, censusDigest: binding.censusDigest, previous: split });
  assert.equal(rechecked.collisions.some((item) => item.key === "T0002|T0004"), false);
});

test("a decision is bound to the pair's current scopes: an edit that re-creates the overlap re-opens it", () => {
  const decided = decide(record, "T0002|T0004", "order", "T0002");
  assert.equal(overlapReview(base, decided).items.find((item) => item.key === "T0002|T0004").state, "decided");
  // T0004 now writes a second file that T0002 also writes: same pair, different scopes.
  const widened = edit(base, "T0004", [["write", "src/store.js"], ["write", "src/auth.js"]]);
  assert.equal(overlapReview(widened, decided).items.find((item) => item.key === "T0002|T0004").state, "open");
  // Even when the overlapping file stays the same, a change to either task's scope re-opens it.
  const moved = edit(base, "T0004", [["write", "src/store.js"], ["write", "src/other.js"]]);
  assert.equal(overlapReview(moved, decided).items.find((item) => item.key === "T0002|T0004").state, "open");
  // A different pair's edit does not disturb this decision.
  const unrelated = edit(base, "T0003", [["write", "src/api.js"], ["write", "src/docs.md"]]);
  assert.equal(overlapReview(unrelated, decided).items.find((item) => item.key === "T0002|T0004").state, "decided");
  // A check against the edited tasks drops the old decision.
  const rechecked = buildCollisionRecord({ ledger: moved, censusDigest: binding.censusDigest, previous: decided });
  assert.equal(rechecked.resolutions["T0002|T0004"], undefined);
});

test("without a saved check every overlap is open; a ledger without overlaps has no overlap headline", () => {
  assert.equal(overlapReview(base, null).settled, 0);
  const clean = ledgerOf(task("A", [["write", "a.js"]]), task("B", [["write", "b.js"]]));
  const review = overlapReview(clean, null);
  assert.equal(review.total, 0);
  assert.equal(overlapReviewText(review).headline, null);
});

// Gap 20: a folder claim against several files inside it listed the folder once
// per file ("src/components, src/components, src/components").
test("overlap text names each overlapping path once, keeping the author's letter case", () => {
  const ledger = ledgerOf(
    task("Folder", [["write", "src/Components"]]),
    task("Files", [["write", "src/components/A.jsx"], ["write", "src/components/B.jsx"], ["read", "src/components/C.jsx"]]),
  );
  const record = buildCollisionRecord({ ledger, censusDigest: binding.censusDigest, now: "2026-10-02T00:00:00.000Z" });
  const [collision] = record.collisions;
  // The stored record is unchanged (its signature keeps earlier decisions matching).
  assert.equal(collision.files.length, 3);
  const lines = overlapFileLines(collision.files);
  assert.deepEqual(lines.map((line) => [line.path, line.paths, line.severity]), [
    ["src/Components", ["src/components/A.jsx", "src/components/B.jsx"], "hard-stop"],
    ["src/Components", ["src/components/C.jsx"], "ordered"],
  ]);
  const read = recordedCollisions({ collisions: { data: record } });
  assert.deepEqual(read[0].paths, ["src/Components"]);
  // Plain recorded paths that differ only by letter case are listed once too.
  const plain = recordedCollisions({ collisions: { data: { collisions: [{ taskIds: ["T0001", "T0002"], paths: ["src/app.js", "SRC/app.js", "src/app.js", "src/b.js"] }] } } });
  assert.deepEqual(plain[0].paths, ["src/app.js", "src/b.js"]);
});
