// Build board for imported projects: one card per approved task, built only from
// the saved task drafts, the checked plan approval and recorded work records.
// Statuses are what the user set; nothing here infers that work happened.
import { canonicalArchitectureJson as canonical } from "../engine/architectureContractVerification.js";
import { inspectTaskDraft } from "./taskDraftLedger.js";
import { allocationByTask, approvedTaskIdsFrom, proofItems, recordedCollisions } from "./workRecordReaders.js";
import { uniquePaths } from "./taskCoordination.js";

export const BUILD_STATES = Object.freeze(["not-started", "in-progress", "done", "blocked"]);
export const BUILD_STATE_LABELS = Object.freeze({ "not-started": "Not started", "in-progress": "In progress", done: "Done", blocked: "Blocked" });
export const BUILD_NOTE_LIMIT = 500;

const sameIds = (left, right) => left.length === right.length && [...left].sort().join("|") === [...right].sort().join("|");

/** Which tasks are approved, and where that came from. Never guesses. */
export function resolveApprovedTasks({ project, ledger, sections, planStatus }) {
  const recorded = approvedTaskIdsFrom(sections);
  if (recorded) {
    return { state: "approved", source: "recorded", taskIds: recorded, changed: false, revision: sections.planAuthority.revision ?? null, sourceTasks: ledger?.tasks ?? [] };
  }
  const matchesProject = planStatus && planStatus.projectId === project?.projectId;
  if (matchesProject && planStatus.state === "observed" && planStatus.checkedLedger) {
    const checked = planStatus.checkedLedger;
    const taskIds = (checked.tasks ?? []).filter((task) => !task.archived).map((task) => task.id);
    const changed = Boolean(ledger) && canonical(checked) !== canonical(ledger);
    return { state: "approved", source: "plan-approval", taskIds, changed, revision: planStatus.revision ?? null, sourceTasks: checked.tasks ?? [] };
  }
  return { state: matchesProject ? planStatus.state ?? "missing" : "missing", source: null, taskIds: [], changed: false, revision: null, sourceTasks: [] };
}

function overlapFindings(ledger) {
  try { return inspectTaskDraft(ledger).findings.filter((item) => item.kind === "file-overlap"); } catch { return []; }
}

export function deriveBuildBoard({ project, ledger, sections = {}, planStatus = null }) {
  const approval = resolveApprovedTasks({ project, ledger, sections, planStatus });
  const current = new Map((ledger?.tasks ?? []).map((task) => [task.id, task]));
  const approvedSource = new Map(approval.sourceTasks.map((task) => [task.id, task]));
  const allocation = allocationByTask(sections);
  const collisions = recordedCollisions(sections);
  const overlaps = collisions ? [] : overlapFindings(ledger);
  const proof = proofItems(sections);
  const statuses = sections.build?.data?.status ?? {};
  const statusOf = (id) => {
    const value = statuses[id];
    return value && BUILD_STATES.includes(value.state)
      ? { state: value.state, updatedAt: value.updatedAt ?? null, note: typeof value.note === "string" ? value.note : "", recorded: true }
      : { state: "not-started", updatedAt: null, note: "", recorded: false };
  };
  const approvedSet = new Set(approval.taskIds);

  const cards = approval.taskIds.map((id) => {
    const task = current.get(id) ?? approvedSource.get(id) ?? null;
    if (!task) return null;
    const allocated = allocation.get(id) ?? null;
    const owner = allocated?.owner ?? (task.owner || null);
    const ownerSource = allocated?.owner ? "allocation" : task.owner ? "draft" : null;
    const blockers = [];
    const constraints = [];
    if (!owner) blockers.push({ kind: "owner", text: "No owner named yet. Assign one in Allocation." , workspace: "allocation" });
    for (const item of collisions ?? []) {
      if (!item.taskIds.includes(id)) continue;
      const others = item.taskIds.filter((other) => other !== id);
      const paths = uniquePaths(item.paths);
      const where = paths.length ? ` (${paths.join(", ")})` : "";
      if (item.resolved) constraints.push(`Agreed with ${others.join(", ") || "another task"}${where}${item.note ? `: ${item.note}` : ""}.`);
      else blockers.push({ kind: "collision", text: `Unresolved overlap with ${others.join(", ") || "another task"}${where}.`, workspace: "collision" });
    }
    for (const item of overlaps) {
      if (!item.taskIds.includes(id)) continue;
      const others = item.taskIds.filter((other) => other !== id);
      blockers.push({ kind: "collision", text: `Plans to change the same files as ${others.join(", ")}; not reviewed in Collision yet.`, workspace: "collision" });
    }
    for (const dependency of task.dependsOn ?? []) {
      if (statusOf(dependency).state !== "done") blockers.push({ kind: "dependency", text: `Waits for ${dependency} to be done.`, workspace: "build" });
    }
    const status = statusOf(id);
    return {
      id,
      task,
      changedSinceApproval: Boolean(current.get(id) && approvedSource.get(id) && canonical(current.get(id)) !== canonical(approvedSource.get(id))),
      removedFromLedger: !current.has(id),
      owner,
      ownerSource,
      wave: allocated?.wave ?? null,
      blockers,
      constraints,
      proof: proof.filter((item) => item.taskId === id),
      status,
    };
  }).filter(Boolean);

  const count = (state) => cards.filter((card) => card.status.state === state).length;
  return {
    approval,
    cards,
    waitingDrafts: (ledger?.tasks ?? []).filter((task) => !task.archived && !approvedSet.has(task.id)).length,
    collisionsRecorded: Boolean(collisions),
    allocationRecorded: allocation.size > 0,
    counts: { total: cards.length, done: count("done"), inProgress: count("in-progress"), blocked: count("blocked"), notStarted: count("not-started") },
  };
}

