import { useMemo, useState } from "react";
import { CameraIcon, CheckCircleIcon, CircleDashedIcon, CodeIcon, FlaskIcon, LinkSimpleIcon, NoteIcon, PlusIcon, TrashIcon, XCircleIcon } from "@phosphor-icons/react";
import { readWorkRecords, writeSection } from "../project/projectWorkRecords.js";
import { activeDrafts, addProofItem, kindLabel, newProofId, PROOF_KINDS, proofCoverage, proofItems, proofScope, removeProofItem, REQUIRED_PROOF_KINDS, saveErrorMessage } from "../project/proofRecords.js";
import { screenshotToDataUrl } from "../project/proofImage.js";
import { useProjectTaskDrafts } from "./useProjectTaskDrafts.js";
import "./ProjectProofPanels.css";

const NAME_KEY = "perfect-planner.proof.last-name";
const rememberedName = () => { try { return globalThis.localStorage?.getItem(NAME_KEY) ?? ""; } catch { return ""; } };
const rememberName = (name) => { try { globalThis.localStorage?.setItem(NAME_KEY, name); } catch { /* convenience only */ } };
const when = (value) => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString() : "unknown time"; };
const KIND_ICONS = { screenshot: CameraIcon, diff: CodeIcon, test: FlaskIcon, note: NoteIcon, skip: CircleDashedIcon };
const FORMAT_LABELS = { image: "Upload an image", link: "Link", text: "Paste text" };
const NEEDS = { screenshot: "Screenshot", diff: "Code change", test: "Passing test" };

export function scopeSentence(scope) {
  const count = `${scope.taskIds.length} task${scope.taskIds.length === 1 ? "" : "s"}`;
  return scope.source === "plan" ? `Covering the ${count} in the approved plan.` : `Covering ${count} from the Ledger. No plan has been approved yet, so every active task counts.`;
}

export function KindChecks({ task }) {
  return <span className="proof-checks">{REQUIRED_PROOF_KINDS.map((kind) => {
    const status = task.kinds[kind];
    const done = status === "proof" || status === "skipped";
    const Icon = done ? CheckCircleIcon : status === "failed" ? XCircleIcon : CircleDashedIcon;
    const text = status === "skipped" ? `${NEEDS[kind]}: not needed` : status === "failed" ? `${NEEDS[kind]}: only failing runs` : `${NEEDS[kind]}: ${done ? "added" : "missing"}`;
    return <span key={kind} className={`proof-check ${done ? "is-done" : status === "failed" ? "is-failed" : ""}`} title={text}><Icon weight={done ? "fill" : "regular"} aria-hidden="true" /><span>{text}</span></span>;
  })}</span>;
}

function ProofValue({ item }) {
  if (item.format === "image") return <a className="proof-thumb" href={item.value} target="_blank" rel="noreferrer"><img src={item.value} alt={item.label || "Screenshot"} /></a>;
  if (item.format === "link") return <a className="proof-link" href={item.value} target="_blank" rel="noreferrer noopener"><LinkSimpleIcon aria-hidden="true" />{item.value}</a>;
  if (item.value.length <= 160 && !item.value.includes("\n")) return <p className="proof-text">{item.value}</p>;
  return <details className="proof-pasted"><summary>Show pasted text ({item.value.split("\n").length} lines)</summary><pre>{item.value}</pre></details>;
}

function ProofItem({ item, onRemove, busy }) {
  const Icon = KIND_ICONS[item.kind] ?? NoteIcon;
  const extra = item.kind === "test" ? ` · ${item.outcome === "passed" ? "passed" : "failed"}${item.merged ? " on the merged code" : ""}` : item.kind === "skip" ? ` · ${NEEDS[item.covers]?.toLowerCase()} not needed` : "";
  return <li className={`proof-item kind-${item.kind}`}>
    <header><Icon aria-hidden="true" /><strong>{item.label || kindLabel(item.kind)}</strong><small>{kindLabel(item.kind)}{extra} · {item.addedBy} · {when(item.addedAt)}</small>
      <button type="button" className="proof-quiet" disabled={busy} onClick={onRemove} aria-label={`Remove ${item.label || kindLabel(item.kind)}`}><TrashIcon aria-hidden="true" />Remove</button></header>
    <ProofValue item={item} />
  </li>;
}

