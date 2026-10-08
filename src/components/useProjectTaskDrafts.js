import { useEffect, useMemo, useRef, useState } from "react";
import { taskDraftBinding } from "../project/taskDraftLedger.js";
import { createTaskDraftStore } from "../project/taskDraftStore.js";

/** Read-only live view of a project's saved task drafts (the Ledger). */
export function useProjectTaskDrafts(project, providedStore) {
  const binding = useMemo(() => { try { return taskDraftBinding(project); } catch { return null; } }, [project?.projectId, project?.registration?.rootIdentity, project?.census?.digest]);
  const store = useMemo(() => binding ? providedStore ?? createTaskDraftStore() : null, [binding, providedStore]);
  const [state, setState] = useState({ ledger: null, error: "", busy: Boolean(binding) });
  const sequence = useRef(0);
  useEffect(() => {
    if (!binding || !store) { setState({ ledger: null, error: "", busy: false }); return undefined; }
    let alive = true;
    const refresh = async () => {
      const request = ++sequence.current;
      setState((current) => ({ ...current, busy: true }));
      try {
        const ledger = await store.read(binding);
        if (alive && request === sequence.current) setState({ ledger, error: "", busy: false });
      } catch (error) {
        if (alive && request === sequence.current) setState((current) => ({ ...current, error: error?.message || "Task drafts could not be read.", busy: false }));
      }
    };
    void refresh();
    const stop = store.subscribe?.(binding, () => { void refresh(); });
    return () => { alive = false; stop?.(); if (!providedStore) store.close?.().catch(() => {}); };
  }, [binding, store, providedStore]);
  return { binding, ...state };
}