/** Next `build` section data after the user sets one task's status. */
export function nextBuildRecord(previous, { taskId, state, note = "", approvedTaskIds, approval = null, now = new Date().toISOString() }) {
  if (!/^T\d{4,6}$/.test(String(taskId))) throw new Error("Task identity is invalid.");
  if (!BUILD_STATES.includes(state)) throw new Error("Choose a valid status.");
  if (!Array.isArray(approvedTaskIds) || !approvedTaskIds.includes(taskId)) throw new Error("Only approved tasks can be tracked here.");
  const cleanNote = String(note ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, BUILD_NOTE_LIMIT);
  const status = { ...(previous?.status ?? {}), [taskId]: { state, updatedAt: now, note: cleanNote } };
  return { status, approvedTaskIds: [...approvedTaskIds], approval: approval ? { source: approval.source ?? null, revision: approval.revision ?? null } : null };
}

/** BUILD-RUN progress from the build section alone. */
export function buildRunProgress(sections) {
  const data = sections?.build?.data;
  const approved = Array.isArray(data?.approvedTaskIds) ? data.approvedTaskIds : [];
  if (!approved.length) return null;
  const states = approved.map((id) => data.status?.[id]?.state ?? "not-started");
  const recordedApproval = approvedTaskIdsFrom(sections);
  return {
    total: approved.length,
    done: states.filter((state) => state === "done").length,
    blocked: states.filter((state) => state === "blocked").length,
    approvalChanged: Boolean(recordedApproval && !sameIds(recordedApproval, approved)),
  };
}

const bullet = (items, empty) => items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;

/** Plain-text brief a person can paste into any coding agent. */
export function agentBrief(card, { projectName = "this project", statusOf = () => null } = {}) {
  const task = card.task;
  const writes = task.claims.filter((claim) => claim.access === "write").map((claim) => `${claim.path} (may change)`);
  const reads = task.claims.filter((claim) => claim.access === "read").map((claim) => `${claim.path} (read only)`);
  const dependencies = (task.dependsOn ?? []).map((id) => `${id}${statusOf(id) ? ` — currently ${BUILD_STATE_LABELS[statusOf(id)] ?? statusOf(id)}` : ""}`);
  const constraints = [
    ...card.blockers.filter((item) => item.kind === "collision").map((item) => `${item.text} Do not change the shared files until this is agreed.`),
    ...card.constraints,
    "Only change the files listed above. If you need to change anything else, stop and ask first.",
  ];
  return [
    `Task ${task.id}: ${task.title}`,
    `Project: ${projectName}`,
    "",
    "What to do:",
    task.description || "No description was written for this task. Ask before guessing.",
    "",
    "Files and areas:",
    bullet([...writes, ...reads], "No files were named for this task. Ask which files are in scope before changing anything."),
    "",
    "Done when:",
    task.acceptance || "No acceptance criteria were written. Ask what “done” means before starting.",
    "",
    `Owner: ${card.owner ?? "not assigned yet"}${card.wave != null ? ` · wave ${card.wave}` : ""}`,
    "Depends on:",
    bullet(dependencies, "Nothing."),
    "",
    "Constraints:",
    bullet(constraints, "None recorded."),
    ...(task.recovery ? ["", "If something goes wrong:", task.recovery] : []),
    "",
    "How to report back:",
    `When you finish, reply with (1) a short summary of what changed, (2) the exact list of files you changed, (3) the test or check command you ran and its full result, and (4) a screenshot if the change is visible. These will be saved as proof for ${task.id} on the Evidence page.`,
  ].join("\n");
}
