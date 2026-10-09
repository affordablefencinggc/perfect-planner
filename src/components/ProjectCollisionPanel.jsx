import { useEffect, useState } from "react";
import { ArrowRightIcon, ArrowsClockwiseIcon, CheckCircleIcon, IntersectIcon, WarningOctagonIcon } from "@phosphor-icons/react";
import { writeSection } from "../project/projectWorkRecords.js";
import { useSavedTaskDrafts } from "../project/useSavedTaskDrafts.js";
import { activeTasks, buildCollisionRecord, collisionStatus, createResolution, overlapFileLines, resolutionState, taskSnapshot } from "../project/taskCoordination.js";
import "./ProjectCoordinationPanels.css";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const when = (iso) => { const date = new Date(iso); return Number.isFinite(date.getTime()) ? date.toLocaleString() : "an unknown time"; };

/** Asks the browser to confirm leaving or reloading the page while `dirty` is true. */
export function useUnsavedWarning(dirty) {
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; return ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

/** Shared read of saved tasks plus whether the saved overlap check still matches them. */
export function useCoordinationBasis(project, records, store) {
  const drafts = useSavedTaskDrafts(project, store);
  const saved = records?.sections?.collisions ?? null;
  const snapshot = drafts.ledger && !drafts.stale ? taskSnapshot(drafts.ledger) : null;
  const savedCurrent = Boolean(saved?.data && snapshot && saved.data.taskSnapshot === snapshot && saved.data.censusDigest === drafts.binding?.censusDigest);
  return { drafts, saved, snapshot, savedCurrent };
}

export function DraftsNotice({ drafts, onWorkspace }) {
  if (!drafts.binding) return <p className="coord-note">Import your app folder before checking its tasks.</p>;
  if (drafts.busy && !drafts.ledger) return <p role="status">Reading saved tasks…</p>;
  if (drafts.error) return <p role="alert" className="coord-note warn">Saved tasks could not be read: {drafts.error}</p>;
  if (drafts.stale) return <p role="alert" className="coord-note warn">The saved tasks belong to an older scan of this folder. Review them in Ledger first.</p>;
  if (drafts.ledger && !activeTasks(drafts.ledger).length) return <div className="coord-empty"><p>No tasks are saved for this project yet.</p><button type="button" onClick={() => onWorkspace?.("ledger")}>Add tasks in Ledger <ArrowRightIcon aria-hidden="true" /></button></div>;
  return null;
}

const label = (collision, id) => `${id} · ${collision.titles?.[id] ?? id}`;

function decisionText(collision, resolution) {
  if (resolution.choice === "order") return `Do ${label(collision, resolution.first)} first, then ${label(collision, collision.tasks.find((id) => id !== resolution.first))}.`;
  if (resolution.choice === "split") return "Split the work so the two tasks no longer change the same files.";
  return "Accepted: the two tasks may run at the same time.";
}

function CollisionCard({ collision, resolution, canDecide, onDecide, onClear, onWorkspace }) {
  // A split is only a plan until the two tasks' file scopes stop overlapping.
  const state = resolutionState(collision, resolution);
  const decided = state === "decided" ? resolution : null;
  const splitPending = state === "split-pending";
  const saved = decided ?? (splitPending ? resolution : null);
  const initial = saved ? (saved.choice === "order" ? `first:${saved.first}` : saved.choice) : `first:${collision.suggestedFirst}`;
  const [choice, setChoice] = useState(initial);
  useEffect(() => setChoice(initial), [initial]);
  const [a, b] = collision.tasks;
  const hard = collision.severity === "hard-stop";
  const save = () => { const [kind, first] = choice.split(":"); onDecide(collision, kind === "first" ? "order" : kind, first); };
  return <article className={`coord-card ${hard ? "hard" : "ordered"} ${decided ? "decided" : ""}`} aria-label={`${a} and ${b} overlap`} data-decision-state={state}>
    <header>
      <strong>{label(collision, a)} <span aria-hidden="true">↔</span> {label(collision, b)}</strong>
      <span className="coord-tag">{hard ? <><WarningOctagonIcon aria-hidden="true" />Must not run at the same time</> : "Needs an order"}</span>
    </header>
    <p>{hard ? "Both tasks change these files:" : "One task changes a file the other reads:"}</p>
    <ul className="coord-files">{overlapFileLines(collision.files).map((file) => <li key={`${file.path}|${file.severity}`}><code>{file.path}</code>{file.paths.length > 0 && <small>({file.paths.join(", ")})</small>}<small>{file.severity === "hard-stop" ? "both change it" : "one changes, one reads"}</small></li>)}</ul>
    {splitPending && <div className="coord-note warn" role="status"><p><b>Split chosen: edit the file scopes of {a} or {b} so they no longer overlap.</b> This overlap stays open until then. Next step: change one task’s files in the Ledger, then check again here.</p><button type="button" onClick={() => onWorkspace?.("ledger")}>Edit file scopes in Ledger <ArrowRightIcon aria-hidden="true" /></button></div>}
    {!decided && !splitPending && <p className="coord-hint">Suggested: {label(collision, collision.suggestedFirst)} first{collision.dependencyOrdered ? " (it is already listed as a dependency)" : ""}.</p>}
    {decided && <p className="coord-decided"><CheckCircleIcon weight="fill" aria-hidden="true" /> Decided: {decisionText(collision, decided)}</p>}
    <div className="coord-actions">
      <label>Decision <select value={choice} disabled={!canDecide} onChange={(event) => setChoice(event.target.value)}>
        <option value={`first:${a}`}>Do {a} first, then {b}</option>
        <option value={`first:${b}`}>Do {b} first, then {a}</option>
        <option value="split">Split the work so they don’t overlap</option>
        <option value="accept">Accept — they can run at the same time</option>
      </select></label>
      <button type="button" disabled={!canDecide} onClick={save}>{saved ? "Update decision" : choice === "split" ? "Choose split" : "Mark resolved"}</button>
      {saved && <button type="button" disabled={!canDecide} onClick={() => onClear(collision)}>Undo</button>}
    </div>
  </article>;
}

export function ProjectCollisionPanel({ project, records, onWorkspace, store, storage }) {
  const { drafts, saved, savedCurrent } = useCoordinationBasis(project, records, store);
  const [error, setError] = useState("");
  const data = saved?.data ?? null;
  const status = data ? collisionStatus(data) : null;
  const tasks = drafts.ledger && !drafts.stale ? activeTasks(drafts.ledger) : [];
  const titles = Object.fromEntries(tasks.map((task) => [task.id, task.title]));
  const canCheck = Boolean(drafts.binding && drafts.ledger && !drafts.stale && tasks.length && project?.state !== "unavailable");

  function save(next) {
    setError("");
    try { writeSection(project.projectId, "collisions", next, { storage }); } catch (cause) { setError(cause?.message === "WORK_RECORDS_STORAGE_UNAVAILABLE" ? "This browser cannot save records right now. Nothing was saved." : `Nothing was saved: ${cause?.message ?? "unknown error"}`); }
  }
  const check = () => save(buildCollisionRecord({ ledger: drafts.ledger, censusDigest: drafts.binding.censusDigest, previous: data }));
  const decide = (collision, choice, first) => {
    try { save({ ...data, resolutions: { ...(data.resolutions ?? {}), [collision.key]: createResolution(collision, choice, first) } }); } catch (cause) { setError(cause.message); }
  };
  const clear = (collision) => { const resolutions = { ...(data.resolutions ?? {}) }; delete resolutions[collision.key]; save({ ...data, resolutions }); };

  return <section className="coord-panel" aria-label="Overlapping work check">
    <header>
      <div><h2><IntersectIcon aria-hidden="true" /> Overlapping work</h2><p>Finds tasks that change the same files, using the files listed on each task in Ledger.</p></div>
      <div className="coord-tools">
        <button type="button" className="primary" disabled={!canCheck} onClick={check}><ArrowsClockwiseIcon aria-hidden="true" />{data ? "Check again" : "Check tasks now"}</button>
        <button type="button" onClick={() => onWorkspace?.("ledger")}>Open Ledger</button>
      </div>
    </header>
    <DraftsNotice drafts={drafts} onWorkspace={onWorkspace} />
    {error && <p role="alert" className="coord-note warn">{error}</p>}
    {!data && canCheck && <p className="coord-note">Your {plural(tasks.length, "task")} have not been checked yet.</p>}
    {data && !savedCurrent && drafts.ledger && !drafts.stale && <p role="alert" className="coord-note warn">Your tasks or folder changed since the last check ({when(data.evaluatedAt)}). The results below are out of date — check again before deciding.</p>}
    {data && <>
      <p role="status" className="coord-summary">
        Last checked {when(data.evaluatedAt)} · {plural(status.checked, "task")} checked · {status.total ? `${plural(status.total, "overlap")}, ${status.hardStops} must not run at the same time · ${status.open} undecided` : "no overlapping files found"}{status.splitPending ? ` (${status.splitPending} waiting for a split in Ledger)` : ""}
      </p>
      {(data.uncheckedTaskIds?.length > 0 || data.invalid?.length > 0) && <div className="coord-note warn">
        <p><b>Not checked.</b> {data.uncheckedTaskIds?.length ? "These tasks don’t list the files they change, so they could not be compared:" : ""}</p>
        <ul>{(data.uncheckedTaskIds ?? []).map((id) => <li key={id}>{id} · {titles[id] ?? "task"}</li>)}{(data.invalid ?? []).map((item) => <li key={item.taskId}>{item.taskId} · {titles[item.taskId] ?? "task"} — {item.reason}</li>)}</ul>
        <button type="button" onClick={() => onWorkspace?.("ledger")}>Add files in Ledger</button>
      </div>}
      <div className="coord-list">
        {(data.collisions ?? []).map((collision) => <CollisionCard key={collision.key} collision={collision} resolution={data.resolutions?.[collision.key]} canDecide={savedCurrent} onDecide={decide} onClear={clear} onWorkspace={onWorkspace} />)}
      </div>
      {status.checked > 0 && status.open > 0 && savedCurrent && <p className="coord-note warn">{plural(status.open, "overlap")} still {status.open === 1 ? "needs" : "need"} a decision. Build lists undecided overlaps as in the way, including “needs an order” pairs.</p>}
      {status.checked > 0 && status.open === 0 && savedCurrent && <p className="coord-ok"><CheckCircleIcon weight="fill" aria-hidden="true" /> {status.total ? "Every overlap has a decision." : "No checked tasks change the same files."} <button type="button" onClick={() => onWorkspace?.("allocation")}>Assign owners <ArrowRightIcon aria-hidden="true" /></button></p>}
    </>}
  </section>;
}
