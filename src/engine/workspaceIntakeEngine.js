const SHA256 = /^[a-f0-9]{64}$/;

export const workspaceIntakeStages = Object.freeze([
  Object.freeze({ id: "17a", name: "Select" }),
  Object.freeze({ id: "17b", name: "Approve" }),
  Object.freeze({ id: "17c", name: "Index" }),
  Object.freeze({ id: "17d", name: "Map" }),
  Object.freeze({ id: "17e", name: "Review" }),
]);

const stepFor = (state) => ({ idle: 0, choosing: 0, selected: 1, registering: 1, scanning: 2, analyzing: 3, "inventory-ready": 3, partial: 4, "review-ready": 4, blocked: 4 }[state] ?? 0);

function blocked(reason, input = {}) {
  return Object.freeze({ state: "blocked", step: 4, reason, mutationAuthorized: false, ...input });
}

export function assessWorkspaceIntake({ selectedPath = "", registration = null, census = null, gaps = null, contractAssessment = null } = {}) {
  if (!selectedPath) return Object.freeze({ state: "idle", step: 0, reason: "Choose one app folder.", mutationAuthorized: false });
  if (!registration) return Object.freeze({ state: "selected", step: 1, reason: "Folder chosen. Starting the read-only scan.", mutationAuthorized: false });
  if (registration.authoritative !== true || registration.access !== "metadata-read-only") return blocked("Workspace registration is not authoritative metadata-only access.");
  if (!census) return Object.freeze({ state: "scanning", step: 2, reason: "The chosen folder is being indexed.", mutationAuthorized: false });
  if (census.authoritative !== true || census.contentReturned !== false) return blocked("Workspace census is not authoritative metadata-only evidence.");
  if (census.workspaceId !== registration.workspaceId || census.registryRevision !== registration.registryRevision || census.rootIdentity !== registration.rootIdentity) return blocked("Workspace census does not match the exact registered folder.");
  if (!SHA256.test(census.digest ?? "") || census.fileCount !== census.files?.length) return blocked("Workspace census identity or counts are invalid.");
  const skipped = census.skipped?.length ?? 0;
  if (!contractAssessment?.ready) return Object.freeze({ state: skipped ? "partial" : "inventory-ready", step: 3, reason: "Inventory captured. Architecture must be approved before files can be mapped to the folder contract.", skipped, mutationAuthorized: false });
  if (!gaps) return Object.freeze({ state: "analyzing", step: 3, reason: "Comparing the indexed app with the approved structure.", skipped, mutationAuthorized: false });
  if (gaps.censusDigest !== census.digest || gaps.mutationAuthorized !== false) return blocked("Gap analysis is not bound to the exact read-only census.");
  return Object.freeze({
    state: skipped ? "partial" : "review-ready",
    step: 4,
    reason: skipped ? `${skipped} files were skipped; review coverage before planning.` : "The app is indexed and ready for structure review.",
    skipped,
    mutationAuthorized: false,
  });
}

export function workspaceIntakeStageState(currentState, stageIndex) {
  const current = stepFor(currentState);
  return stageIndex < current ? "complete" : stageIndex === current ? "current" : "pending";
}

export function redactWorkspaceIntakeSummary({ registration, census, gaps }) {
  if (!registration || !census) return null;
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: registration.workspaceId,
    rootIdentity: registration.rootIdentity,
    registryRevision: registration.registryRevision,
    censusDigest: census.digest,
    fileCount: census.fileCount,
    skippedCount: census.skipped?.length ?? 0,
    structureCompletion: gaps?.completionPercentage ?? null,
    gapCount: gaps?.gaps?.length ?? null,
    unexpectedCount: gaps?.unexpected?.length ?? null,
    mutationAuthorized: false,
  });
}
