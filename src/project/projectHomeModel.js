import { projectAuthorityKinds, validateProjectSession } from "./projectSession.js";
import { deriveDiscoveryReview } from "./discoveryReviewModel.js";
import { effectivePlanAuthority } from "./planApproval.js";
import { allocationStatus, collisionStatus, overlapReviewText, recordOverlapReview } from "./taskCoordination.js";

export const PROJECT_HOME_MODEL_SCHEMA_VERSION = 1;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function unavailableAuthority() {
  return {
    state: "unavailable",
    recordedState: null,
    entityId: null,
    digest: null,
    revision: null,
    recordedAt: null,
  };
}

function effectiveFactState(sessionState, presentState) {
  if (sessionState === "unavailable") return "unavailable";
  if (sessionState === "stale") return "stale";
  return presentState;
}

function summarizeRegistration(project) {
  const registration = project?.registration ?? null;
  const recordedState = !registration || registration.access === "unavailable" ? "unavailable"
    : registration.persistence === "durable" ? "available"
      : "attention";
  return {
    state: effectiveFactState(project?.state, recordedState),
    rootLabel: registration?.rootLabel ?? null,
    adapter: registration?.adapter ?? null,
    access: registration?.access ?? null,
    persistence: registration?.persistence ?? null,
    revision: registration?.registryRevision ?? null,
  };
}

function summarizeCensus(project) {
  const census = project?.census ?? null;
  const recordedState = !census ? "unavailable" : census.skippedCount > 0 ? "blocked" : "available";
  return {
    state: effectiveFactState(project?.state, recordedState),
    fileCount: census?.fileCount ?? null,
    skippedCount: census?.skippedCount ?? null,
    totalBytesHashed: census?.totalBytesHashed ?? null,
    digest: census?.digest ?? null,
    revision: census?.registryRevision ?? null,
    generatedAt: census?.generatedAt ?? null,
  };
}

// A recorded user review of every open area for this exact scan resolves the discovery gaps.
const discoveryReviewed = (project, records) => deriveDiscoveryReview(project, records).state === "recorded";

function discoveryNeedsReview(discovery, reviewed = false) {
  if (!discovery || reviewed) return false;
  return discovery.counts.observed === 0
    || discovery.counts.signals > 0
    || discovery.counts.unanswered > 0
    || discovery.categories.length === 0
    || discovery.categories.some((category) => category.state !== "observed");
}

function summarizeDiscovery(project, records = null) {
  const discovery = project?.discovery ?? null;
  const review = discovery ? deriveDiscoveryReview(project, records) : null;
  let recordedState = "unavailable";
  if (discovery?.state === "stale") recordedState = "stale";
  else if (discovery?.state === "unavailable") recordedState = "unavailable";
  else if (discoveryNeedsReview(discovery, review?.state === "recorded")) recordedState = "review";
  else if (discovery) recordedState = "available";
  return {
    state: effectiveFactState(project?.state, recordedState),
    observed: discovery?.counts.observed ?? null,
    signals: discovery?.counts.signals ?? null,
    unanswered: discovery?.counts.unanswered ?? null,
    categoryCount: discovery?.categories.length ?? null,
    censusDigest: discovery?.censusDigest ?? null,
    generatedAt: discovery?.generatedAt ?? null,
    reviewRequired: review?.required ?? null,
    reviewDecided: review?.decided ?? null,
  };
}

// Overlapping tasks, read from the decisions saved on the Collision page. A
// missing check is "unavailable", never "no overlaps".
function summarizeOverlaps(project, records = null) {
  const data = project ? records?.sections?.collisions?.data : null;
  if (!data || typeof data !== "object") return { state: "unavailable", total: null, decided: null, splitPending: null, open: null, text: null, lines: [] };
  const stale = Boolean(data.censusDigest && project?.census?.digest && data.censusDigest !== project.census.digest);
  const review = recordOverlapReview(data);
  const { headline, lines } = overlapReviewText(review);
  const settled = review.settled === review.total;
  return {
    state: stale ? "stale" : settled ? "available" : "review",
    total: review.total,
    decided: review.settled,
    splitPending: review.splitPending,
    open: review.open,
    text: stale ? "The project folder changed since tasks were checked for overlaps. Check them again on the Collision page." : headline ?? "No overlapping files found.",
    lines: lines.filter((line, index) => review.items[index].state !== "decided"),
  };
}

