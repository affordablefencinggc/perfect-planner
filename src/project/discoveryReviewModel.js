// Discovery review: the user's per-category decision on what the folder scan found.
// A review only counts for the exact discovery snapshot it was made against; a newer
// scan leaves earlier decisions on record but no longer applies them. Nothing here
// infers a decision: an area without one stays open.
import { workspaceDiscoveryCategories } from "../engine/workspaceDiscoveryEngine.js";

export const DISCOVERY_REVIEW_SCHEMA_VERSION = 1;
export const DISCOVERY_DECISIONS = Object.freeze(["confirmed", "not-applicable", "answered"]);
export const DISCOVERY_NOTE_LIMIT = 500;

/** Identifies the discovery snapshot a review is bound to, or null when there is none. */
export function discoverySnapshotOf(project) {
  const discovery = project?.discovery ?? null;
  if (!discovery) return null;
  return {
    censusDigest: discovery.censusDigest ?? null,
    generatedAt: discovery.generatedAt ?? null,
    generation: discovery.censusDigest || discovery.generatedAt ? null : project.generation ?? null,
  };
}

const sameSnapshot = (left, right) => !!left && !!right
  && (left.censusDigest ?? null) === (right.censusDigest ?? null)
  && (left.generatedAt ?? null) === (right.generatedAt ?? null)
  && (left.generation ?? null) === (right.generation ?? null);

function validDecision(value) {
  if (!value || typeof value !== "object" || !DISCOVERY_DECISIONS.includes(value.decision)) return null;
  const note = typeof value.note === "string" ? value.note.slice(0, DISCOVERY_NOTE_LIMIT) : "";
  if (value.decision === "answered" && !note.trim()) return null;
  return { decision: value.decision, note, decidedAt: typeof value.decidedAt === "string" ? value.decidedAt : null };
}

/** Every category the review covers: the eight standard areas plus any extra the snapshot holds. */
function reviewCategories(discovery) {
  const recorded = new Map((discovery?.categories ?? []).map((category) => [category.id, category]));
  const definitions = new Map(workspaceDiscoveryCategories.map((definition) => [definition.id, definition]));
  const ids = [...definitions.keys(), ...[...recorded.keys()].filter((id) => !definitions.has(id))];
  return ids.map((id) => {
    const definition = definitions.get(id) ?? null;
    const category = recorded.get(id) ?? null;
    return {
      id,
      title: definition?.title ?? id,
      questions: definition?.questions ?? [],
      state: category?.state ?? "unanswered",
      findingIds: category?.findingIds ?? [],
      findingCount: category?.findingCount ?? 0,
    };
  });
}

/**
 * Pure selector. `records` is the result of readWorkRecords/useProjectWorkRecords.
 * state: "unanswered" (no snapshot), "stale"/"unavailable" (snapshot not usable),
 * "review" (some area still needs a decision), "recorded" (every area that needs one has one).
 */
export function deriveDiscoveryReview(project, records = null) {
  const discovery = project?.discovery ?? null;
  const snapshot = discoverySnapshotOf(project);
  const section = records?.sections?.discoveryReview ?? null;
  const data = section?.data ?? null;
  const applies = !!data && sameSnapshot(data.snapshot, snapshot);
  const outdated = !!data && !applies && Object.keys(data.categories ?? {}).length > 0;
  const decisions = applies ? data.categories ?? {} : {};
  const items = reviewCategories(discovery).map((category) => {
    const decision = validDecision(decisions[category.id]);
    return { ...category, needsDecision: category.state !== "observed", decision };
  });
  const required = items.filter((item) => item.needsDecision);
  const decided = required.filter((item) => item.decision).length;
  let state;
  if (!discovery) state = "unanswered";
  else if (discovery.state === "stale" || discovery.state === "unavailable") state = discovery.state;
  else state = decided === required.length ? "recorded" : "review";
  return {
    state,
    snapshot,
    revision: applies ? section.revision : null,
    recordedAt: applies ? section.recordedAt : null,
    outdated,
    items,
    required: required.length,
    decided,
    open: required.length - decided,
  };
}

/**
 * Returns the next discoveryReview section data after deciding (or clearing, when
 * decision is null) one category. Decisions made against another snapshot are dropped.
 */
export function nextDiscoveryReviewData(project, previousData, categoryId, decision, { note = "", now = () => new Date().toISOString() } = {}) {
  const snapshot = discoverySnapshotOf(project);
  if (!snapshot) throw new Error("DISCOVERY_REVIEW_SNAPSHOT_REQUIRED");
  if (project.discovery.state !== "generated") throw new Error("DISCOVERY_REVIEW_SNAPSHOT_NOT_CURRENT");
  if (typeof categoryId !== "string" || !categoryId) throw new Error("DISCOVERY_REVIEW_CATEGORY_REQUIRED");
  if (decision !== null && !DISCOVERY_DECISIONS.includes(decision)) throw new Error("DISCOVERY_REVIEW_DECISION_INVALID");
  const text = String(note ?? "").trim().slice(0, DISCOVERY_NOTE_LIMIT);
  if (decision === "answered" && !text) throw new Error("DISCOVERY_REVIEW_ANSWER_REQUIRED");
  const kept = previousData && sameSnapshot(previousData.snapshot, snapshot) ? { ...(previousData.categories ?? {}) } : {};
  if (decision === null) delete kept[categoryId];
  else kept[categoryId] = { decision, note: text, decidedAt: now() };
  return { schemaVersion: DISCOVERY_REVIEW_SCHEMA_VERSION, snapshot, categories: kept };
}

/** Plain-language one-line summary used by receipts and Home. */
export function discoveryReviewDetail(review) {
  if (review.state === "unanswered") return "No folder scan has been reviewed yet.";
  if (review.required === 0) return "Every area had clear findings; nothing needs your answer.";
  const base = `${review.decided} of ${review.required} area${review.required === 1 ? "" : "s"} reviewed`;
  if (review.open === 0) return `${base} for the current scan.`;
  return `${base} · ${review.open} still need${review.open === 1 ? "s" : ""} your answer${review.outdated ? " (earlier answers were for an older scan)" : ""}.`;
}
