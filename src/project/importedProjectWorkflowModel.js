import { workspaceDiscoveryCategories } from "../engine/workspaceDiscoveryEngine.js";
import { deriveDiscoveryReview, discoveryReviewDetail } from "./discoveryReviewModel.js";
import { deriveProjectHomeModel } from "./projectHomeModel.js";
import { validateProjectSession } from "./projectSession.js";
import { deriveWorkRecordReceipt } from "./workRecordReceipts.js";
import { planApprovalStatus } from "./planApproval.js";
import { workflowNextAction } from "./workflowNextAction.js";

export const IMPORTED_WORKFLOW_MODEL_SCHEMA_VERSION = 1;

const SUPPORTED_WORKSPACES = new Set([
  "plan",
  "collision",
  "allocation",
  "build",
  "evidence",
  "integrity",
  "ledger",
  "index",
]);

const WORKSPACE_COPY = Object.freeze({
  plan: {
    eyebrow: "DEFINE · PROJECT-SCOPED PLANNING",
    title: "Planning intake",
    purpose: "Turn reviewed folder evidence into explicit decisions without borrowing tasks from the Demo project.",
    outcome: "One approved plan bound to this project, folder scan fingerprint, and saved approval revisions.",
    unlock: "Collision review begins only after the exact plan revision is approved.",
  },
  collision: {
    eyebrow: "COORDINATE · COLLISION CHECK",
    title: "Collision review",
    purpose: "Compare exact planned write claims before two workers can touch the same surface.",
    outcome: "A saved collision check for this project; a missing check is never shown as zero collisions.",
    unlock: "Allocation begins after collisions are resolved or explicitly serialized.",
  },
  allocation: {
    eyebrow: "COORDINATE · RESPONSIBILITY",
    title: "Allocation readiness",
    purpose: "Give every task a named owner (a person or an agent) and an order to run in.",
    outcome: "An owner and a wave for every current task, saved for this project. Branches and worktrees are not tracked in this version.",
    unlock: "Build begins after overlapping work is decided and every task has an owner.",
  },
  build: {
    eyebrow: "BUILD · GUARDED EXECUTION",
    title: "Build readiness",
    purpose: "Track each approved task: who owns it, what is in its way, and whether it is done.",
    outcome: "Every approved task marked done by the people doing the work.",
    unlock: "Proof comes next: attach a screenshot, code change, or test result for each finished task.",
  },
  evidence: {
    eyebrow: "PROVE · PROJECT EVIDENCE",
    title: "Evidence register",
    purpose: "Attach screenshots, code changes, and test results to each task so finished work can be checked.",
    outcome: "Every task has a screenshot, a code change, and a passing test, or a stated reason one is not needed.",
    unlock: "Integrity review begins once every task has its proof.",
  },
  integrity: {
    eyebrow: "PROVE · INDEPENDENT INTEGRITY",
    title: "Integrity readiness",
    purpose: "Check that every task is proven, then have a named reviewer sign off this exact version of the plan.",
    outcome: "Full proof, a sign-off on the current plan, and tests passing on the merged code.",
    unlock: "A changed plan needs a fresh sign-off; nothing is marked done from estimates.",
  },
  ledger: {
    eyebrow: "PROJECT LEDGER · SAVED STATUS",
    title: "Project record ledger",
    purpose: "List what this project actually saved and keep every missing workflow approval visible.",
    outcome: "One complete, project-bound history of inputs, decisions, work, conflicts, owners, and proof.",
    unlock: "No stage is promoted from an unrecorded or cross-project value.",
  },
  index: {
    eyebrow: "PROJECT INDEX · SAFE LOCATORS",
    title: "Project evidence index",
    purpose: "Search this project's tasks, discovery areas, saved plans, and proof in one place.",
    outcome: "A search built only from this project's own records, never the Demo.",
    unlock: "Indexed evidence can be reviewed; it does not become approved by appearing here.",
  },
});

const deepFreeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const compactDigest = (value) => typeof value === "string" && value.length >= 12
  ? `${value.slice(0, 12)}…`
  : null;

function effectiveState(project, recordedState) {
  if (project.state === "unavailable") return "unavailable";
  if (project.state === "stale") return "stale";
  return recordedState;
}

function receipt(id, label, state, detail, source = null) {
  return { id, label, state, detail, source };
}

