// Evidence and Integrity requirements derived from recorded proof items and sign-off.
// Returning null keeps the "unanswered" placeholder: nothing recorded is never success.
import { latestMergedTest, proofCoverage, proofItems, proofScope, REQUIRED_KIND_LABELS } from "../proofRecords.js";

const day = (value) => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "an unknown date"; };
const listed = (ids) => ids.length > 6 ? `${ids.slice(0, 6).join(", ")} and ${ids.length - 6} more` : ids.join(", ");
const scopeNote = (scope) => scope.source === "plan" ? "approved plan" : `task list as of ${day(scope.seenAt)}`;

function kindDeriver(kind) {
  return (sections) => {
    if (!sections.proof) return null;
    const scope = proofScope(sections);
    if (!scope.taskIds.length) return { state: "unanswered", detail: "Proof is saved, but there are no tasks to cover yet." };
    const { covered, skipped, missing } = proofCoverage(scope, proofItems(sections)).byKind[kind];
    const skippedNote = skipped ? ` (${skipped} marked not needed)` : "";
    if (!missing.length) return { state: "recorded", detail: `All ${scope.taskIds.length} tasks have ${REQUIRED_KIND_LABELS[kind]}${skippedNote} · ${scopeNote(scope)}.` };
    return { state: "review", detail: `${covered} of ${scope.taskIds.length} tasks have ${REQUIRED_KIND_LABELS[kind]}${skippedNote}. Missing: ${listed(missing)} · ${scopeNote(scope)}.` };
  };
}

function proofBundle(sections) {
  if (!sections.proof) return null;
  const scope = proofScope(sections);
  if (!scope.taskIds.length) return { state: "unanswered", detail: "Proof is saved, but there are no tasks to cover yet." };
  const coverage = proofCoverage(scope, proofItems(sections));
  if (coverage.complete === coverage.total) return { state: "recorded", detail: `Every task (${coverage.total}) has a screenshot, a code change and a passing test, or a reason they are not needed · ${scopeNote(scope)}.` };
  return { state: "review", detail: `${coverage.complete} of ${coverage.total} tasks have complete proof, ${coverage.partial} partial, ${coverage.none} none · ${scopeNote(scope)}.` };
}

function signOff(sections) {
  const review = sections.review?.data;
  if (!review?.planDigest || !review.reviewer) return null;
  const scope = proofScope(sections);
  const who = `${review.reviewer} on ${day(review.signedAt)}`;
  if (scope.digest !== review.planDigest) return { state: "stale", detail: `Signed off by ${who}, but the plan has changed since. Sign off this version again.` };
  return { state: "recorded", detail: `Signed off by ${who} for this plan version (${review.taskIds?.length ?? 0} tasks).` };
}

function mergedTests(sections) {
  if (!sections.proof) return null;
  const latest = latestMergedTest(proofItems(sections));
  if (!latest) return null;
  const what = `${latest.label || "Test run"} (${latest.taskId}) added by ${latest.addedBy} on ${day(latest.addedAt)}`;
  return latest.outcome === "passed"
    ? { state: "recorded", detail: `Tests passed on the merged code: ${what}.` }
    : { state: "review", detail: `The latest test run on the merged code failed: ${what}.` };
}

export const receiptDerivers = Object.freeze({
  "PROOF-SCREENSHOT": kindDeriver("screenshot"),
  "PROOF-DIFF": kindDeriver("diff"),
  "PROOF-TEST": kindDeriver("test"),
  "INT-PROOF": proofBundle,
  "INT-REVIEW": signOff,
  "INT-MERGED": mergedTests,
});
