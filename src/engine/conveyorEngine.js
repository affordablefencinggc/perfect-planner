export const CONVEYOR_STAGES = ["READY", "CLAIMED", "BUILDING", "PROOF", "REVIEW", "CI", "MERGE_QUEUE", "MERGED"];
const ID = /^[A-Z][A-Z0-9]*-[0-9]{2,}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function canonicalWorkUnit(input = {}) {
  const errors = [];
  if (!ID.test(String(input.planId ?? ""))) errors.push("planId must use a stable uppercase prefix and numeric sequence.");
  if (!/^[A-Z][0-9]{2,}(?:-[0-9]+)?$/.test(String(input.taskId ?? ""))) errors.push("taskId must use a stable package/item identity such as B07 or B07-4.");
  if (!SLUG.test(String(input.slug ?? ""))) errors.push("slug must be lowercase kebab-case.");
  if (!String(input.owner ?? "").trim()) errors.push("owner is required.");
  if (errors.length) return { valid: false, errors };
  const plan = input.planId.toLowerCase(); const task = input.taskId.toLowerCase();
  return { valid: true, errors: [], unit: { ...input, stage: input.stage ?? "READY", branch: `pp/${plan}/${task}-${input.slug}`, worktree: `pp-worktrees/${plan}/${task}`, dependencies: input.dependencies ?? [], claims: input.claims ?? [] } };
}

function required(condition, message, blockers) { if (!condition) blockers.push(message); }

export function assessConveyorTransition(unit, nextStage, context = {}) {
  const blockers = [];
  const currentIndex = CONVEYOR_STAGES.indexOf(unit?.stage);
  const nextIndex = CONVEYOR_STAGES.indexOf(nextStage);
  if (currentIndex < 0 || nextIndex < 0) return { allowed: false, blockers: ["Unknown conveyor stage."] };
  if (nextIndex !== currentIndex + 1) return { allowed: false, blockers: [`Stage transition must move exactly one station forward: ${unit.stage} → ${CONVEYOR_STAGES[currentIndex + 1] ?? "none"}.`] };
  if (nextStage === "CLAIMED") {
    required(context.sessionState === "active", "An ACTIVE session must own the claim.", blockers);
    required(context.collisionClear === true, "Collision census must be clear before claim.", blockers);
    if (context.collisionClear === false) required(context.contingency?.order && context.contingency?.owner && context.contingency?.trigger, "A collision requires an owned, triggered contingency order.", blockers);
  }
  if (nextStage === "BUILDING") {
    required(context.branch === unit.branch, "Checked-out branch does not match the canonical work-unit branch.", blockers);
    required(context.worktree === unit.worktree, "Worktree does not match the canonical work-unit path.", blockers);
    required(context.claimLedgered === true, "Claim must be journalled before building.", blockers);
    required(context.dependenciesComplete === true, "All dependency gates must be complete.", blockers);
  }
  if (nextStage === "PROOF") {
    required(context.allItemsBuilt === true, "Every scoped item must be built before proof.", blockers);
    required(context.outsideClaimWrites === 0, "Writes outside the registered claim block proof.", blockers);
  }
  if (nextStage === "REVIEW") {
    required(context.machineProofComplete === true, "Machine proof is incomplete.", blockers);
    required(context.scopedDiffPresent === true, "Scoped code difference is missing.", blockers);
    required(context.uiWork !== true || context.screenshotPresent === true, "UI work requires a current screenshot.", blockers);
    required(context.uiWork !== true || context.screenshotViewed === true, "UI screenshot requires a viewing attestation.", blockers);
  }
  if (nextStage === "CI") {
    required(Number(context.approvedReviews ?? 0) >= Number(context.requiredReviews ?? 1), "Required independent reviews are missing.", blockers);
    required(Number(context.unresolvedReviewComments ?? 0) === 0, "Review comments remain unresolved.", blockers);
  }
  if (nextStage === "MERGE_QUEUE") {
    required(context.mergedStateCI === "green", "Simulated merged-state CI is not green.", blockers);
    required(context.collisionRescanClear === true, "Final collision rescan is not clear.", blockers);
    required(context.proofFresh === true, "Proof is stale or no longer matches the head commit.", blockers);
  }
  if (nextStage === "MERGED") {
    required(context.targetHeadUnchanged === true, "Target branch moved after rehearsal; rerun the merge gate.", blockers);
    required(context.humanApproved === true, "Explicit human merge approval is missing.", blockers);
    required(context.journalValid === true, "Decision/proof journal is invalid.", blockers);
    required(context.releaseReportWritten === true, "Completion report has not been written.", blockers);
  }
  return { allowed: blockers.length === 0, blockers, transition: { from: unit.stage, to: nextStage, unitId: `${unit.planId}/${unit.taskId}` } };
}

