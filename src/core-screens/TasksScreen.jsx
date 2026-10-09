import { useState } from "react";
import { CheckCircleIcon, CopyIcon, GitMergeIcon, PlayIcon, SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { copyText } from "../project/connectAgentSetup.js";
import { AdvancedOnly, CoreScreen } from "./CoreScreen.jsx";
import { coreGet, useCoreResource } from "./coreApi.js";
import "./TasksScreen.css";

// Run the core loop from the app (core/host/routes/tasks.ts): start a worker on a task, approve
// its test, check the work, approve the diff and merge. Every button is a person action through
// the app window's own session; the worker only ever gets the token shown here once.
export const TASKS_POLL_MS = 2000;
export const DEFAULT_WORKER_MODEL = "claude-sonnet-4-5";

const STAGE = {
  "needs-test": { label: "Needs a test", tone: "" },
  "test-proposed": { label: "Test to approve", tone: "warn" },
  "test-approved": { label: "Test approved", tone: "warn" },
  "test-passes-already": { label: "Test already passes", tone: "bad" },
  "ready-to-claim": { label: "Waiting for the worker to claim", tone: "" },
  building: { label: "Being built", tone: "" },
  "review-diff": { label: "Diff to review", tone: "warn" },
  "ready-to-merge": { label: "Ready to merge", tone: "good" },
  reopened: { label: "Sent back", tone: "warn" },
  done: { label: "Done", tone: "good" },
};

const who = (actor) => (!actor ? "" : actor.kind === "person" ? `you (${actor.id})` : actor.model ? `${actor.id} (${actor.model})` : actor.id);

function Snippet({ label, text, id, copied, onCopy }) {
  return (
    <div className="core-tasks-snippet">
      <div className="core-tasks-snippet-head">
        <strong>{label}</strong>
        <button type="button" className="core-button" onClick={() => onCopy(id, text)} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied?.id === id && copied.ok ? <><CheckCircleIcon aria-hidden="true" /> Copied</> : <><CopyIcon aria-hidden="true" /> Copy</>}
        </button>
      </div>
      <pre tabIndex={0} aria-label={`${label} for ${id.split(":")[0]}`}><code>{text}</code></pre>
    </div>
  );
}

function DispatchPanel({ dispatch, onClose }) {
  const [copied, setCopied] = useState(null);
  const copy = async (id, text) => setCopied({ id, ok: await copyText(text) });
  return (
    <div className="core-tasks-dispatch" role="region" aria-label={`Worker for ${dispatch.task}`}>
      <p>
        Two steps in a {dispatch.shell === "PowerShell" ? "PowerShell window" : "terminal"} on this computer: the set-up command adds Perfect Planner to Claude Code in the task's own folder, then the start command opens Claude Code with the brief. The worker writes the test first and waits for you to approve it here.
      </p>
      {dispatch.warning && <p className="core-tasks-warn">{dispatch.warning}</p>}
      <Snippet label="Set-up command" id={`${dispatch.task}:setup`} text={dispatch.setup} copied={copied} onCopy={copy} />
      <Snippet label="Start command" id={`${dispatch.task}:start`} text={dispatch.start} copied={copied} onCopy={copy} />
      <details>
        <summary>Read the brief, or use another agent</summary>
        <Snippet label="Brief" id={`${dispatch.task}:brief`} text={dispatch.brief} copied={copied} onCopy={copy} />
        <Snippet label="MCP settings" id={`${dispatch.task}:json`} text={dispatch.json} copied={copied} onCopy={copy} />
      </details>
      {copied && !copied.ok && <p className="core-tasks-warn">Copy did not work here. Select the text and copy it by hand.</p>}
      <p className="core-muted">The command holds this worker's private key and works only for {dispatch.task}. It is shown once.</p>
      <button type="button" className="core-button" onClick={onClose}>Hide command</button>
    </div>
  );
}

function RepoPicker({ repo, onSave }) {
  const [root, setRoot] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { await onSave(root.trim()); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <form className="core-card core-tasks-repo" onSubmit={save}>
      <h3>Choose your project's git folder</h3>
      <p className="core-muted">{repo.reason}</p>
      <label>Git folder<input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="C:\repos\my-app" autoComplete="off" /></label>
      <button type="submit" className="core-button primary" disabled={!root.trim() || busy}>Use this folder</button>
      {error && <p className="core-tasks-warn" role="alert">{error.message}</p>}
    </form>
  );
}

function OwnTestForm({ onSave }) {
  const [command, setCommand] = useState("");
  const [files, setFiles] = useState("");
  const list = files.split(/[\n,]/).map((f) => f.trim()).filter(Boolean);
  return (
    <details className="core-tasks-own-test">
      <summary>Write the test yourself instead</summary>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ command: command.trim(), files: list }); }}>
        <label>Test command<input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm test -- tests/save.test.js" autoComplete="off" /></label>
        <label>Test file(s)<input value={files} onChange={(e) => setFiles(e.target.value)} placeholder="tests/save.test.js" autoComplete="off" /></label>
        <button type="submit" className="core-button" disabled={!command.trim() || !list.length}>Save test</button>
      </form>
    </details>
  );
}

