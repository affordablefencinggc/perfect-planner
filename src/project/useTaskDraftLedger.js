import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sameTaskDraftBinding, taskDraftBinding } from "./taskDraftLedger.js";
import { createTaskDraftStore } from "./taskDraftStore.js";
import { recordTaskDraftPresence } from "./taskDraftPresence.js";

function bindingFor(project) {
  try { return taskDraftBinding(project); } catch { return null; }
}

/**
 * Live, read-only view of the project's saved task drafts. Every successful read
 * also refreshes the small presence summary used by the Ledger requirement.
 * Returns {binding, ledger, stale, busy, error, refresh}.
 */
export function useTaskDraftLedger(project, providedStore = null) {
  const binding = bindingFor(project);
  const key = binding ? `${binding.projectId}:${binding.rootIdentity}:${binding.censusDigest}` : "";
  const stableBinding = useMemo(() => binding, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const store = useMemo(() => (stableBinding ? providedStore ?? createTaskDraftStore() : null), [providedStore, stableBinding]);
  const [state, setState] = useState({ ledger: null, busy: Boolean(binding), error: "" });
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!store || !stableBinding) return;
    const request = ++sequence.current;
    setState((current) => ({ ...current, busy: true, error: "" }));
    try {
      const ledger = await store.read(stableBinding);
      if (request !== sequence.current) return;
      if (ledger?.binding?.projectId === stableBinding.projectId) recordTaskDraftPresence(stableBinding.projectId, ledger);
      setState({ ledger, busy: false, error: "" });
    } catch (error) {
      if (request === sequence.current) setState((current) => ({ ...current, busy: false, error: error?.message || "Saved tasks could not be read." }));
    }
  }, [store, stableBinding]);

  useEffect(() => {
    if (!store || !stableBinding) { setState({ ledger: null, busy: false, error: "" }); return undefined; }
    refresh();
    const unsubscribe = store.subscribe?.(stableBinding, refresh);
    return () => {
      sequence.current++;
      unsubscribe?.();
      if (!providedStore) Promise.resolve(store.close?.()).catch(() => {});
    };
  }, [store, stableBinding, refresh, providedStore]);

  const stale = Boolean(state.ledger && stableBinding && !sameTaskDraftBinding(state.ledger.binding, stableBinding));
  return { binding: stableBinding, ...state, stale, refresh };
}
