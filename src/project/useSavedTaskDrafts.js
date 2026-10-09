import { useEffect, useMemo, useRef, useState } from "react";
import { sameTaskDraftBinding, taskDraftBinding } from "./taskDraftLedger.js";
import { createTaskDraftStore } from "./taskDraftStore.js";

/** Read-only live view of a project's saved Ledger drafts. */
export function useSavedTaskDrafts(project, providedStore) {
  const rootIdentity = project?.registration?.rootIdentity, censusDigest = project?.census?.digest, projectId = project?.projectId;
  const binding = useMemo(() => { try { return taskDraftBinding({ projectId, registration: { rootIdentity }, census: { digest: censusDigest } }); } catch { return null; } }, [projectId, rootIdentity, censusDigest]);
  const [state, setState] = useState({ ledger: null, error: "", busy: Boolean(binding) });
  const sequence = useRef(0);
  const refreshRef = useRef(() => {});
  useEffect(() => {
    if (!binding) { setState({ ledger: null, error: "", busy: false }); return undefined; }
    const store = providedStore ?? createTaskDraftStore();
    let alive = true;
    const refresh = async () => {
      const request = ++sequence.current;
      setState((current) => ({ ...current, busy: true, error: "" }));
      try {
        const ledger = await store.read(binding);
        if (alive && request === sequence.current) setState({ ledger, error: "", busy: false });
      } catch (error) {
        if (alive && request === sequence.current) setState((current) => ({ ...current, error: error?.message || "Saved tasks could not be read.", busy: false }));
      }
    };
    refreshRef.current = refresh;
    refresh();
    const unsubscribe = store.subscribe?.(binding, refresh);
    return () => { alive = false; sequence.current += 1; unsubscribe?.(); if (!providedStore) store.close?.().catch(() => {}); };
  }, [binding, providedStore]);
  const stale = Boolean(state.ledger && binding && !sameTaskDraftBinding(state.ledger.binding, binding));
  return { binding, ...state, stale, refresh: () => refreshRef.current() };
}