function DiffView({ diff }) {
  return (
    <div className="core-tasks-diff">
      <p className="core-muted">{diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed: {diff.files.join(", ")}</p>
      <pre tabIndex={0} aria-label={`Diff for ${diff.task}`}>
        {diff.text.split("\n").map((line, i) => (
          <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : ""}>{line}{"\n"}</span>
        ))}
      </pre>
    </div>
  );
}

function TaskCard({ task, project, act, busy, notice, dispatchFor, onDispatched, onHideDispatch }) {
  const [model, setModel] = useState(task.dispatch?.model ?? DEFAULT_WORKER_MODEL);
  const [diff, setDiff] = useState(null);
  const [diffError, setDiffError] = useState(null);
  const [sendBack, setSendBack] = useState(false);
  const [notes, setNotes] = useState("");
  const stage = STAGE[task.stage] ?? { label: task.stage, tone: "" };
  const id = task.id;
  const working = busy === id;
  const run = (step, path, body) => act(id, step, path, body);
  const base = task.worktree?.base ?? "main";

  const showDiff = async () => {
    setDiffError(null);
    try { setDiff(await coreGet(`/tasks/${id}/diff`, project)); } catch (error) { setDiffError(error); }
  };

  const startWorker = async () => {
    const result = await run("dispatch", `/tasks/${id}/dispatch`, model.trim() ? { model: model.trim() } : {});
    if (result) onDispatched(result);
  };

  const canStart = !["done", "ready-to-merge", "review-diff"].includes(task.stage) && task.status !== "claimed";

  return (
    <article className="core-card core-tasks-card" aria-label={`${task.label} ${task.title}`} data-stage={task.stage}>
      <header>
        <div>
          <span className="core-tasks-id">{task.label}</span>
          <h3>{task.title}</h3>
          {task.clauses.length > 0 && <span className="core-muted core-tasks-clauses">{task.clauses.join(" · ")}</span>}
        </div>
        <span className={`core-pill ${stage.tone}`}>{stage.label}</span>
      </header>

      {task.test && (
        <div className="core-tasks-test">
          <span className="core-muted">Done-when test</span>
          <code>{task.test.command}</code>
          <span className="core-muted">
            {task.test.files.length > 0 && `${task.test.files.join(", ")} · `}Proposed by {who(task.test.by)}
            {task.approval && ` · approved by ${who(task.approval.by)}`}
            {task.baseline && (task.baseline.passed ? " · already passes, so it proves nothing" : " · fails on today's code")}
          </span>
        </div>
      )}

      {task.owner && task.status !== "done" && <p className="core-tasks-line"><span className="core-muted">Worker</span> {task.owner}</p>}
      {task.lastProgress && <p className="core-tasks-line"><span className="core-muted">Latest</span> {task.lastProgress}</p>}
      {task.proofs.length > 0 && <p className="core-tasks-line"><span className="core-muted">Proof</span> {task.proofs.map((p) => `${p.kind} ${p.link.slice(0, 12)}`).join(", ")}</p>}
      {task.check && task.stage !== "done" && (
        <p className="core-tasks-line"><span className="core-muted">Last check</span> {task.check.passed ? "passed" : "failed"}{task.check.commit ? ` at ${task.check.commit.slice(0, 12)}` : ""}</p>
      )}
      {task.merged && <p className="core-tasks-line"><span className="core-muted">Merged</span> {task.merged.commit?.slice(0, 12)}</p>}
      <AdvancedOnly as="p">{task.worktree ? `${task.worktree.branch} · ${task.worktree.path} · port ${task.worktree.port}` : "No worktree"}</AdvancedOnly>

      {notice && <p className={`core-tasks-notice ${notice.tone}`} role="status">{notice.text}</p>}

      <div className="core-tasks-actions">
        {canStart && !dispatchFor && (
          <span className="core-tasks-start">
            <label>Worker model<input value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" /></label>
            <button type="button" className={`core-button ${task.stage === "needs-test" ? "primary" : ""}`} onClick={startWorker} disabled={working}>
              {working ? <SpinnerGapIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />} {task.dispatch ? "Start worker again" : "Start worker"}
            </button>
          </span>
        )}
        {(task.stage === "test-proposed" || task.stage === "test-approved") && (
          <button type="button" className="core-button primary" onClick={() => run("approve-test", `/tasks/${id}/approve-test`)} disabled={working || !task.worktree}>
            {task.stage === "test-proposed" ? "Approve test" : "Run the test again"}
          </button>
        )}
        {task.stage === "building" && (
          <button type="button" className="core-button primary" onClick={() => run("check", `/tasks/${id}/check`)} disabled={working}>Check the work</button>
        )}
        {(task.stage === "review-diff" || task.stage === "ready-to-merge") && (
          <>
            <button type="button" className="core-button" onClick={showDiff}>Show diff</button>
            {task.stage === "review-diff" && <button type="button" className="core-button primary" onClick={() => run("approve-diff", `/tasks/${id}/approve-diff`)} disabled={working}>Approve diff</button>}
            {task.stage === "review-diff" && <button type="button" className="core-button" onClick={() => setSendBack(true)}>Send back</button>}
            {task.stage === "ready-to-merge" && (
              <button type="button" className="core-button primary" onClick={() => run("merge", `/tasks/${id}/merge`)} disabled={working}>
                {working ? <SpinnerGapIcon aria-hidden="true" /> : <GitMergeIcon aria-hidden="true" />} Merge into {base}
              </button>
            )}
          </>
        )}
      </div>

      {task.stage === "needs-test" && task.worktree && <OwnTestForm onSave={(body) => run("test", `/tasks/${id}/test`, body)} />}

      {sendBack && (
        <form className="core-tasks-sendback" onSubmit={async (e) => { e.preventDefault(); const ok = await run("reject", `/tasks/${id}/reject`, { notes: notes.trim() }); if (ok) { setSendBack(false); setNotes(""); } }}>
          <label>What should change<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></label>
          <button type="submit" className="core-button primary" disabled={!notes.trim() || working}>Send back to the worker</button>
          <button type="button" className="core-button" onClick={() => setSendBack(false)}>Cancel</button>
        </form>
      )}

      {diffError && <p className="core-tasks-warn" role="alert">{diffError.message}</p>}
      {diff && <DiffView diff={diff} />}

      {dispatchFor && <DispatchPanel dispatch={dispatchFor} onClose={onHideDispatch} />}
    </article>
  );
}

