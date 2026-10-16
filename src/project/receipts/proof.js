// Evidence and Integrity requirements derived from recorded proof items and sign-off.
// Returning null keeps the "unanswered" placeholder: nothing recorded is never success.
import { latestMergedTest, planTaskIds, proofCoverage, proofItems, proofScope, REQUIRED_KIND_LABELS } from "../proofRecords.js";
import { readTaskDraftPresence } from "../taskDraftPresence.js";

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
  const waived = coverage.waived ? `, ${coverage.waived} waived (every proof marked not needed)` : "";
  return { state: "review", detail: `${coverage.complete} of ${coverage.total} tasks have complete proof${waived}, ${coverage.partial} partial, ${coverage.none} none · ${scopeNote(scope)}.` };
}

/**
 * The plan version a sign-off must match, judged without the sign-off's own
 * snapshot (comparing a review with itself always looks current). The approved
 * plan wins; then the Ledger's saved draft fingerprint; then proof saved after
 * the sign-off. Null when nothing independent says what the tasks are now.
 */
function currentPlanDigest(sections, { project, storage } = {}) {
  if (planTaskIds(sections.planAuthority)) return proofScope(sections).digest;
  const presence = readTaskDraftPresence(project?.projectId, storage ?? undefined);
  const sameScan = !presence?.censusDigest || !project?.census?.digest || presence.censusDigest === project.census.digest;
  if (typeof presence?.draftsDigest === "string" && sameScan) return presence.draftsDigest;
  const proofSeen = sections.proof?.data?.scope && String(sections.proof.recordedAt ?? "") > String(sections.review?.recordedAt ?? "");
  return proofSeen ? proofScope({ proof: sections.proof }).digest : null;
}

function signOff(sections, context) {
  const review = sections.review?.data;
  if (!review?.planDigest || !review.reviewer) return null;
  const who = `${review.reviewer} on ${day(review.signedAt)}`;
  const current = currentPlanDigest(sections, context);
  if (!current) return { state: "review", detail: `Signed off by ${who}. The current task list could not be checked here; open Integrity to confirm the sign-off still covers it.` };
  if (current !== review.planDigest) return { state: "stale", detail: `Signed off by ${who}, but the plan has changed since. Sign off this version again.` };
  const tasks = `${review.taskIds?.length ?? 0} task${review.taskIds?.length === 1 ? "" : "s"}`;
  const proof = review.proofAtSignOff;
  const caveats = [
    review.planSource !== "plan" && "no plan was approved",
    !proof ? "proof at sign-off was not recorded" : proof.complete < proof.total && `only ${proof.complete} of ${proof.total} tasks were fully proven`,
  ].filter(Boolean);
  if (caveats.length) return { state: "review", detail: `Signed off by ${who} (${tasks}), but ${caveats.join(" and ")}.` };
  return { state: "recorded", detail: `Signed off by ${who} for this approved plan version (${tasks}, all fully proven).` };
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
