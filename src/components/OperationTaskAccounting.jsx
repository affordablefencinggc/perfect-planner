import { useEffect, useMemo, useRef, useState } from 'react';
import { createTaskDraftStore } from '../project/taskDraftStore.js';
import { sameTaskDraftBinding, taskDraftBinding, validateTaskDraftLedger } from '../project/taskDraftLedger.js';
import { OperationTaskRunObservations } from './OperationTaskRunObservations.jsx';
import { OperationNativeTaskAttempts } from './OperationNativeTaskAttempts.jsx';
import { isNativeWorkspaceRuntime } from '../native/workspaceCensus.js';

// The current imported ledger is a draft, not an execution authority. Never infer
// success/failure counts from diagnostic severity, commit counts or free text.
export function OperationTaskAccounting({ project, diagnostics = [], store: providedStore }) {
  let binding;
  try { binding = taskDraftBinding(project); } catch {
    return <section aria-label="Change accounting"><h3>Change accounting unavailable</h3><p>Import and register a project before reading its numbered tasks.</p></section>;
  }
  return <BoundAccounting key={JSON.stringify(binding)} binding={binding} project={project} diagnostics={diagnostics} providedStore={providedStore}/>;
}

function BoundAccounting({ binding, project, diagnostics, providedStore }) {
  // Keep native history mounted independently of draft loading or corruption.
  // It has its own registered-project checks; draft state cannot approve it.
  return <div className="ops-change-accounting">
    {isNativeWorkspaceRuntime()&&<OperationNativeTaskAttempts project={project}/>}
    <DraftAccounting binding={binding} project={project} diagnostics={diagnostics} providedStore={providedStore}/>
  </div>;
}

function DraftAccounting({ binding, project, diagnostics, providedStore }) {
  const store = useMemo(() => providedStore ?? createTaskDraftStore(), [providedStore]);
  const [result, setResult] = useState({ state: 'loading', ledger: null });
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const request = ++generation.current;
      setResult({ state: 'loading', ledger: null });
      try {
        const ledger = validateTaskDraftLedger(await store.read(binding));
        if (!sameTaskDraftBinding(ledger.binding, binding)) throw new Error('stale');
        if (alive && request === generation.current) setResult({ state: 'ready', ledger });
      } catch {
        if (alive && request === generation.current) setResult({ state: 'unavailable', ledger: null });
      }
    };
    refresh(); const unsubscribe = store.subscribe?.(binding, refresh);
    window.addEventListener('focus', refresh);
    return () => { alive = false; generation.current++; unsubscribe?.(); window.removeEventListener('focus', refresh); if (!providedStore) store.close().catch(() => {}); };
  }, [store]);
  if (['stale', 'unavailable'].includes(project.state) || result.state === 'unavailable') return <section aria-label="Change accounting"><h3>Change accounting unavailable</h3><p role="alert">The current task ledger could not be verified. No success or failure totals can be inferred. Review the project and saved Ledger.</p></section>;
  if (result.state === 'loading') return <section aria-label="Change accounting"><p role="status">Reading numbered changes…</p></section>;
  const active = result.ledger.tasks.filter(task => !task.archived);
  const archived = result.ledger.tasks.length - active.length;
  const errors = diagnostics.filter(event => event.projectId === binding.projectId && ['error', 'critical'].includes(event.severity ?? event.level));
  const taskIds = new Set(result.ledger.tasks.map(task => task.id));
  const unmatched = errors.filter(event => !taskIds.has(event.taskId));
  return <section aria-label="Change accounting" className="ops-change-accounting">
    <h3>Every numbered change</h3>
    <p role="status"><strong>{active.length} active · {active.length} outcomes unverified · {archived} archived</strong></p>
    <p>Saved draft revision {result.ledger.revision}. Approved task outcomes are not connected. Verified and failed totals are unavailable—not zero. Commits do not prove completion.</p>
    {!isNativeWorkspaceRuntime()&&<OperationTaskRunObservations ledger={result.ledger}/>}
    {errors.length > 0 && <p role="alert">{errors.length} recorded error events need inspection. These are diagnostic observations, not current task verdicts; earlier failures may already have been resolved.</p>}
    {active.length === 0 && <p>No active numbered tasks in this draft. This is not evidence that all work is finished.</p>}
    {result.ledger.tasks.map(task => {
      const linked = errors.filter(event => event.taskId === task.id);
      return <details key={task.id} open={linked.length > 0}>
        <summary><strong>{task.id} · {task.title}</strong> — {task.archived ? 'Archived, not verified complete' : 'Outcome unverified'}{linked.length > 0 ? ` · ${linked.length} recorded errors` : ''}</summary>
        <p>Proposed owner: {task.owner || 'Unassigned'}. Next: {linked.length ? 'Review the recorded errors and obtain a task-bound verification result.' : 'Obtain a task-bound verification result.'}</p>
        <p>Recovery plan: {task.recovery || 'Not recorded'}. Work preservation has not been verified by this view.</p>
        {linked.map((event, index) => <div key={event.eventId ?? index}><p><strong>Observed error:</strong> {event.message}</p><p>Cause: unknown unless established by supporting evidence. Recorded {event.timestamp}; run {event.runId || 'not recorded'}.</p></div>)}
      </details>;
    })}
    {unmatched.length > 0 && <details open><summary>{unmatched.length} errors without a matching task in this ledger</summary>{unmatched.map((event, index) => <p key={event.eventId ?? index}>{event.taskId || 'No task reference'}: {event.message}</p>)}</details>}
  </section>;
}
