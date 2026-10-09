import { useEffect, useMemo, useState } from "react";
import { ArrowRightIcon, ListNumbersIcon, RobotIcon, UserIcon } from "@phosphor-icons/react";
import { writeSection } from "../project/projectWorkRecords.js";
import { activeTasks, allocationStatus, buildAllocationRecord, normalizeAssignment, OWNER_MAX, ownerKind, suggestedWaves, WAVE_MAX } from "../project/taskCoordination.js";
import { DraftsNotice, useCoordinationBasis } from "./ProjectCollisionPanel.jsx";
import "./ProjectCoordinationPanels.css";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ProjectAllocationPanel({ project, records, onWorkspace, store, storage }) {
  const { drafts, saved, savedCurrent, snapshot } = useCoordinationBasis(project, records, store);
  const allocation = records?.sections?.allocation?.data ?? null;
  const tasks = useMemo(() => (drafts.ledger && !drafts.stale ? activeTasks(drafts.ledger) : []), [drafts.ledger, drafts.stale]);
  const collisionData = savedCurrent ? saved.data : null;
  const defaults = useMemo(() => suggestedWaves(drafts.ledger, collisionData), [drafts.ledger, collisionData]);
  const initial = useMemo(() => Object.fromEntries(tasks.map((task) => {
    const recorded = allocation?.assignments?.[task.id];
    return [task.id, { owner: recorded?.owner ?? task.owner ?? "", wave: String(recorded?.wave ?? defaults.waves[task.id] ?? "") }];
  })), [tasks, allocation, defaults]);
  const [form, setForm] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { if (!dirty) setForm(initial); }, [initial, dirty]);

  const change = (id, field, value) => { setDirty(true); setMessage(""); setForm((current) => ({ ...current, [id]: { ...(current[id] ?? initial[id]), [field]: value } })); };
  const resetWaves = () => { setDirty(true); setForm((current) => Object.fromEntries(tasks.map((task) => [task.id, { ...current[task.id], wave: String(defaults.waves[task.id] ?? "") }]))); };
  const canSave = Boolean(tasks.length && drafts.binding && project?.state !== "unavailable");
  const recordedCurrent = Boolean(allocation && allocation.taskSnapshot === snapshot && allocation.censusDigest === drafts.binding?.censusDigest);
  const pending = tasks.filter((task) => !normalizeAssignment(form[task.id]).owner).length;

  function save() {
    try {
      writeSection(project.projectId, "allocation", buildAllocationRecord({ ledger: drafts.ledger, censusDigest: drafts.binding.censusDigest, collisionData: saved?.data ?? null, assignments: form }), { storage });
      setDirty(false);
      setMessage(pending ? `Saved. ${plural(pending, "task")} still ${pending === 1 ? "needs" : "need"} an owner.` : "Saved. Every task has an owner.");
    } catch (cause) {
      setMessage(cause?.message === "WORK_RECORDS_STORAGE_UNAVAILABLE" ? "This browser cannot save records right now. Nothing was saved." : `Nothing was saved: ${cause?.message ?? "unknown error"}`);
    }
  }

  const status = allocation ? allocationStatus(allocation) : null;
  return <section className="coord-panel" aria-label="Task owners and order">
    <header>
      <div><h2><ListNumbersIcon aria-hidden="true" /> Owners and order</h2><p>Give each task an owner and a wave. Tasks in the same wave can run at the same time; wave 2 starts after wave 1.</p></div>
      <div className="coord-tools">
        <button type="button" className="primary" disabled={!canSave} onClick={save}>Save assignments</button>
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
      <div className="coord-table" role="table" aria-label="Task assignments">
        <div role="row" className="coord-row head"><span role="columnheader">Task</span><span role="columnheader">Owner</span><span role="columnheader">Wave</span></div>
        {tasks.map((task) => {
          const value = form[task.id] ?? initial[task.id] ?? { owner: "", wave: "" };
          const kind = ownerKind(value.owner.trim());
          return <div role="row" className="coord-row" key={task.id}>
            <span role="cell"><code>{task.id}</code> {task.title}</span>
            <span role="cell" className="coord-owner">{kind === "agent" ? <RobotIcon aria-hidden="true" /> : <UserIcon aria-hidden="true" />}<input aria-label={`Owner for ${task.id}`} maxLength={OWNER_MAX} value={value.owner} placeholder="Name or agent: name" onChange={(event) => change(task.id, "owner", event.target.value)} /></span>
            <span role="cell"><input aria-label={`Wave for ${task.id}`} type="number" min={1} max={WAVE_MAX} value={value.wave} onChange={(event) => change(task.id, "wave", event.target.value)} /></span>
          </div>;
        })}
      </div>
      {message && <p role="status" className="coord-note">{message}</p>}
    </>}
  </section>;
}