export function applyConveyorTransition(unit, nextStage, context = {}, options = {}) {
  const assessment = assessConveyorTransition(unit, nextStage, context);
  if (!assessment.allowed) return { ...assessment, unit };
  return { ...assessment, unit: { ...unit, stage: nextStage, stageEnteredAt: options.timestamp ?? new Date().toISOString(), stageEvidence: { ...(unit.stageEvidence ?? {}), [nextStage]: context.evidenceId ?? null } } };
}

export function allocateConveyor(units = [], options = {}) {
  if (!Array.isArray(units) || units.length > 10_000) throw new Error("Allocation requires at most 10000 work units.");
  const taskIds = new Set();
  const waveByTask = new Map();
  for (const unit of units) {
    if (!unit || typeof unit.taskId !== "string" || !unit.taskId.trim() || taskIds.has(unit.taskId)) throw new Error("Allocation requires unique named task IDs.");
    if (!Number.isSafeInteger(unit.wave) || unit.wave < 1) throw new Error(`Work unit ${unit.taskId} requires a positive safe integer wave.`);
    taskIds.add(unit.taskId);
    waveByTask.set(unit.taskId, unit.wave);
  }
  for (const unit of units) {
    const dependencies = unit.dependsOn ?? [];
    if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length || dependencies.some((id) => id === unit.taskId || !taskIds.has(id))) throw new Error(`Work unit ${unit.taskId} has duplicate, self, or missing dependencies.`);
    if (dependencies.some((id) => waveByTask.get(id) > unit.wave)) throw new Error(`Work unit ${unit.taskId} has a backwards-wave dependency.`);
    if (!Number.isFinite(Number(unit.dependenciesFinishHour ?? 0)) || Number(unit.dependenciesFinishHour ?? 0) < 0) throw new Error(`Work unit ${unit.taskId} has an invalid dependency finish time.`);
  }
  const developerCapacity = new Map(Object.entries(options.developerCapacityHours ?? {}));
  const allocations = [];
  const ownerClock = new Map();
  const laneClock = new Map();
  const finishByTask = new Map();
  const pending = [...units].sort((a, b) => a.wave - b.wave || String(a.lane).localeCompare(String(b.lane)) || a.taskId.localeCompare(b.taskId));
  let currentWave;
  let waveStartHour = 0;
  let waveFinishHour = 0;
  while (pending.length) {
    // Derived lanes only separate conflicts within one wave. Finish the whole
    // earlier wave before starting another, while keeping its lanes parallel.
    if (pending[0].wave !== currentWave) {
      currentWave = pending[0].wave;
      waveStartHour = waveFinishHour;
    }
    const readyIndex = pending.findIndex((unit) => unit.wave === currentWave && (unit.dependsOn ?? []).every((id) => finishByTask.has(id)));
    if (readyIndex < 0) throw new Error("Allocation dependencies contain a cycle.");
    const [unit] = pending.splice(readyIndex, 1);
    const capacity = Number(developerCapacity.get(unit.owner) ?? 0);
    if (!Number.isFinite(capacity) || !(capacity > 0)) throw new Error(`No finite daily capacity is registered for ${unit.owner}.`);
    const laneKey = `${unit.wave}:${unit.lane}`;
    const dependencyFinishHour = Math.max(0, ...(unit.dependsOn ?? []).map((id) => finishByTask.get(id)));
    const startHour = Math.max(waveStartHour, ownerClock.get(unit.owner) ?? 0, laneClock.get(laneKey) ?? 0, Number(unit.dependenciesFinishHour ?? 0), dependencyFinishHour);
    const durationHours = Number(unit.estimateHours);
    if (!Number.isFinite(durationHours) || !(durationHours > 0)) throw new Error(`Work unit ${unit.taskId} requires a finite positive estimate.`);
    const finishHour = startHour + durationHours;
    waveFinishHour = Math.max(waveFinishHour, finishHour);
    ownerClock.set(unit.owner, finishHour); laneClock.set(laneKey, finishHour);
    finishByTask.set(unit.taskId, finishHour);
    allocations.push({ taskId: unit.taskId, owner: unit.owner, wave: unit.wave, lane: unit.lane, startHour, finishHour, startDay: Math.floor(startHour / capacity) + 1, finishDay: Math.ceil(finishHour / capacity) });
  }
  return { allocations, totalFinishHour: Math.max(0, ...allocations.map((item) => item.finishHour)), owners: [...new Set(allocations.map((item) => item.owner))] };
}