function summarizeAuthorities(project) {
  return Object.fromEntries(projectAuthorityKinds.map((kind) => {
    const authority = project?.authorities?.[kind] ?? null;
    if (!authority) return [kind, unavailableAuthority()];
    return [kind, {
      state: effectiveFactState(project.state, authority.state),
      recordedState: authority.state,
      entityId: authority.entityId,
      digest: authority.digest,
      revision: authority.revision,
      recordedAt: authority.recordedAt,
    }];
  }));
}

function bindingFor(project) {
  return {
    projectId: project?.projectId ?? null,
    sessionGeneration: project?.generation ?? null,
    sessionSchemaVersion: project?.schemaVersion ?? null,
    registryRevision: project?.registration?.registryRevision ?? null,
    censusDigest: project?.census?.digest ?? null,
    discoveryDigest: project?.discovery?.censusDigest ?? null,
    sessionUpdatedAt: project?.updatedAt ?? null,
    authorityRevisions: Object.fromEntries(projectAuthorityKinds.map((kind) => [kind, project?.authorities?.[kind]?.revision ?? null])),
  };
}

function blocker(id, scope, state, reason) {
  return { id, scope, state, reason };
}

function action(id, label, workspace, reason) {
  return { id, label, workspace, reason };
}

function emptyModel() {
  return deepFreeze({
    schemaVersion: PROJECT_HOME_MODEL_SCHEMA_VERSION,
    mode: "empty",
    project: { projectId: null, name: null, kind: "empty", state: "empty", generation: null },
    binding: bindingFor(null),
    stage: { id: "empty", state: "empty", label: "No project selected" },
    summary: {
      message: "No project evidence is active.",
      registration: summarizeRegistration(null),
      census: summarizeCensus(null),
      discovery: summarizeDiscovery(null),
      overlaps: summarizeOverlaps(null),
      authorities: summarizeAuthorities(null),
    },
    blockers: [blocker("project-missing", "project", "unavailable", "No project identity is active.")],
    nextAction: action("select-project", "Choose an app folder", "structure", "Save a redacted registration record before any project status is shown."),
  });
}

function demoModel(project) {
  return deepFreeze({
    schemaVersion: PROJECT_HOME_MODEL_SCHEMA_VERSION,
    mode: "demo",
    project: { projectId: project.projectId, name: project.name, kind: project.kind, state: project.state, generation: project.generation },
    binding: bindingFor(project),
    stage: { id: "demo", state: "demo", label: "Demonstration project" },
    summary: {
      message: "Demo data is isolated and is not evidence about an imported project.",
      registration: summarizeRegistration(project),
      census: summarizeCensus(project),
      discovery: summarizeDiscovery(project),
      overlaps: summarizeOverlaps(null),
      authorities: summarizeAuthorities(project),
    },
    blockers: [blocker("demo-not-project-evidence", "project", "demo", "Demonstration fixtures cannot promote an imported project.")],
    nextAction: action("select-real-project", "Choose a real app folder", "structure", "Import project evidence when work must apply to a real app."),
  });
}

