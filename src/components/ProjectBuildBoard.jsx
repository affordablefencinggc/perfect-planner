import { useEffect, useMemo, useState } from "react";
import { ArrowRightIcon, CheckCircleIcon, ClipboardTextIcon, HammerIcon, WarningIcon } from "@phosphor-icons/react";
import { useOptionalProject } from "../project/ProjectProvider.jsx";
import { readSection, writeSection } from "../project/projectWorkRecords.js";
import { useTaskDraftLedger } from "../project/useTaskDraftLedger.js";
import { agentBrief, BUILD_NOTE_LIMIT, BUILD_STATE_LABELS, BUILD_STATES, deriveBuildBoard, nextBuildRecord } from "../project/projectBuildModel.js";
import "./ProjectBuildBoard.css";

const WORKSPACE_NAMES = { allocation: "Allocation", collision: "Collision", build: "Build", evidence: "Evidence", ledger: "Ledger" };

async function copyText(text) {
  if (globalThis.navigator?.clipboard?.writeText) { await globalThis.navigator.clipboard.writeText(text); return true; }
  return false;
}

function BuildCard({ card, board, project, onWorkspace, onSave }) {
  const [state, setState] = useState(card.status.state);
  const [note, setNote] = useState(card.status.note);
  const [message, setMessage] = useState("");
  const [manualBrief, setManualBrief] = useState("");
  useEffect(() => { setState(card.status.state); setNote(card.status.note); }, [card.status.state, card.status.note, card.status.updatedAt]);
  const dirty = state !== card.status.state || note !== card.status.note;
  const statusOf = (id) => board.cards.find((item) => item.id === id)?.status.state ?? null;

  async function copyBrief() {
    const brief = agentBrief(card, { projectName: project.name, statusOf });
    try {
      if (await copyText(brief)) { setManualBrief(""); setMessage("Brief copied. Paste it into your agent."); return; }
    } catch { /* fall through to manual copy */ }
    setManualBrief(brief);
    setMessage("Copying is blocked here. Select the brief below and copy it.");
  }

  function save() {
    try { onSave(card.id, state, note); setMessage("Status saved."); } catch (error) { setMessage(error.message || "Status could not be saved."); }
  }

  return <article className={`build-card build-state-${card.status.state}`} aria-label={`${card.id} ${card.task.title}`}>
    <header>
      <code>{card.id}</code>
      <h3>{card.task.title}</h3>
      <span className="build-card-status">{card.status.state === "done" && <CheckCircleIcon weight="fill" aria-hidden="true" />}{BUILD_STATE_LABELS[card.status.state]}</span>
    </header>
    {(card.changedSinceApproval || card.removedFromLedger) && <p className="build-card-warning"><WarningIcon aria-hidden="true" />{card.removedFromLedger ? "This task is no longer in the Ledger. Showing the approved version." : "Edited in the Ledger after approval. Showing the latest text; approve the plan again to confirm it."}</p>}
    <dl>
      <div><dt>Owner</dt><dd>{card.owner ?? "Not assigned"}{card.ownerSource === "draft" && <small> (named in the task; not confirmed in Allocation)</small>}</dd></div>
      <div><dt>Wave</dt><dd>{card.wave ?? "Not set"}</dd></div>
      <div><dt>Proof</dt><dd>{card.proof.length ? `${card.proof.length} attached: ${card.proof.map((item) => item.label).join(", ")}` : "None attached yet"}</dd></div>
    </dl>
    <section className="build-card-blockers" aria-label={`What is in the way of ${card.id}`}>
      <strong>In the way</strong>
      {card.blockers.length ? <ul>{card.blockers.map((item) => <li key={item.text}><span>{item.text}</span>{item.workspace !== "build" && <button type="button" className="build-link" onClick={() => onWorkspace?.(item.workspace)}>Open {WORKSPACE_NAMES[item.workspace]}<ArrowRightIcon aria-hidden="true" /></button>}</li>)}</ul> : <p>Nothing recorded is in the way.</p>}
      {card.constraints.length > 0 && <ul className="build-card-constraints">{card.constraints.map((item) => <li key={item}>{item}</li>)}</ul>}
    </section>
    <div className="build-card-controls">
      <label>Status<select aria-label={`Status for ${card.id}`} value={state} onChange={(event) => setState(event.target.value)}>{BUILD_STATES.map((value) => <option key={value} value={value}>{BUILD_STATE_LABELS[value]}</option>)}</select></label>
      <label>Note (optional)<input aria-label={`Note for ${card.id}`} value={note} maxLength={BUILD_NOTE_LIMIT} onChange={(event) => setNote(event.target.value)} placeholder="What changed, or what is blocking it" /></label>
      <div className="build-card-actions">
        <button type="button" className="primary-button" disabled={!dirty} onClick={save}>Save status</button>
        <button type="button" onClick={copyBrief}><ClipboardTextIcon aria-hidden="true" />Copy brief for an agent</button>
        {card.proof.length === 0 && <button type="button" className="build-link" onClick={() => onWorkspace?.("evidence")}>Add proof<ArrowRightIcon aria-hidden="true" /></button>}
      </div>
      {card.status.updatedAt && <small>Last set {new Date(card.status.updatedAt).toLocaleString()}</small>}
      {message && <p role="status">{message}</p>}
      {manualBrief && <textarea aria-label={`Brief for ${card.id}`} readOnly value={manualBrief} rows={12} onFocus={(event) => event.target.select()} />}
    </div>
  </article>;
}