function allocationSlug(value) { return String(value ?? "work-unit").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "work-unit"; }

export function buildAllocationWorkspaceModel(manifest, execution, collisionGate, policy = {}) {
  const blockers = [];
  if (!execution?.valid) blockers.push(...(execution?.errors?.length ? execution.errors : ["Execution map is invalid or unavailable."]));
  const roster = Array.isArray(policy.roster) ? policy.roster.filter((item) => item?.name && Number(item.capacityHours) > 0) : [];
  if (!roster.length) blockers.push("Allocation requires at least one named worker with positive daily capacity.");
  const taskById = new Map((manifest?.tasks ?? []).map((task) => [task.taskId, task]));
  const laneByTask = new Map();
  for (const wave of execution?.waves ?? []) for (const lane of wave.lanes ?? []) for (const task of lane.tasks ?? []) laneByTask.set(task.taskId, { wave: wave.wave, lane: lane.id });
  const units = [];
  for (const [index, task] of (manifest?.tasks ?? []).entries()) {
    const placement = laneByTask.get(task.taskId);
    if (!placement) { blockers.push(`Task ${task.taskId} has no derived execution lane.`); continue; }
    const configuredOwner = policy.ownerByTask?.[task.taskId];
    const worker = roster.find((item) => item.name === configuredOwner) ?? roster[index % Math.max(roster.length, 1)];
    if (!worker) continue;
    units.push({ taskId: task.taskId, owner: worker.name, wave: placement.wave, lane: placement.lane, estimateHours: Number(task.estimateMinutes) / 60, dependsOn: task.dependsOn ?? [] });
  }
  let allocation = { allocations: [], totalFinishHour: 0, owners: [] };
  if (!blockers.length) {
    try { allocation = allocateConveyor(units, { developerCapacityHours: Object.fromEntries(roster.map((item) => [item.name, item.capacityHours])) }); }
    catch (error) { blockers.push(`Allocation refused: ${error.message}`); }
  }
  const collisionClear = collisionGate?.ready === true && Number(collisionGate?.unresolved ?? 0) === 0;
  if (!collisionClear) blockers.push(`${Number(collisionGate?.unresolved ?? 0)} collision disposition(s) remain unresolved.`);
  const rows = roster.map((worker) => ({
    name: worker.name, role: worker.role ?? "Worker", type: worker.type ?? "human",
    assignments: allocation.allocations.filter((item) => item.owner === worker.name).map((item) => {
      const task = taskById.get(item.taskId); const canonical = canonicalWorkUnit({ planId: manifest.planId, taskId: item.taskId, slug: allocationSlug(task?.title), owner: worker.name });
      return { id: item.taskId, label: task?.title ?? item.taskId, start: Math.max(1, item.startDay), span: Math.max(1, item.finishDay - item.startDay + 1), status: collisionClear ? "ready" : "blocked", wave: item.wave, lane: item.lane, dependsOn: task?.dependsOn ?? [], branch: canonical.unit?.branch ?? null, worktree: canonical.unit?.worktree ?? null, gitCreated: false };
    }),
  })).filter((row) => row.assignments.length);
  const finishDay = Math.max(0, ...allocation.allocations.map((item) => item.finishDay));
  return {
    ready: blockers.length === 0,
    blockers,
    rows,
    metrics: { safeLanes: (execution?.waves ?? []).reduce((sum, wave) => sum + wave.lanes.length, 0), dependencyCount: (manifest?.tasks ?? []).reduce((sum, task) => sum + (task.dependsOn?.length ?? 0), 0), criticalPathMinutes: execution?.criticalPath?.minutes ?? 0, p50Days: finishDay, p80Days: finishDay ? Math.ceil(finishDay * Number(policy.p80Multiplier ?? 1.2)) : 0 },
    collision: { clear: collisionClear, unresolved: Number(collisionGate?.unresolved ?? 0) },
    dependencies: { valid: execution?.valid === true, criticalPath: execution?.criticalPath?.path ?? [] },
    gitCreation: { available: false, state: "BLOCKED", reason: "Live Git branch/worktree creation is not connected; displayed identities are deterministic reservations only." },
  };
}
