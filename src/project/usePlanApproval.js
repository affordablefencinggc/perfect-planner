import { useCallback, useEffect, useRef, useState } from "react";
import { taskDraftBinding } from "./taskDraftLedger.js";
import { createTaskDraftStore } from "./taskDraftStore.js";
import { activePlanTasks, digestPlanTasks, notePlanTaskDrift, recordPlanApproval, validPlanApproval } from "./planApproval.js";
import { approveCorePlan, CoreApiError, coreProjectKey } from "../core-screens/coreApi.js";

let sharedStore;
const defaultStore = () => (sharedStore ??= createTaskDraftStore());
const bindingOf = (project) => { try { return taskDraftBinding(project); } catch { return null; } };

/**
 * The Plan page's approve writes the same person-signed plan.approved that Deep
 * planning writes, so the core ledger stays the one plan approval. A refusal
 * (e.g. a blocking planning question is open) stops the approval; only when the
 * local service is not running at all does the approval stay on this device.
 */
async function approveInCoreLedger(projectId, tasks) {
  try {
    await approveCorePlan(coreProjectKey(projectId), activePlanTasks(tasks).map((task) => ({ id: task.id, title: String(task.title ?? "") })));
  } catch (error) {
    const unreachable = !(error instanceof CoreApiError) || ["OFFLINE", "BAD_RESPONSE"].includes(error.code) || error.status === 404 || error.status >= 500;
    if (!unreachable) throw error;
  }
}

/**
 * Reads the saved task drafts for an imported project and, when `watch` is on,
 * keeps the saved approval's "tasks changed since approval" flag in step with
 * them. Reading is skipped while `enabled` is false.
 */
export function usePlanApproval(project, records, { store: providedStore, watch = true, enabled = true } = {}) {
  const binding = bindingOf(project);
  const key = binding ? `${binding.projectId}:${binding.rootIdentity}:${binding.censusDigest}` : null;
  const store = providedStore ?? (enabled && binding ? defaultStore() : null);
  const [state, setState] = useState({ ledger: null, digest: null, error: "", loading: Boolean(enabled && binding) });
  const sequence = useRef(0);
  const approval = records?.sections?.planAuthority?.data;
  const approvedDigest = validPlanApproval(approval) ? approval.planDigest : null;

  const read = useCallback(async () => {
    if (!store || !binding) return null;
    const request = ++sequence.current;
    try {
      const ledger = await store.read(binding);
      const digest = await digestPlanTasks(ledger.tasks);
      if (request === sequence.current) setState({ ledger, digest, error: "", loading: false });
      return ledger;
    } catch (error) {
      if (request === sequence.current) setState((current) => ({ ...current, error: error?.message ?? "Saved tasks could not be read.", loading: false }));
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key]);

  useEffect(() => {
    if (!enabled || !store || !binding) return undefined;
    void read();
    const stop = store.subscribe?.(binding, () => { void read(); });
    return () => { sequence.current++; stop?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, read]);

  useEffect(() => {
    if (!watch || !enabled || !approvedDigest || !state.ledger || !binding) return;
    void notePlanTaskDrift(binding.projectId, state.ledger.tasks).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch, enabled, approvedDigest, state.digest, key]);

  /** Explicit user approval of the tasks as currently saved (re-read, never the cached copy). */
  const approve = useCallback(async () => {
    if (!store || !binding) throw new Error("Register your app folder before approving a plan.");
    const ledger = await store.read(binding);
    await approveInCoreLedger(binding.projectId, ledger.tasks);
    const record = await recordPlanApproval(binding.projectId, { tasks: ledger.tasks, censusDigest: binding.censusDigest, source: "local-approval" });
    await read();
    return record;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key, read]);

  return { ...state, binding, approvedDigest, approve, refresh: read };
}

/** Background watcher: only touches saved drafts when an approval exists to compare against. */
export function usePlanTaskDriftWatch(project, records, options = {}) {
  const approval = records?.sections?.planAuthority?.data;
  usePlanApproval(project, records, { ...options, watch: true, enabled: project?.kind === "imported" && validPlanApproval(approval) });
}