function collectBlockers(project, records = null) {
  const blockers = [];
  const registration = project.registration;
  const census = project.census;
  const discovery = project.discovery;

  if (!registration) blockers.push(blocker("registration-missing", "registration", "unavailable", "No registered workspace record is available."));
  else if (registration.access === "unavailable") blockers.push(blocker("registration-access-unavailable", "registration", "unavailable", "Registered workspace access is unavailable."));

  if (!census) blockers.push(blocker("census-missing", "census", "unavailable", "No project-bound folder scan record is available."));
  else if (census.skippedCount > 0) blockers.push(blocker("census-skipped-files", "census", "blocked", `${census.skippedCount} indexed item${census.skippedCount === 1 ? " was" : "s were"} skipped.`));

  if (!discovery) blockers.push(blocker("discovery-missing", "discovery", "unavailable", "No discovery snapshot is available."));
  else if (discovery.state === "generated" && discoveryReviewed(project, records)) { /* every open area has the user's decision */ }
  else {
    if (discovery.state === "stale") blockers.push(blocker("discovery-stale", "discovery", "stale", "The discovery snapshot is stale."));
    if (discovery.state === "unavailable") blockers.push(blocker("discovery-unavailable", "discovery", "unavailable", "The discovery snapshot is unavailable."));
    if (discovery.counts.observed === 0) blockers.push(blocker("discovery-observations-missing", "discovery", "review", "The discovery snapshot contains no observed project facts."));
    if (discovery.counts.signals > 0) blockers.push(blocker("discovery-signals-unreviewed", "discovery", "review", `${discovery.counts.signals} discovery signal${discovery.counts.signals === 1 ? " needs" : "s need"} review.`));
    if (discovery.counts.unanswered > 0) blockers.push(blocker("discovery-questions-unanswered", "discovery", "review", `${discovery.counts.unanswered} discovery categor${discovery.counts.unanswered === 1 ? "y is" : "ies are"} unanswered.`));
    if (discovery.categories.length === 0) blockers.push(blocker("discovery-categories-missing", "discovery", "review", "No discovery categories are recorded."));
  }

  for (const kind of projectAuthorityKinds) {
    const authority = project.authorities[kind];
    if (!authority) blockers.push(blocker(`authority-${kind}-missing`, kind, "unavailable", `No saved ${kind} record is available.`));
    else if (authority.state === "unavailable") blockers.push(blocker(`authority-${kind}-unavailable`, kind, "unavailable", `The saved ${kind} record is unavailable.`));
    else if (authority.state === "stale") blockers.push(blocker(`authority-${kind}-stale`, kind, "stale", `The saved ${kind} record is out of date.`));
    else if (authority.state !== "authoritative") blockers.push(blocker(`authority-${kind}-unapproved`, kind, "review", `The ${kind} record is generated but not approved yet.`));
  }

  const overlaps = summarizeOverlaps(project, records);
  if (overlaps.state === "stale") blockers.push(blocker("collisions-stale", "collision", "stale", overlaps.text));
  else if (overlaps.state === "review") blockers.push(blocker("collisions-undecided", "collision", "review", [`${overlaps.text}.`, ...overlaps.lines].join(" ")));
  return blockers;
}