function authorityReceipt(project, kind, label) {
  const authority = project.authorities?.[kind] ?? null;
  if (!authority) return receipt(`AUTH-${kind.toUpperCase()}`, label, effectiveState(project, "unanswered"), "No approval record is saved.");
  const state = authority.state === "authoritative"
    ? "recorded"
    : authority.state === "generated"
      ? "review"
      : authority.state;
  return receipt(
    `AUTH-${kind.toUpperCase()}`,
    label,
    effectiveState(project, state),
    `${authority.state} · revision ${authority.revision} · ${compactDigest(authority.digest)}`,
    authority.entityId,
  );
}

// The approved plan is recorded as a project work record (planAuthority); the
// session's own plan authority is used only when no such record exists.
function planReceipt(project, records) {
  const status = planApprovalStatus(project, records);
  if (!status) return authorityReceipt(project, "plan", "Plan approval");
  return receipt("AUTH-PLAN", "Plan approval", effectiveState(project, status.state), status.detail, status.revision ? `Saved plan approval · revision ${status.revision}` : null);
}

function sessionReceipts(project, records = null) {
  const registration = project.registration;
  const census = project.census;
  const discovery = project.discovery;
  // Discovery clears only when the user has decided every area that needs a decision for this exact scan.
  const discoveryReview = deriveDiscoveryReview(project, records);
  const discoveryState = discoveryReview.state;

  return [
    receipt("REC-PROJECT", "Project identity", effectiveState(project, "recorded"), `${project.projectId} · scan ${project.generation}`),
    receipt(
      "REC-REGISTRATION",
      "Folder registration",
      effectiveState(project, registration?.access === "metadata-read-only" ? "recorded" : "unavailable"),
      registration
        ? `${registration.rootLabel} · ${registration.adapter} · registry revision ${registration.registryRevision}`
        : "No folder registration is saved.",
    ),
    receipt(
      "REC-CENSUS",
      "Bounded folder scan",
      effectiveState(project, census ? (census.skippedCount > 0 ? "review" : "recorded") : "unanswered"),
      census
        ? `${census.fileCount.toLocaleString()} files · ${census.skippedCount} skipped · fingerprint ${compactDigest(census.digest)}`
        : "No folder scan is saved yet.",
    ),
    receipt(
      "REC-DISCOVERY",
      "Discovery snapshot",
      effectiveState(project, discoveryState),
      discovery
        ? `${discovery.counts.observed} observed · ${discovery.counts.signals} review signals · ${discovery.counts.unanswered} unanswered · ${discoveryReviewDetail(discoveryReview)}`
        : "No discovery snapshot is saved yet.",
    ),
    authorityReceipt(project, "architecture", "Architecture approval"),
    authorityReceipt(project, "folder", "Folder-contract approval"),
    authorityReceipt(project, "component", "Component approval"),
    planReceipt(project, records),
  ];
}

const missingReceipt = (id, label, detail) => receipt(id, label, "unanswered", detail);
// A work-record receipt replaces the missing placeholder only when the feature has recorded something.
const recordedOr = (records, context) => (id, label, detail) => {
  const derived = deriveWorkRecordReceipt(id, records, context);
  return derived ? receipt(id, label, derived.state, derived.detail, derived.source ?? null) : missingReceipt(id, label, detail);
};

function requirementsFor(workspace, receipts, records, project) {
  const missingReceipt = recordedOr(records, { project, receipts });
  const byId = new Map(receipts.map((item) => [item.id, item]));
  const authority = (kind) => byId.get(`AUTH-${kind.toUpperCase()}`);
  const registration = byId.get("REC-REGISTRATION");
  const census = byId.get("REC-CENSUS");
  const discovery = byId.get("REC-DISCOVERY");

  const plans = {
    plan: [
      registration,
      census,
      discovery,
      authority("architecture"),
      authority("folder"),
      authority("component"),
      authority("plan"),
    ],
    collision: [
      authority("plan"),
      authority("component"),
      missingReceipt("COL-EVALUATION", "Collision evaluation", "Tasks have not been checked for overlapping files yet."),
    ],
    allocation: [
      authority("plan"),
      missingReceipt("ALLOC-CLEARANCE", "Collision clearance", "Overlapping tasks have not been checked and decided yet."),
      missingReceipt("ALLOC-OWNERS", "Named owners", "No owners are saved for this project's tasks yet."),
    ],
    build: [
      authority("plan"),
      missingReceipt("BUILD-CLEARANCE", "Collision clearance", "Overlapping tasks have not been checked and decided yet."),
      missingReceipt("BUILD-ALLOCATION", "Allocation approval", "No owners are saved for this project's tasks yet."),
      missingReceipt("BUILD-RUN", "Approved tasks done", "No approved task has been marked done on the Build board yet."),
    ],
    evidence: [
      census,
      missingReceipt("PROOF-SCREENSHOT", "Screenshots", "No screenshot has been added for any task yet."),
      missingReceipt("PROOF-DIFF", "Code changes", "No code change has been added for any task yet."),
      missingReceipt("PROOF-TEST", "Test results", "No test result has been added for any task yet."),
    ],
    integrity: [
      authority("folder"),
      authority("plan"),
      missingReceipt("INT-PROOF", "Proof for every task", "No proof has been added for any task yet."),
      missingReceipt("INT-REVIEW", "Plan sign-off", "No one has signed off this plan yet."),
      missingReceipt("INT-MERGED", "Tests passed on the merged code", "No test result on the merged code has been added yet."),
    ],
    ledger: [
      ...receipts,
      missingReceipt("LEDGER-TASKS", "Saved task drafts", "No task drafts are saved for this project yet. Add the first task in the Ledger."),
    ],
    index: [
      ...receipts,
      missingReceipt("INDEX-BUILD", "Project search", "Search needs a folder scan of this project first."),
    ],
  };
  return plans[workspace];
}