const NOTICE = {
  dispatch: () => null,
  test: () => ({ tone: "good", text: "Test saved. Approve it to run it on today's code." }),
  "approve-test": (r) => (r.failsFirst
    ? { tone: "good", text: "Approved. The test fails on today's code, as it should, so the worker can claim the task now." }
    : { tone: "bad", text: `Approved, but ${r.reason ?? "the test did not fail on today's code"}${r.output ? ` Output: ${r.output.slice(-300)}` : ""}` }),
  check: (r) => (r.passed
    ? { tone: "good", text: `The approved test passes in the worktree at ${String(r.commit ?? "").slice(0, 12)}. Review the diff next.` }
    : { tone: "bad", text: `${r.reason ?? "The test failed."}${r.output ? ` Output: ${r.output.slice(-300)}` : ""}` }),
  "approve-diff": () => ({ tone: "good", text: "Diff approved. Merging reruns the test on the merged code first." }),
  reject: (r) => ({ tone: "warn", text: `Reopened as ${r.reopenedAs}. Start a worker on it when you are ready.` }),
  merge: (r) => ({ tone: "good", text: `Merged into ${r.into} at ${String(r.commit ?? "").slice(0, 12)}. The test passed on the merge and the task is done.` }),
};

export default function TasksScreen() {
  const [busy, setBusy] = useState(null);
  const [notices, setNotices] = useState({});
  const [dispatches, setDispatches] = useState({});
  const resource = useCoreResource("/tasks", { isEmpty: (data) => !data || (data.repo?.ok && !data.tasks?.length), pollMs: TASKS_POLL_MS });
  const data = resource.data;

  const act = async (id, step, path, body) => {
    setBusy(id);
    setNotices((all) => ({ ...all, [id]: null }));
    try {
      const result = await resource.post(path, body ?? {});
      const notice = NOTICE[step]?.(result ?? {});
      if (notice) setNotices((all) => ({ ...all, [id]: notice }));
      return result ?? true;
    } catch (error) {
      setNotices((all) => ({ ...all, [id]: { tone: "bad", text: error.message } }));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const saveRepo = async (root) => resource.post("/tasks/repo", { root });

  return (
    <CoreScreen
      id="tasks"
      title="Tasks"
      purpose="Start a worker on a task, approve its test, check the work, approve the diff and merge. Each step is yours and lands on the ledger."
      resource={resource}
      empty={<><strong>No tasks yet.</strong>Approve the plan in Deep planning, or add your own task there, and the tasks appear here.</>}
    >
      {data && !data.repo?.ok && <RepoPicker repo={data.repo} onSave={saveRepo} />}
      {data?.repo?.ok && (
        <p className="core-muted core-tasks-repo-line">Workers branch from <code>{data.repo.root}</code></p>
      )}
      {data && data.tasks.length > 0 && (
        <div className="core-tasks-list">
          {data.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              project={resource.project}
              act={act}
              busy={busy}
              notice={notices[task.id]}
              dispatchFor={dispatches[task.id] && task.status !== "claimed" && task.status !== "done" ? dispatches[task.id] : null}
              onDispatched={(result) => setDispatches((all) => ({ ...all, [task.id]: result }))}
              onHideDispatch={() => setDispatches((all) => ({ ...all, [task.id]: null }))}
            />
          ))}
        </div>
      )}
      {data && !data.repo?.ok && data.tasks.length === 0 && (
        <p className="core-empty"><WarningCircleIcon aria-hidden="true" /> No tasks yet. Approve the plan in Deep planning first.</p>
      )}
    </CoreScreen>
  );
}