function AddProofForm({ taskId, onSave, onCancel, readImage }) {
  const [kind, setKind] = useState("screenshot");
  const formats = PROOF_KINDS.find((entry) => entry.id === kind).formats;
  const [format, setFormat] = useState("image");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [addedBy, setAddedBy] = useState(rememberedName);
  const [outcome, setOutcome] = useState("passed");
  const [merged, setMerged] = useState(false);
  const [covers, setCovers] = useState("screenshot");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const activeFormat = formats.includes(format) ? format : formats[0];
  const chooseKind = (next) => { setKind(next); setValue(""); setError(""); setFormat(PROOF_KINDS.find((entry) => entry.id === next).formats[0]); };

  async function pickImage(file) {
    setError(""); setValue("");
    if (!file) return;
    setBusy(true);
    try { const result = await readImage(file); setValue(result.dataUrl); if (!label) setLabel(file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 160)); }
    catch (cause) { setError(cause?.message || "That image could not be read."); }
    finally { setBusy(false); }
  }

  async function submit(event) {
    event.preventDefault();
    setError(""); setBusy(true);
    const item = { id: newProofId(), kind, format: activeFormat, label, value, addedAt: new Date().toISOString(), addedBy, ...(kind === "test" ? { outcome, merged } : {}), ...(kind === "skip" ? { covers } : {}) };
    const problem = onSave(item);
    setBusy(false);
    if (problem) setError(problem); else rememberName(addedBy.trim());
  }

  const fieldId = (name) => `proof-${taskId}-${name}`;
  return <form className="proof-form" onSubmit={submit} aria-label={`Add proof to ${taskId}`}>
    <div className="proof-form-row">
      <label htmlFor={fieldId("kind")}>What are you adding?</label>
      <select id={fieldId("kind")} value={kind} onChange={(event) => chooseKind(event.target.value)}>{PROOF_KINDS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select>
    </div>
    {formats.length > 1 && <fieldset className="proof-form-row proof-choice"><legend>How</legend>{formats.map((entry) => <label key={entry}><input type="radio" name={fieldId("format")} value={entry} checked={activeFormat === entry} onChange={() => { setFormat(entry); setValue(""); }} />{FORMAT_LABELS[entry]}</label>)}</fieldset>}
    {kind === "skip" && <div className="proof-form-row"><label htmlFor={fieldId("covers")}>Which proof is not needed?</label><select id={fieldId("covers")} value={covers} onChange={(event) => setCovers(event.target.value)}>{REQUIRED_PROOF_KINDS.map((entry) => <option key={entry} value={entry}>{NEEDS[entry]}</option>)}</select></div>}
    {activeFormat === "image" && <div className="proof-form-row"><label htmlFor={fieldId("file")}>Screenshot image</label><input id={fieldId("file")} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { void pickImage(event.target.files?.[0]); }} />
      <small>Large images are shrunk to about 400 KB and kept in this browser only.</small>
      {value && <img className="proof-preview" src={value} alt="Screenshot preview" />}</div>}
    {activeFormat === "link" && <div className="proof-form-row"><label htmlFor={fieldId("link")}>Link</label><input id={fieldId("link")} type="url" inputMode="url" placeholder="https://" value={value} maxLength={2000} onChange={(event) => setValue(event.target.value)} /></div>}
    {activeFormat === "text" && <div className="proof-form-row"><label htmlFor={fieldId("text")}>{kind === "skip" ? "Why is it not needed?" : kind === "test" ? "Test output" : kind === "diff" ? "Code change (diff)" : "Note"}</label><textarea id={fieldId("text")} rows={kind === "note" || kind === "skip" ? 3 : 7} value={value} maxLength={20000} onChange={(event) => setValue(event.target.value)} /></div>}
    {kind === "test" && <fieldset className="proof-form-row proof-choice"><legend>Result</legend>
      <label><input type="radio" name={fieldId("outcome")} checked={outcome === "passed"} onChange={() => setOutcome("passed")} />Passed</label>
      <label><input type="radio" name={fieldId("outcome")} checked={outcome === "failed"} onChange={() => setOutcome("failed")} />Failed</label>
      <label className="proof-merged"><input type="checkbox" checked={merged} onChange={(event) => setMerged(event.target.checked)} />These tests ran on the merged code</label></fieldset>}
    <div className="proof-form-grid">
      <div className="proof-form-row"><label htmlFor={fieldId("label")}>Short title (optional)</label><input id={fieldId("label")} value={label} maxLength={160} onChange={(event) => setLabel(event.target.value)} /></div>
      <div className="proof-form-row"><label htmlFor={fieldId("by")}>Added by</label><input id={fieldId("by")} value={addedBy} maxLength={120} autoComplete="name" onChange={(event) => setAddedBy(event.target.value)} /></div>
    </div>
    {error && <p role="alert" className="proof-error">{error}</p>}
    <div className="proof-actions"><button type="submit" className="proof-primary" disabled={busy}>{busy ? "Working…" : "Save proof"}</button><button type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}