function planningQuestions(project, records) {
  const categoryById = new Map((project.discovery?.categories ?? []).map((category) => [category.id, category]));
  const decisions = new Map(deriveDiscoveryReview(project, records).items.map((item) => [item.id, item.decision]));
  return workspaceDiscoveryCategories.map((definition) => {
    const category = categoryById.get(definition.id) ?? null;
    const decision = decisions.get(definition.id) ?? null;
    let state = decision ? "recorded" : !category ? "unanswered" : category.state === "observed" ? "recorded" : category.state === "signal" ? "review" : "unanswered";
    state = effectiveState(project, state);
    return {
      id: definition.id,
      title: definition.title,
      state,
      findingIds: category?.findingIds ?? [],
      questions: definition.questions,
      decision,
    };
  });
}

// Never routes to the open page; see workflowNextAction.js.
const nextActionFor = workflowNextAction;

/**
 * Read-only selector for imported-project workflow pages. It consumes one
 * validated ProjectSession and deliberately has no Demo-data fallback.
 */
export function deriveImportedProjectWorkflowModel(session, workspace, records = null) {
  if (!SUPPORTED_WORKSPACES.has(workspace)) throw new Error(`Unsupported imported-project workspace: ${String(workspace)}.`);
  const project = validateProjectSession(session);
  if (project.kind === "demo" || project.state === "demo") throw new Error("Demo projects cannot be rendered by the imported-project workflow.");

  const home = deriveProjectHomeModel(project, records);
  const receipts = sessionReceipts(project, records);
  const requirements = requirementsFor(workspace, receipts, records, project)
    .filter(Boolean)
    .map((item) => project.state === "unavailable" || project.state === "stale"
      ? { ...item, state: project.state }
      : item);
  const recordedCount = requirements.filter((item) => item.state === "recorded").length;
  const reviewCount = requirements.filter((item) => ["review", "stale"].includes(item.state)).length;
  const unansweredCount = requirements.length - recordedCount - reviewCount;
  const pageState = project.state === "unavailable"
    ? "unavailable"
    : project.state === "stale"
      ? "stale"
      : unansweredCount > 0 || reviewCount > 0
        ? "unanswered"
        : "recorded";

  return deepFreeze({
    schemaVersion: IMPORTED_WORKFLOW_MODEL_SCHEMA_VERSION,
    workspace,
    copy: WORKSPACE_COPY[workspace],
    project: home.project,
    binding: home.binding,
    pageState,
    counts: { recorded: recordedCount, review: reviewCount, unanswered: unansweredCount, total: requirements.length },
    requirements,
    questions: workspace === "plan" || workspace === "index" ? planningQuestions(project, records) : [],
    nextAction: nextActionFor(workspace, requirements),
    caveats: [
      ...(project.census?.skippedCount > 0 ? [`${project.census.skippedCount} folder scan item${project.census.skippedCount === 1 ? " was" : "s were"} skipped; coverage is incomplete.`] : []),
      ...(project.registration?.persistence === "reselect-required" ? ["Folder access must be reselected after this browser session."] : []),
      "Recorded metadata is evidence about structure, not proof that a workflow action occurred.",
    ],
  });
}
