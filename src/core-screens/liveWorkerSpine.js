// Read-only projection of the authoritative task board and /agents roster.
// It is deliberately not a second activity store: a claim or heartbeat alone
// never produces a "working" display state.
export const LIVE_WORKER_STALE_MS = 10 * 60 * 1000;

export function providerOf(worker) {
  const id = worker?.reportedModel ? "" : String(worker?.id ?? "").toLowerCase();
  const model = String(worker?.model ?? "").replace(/^unverified:/, "").toLowerCase();
  if (/^(codex|openai|gpt|o\d)/.test(id) || /codex|openai|\bgpt|\bo\d/.test(model)) return "codex";
  if (/^claude/.test(id) || /claude|sonnet|opus|haiku/.test(model)) return "claude";
  if (/^gemini/.test(id) || /gemini/.test(model)) return "gemini";
  return "unknown";
}

/**
 * Identity survives a host restart in the signed task projection.  A checked-in
 * agent is only a liveness observation; it must not overwrite that durable
 * attribution, and a model label is never allowed to turn a Codex owner into
 * Claude.
 */
export function workerIdentityFor(task, agents = []) {
  const live = liveWorkerFor(task, agents);
  const requestedModel = live?.requestedModel ?? task?.dispatch?.model ?? task?.workerDispatch?.requestedModel;
  const report = task?.workerReport;
  const reportedModel = live?.reportedModel ?? (report?.worker === task?.owner ? report?.reportedModel : null);
  const model = reportedModel ?? live?.model ?? requestedModel;
  const id = task?.owner ?? live?.id;
  return id || model ? { ...live, ...(id ? { id } : {}), ...(model ? { model } : {}), requestedModel, reportedModel, modelReported: Boolean(reportedModel), modelConflict: Boolean(requestedModel && reportedModel && requestedModel !== reportedModel), modelRequested: !reportedModel && Boolean(requestedModel), quiet: Boolean(live?.quiet) } : null;
}

export function isFresh(value, now = Date.now()) {
  const at = Date.parse(String(value ?? ""));
  return Number.isFinite(at) && now - at >= 0 && now - at < LIVE_WORKER_STALE_MS;
}

function progressAt(task) { return task?.lastProgress?.at ?? task?.lastProgress?.timestamp ?? task?.lastProgress?.createdAt ?? null; }

export function deriveLiveWorkerState(task, worker, now = Date.now()) {
  if (task?.stage === "done" || task?.status === "done") return { state: "done", animated: false, label: "Merged and done", detail: "Merged on the ledger" };
  if (task?.status === "blocked") return { state: "blocked", animated: false, label: "Blocked", detail: "Task is blocked on the ledger" };
  if (task?.check?.passed === false) return { state: "test-failed", animated: false, label: "Test failed", detail: "The last independent check failed" };
  if (task?.stage === "ready-to-merge") return { state: "ready-to-merge", animated: false, label: "Approved, waiting for you to merge", detail: "The approved diff is ready to merge" };
  const activity = task?.workerActivity;
  const matching = task?.status === "claimed" && worker?.id === task?.owner && activity?.worker === task?.owner;
  const freshWork = matching && activity.activity === "working" && isFresh(activity.at, now) && isFresh(worker.lastSeen, now) && !worker.quiet;
  const freshFinished = matching && activity.activity === "finished" && isFresh(activity.at, now) && isFresh(worker.lastSeen, now) && !worker.quiet;
  // A worker report is not an independent check. Keep the saved check visible as
  // history, but describe fresh work after it neutrally unless a new check record
  // itself exists.
  if (freshFinished) return task?.check?.passed === true && activity.afterCheck === true
    ? { state: "finished-awaiting-review", animated: false, visible: true, label: "Finished after the last check · Awaiting review", detail: "Worker reported finished; the saved independent check passed earlier" }
    : { state: "finished-awaiting-review", animated: false, visible: true, label: "Worker reported finished · Awaiting review", detail: "Fresh worker-reported finish; awaiting review" };
  if (task?.stage === "review-diff" && task?.check?.passed === true && activity?.afterCheck === true && freshWork) return { state: "reworking", animated: true, label: "Working after the last check", detail: "The saved independent check passed earlier; current activity is worker-reported" };
  if (task?.check?.passed === true && (task?.proofs?.length ?? 0) > 0) return { state: "awaiting-review", animated: false, label: "Checks passed · Awaiting review", detail: "Independent check passed and proof is attached" };
  if (!worker) return { state: "waiting", animated: false, label: "Waiting", detail: "No checked-in worker for this attempt" };
  const reportedAt = progressAt(task);
  const agentFresh = isFresh(worker.lastSeen, now) && !worker.quiet;
  const reportFresh = isFresh(reportedAt, now);
  if (worker.quiet || (worker.lastSeen && !agentFresh) || (reportedAt && !reportFresh)) return { state: "stale", animated: false, label: "Stale / disconnected", detail: "No fresh observed worker activity" };
  if (task?.stage === "building" && freshWork && agentFresh && reportFresh) return { state: "working", animated: true, label: "Working", detail: "Latest activity is reported by the worker" };
  return { state: "waiting", animated: false, label: "Waiting", detail: "Claimed or checked in; no fresh reported task progress" };
}

export function liveWorkerFor(task, agents = []) { return agents.find((agent) => agent.role === "worker" && (agent.task === task.label || agent.task === task.id) && (!task.owner || agent.id === task.owner) && !agent.revoked) ?? null; }