export function ProjectBuildBoard({ project, records, onWorkspace, store = null }) {
  const projectContext = useOptionalProject();
  const planStatus = projectContext?.planStatuses?.[project?.projectId] ?? null;
  const drafts = useTaskDraftLedger(project, store);
  const [error, setError] = useState("");
  const sections = records?.sections ?? {};
  const board = useMemo(
    () => deriveBuildBoard({ project, ledger: drafts.stale ? null : drafts.ledger, sections, planStatus }),
    [project, drafts.ledger, drafts.stale, sections, planStatus],
  );

  function save(taskId, state, note) {
    setError("");
    try {
      const previous = readSection(project.projectId, "build")?.data ?? null;
      writeSection(project.projectId, "build", nextBuildRecord(previous, { taskId, state, note, approvedTaskIds: board.approval.taskIds, approval: board.approval }));
    } catch (failure) {
      const text = failure?.message === "WORK_RECORDS_STORAGE_UNAVAILABLE" ? "This browser is not letting the app save. Nothing was changed." : failure?.message === "WORK_RECORDS_UNREADABLE" ? "Saved progress for this project could not be read, so nothing was overwritten." : failure?.message || "Status could not be saved.";
      setError(text);
      throw new Error(text);
    }
  }

  const { counts, approval } = board;
  return <section className="project-build-board" aria-label="Build board">
    <header>
      <div><h2><HammerIcon aria-hidden="true" />Build board</h2><p>Each approved task, who owns it, what is in its way, and where it stands. You set each status; the app does not run the work for you.</p></div>
      {counts.total > 0 && <p className="build-board-counts" aria-label="Build progress"><b>{counts.done}</b> of <b>{counts.total}</b> done · {counts.inProgress} in progress · {counts.blocked} blocked · {counts.notStarted} not started</p>}
    </header>
    {drafts.busy && !drafts.ledger && <p role="status">Reading saved tasks…</p>}
    {drafts.error && <p role="alert" className="build-board-error">Saved tasks could not be read: {drafts.error}</p>}
    {drafts.stale && <p role="alert" className="build-board-error">The saved tasks belong to an earlier folder scan. Review them in the Ledger before building.</p>}
    {error && <p role="alert" className="build-board-error">{error}</p>}
    {approval.state !== "approved" && !drafts.busy && <div className="build-board-empty">
      <p>{approval.state === "refreshing" ? "Checking the plan approval…" : approval.state === "pending" || approval.state === "unfinished" ? "A plan approval is still in progress in the Ledger." : approval.state === "stale" ? "The plan approval is out of date because the folder scan changed. Review the tasks and approve the plan again on the Plan page." : approval.state === "unavailable" ? "The plan approval could not be checked right now." : "No plan approved yet. Approve the plan on the Plan page first."}</p>
      {approval.state === "pending" || approval.state === "unfinished"
        ? <button type="button" onClick={() => onWorkspace?.("ledger")}>Open Ledger<ArrowRightIcon aria-hidden="true" /></button>
        : <button type="button" onClick={() => onWorkspace?.("plan")}>Open Plan<ArrowRightIcon aria-hidden="true" /></button>}
    </div>}
    {approval.changed && <p className="build-board-note"><WarningIcon aria-hidden="true" />The Ledger changed after the plan was approved. Approve it again to bring new or edited tasks onto this board.</p>}
    {board.waitingDrafts > 0 && approval.state === "approved" && <p className="build-board-note">{board.waitingDrafts} task draft{board.waitingDrafts === 1 ? " is" : "s are"} not part of the approved plan yet.</p>}
    {approval.state === "approved" && !board.collisionsRecorded && board.cards.length > 0 && <p className="build-board-note">Overlaps have not been reviewed in Collision yet, so file overlaps between tasks are shown as in the way.</p>}
    {approval.state === "approved" && !board.cards.length && <p className="build-board-empty">The approved plan has no active tasks.</p>}
    {board.cards.length > 0 && <div className="build-board-grid">
      {board.cards.map((card) => <BuildCard key={card.id} card={card} board={board} project={project} onWorkspace={onWorkspace} onSave={save} />)}
    </div>}
  </section>;
}