export function ProjectEvidencePanel({ project, records, onWorkspace, store, storage, readImage = screenshotToDataUrl }) {
  const drafts = useProjectTaskDrafts(project, store);
  const sections = records?.sections ?? {};
  const scope = useMemo(() => proofScope(sections, drafts.ledger), [sections, drafts.ledger]);
  const items = proofItems(sections);
  const coverage = useMemo(() => proofCoverage(scope, items), [scope, items]);
  const titles = useMemo(() => new Map(activeDrafts(drafts.ledger).concat(drafts.ledger?.tasks ?? []).map((task) => [task.id, task.title])), [drafts.ledger]);
  const [openTask, setOpenTask] = useState(null);
  const [message, setMessage] = useState({ text: "", error: false });
  const orphanIds = Object.keys(items).filter((id) => !scope.taskIds.includes(id));

  function save(next, success) {
    try {
      writeSection(project.projectId, "proof", next, storage ? { storage } : undefined);
      setMessage({ text: success, error: false });
      return "";
    } catch (cause) {
      const text = saveErrorMessage(cause);
      setMessage({ text, error: true });
      return text;
    }
  }
  const current = () => readWorkRecords(project.projectId, storage ?? undefined).sections;
  const add = (taskId) => (item) => {
    let next;
    try { next = addProofItem(current(), taskId, item, scope); } catch (cause) { return cause.message; }
    const problem = save(next, `Proof saved to ${taskId}.`);
    if (!problem) setOpenTask(null);
    return problem;
  };
  const remove = (taskId, item) => { save(removeProofItem(current(), taskId, item.id, scope), `Removed “${item.label || kindLabel(item.kind)}” from ${taskId}.`); };

  if (!drafts.binding) return <section className="proof-panel" aria-label="Task proof"><h2>Proof for each task</h2><p>Choose your app folder in Structure before adding proof.</p><button type="button" onClick={() => onWorkspace?.("structure")}>Open Structure</button></section>;

  return <section className="proof-panel" aria-label="Task proof">
    <header className="proof-panel-head">
      <div><h2>Proof for each task</h2><p>{drafts.busy && !drafts.ledger ? "Reading your tasks…" : scopeSentence(scope)} Each task needs a screenshot, a code change and a passing test — or a short reason one is not needed.</p></div>
      <dl className="proof-tally" aria-label="Proof coverage">
        <div><dt>Complete</dt><dd>{coverage.complete}</dd></div>
        <div><dt>Partial</dt><dd>{coverage.partial}</dd></div>
        <div><dt>No proof</dt><dd>{coverage.none}</dd></div>
      </dl>
    </header>
    {drafts.error && <p role="alert" className="proof-error">Tasks could not be read: {drafts.error}</p>}
    {records?.unreadable && <p role="alert" className="proof-error">Saved records for this project could not be read. Nothing will be overwritten.</p>}
    <p role="status" className={message.error ? "proof-error" : "proof-status"}>{message.text}</p>
    {!drafts.busy && !scope.taskIds.length && <div className="proof-empty"><p>There are no tasks to prove yet.</p><button type="button" onClick={() => onWorkspace?.("ledger")}>Plan tasks in Ledger</button></div>}
    <ol className="proof-tasks">
      {coverage.tasks.map((task) => <li key={task.taskId} className={`proof-task status-${task.status}`}>
        <header>
          <span className="proof-task-title"><code>{task.taskId}</code><strong>{titles.get(task.taskId) ?? "Task not in the current Ledger"}</strong></span>
          <KindChecks task={task} />
          <button type="button" className="proof-add" aria-label={`Add proof to ${task.taskId}`} aria-expanded={openTask === task.taskId} onClick={() => setOpenTask(openTask === task.taskId ? null : task.taskId)}><PlusIcon aria-hidden="true" />Add proof</button>
        </header>
        {(items[task.taskId] ?? []).length > 0 && <ul className="proof-items">{items[task.taskId].map((item) => <ProofItem key={item.id} item={item} onRemove={() => remove(task.taskId, item)} />)}</ul>}
        {openTask === task.taskId && <AddProofForm taskId={task.taskId} onSave={add(task.taskId)} onCancel={() => setOpenTask(null)} readImage={readImage} />}
      </li>)}
    </ol>
    {orphanIds.length > 0 && <details className="proof-orphans"><summary>Proof kept for {orphanIds.length} task{orphanIds.length === 1 ? "" : "s"} no longer in the plan</summary>
      {orphanIds.map((taskId) => <div key={taskId}><h3><code>{taskId}</code> {titles.get(taskId) ?? ""}</h3><ul className="proof-items">{items[taskId].map((item) => <ProofItem key={item.id} item={item} onRemove={() => remove(taskId, item)} />)}</ul></div>)}
    </details>}
  </section>;
}
