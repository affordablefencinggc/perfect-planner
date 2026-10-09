import { useEffect, useMemo, useState } from "react";
import { ArrowRightIcon, ListNumbersIcon, RobotIcon, UserIcon } from "@phosphor-icons/react";
import { writeSection } from "../project/projectWorkRecords.js";
import { activeTasks, allocationStatus, buildAllocationRecord, confirmedAssignments, ledgerOwnerProposals, normalizeAssignment, OWNER_MAX, ownerKind, suggestedWaves, WAVE_MAX } from "../project/taskCoordination.js";
import { DraftsNotice, useCoordinationBasis } from "./ProjectCollisionPanel.jsx";
import "./ProjectCoordinationPanels.css";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ProjectAllocationPanel({ project, records, onWorkspace, store, storage }) {
  const { drafts, saved, savedCurrent, snapshot } = useCoordinationBasis(project, records, store);
  const allocation = records?.sections?.allocation?.data ?? null;
  const tasks = useMemo(() => (drafts.ledger && !drafts.stale ? activeTasks(drafts.ledger) : []), [drafts.ledger, drafts.stale]);
  const collisionData = savedCurrent ? saved.data : null;
  const defaults = useMemo(() => suggestedWaves(drafts.ledger, collisionData), [drafts.ledger, collisionData]);
  // Ledger "Proposed owner" values pre-fill empty owners, but stay marked as
  // proposals (fromLedger) until the person confirms them. Allocated owners win.
  const proposals = useMemo(() => ledgerOwnerProposals(drafts.ledger && !drafts.stale ? drafts.ledger : null, allocation), [drafts.ledger, drafts.stale, allocation]);
  const initial = useMemo(() => Object.fromEntries(tasks.map((task) => {
    const recorded = allocation?.assignments?.[task.id];
    const wave = String(recorded?.wave ?? defaults.waves[task.id] ?? "");
    if (recorded?.owner) return [task.id, { owner: recorded.owner, wave, fromLedger: false }];
    if (proposals[task.id]) return [task.id, { owner: proposals[task.id], wave, fromLedger: true }];
    return [task.id, { owner: "", wave, fromLedger: false }];
  })), [tasks, allocation, defaults, proposals]);
  const [form, setForm] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { if (!dirty) setForm(initial); }, [initial, dirty]);

  const change = (id, field, value) => { setDirty(true); setMessage(""); setForm((current) => ({ ...current, [id]: { ...(current[id] ?? initial[id]), [field]: value, ...(field === "owner" ? { fromLedger: false } : {}) } })); };
  const confirmOwner = (id) => { setDirty(true); setMessage(""); setForm((current) => ({ ...current, [id]: { ...(current[id] ?? initial[id]), fromLedger: false } })); };
  const resetWaves = () => { setDirty(true); setForm((current) => Object.fromEntries(tasks.map((task) => [task.id, { ...current[task.id], wave: String(defaults.waves[task.id] ?? "") }]))); };
  const canSave = Boolean(tasks.length && drafts.binding && project?.state !== "unavailable");
  const recordedCurrent = Boolean(allocation && allocation.taskSnapshot === snapshot && allocation.censusDigest === drafts.binding?.censusDigest);
  const unconfirmed = tasks.filter((task) => (form[task.id] ?? initial[task.id])?.fromLedger).map((task) => task.id);

  function save(values = form, lead = "Saved.") {
    const assignments = confirmedAssignments(values);
    const pending = tasks.filter((task) => !normalizeAssignment(assignments[task.id]).owner).length;
    const skipped = tasks.filter((task) => values[task.id]?.fromLedger).length;
    try {
      writeSection(project.projectId, "allocation", buildAllocationRecord({ ledger: drafts.ledger, censusDigest: drafts.binding.censusDigest, collisionData: saved?.data ?? null, assignments }), { storage });
      setDirty(false);
      const owners = pending ? `${plural(pending, "task")} still ${pending === 1 ? "needs" : "need"} an owner.` : "Every task has an owner.";
      const notes = skipped ? ` ${skipped === 1 ? "1 owner from the Ledger was not confirmed, so it was" : `${skipped} owners from the Ledger were not confirmed, so they were`} not saved.` : "";
      setMessage(`${lead} ${owners}${notes}`);
    } catch (cause) {
      setMessage(cause?.message === "WORK_RECORDS_STORAGE_UNAVAILABLE" ? "This browser cannot save records right now. Nothing was saved." : `Nothing was saved: ${cause?.message ?? "unknown error"}`);
    }
  }

  function applyLedgerOwners() {
    const count = unconfirmed.length;
    const next = Object.fromEntries(tasks.map((task) => {
      const value = form[task.id] ?? initial[task.id];
      return [task.id, { ...value, fromLedger: false }];
    }));
    setForm(next);
    save(next, count === 1 ? "Saved the Ledger owner for 1 task." : `Saved Ledger owners for ${count} tasks.`);
  }

  const status = allocation ? allocationStatus(allocation) : null;
  return <section className="coord-panel" aria-label="Task owners and order">
    <header>
      <div><h2><ListNumbersIcon aria-hidden="true" /> Owners and order</h2><p>Give each task an owner and a wave. Tasks in the same wave can run at the same time; wave 2 starts after wave 1.</p></div>
      <div className="coord-tools">
        <button type="button" className="primary" disabled={!canSave} onClick={() => save()}>Save assignments</button>
        {unconfirmed.length > 0 && <button type="button" disabled={!canSave} onClick={applyLedgerOwners}>{unconfirmed.length === 1 ? "Use the Ledger owner for 1 task" : `Use Ledger owners for all ${unconfirmed.length} tasks`}</button>}
        <button type="button" disabled={!tasks.length} onClick={resetWaves}>Use suggested waves</button>
      </div>
    </header>
    <DraftsNotice drafts={drafts} onWorkspace={onWorkspace} />
    {tasks.length > 0 && <>
      {!saved && <p className="coord-note warn">Tasks have not been checked for overlapping files yet, so the suggested waves only follow task dependencies. <button type="button" onClick={() => onWorkspace?.("collision")}>Check overlaps <ArrowRightIcon aria-hidden="true" /></button></p>}
      {saved && !savedCurrent && <p className="coord-note warn">Tasks changed since the last overlap check. Suggested waves ignore that check until you run it again. <button type="button" onClick={() => onWorkspace?.("collision")}>Check again <ArrowRightIcon aria-hidden="true" /></button></p>}
      {defaults.blocked.length > 0 && <p className="coord-note warn">These tasks wait on each other in a loop, so no wave could be suggested: {defaults.blocked.join(", ")}. Pick a wave yourself or fix the dependencies in Ledger.</p>}
      {allocation && !recordedCurrent && <p role="alert" className="coord-note warn">The saved assignments were made for an earlier version of the task list. Review and save again.</p>}
      <p role="status" className="coord-summary">{status ? `Saved: ${status.owned} of ${plural(status.tasks, "task")} have an owner.` : "No assignments saved yet."} Use a person’s name, or “agent: name” for an AI agent. Branches and separate working folders are not tracked in this version.</p>
      {unconfirmed.length > 0 && <p className="coord-note">Owners marked “From the Ledger” were proposed when the tasks were written. They are not saved as owners until you confirm them: use Confirm on a task, or the Ledger owners button above to confirm all of them and save.</p>}
      <div className="coord-table" role="table" aria-label="Task assignments">
        <div role="row" className="coord-row head"><span role="columnheader">Task</span><span role="columnheader">Owner</span><span role="columnheader">Wave</span></div>
        {tasks.map((task) => {
          const value = form[task.id] ?? initial[task.id] ?? { owner: "", wave: "" };
          const kind = ownerKind(value.owner.trim());
          return <div role="row" className="coord-row" key={task.id}>
            <span role="cell"><code>{task.id}</code> {task.title}</span>
            <span role="cell" className="coord-owner">{kind === "agent" ? <RobotIcon aria-hidden="true" /> : <UserIcon aria-hidden="true" />}<input aria-label={`Owner for ${task.id}`} maxLength={OWNER_MAX} value={value.owner} placeholder="Name or agent: name" onChange={(event) => change(task.id, "owner", event.target.value)} />{value.fromLedger && <><small>{`From the Ledger: ${value.owner}`}</small><button type="button" aria-label={`Confirm Ledger owner for ${task.id}`} onClick={() => confirmOwner(task.id)}>Confirm</button></>}</span>
            <span role="cell"><input aria-label={`Wave for ${task.id}`} type="number" min={1} max={WAVE_MAX} value={value.wave} onChange={(event) => change(task.id, "wave", event.target.value)} /></span>
          </div>;
        })}
      </div>
      {message && <p role="status" className="coord-note">{message}</p>}
    </>}
  </section>;
}
