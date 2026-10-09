import { useState } from "react";
import {
  ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, CheckCircleIcon, FlagIcon, FolderOpenIcon,
  ListPlusIcon, PencilSimpleIcon, RobotIcon, WarningIcon,
} from "@phosphor-icons/react";
import { AdvancedOnly, CoreScreen, useAdvanced } from "./CoreScreen.jsx";
import { useCoreResource } from "./coreApi.js";
import "./MvpBoardScreen.css";

// The MVP board: every feature placed in a stage, the proposed MVP line
// between the MVP and later stages, and the person's confirmation.
const STATUS = {
  done: { label: "Done", tone: "good" },
  partial: { label: "Partial", tone: "warn" },
  missing: { label: "Missing", tone: "bad" },
};
const LINE_LABEL = "Proposed MVP line — confirm or move features across";

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function MvpBoardScreen() {
  const resource = useCoreResource("/mvp", { isEmpty: (data) => !data?.staged });
  const [restaging, setRestaging] = useState(false);
  const data = resource.data;
  const staged = resource.status === "ready" && !restaging;
  const actions = resource.status === "ready" ? (
    <>
      {restaging ? (
        <button type="button" className="core-button" onClick={() => setRestaging(false)}><ArrowLeftIcon aria-hidden="true" /> Back to the board</button>
      ) : (
        <button type="button" className="core-button" onClick={() => setRestaging(true)}><ListPlusIcon aria-hidden="true" /> Start a new proposal</button>
      )}
    </>
  ) : null;
  return (
    <CoreScreen
      id="mvp"
      title="MVP board"
      purpose="Decide what the first working version must include. Everything else waits for a later stage, with a reason."
      actions={actions}
      resource={resource}
      empty={<StagePicker resource={resource} />}
    >
      {staged ? <Board data={data} resource={resource} /> : <StagePicker resource={resource} onDone={() => setRestaging(false)} replacing />}
    </CoreScreen>
  );
}

