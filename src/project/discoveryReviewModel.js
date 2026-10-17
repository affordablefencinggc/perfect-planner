// Discovery review: the user's per-category decision on what the folder scan found.
// A review only counts for the exact discovery snapshot it was made against; a newer
// scan leaves earlier decisions on record but no longer applies them. Nothing here
// infers a decision: an area without one stays open.
import { workspaceDiscoveryCategories } from "../engine/workspaceDiscoveryEngine.js";
import { writeSection } from "./projectWorkRecords.js";

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

/**
 * Area counts shared by Home and the review panel, so both screens use one unit.
 * `signals` and `unanswered` count only areas that still need the user's answer;
 * an answered area clears from both.
 */
export function discoveryAreaCounts(review) {
  const items = review?.items ?? [];
  const open = (state) => items.filter((item) => item.state === state && item.needsDecision && !item.decision).length;
  return {
    total: items.length,
    observed: items.filter((item) => item.state === "observed").length,
    signals: open("signal"),
    unanswered: open("unanswered"),
    required: review?.required ?? 0,
    decided: review?.decided ?? 0,
    open: review?.open ?? 0,
  };
}

// Saved finding details: labels, certainty, short generated details and up to three
// evidence paths per finding. Metadata only — never file contents — and bound to the
// exact scan, so "Review what we found" can still show them after a reload.
export const DISCOVERY_FINDINGS_SCHEMA_VERSION = 1;
export const DISCOVERY_FINDINGS_LIMITS = Object.freeze({
  maxAreas: 16,
  maxFindingsPerArea: 24,
  maxEvidencePerFinding: 3,
  maxPathCharacters: 512,
  maxLabelCharacters: 120,
  maxDetailCharacters: 280,
});
const AREA_ID = /^[A-Z][A-Z0-9-]{1,31}$/;
const FINDING_ID = /^[a-zA-Z0-9._:-]{1,96}$/;
const CERTAINTIES = Object.freeze(["observed", "signal"]);

const clip = (value, limit) => (value.length <= limit ? value : `${value.slice(0, limit - 1)}…`);

function safeEvidencePath(value) {
  if (typeof value !== "string" || !value || value.length > DISCOVERY_FINDINGS_LIMITS.maxPathCharacters) return null;
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.split("/").some((part) => part === "..")) return null;
  return value;
}

function cleanFinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.id !== "string" || !FINDING_ID.test(value.id)) return null;
  if (typeof value.label !== "string" || !value.label.trim() || !CERTAINTIES.includes(value.certainty)) return null;
  const evidenceSource = Array.isArray(value.evidence) ? value.evidence : [];
  const evidence = evidenceSource.slice(0, DISCOVERY_FINDINGS_LIMITS.maxEvidencePerFinding).map(safeEvidencePath).filter(Boolean);
  const count = Number.isSafeInteger(value.evidenceCount) && value.evidenceCount >= evidence.length ? value.evidenceCount : evidence.length;
  return {
    id: value.id,
    label: clip(value.label, DISCOVERY_FINDINGS_LIMITS.maxLabelCharacters),
    certainty: value.certainty,
    evidence,
    evidenceCount: count,
    detail: typeof value.detail === "string" ? clip(value.detail, DISCOVERY_FINDINGS_LIMITS.maxDetailCharacters) : "",
  };
}

function cleanAreas(entries) {
  const areas = {};
  for (const [id, findings] of entries.slice(0, DISCOVERY_FINDINGS_LIMITS.maxAreas)) {
    if (typeof id !== "string" || !AREA_ID.test(id) || !Array.isArray(findings)) continue;
    areas[id] = findings.slice(0, DISCOVERY_FINDINGS_LIMITS.maxFindingsPerArea).map(cleanFinding).filter(Boolean);
  }
  return areas;
}

/** The discoveryFindings section data for a scan result, bound to the project's saved scan. */
export function discoveryFindingsData(project, discovery) {
  const snapshot = discoverySnapshotOf(project);
  if (!snapshot) throw new Error("DISCOVERY_FINDINGS_SNAPSHOT_REQUIRED");
  const categories = Array.isArray(discovery?.categories) ? discovery.categories : [];
  return {
    schemaVersion: DISCOVERY_FINDINGS_SCHEMA_VERSION,
    snapshot,
    categories: cleanAreas(categories.map((category) => [category?.id, category?.findings])),
  };
}

/** Saves the finding details for this scan. Returns the stored record, or null when nothing could be saved. */
export function saveDiscoveryFindings(project, discovery, { storage, now } = {}) {
  if (!project?.projectId || !project.discovery || !Array.isArray(discovery?.categories)) return null;
  const data = discoveryFindingsData(project, discovery);
  const options = {};
  if (storage !== undefined) options.storage = storage;
  if (now) options.now = now;
  return writeSection(project.projectId, "discoveryFindings", data, options);
}

/** Saved finding details by area for the project's current scan; empty when none apply. */
export function savedDiscoveryFindings(project, records = null) {
  const data = records?.sections?.discoveryFindings?.data ?? null;
  if (!data || typeof data !== "object" || data.schemaVersion !== DISCOVERY_FINDINGS_SCHEMA_VERSION) return new Map();
  if (!sameSnapshot(data.snapshot, discoverySnapshotOf(project))) return new Map();
  const categories = data.categories && typeof data.categories === "object" && !Array.isArray(data.categories) ? data.categories : {};
  return new Map(Object.entries(cleanAreas(Object.entries(categories))));
}

/** Plain-language one-line summary used by receipts and Home. */
export function discoveryReviewDetail(review) {
  if (review.state === "unanswered") return "No folder scan has been reviewed yet.";
  if (review.required === 0) return "Every area had clear findings; nothing needs your answer.";
  const base = `${review.decided} of ${review.required} area${review.required === 1 ? "" : "s"} reviewed`;
  if (review.open === 0) return `${base} for the current scan.`;
  return `${base} · ${review.open} still need${review.open === 1 ? "s" : ""} your answer${review.outdated ? " (earlier answers were for an older scan)" : ""}.`;
}