// Plan-specific copy when the plan comes from the saved approval (work record).
function planStage(authority, planStatus) {
  if (!authority) return {
    stage: { id: "plan", state: "unavailable", label: "Plan approval required" },
    nextAction: action("approve-plan", "Approve the plan", "plan", "Add tasks in the Ledger, then approve them on the Plan page."),
  };
  if (!planStatus || authority.state === "authoritative") return null;
  if (planStatus.state === "unavailable") return {
    stage: { id: "plan", state: "unavailable", label: "Saved plan approval unreadable" },
    nextAction: action("approve-plan", "Approve the plan again", "plan", planStatus.detail),
  };
  if (planStatus.state === "stale") return {
    stage: { id: "plan", state: "stale", label: "Plan approval out of date" },
    nextAction: action("refresh-plan-approval", "Review and approve the plan", "plan", planStatus.detail),
  };
  return {
    stage: { id: "plan", state: "review", label: "Tasks changed since approval" },
    nextAction: action("reapprove-plan", "Review and approve the plan", "plan", planStatus.detail),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sameSet = (left, right) => left.length === right.length && [...left].sort().join("|") === [...right].sort().join("|");

/**
 * Overlap and owner steps between an approved plan and readiness. Each saved
 * record must cover exactly the approved tasks; nothing here is inferred.
 */
function coordinationGaps(records, planStatus) {
  const approved = planStatus?.record?.taskIds;
  if (planStatus?.state !== "recorded" || !Array.isArray(approved)) return [];
  const gaps = [];
  const collisions = records?.sections?.collisions?.data;
  const checkedIds = collisions ? [...(collisions.checkedTaskIds ?? []), ...(collisions.uncheckedTaskIds ?? []), ...(collisions.invalid ?? []).map((item) => item?.taskId)] : [];
  if (!collisions || typeof collisions !== "object") gaps.push({ id: "collision-check-missing", workspace: "collision", label: "Check tasks for overlapping work", reason: "The approved tasks have not been checked for overlapping files yet." });
  else if (!sameSet(checkedIds, approved)) gaps.push({ id: "collision-check-stale", workspace: "collision", label: "Check overlapping work again", reason: "The saved overlap check covers a different set of tasks than the approved plan." });
  else {
    const status = collisionStatus(collisions);
    if (status.open) gaps.push({ id: "collision-undecided", workspace: "collision", label: "Decide overlapping work", reason: `${status.open} of ${plural(status.total, "overlap")} still ${status.open === 1 ? "needs" : "need"} a decision.` });
  }
  const allocation = records?.sections?.allocation?.data;
  if (!allocation || typeof allocation !== "object") gaps.push({ id: "owners-missing", workspace: "allocation", label: "Assign owners", reason: "No task has a saved owner yet." });
  else if (!sameSet(Array.isArray(allocation.taskIds) ? allocation.taskIds : [], approved)) gaps.push({ id: "owners-stale", workspace: "allocation", label: "Review owners again", reason: "The saved owners were set for a different set of tasks than the approved plan." });
  else {
    const status = allocationStatus(allocation);
    if (status.missing) gaps.push({ id: "owners-incomplete", workspace: "allocation", label: "Assign owners", reason: `${status.missing} of ${plural(status.tasks, "task")} still ${status.missing === 1 ? "needs" : "need"} an owner.` });
  }
  return gaps;
}

function nextStage(project, records = null, planStatus = null) {
  const registration = project.registration;
  const census = project.census;
  const discovery = project.discovery;

  if (project.state === "unavailable") return {
    stage: { id: "unavailable", state: "unavailable", label: "Project record unavailable" },
    nextAction: action("restore-project-authority", "Restore project access", "structure", "Reconnect the exact registered project before using last-known facts."),
  };
  if (project.state === "stale") return {
    stage: { id: "stale", state: "stale", label: "Project evidence stale" },
    nextAction: action("refresh-project-evidence", "Refresh project evidence", "structure", "Take a new project-bound folder scan and discovery snapshot."),
  };
  if (!registration || registration.access === "unavailable") return {
    stage: { id: "registration", state: "unavailable", label: "Workspace registration required" },
    nextAction: action("register-workspace", "Register the app folder", "structure", "Establish a redacted project identity before reading project facts."),
  };
  if (!census) return {
    stage: { id: "census", state: "unavailable", label: "Workspace folder scan required" },
    nextAction: action("capture-census", "Run the read-only folder scan", "structure", "Bind a complete folder scan to this registration revision."),
  };
  if (census.skippedCount > 0) return {
    stage: { id: "census-review", state: "blocked", label: "Folder scan coverage incomplete" },
    nextAction: action("resolve-skipped-files", "Review skipped folder scan items", "structure", "Resolve or explicitly bound incomplete coverage before promotion."),
  };
  if (!discovery) return {
    stage: { id: "discovery", state: "unavailable", label: "Discovery snapshot required" },
    nextAction: action("generate-discovery", "Generate project discovery", "structure", "Derive project questions and signals from the current folder scan."),
  };
  if (discovery.state === "unavailable") return {
    stage: { id: "discovery", state: "unavailable", label: "Discovery unavailable" },
    nextAction: action("restore-discovery", "Restore project discovery", "structure", "Regenerate discovery from the bound census."),
  };
  if (discovery.state === "stale") return {
    stage: { id: "discovery-review", state: "stale", label: "Discovery snapshot stale" },
    nextAction: action("refresh-discovery", "Refresh project discovery", "structure", "Replace the stale discovery snapshot before promotion."),
  };
  if (discoveryNeedsReview(discovery, discoveryReviewed(project, records))) return {
    stage: { id: "discovery-review", state: "review", label: "Discovery review required" },
    nextAction: action("review-discovery", "Review discovery gaps", "structure", "Resolve signals, unanswered categories, and missing observations."),
  };

  for (const kind of projectAuthorityKinds) {
    const authority = project.authorities[kind];
    const workspace = kind === "architecture" ? "blueprint" : kind === "folder" ? "structure" : kind === "component" ? "components" : "plan";
    const capitalized = `${kind[0].toUpperCase()}${kind.slice(1)}`;
    if (kind === "plan") { const plan = planStage(authority, planStatus); if (plan) return plan; }
    if (!authority || authority.state === "unavailable") return {
      stage: { id: kind, state: "unavailable", label: `${capitalized} record required` },
      nextAction: action(`generate-${kind}-authority`, `Generate ${kind} record`, workspace, `Create a project-bound ${kind} revision from current evidence.`),
    };
    if (authority.state === "stale") return {
      stage: { id: kind, state: "stale", label: `${capitalized} record out of date` },
      nextAction: action(`refresh-${kind}-authority`, `Refresh ${kind} record`, workspace, `Replace the out-of-date ${kind} record before promotion.`),
    };
    if (authority.state !== "authoritative") return {
      stage: { id: kind, state: "review", label: `${capitalized} approval required` },
      nextAction: action(`approve-${kind}-authority`, `Review ${kind} record`, workspace, `Approve or reject the exact generated ${kind} revision.`),
    };
  }

  // Ready needs an explicit confirmation: either a promoted session, or the
  // user's "Confirm project is ready" recorded against the current approved plan.
  const gaps = coordinationGaps(records, planStatus);
  if (project.state !== "authoritative" && !planStatus?.confirmed && gaps.length) return {
    stage: { id: gaps[0].workspace, state: "review", label: gaps[0].label },
    nextAction: action(gaps[0].id, gaps[0].label, gaps[0].workspace, gaps[0].reason),
  };
  if (project.state !== "authoritative" && !planStatus?.confirmed) return {
    stage: { id: "promotion", state: "review", label: "Confirm the project is ready" },
    nextAction: planStatus?.state === "recorded"
      ? action("confirm-project-ready", "Confirm project is ready", null, "Every planning step is recorded. Confirm to mark this project ready for coordinated work.")
      : action("approve-plan", "Approve the plan", "plan", "Approve the current tasks on the Plan page so the readiness confirmation has a plan to belong to."),
  };
  return {
    stage: { id: "ready", state: "ready", label: "Project status ready" },
    nextAction: action("open-authoritative-plan", "Open the approved plan", "plan", "Continue from the current project-bound approved plan."),
  };
}

function summaryMessage(project, stage) {
  if (project.state === "unavailable") return "Project facts are unavailable; last-known values cannot be presented as current.";
  if (project.state === "stale") return "Project facts are stale and cannot promote work until refreshed.";
  if (stage.id === "ready") return "Registration, folder scan, discovery, and required records are current for this project revision.";
  if (project.state === "generated") return "Generated project evidence exists, but unresolved review or authority work blocks promotion.";
  if (project.state === "authoritative") return "The session is marked approved, but required evidence gaps still block promotion.";
  return "Imported project evidence is registered; missing or unreviewed facts remain unavailable.";
}

/**
 * Derive a read-only home aggregate from one validated ProjectSession. The
 * selector never consults Demo fixtures, ambient registry state, or another
 * project. Pass null when there is no active project.
 */
export function deriveProjectHomeModel(session, records = null) {
  if (session == null || (session.state === "empty" && session.project == null && !session.kind)) return emptyModel();
  const validated = validateProjectSession(session);
  if (validated.kind === "empty" || validated.state === "empty") return emptyModel();
  if (validated.kind === "demo" || validated.state === "demo") return demoModel(validated);

  // The saved plan approval (work record), when present, stands in for the plan authority.
  const plan = effectivePlanAuthority(validated, records);
  const project = plan.status ? { ...validated, authorities: { ...validated.authorities, plan: plan.authority } } : validated;
  const { stage, nextAction } = nextStage(project, records, plan.status);
  const blockers = collectBlockers(project, records);
  if (project.state === "stale") blockers.unshift(blocker("project-stale", "project", "stale", "The active ProjectSession is stale."));
  if (project.state === "unavailable") blockers.unshift(blocker("project-unavailable", "project", "unavailable", "The active project session record is unavailable."));
  // Undecided overlaps are already listed by collectBlockers (collisions-undecided).
  for (const gap of coordinationGaps(records, plan.status).filter((item) => item.id !== "collision-undecided")) blockers.push(blocker(gap.id, gap.workspace, "review", gap.reason));
  if (stage.id === "promotion") blockers.push(blocker("project-promotion-pending", "project", "review", "Every planning step is recorded, but nobody has confirmed the project is ready yet."));

  return deepFreeze({
    schemaVersion: PROJECT_HOME_MODEL_SCHEMA_VERSION,
    mode: project.state,
    project: { projectId: project.projectId, name: project.name, kind: project.kind, state: project.state, generation: project.generation },
    binding: bindingFor(project),
    stage,
    summary: {
      message: summaryMessage(project, stage),
      registration: summarizeRegistration(project),
      census: summarizeCensus(project),
      discovery: summarizeDiscovery(project, records),
      overlaps: summarizeOverlaps(project, records),
      authorities: summarizeAuthorities(project),
    },
    blockers,
    nextAction,
  });
}