function StagePicker({ resource, onDone, replacing = false }) {
  const advanced = useAdvanced();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [scanGoal, setScanGoal] = useState("");
  const [folder, setFolder] = useState("");
  const [goal, setGoal] = useState("");
  const [features, setFeatures] = useState("");

  const submit = async (mode, body) => {
    setBusy(mode);
    setError("");
    try {
      await resource.post("/mvp/stage", { mode, ...body });
      onDone?.();
    } catch (e) {
      setError(e.message || "That did not work.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="mvp-picker">
      {!replacing && (
        <p className="mvp-picker-lead">
          <strong>No MVP plan yet.</strong> Start from the code you already have, or from a list of features you want to build.
        </p>
      )}
      {replacing && <p className="mvp-picker-lead">A new proposal replaces the current board and clears its confirmation. The old board stays in the ledger.</p>}
      {error && <p className="mvp-alert" role="alert"><WarningIcon aria-hidden="true" weight="fill" /> {error}</p>}
      <div className="mvp-picker-grid">
        <form
          className="core-card mvp-choice"
          aria-labelledby="mvp-scan-title"
          onSubmit={(e) => { e.preventDefault(); submit("existing", { goal: scanGoal, ...(folder.trim() ? { path: folder.trim() } : {}) }); }}
        >
          <h3 id="mvp-scan-title"><FolderOpenIcon aria-hidden="true" /> Scan this project's code</h3>
          <p className="core-muted">Perfect Planner reads the code, marks each feature Done, Partial or Missing with the files that show it, and proposes an MVP line for you to confirm.</p>
          <label className="mvp-field">
            <span>What is the project for? (optional, one line)</span>
            <input value={scanGoal} onChange={(e) => setScanGoal(e.target.value)} maxLength={200} placeholder="Write and share notes" />
          </label>
          <label className="mvp-field">
            <span>Folder to scan (optional — leave empty for this project's folder)</span>
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={advanced ? "/path/to/repository" : "Leave empty to scan this project"} />
          </label>
          <button type="submit" className="core-button primary" disabled={!!busy}>
            <FolderOpenIcon aria-hidden="true" /> {busy === "existing" ? "Scanning…" : "Scan this project's code"}
          </button>
        </form>
        <form
          className="core-card mvp-choice"
          aria-labelledby="mvp-new-title"
          onSubmit={(e) => { e.preventDefault(); submit("new", { goal, features }); }}
        >
          <h3 id="mvp-new-title"><ListPlusIcon aria-hidden="true" /> Plan a new project</h3>
          <p className="core-muted">Say what the project is for and list the features. Perfect Planner proposes which ones belong in the MVP.</p>
          <label className="mvp-field">
            <span>What is the project for? (one line)</span>
            <input value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={200} required placeholder="Plan a project and track tasks to done" />
          </label>
          <label className="mvp-field">
            <span>Features, one per line</span>
            <textarea
              value={features}
              onChange={(e) => setFeatures(e.target.value)}
              rows={7}
              required
              placeholder={"Plan editor (needs: Project store)\nTask board\nProject store\nShare with a team"}
            />
          </label>
          <p className="core-muted mvp-hint">To say one feature needs another, add “(needs: other feature)” at the end of its line.</p>
          <button type="submit" className="core-button primary" disabled={!!busy || !goal.trim() || !features.trim()}>
            <ListPlusIcon aria-hidden="true" /> {busy === "new" ? "Planning…" : "Plan a new project"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Board({ data, resource }) {
  const advanced = useAdvanced();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState(null); // { feature, to }
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const stages = [...data.stages].sort((a, b) => a.order - b.order);
  const nameOf = (id) => stages.find((s) => s.id === id)?.name ?? id;
  const mvpName = nameOf("mvp");
  const later = stages.filter((s) => s.id !== "mvp");

  const run = async (path, body, done) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await resource.post(path, body);
      if (done) setNotice(done);
      return true;
    } catch (e) {
      setError(e.message || "That did not work.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const move = async (feature, to, reason = "") => {
    const f = data.features.find((x) => x.id === feature);
    if (!f || f.stage === to) return;
    if (to !== "mvp" && !reason) { setPrompt({ feature, to }); return; }
    const ok = await run("/mvp/move", { feature, to, reason }, `Moved ${f.name} to ${nameOf(to)}.`);
    if (ok) setPrompt(null);
  };

  const onDrop = (stage) => (e) => {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer?.getData("text/plain") || dragging;
    setDragging(null);
    if (id) move(id, stage);
  };

  const counts = data.counts ?? { done: 0, partial: 0, missing: 0 };
  const inMvp = data.features.filter((f) => f.stage === "mvp");

  return (
    <div className="mvp-board-wrap">
      <div className="mvp-summary core-card">
        <div className="mvp-summary-main">
          <p className="mvp-goal"><strong>{data.goal}</strong></p>
          <p className="core-muted">
            {data.proposal?.summary || `${inMvp.length} of ${data.features.length} features in the ${mvpName}`}.{" "}
            {data.mode === "existing"
              ? `In the code today: ${counts.done} done, ${counts.partial} partial, ${counts.missing} missing.`
              : "Planned features, not built yet."}
          </p>
          {data.proposal?.offline && (
            <p className="mvp-offline" role="note">
              <RobotIcon aria-hidden="true" /> This proposal came from the offline advisor, a built-in stand-in that follows fixed rules. Check it before you confirm.
            </p>
          )}
          <AdvancedOnly as="p">
            Proposal {data.proposal?.entry}{data.proposal?.subject ? ` · ${data.proposal.subject}` : ""} by {data.proposal?.by?.id}{data.proposal?.by?.model ? ` (${data.proposal.by.model})` : ""} · staged {data.source?.staging}
            {data.source?.kind ? ` · source ${data.source.kind}` : ""}{data.source?.root ? ` · ${data.source.root}` : ""}
          </AdvancedOnly>
        </div>
        <div className="mvp-summary-actions">
          {data.mode === "existing" && (
            <button type="button" className="core-button" disabled={busy} onClick={() => run("/mvp/rescan", {}, "Read the code again.")}>
              <ArrowClockwiseIcon aria-hidden="true" /> Read the code again
            </button>
          )}
          {data.confirmed ? (
            <span className="mvp-confirmed" role="status">
              <CheckCircleIcon aria-hidden="true" weight="fill" /> Confirmed
              {data.confirmation && <> by {data.confirmation.name ?? data.confirmation.by} on {when(data.confirmation.at)}</>}
              <AdvancedOnly> {data.confirmation?.entry} · {data.confirmation?.subject}</AdvancedOnly>
            </span>
          ) : (
            <button type="button" className="core-button primary" disabled={busy} onClick={() => run("/mvp/confirm", {}, "The MVP line is confirmed.")}>
              <CheckCircleIcon aria-hidden="true" /> Confirm MVP line
            </button>
          )}
        </div>
      </div>

      {data.source?.stale && <p className="mvp-alert" role="status"><WarningIcon aria-hidden="true" /> The scanned folder could not be read again, so statuses are from when it was scanned.</p>}
      {error && <p className="mvp-alert" role="alert"><WarningIcon aria-hidden="true" weight="fill" /> {error}</p>}
      {notice && !error && <p className="mvp-notice" role="status">{notice}</p>}
      {data.warnings?.length > 0 && (
        <div className="mvp-alert mvp-warnings" role="status">
          <WarningIcon aria-hidden="true" weight="fill" />
          <div>
            <strong>Some {mvpName} features need things that sit in a later stage.</strong>
            <ul>{data.warnings.map((w) => <li key={w.feature}>{w.message}</li>)}</ul>
          </div>
        </div>
      )}

      <div className="mvp-board" role="group" aria-label="Stages">
        {stages.map((stage) => (
          <StageColumnWithLine key={stage.id} isMvp={stage.id === "mvp"}>
            <StageColumn
              stage={stage}
              data={data}
              features={data.features.filter((f) => f.stage === stage.id)}
              advanced={advanced}
              busy={busy}
              later={later}
              mvpName={mvpName}
              prompt={prompt}
              setPrompt={setPrompt}
              move={move}
              rename={(name) => run("/mvp/rename", { stage: stage.id, name }, `Renamed the stage to ${name}.`)}
              dropActive={dropTarget === stage.id}
              dragProps={{
                onDragOver: (e) => { e.preventDefault(); if (dropTarget !== stage.id) setDropTarget(stage.id); },
                onDragLeave: () => setDropTarget((t) => (t === stage.id ? null : t)),
                onDrop: onDrop(stage.id),
              }}
              onDragStart={(id) => setDragging(id)}
              onDragEnd={() => { setDragging(null); setDropTarget(null); }}
            />
          </StageColumnWithLine>
        ))}
      </div>

      <DoneWhen data={data} mvpName={mvpName} advanced={advanced} />
      {advanced && data.history?.length > 0 && (
        <section className="core-card mvp-history" aria-labelledby="mvp-history-title">
          <h3 id="mvp-history-title">Ledger entries for this board</h3>
          <ol>
            {data.history.map((h) => (
              <li key={h.n}>
                <span className="core-advanced">{h.n} · {h.subject}</span> {h.summary}
                {h.reason && h.reason !== h.summary ? <span className="core-muted"> — {h.reason}</span> : null}
                <span className="core-advanced"> · {h.actor?.kind}:{h.actor?.id} · {when(h.at)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function StageColumnWithLine({ isMvp, children }) {
  if (!isMvp) return children;
  return (
    <>
      {children}
      <div className="mvp-line" role="separator" aria-orientation="vertical" aria-label={LINE_LABEL}>
        <span className="mvp-line-label"><FlagIcon aria-hidden="true" /> {LINE_LABEL}</span>
      </div>
    </>
  );
}

function StageColumn({ stage, features, advanced, busy, later, mvpName, prompt, setPrompt, move, rename, dropActive, dragProps, onDragStart, onDragEnd }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(stage.name);
  const isMvp = stage.id === "mvp";
  return (
    <section
      className={`mvp-column${isMvp ? " is-mvp" : ""}${dropActive ? " is-drop" : ""}`}
      aria-labelledby={`mvp-stage-${stage.id}`}
      data-stage={stage.id}
      {...dragProps}
    >
      <header className="mvp-column-head">
        {editing ? (
          <form className="mvp-rename" onSubmit={async (e) => { e.preventDefault(); if (await rename(name.trim())) setEditing(false); }}>
            <label>
              <span className="mvp-sr">New name for {stage.name}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus />
            </label>
            <button type="submit" className="core-button" disabled={busy || !name.trim()}>Save</button>
            <button type="button" className="core-button" onClick={() => { setEditing(false); setName(stage.name); }}>Cancel</button>
          </form>
        ) : (
          <>
            <h3 id={`mvp-stage-${stage.id}`}>{stage.name} <span className="core-muted mvp-count">{features.length}</span></h3>
            <AdvancedOnly>{stage.id}</AdvancedOnly>
            <button type="button" className="mvp-icon-button" aria-label={`Rename ${stage.name}`} onClick={() => { setName(stage.name); setEditing(true); }}>
              <PencilSimpleIcon aria-hidden="true" />
            </button>
          </>
        )}
      </header>
      {features.length === 0 && <p className="core-muted mvp-column-empty">No features here. Drag one in, or use its move buttons.</p>}
      <ul className="mvp-cards">
        {features.map((f) => (
          <FeatureCard
            key={f.id}
            feature={f}
            advanced={advanced}
            busy={busy}
            later={later}
            mvpName={mvpName}
            prompt={prompt?.feature === f.id ? prompt : null}
            setPrompt={setPrompt}
            move={move}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </ul>
    </section>
  );
}

function FeatureCard({ feature: f, advanced, busy, later, mvpName, prompt, setPrompt, move, onDragStart, onDragEnd }) {
  const status = STATUS[f.status] ?? STATUS.missing;
  const inMvp = f.stage === "mvp";
  return (
    <li
      className={`mvp-card${f.missingDependencies?.length ? " has-warning" : ""}`}
      draggable
      aria-label={`${f.name}, ${status.label}`}
      onDragStart={(e) => { e.dataTransfer?.setData("text/plain", f.id); onDragStart(f.id); }}
      onDragEnd={onDragEnd}
      data-feature={f.id}
    >
      <div className="mvp-card-head">
        <strong className="mvp-card-name">{f.name}</strong>
        <span className={`core-pill ${status.tone}`}>{status.label}</span>
      </div>
      <AdvancedOnly as="div">{f.id}{f.onJourney ? " · on journey" : ""}{f.userFacing ? "" : " · internal"}</AdvancedOnly>
      {f.onJourney && !advanced && <p className="mvp-tag">Part of the main journey</p>}
      {!inMvp && f.reason && <p className="mvp-reason">Why later: {f.reason}</p>}
      {f.findings?.length > 0 && <p className="core-muted mvp-findings">{f.findings.join(". ")}</p>}
      <Evidence evidence={f.evidence} advanced={advanced} />
      {f.dependsOn?.length > 0 && (
        <p className="mvp-deps">
          Needs:{" "}
          {f.dependsOn.map((d, i) => (
            <span key={d.id} className={f.missingDependencies?.includes(d.id) ? "mvp-dep-missing" : undefined}>
              {i > 0 ? ", " : ""}{d.name}{d.stage && d.stage !== f.stage ? ` (${d.stage === "mvp" ? mvpName : later.find((s) => s.id === d.stage)?.name ?? d.stage})` : ""}
            </span>
          ))}
        </p>
      )}
      {prompt ? (
        <ReasonPrompt feature={f} initial={prompt.to} later={later} busy={busy} onCancel={() => setPrompt(null)} onMove={(to, reason) => move(f.id, to, reason)} />
      ) : (
        <div className="mvp-card-actions">
          {!inMvp && (
            <button type="button" className="core-button" disabled={busy} onClick={() => move(f.id, "mvp")} aria-label={`Move ${f.name} to ${mvpName}`}>
              <ArrowLeftIcon aria-hidden="true" /> Move to {mvpName}
            </button>
          )}
          <button
            type="button"
            className="core-button"
            disabled={busy}
            onClick={() => setPrompt({ feature: f.id, to: inMvp ? later[0]?.id : later.find((s) => s.id !== f.stage)?.id })}
            aria-label={`Move ${f.name} later`}
          >
            Move later <ArrowRightIcon aria-hidden="true" />
          </button>
        </div>
      )}
    </li>
  );
}

function Evidence({ evidence = [], advanced }) {
  if (!evidence.length) return null;
  const files = evidence.length === 1 ? "1 piece of evidence" : `${evidence.length} pieces of evidence`;
  return (
    <details className="mvp-evidence" open={advanced || undefined}>
      <summary>{files}</summary>
      <ul>
        {evidence.map((e, i) => (
          <li key={`${e.file}-${e.line ?? ""}-${i}`}>
            <code>{e.file}{e.line ? `:${e.line}` : ""}</code> <span className="core-muted">{e.note}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ReasonPrompt({ feature, initial, later, busy, onCancel, onMove }) {
  const options = later.filter((s) => s.id !== feature.stage);
  const [to, setTo] = useState(options.some((s) => s.id === initial) ? initial : options[0]?.id);
  const [reason, setReason] = useState("");
  const ok = reason.trim() && reason.trim().toUpperCase() !== "TBD";
  return (
    <form className="mvp-prompt" onSubmit={(e) => { e.preventDefault(); if (ok) onMove(to, reason.trim()); }} aria-label={`Move ${feature.name} later`}>
      <label className="mvp-field">
        <span>Move to</span>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label className="mvp-field">
        <span>Why can it wait? (one line)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value.replace(/[\r\n]/g, " "))} maxLength={200} autoFocus placeholder="The first journey works without it" />
      </label>
      <div className="mvp-card-actions">
        <button type="submit" className="core-button primary" disabled={busy || !ok}>Move</button>
        <button type="button" className="core-button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function DoneWhen({ data, mvpName, advanced }) {
  const journey = data.journey;
  const done = data.doneWhen;
  return (
    <section className="core-card mvp-done" aria-labelledby="mvp-done-title">
      <h3 id="mvp-done-title">When is the {mvpName} done?</h3>
      <p>
        When the line is confirmed, every {mvpName} feature is Done, and one end-to-end journey passes its test.
        {done?.done ? <strong className="mvp-done-yes"> The {mvpName} is done.</strong> : null}
      </p>
      {journey && (
        <div className="mvp-journey">
          <p><strong>The journey:</strong> {journey.name}</p>
          {journey.steps?.length > 0 && <ol>{journey.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
          <p className="core-muted">
            {done?.journeyPassed ? "The journey test has passed." : "The journey test has not passed yet."}
            {advanced && <> <code>{journey.test}</code></>}
          </p>
        </div>
      )}
      {done && !done.done && done.blocking?.length > 0 && (
        <>
          <p><strong>Still to do</strong></p>
          <ul className="mvp-blocking">{(advanced || !done.todo ? done.blocking : done.todo).map((b, i) => <li key={i}>{b}</li>)}</ul>
        </>
      )}
    </section>
  );
}
