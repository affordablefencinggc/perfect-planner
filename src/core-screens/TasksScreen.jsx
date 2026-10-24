import { useCallback, useEffect, useState } from "react";
import { CheckCircleIcon, CopyIcon, GitMergeIcon, PlayIcon, SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { describeLaunchFolder } from "../browser/launchFolder.js";
import { copyText } from "../project/connectAgentSetup.js";
import { WorkHeader } from "./WorkHeader.jsx";
import { AdvancedOnly, CoreScreen, useAdvanced } from "./CoreScreen.jsx";
import { coreGet, corePost, useCoreResource } from "./coreApi.js";
import { CostPanel, GroupBar, RepoBar } from "./TasksRepos.jsx";
import "./TasksScreen.css";

// Run the core loop from the app (core/host/routes/tasks.ts): start a worker on a task, approve
// its test, check the work, approve the diff and merge. Every button is a person action through
// the app window's own session, and each approval names exactly what the person saw (the test entry,
// the commit whose diff they read), so a worker changing it meanwhile makes the click stale. The
// worker's token stays in a file; the commands only name that file.
export const TASKS_POLL_MS = 2000;
export const DEFAULT_WORKER_MODEL = "claude-sonnet-4-5";

const STAGE = {
  "needs-test": { label: "Needs a test", tone: "" },
  "test-proposed": { label: "Test to approve", tone: "warn" },
  "test-approved": { label: "Test approved", tone: "warn" },
  "test-passes-already": { label: "Test already passes", tone: "bad" },
  "waiting-for-jev": { label: "Waiting for Jev", tone: "warn" },
  "jev-found-gaps": { label: "Jev found gaps", tone: "bad" },
  "ready-to-claim": { label: "Waiting for the worker to claim", tone: "" },
  building: { label: "Being built", tone: "" },
  "review-diff": { label: "Diff to review", tone: "warn" },
  "ready-to-merge": { label: "Ready to merge", tone: "good" },
  reopened: { label: "Sent back", tone: "warn" },
  done: { label: "Done", tone: "good" },
};

// The last 20 lines of a test's output, where the reason a test failed is.
const tail = (output) => String(output ?? "").split(/\r?\n/).filter((l) => l.trim()).slice(-20).join("\n").slice(-2000);
const withTail = (text, output) => (tail(output) ? `${text}\n\n${tail(output)}` : text);

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
        {Object.entries(dispatch.agents ?? {}).map(([name, a]) => (
          <div key={name}>
            <p className="core-muted">{name === "gemini" ? "Gemini CLI" : "Codex CLI"}: run the set-up, then the start command. {a.note}</p>
            <Snippet label={`${name} set-up`} id={`${dispatch.task}:${name}:setup`} text={a.setup} copied={copied} onCopy={copy} />
            <Snippet label={`${name} start`} id={`${dispatch.task}:${name}:start`} text={a.start} copied={copied} onCopy={copy} />
          </div>
        ))}
      </details>
      {copied && !copied.ok && <p className="core-tasks-warn">Copy did not work here. Select the text and copy it by hand.</p>}
      <p className="core-muted">The command holds this worker's private key and works only for {dispatch.task}. It is shown once.</p>
      <button type="button" className="core-button" onClick={onClose}>Hide command</button>
    </div>
  );
}

// What Jev said about the test or the change, in Jev's own plain reasons. Shown only once a Jev key is saved.
function JevLine({ label, line }) {
  if (!line) return null;
  return (
    <div className={`core-tasks-jev ${line.state}`}>
      <p className="core-tasks-line"><span className="core-muted">{label}</span> {line.message}</p>
      {line.reasons.length > 0 && <ul>{line.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}
    </div>
  );
}

function RepoPicker({ repo, onSave }) {
  const [root, setRoot] = useState(repo.suggested ?? "");
  const [error, setError] = useState(null);
  // No folder suggested by the host: offer the folder the person already imported, once, unless they typed something.
  useEffect(() => {
    if (repo.suggested) return undefined;
    let live = true;
    describeLaunchFolder().then((folder) => { if (live && folder?.path) setRoot((current) => current || folder.path); });
    return () => { live = false; };
  }, [repo.suggested]);
  const [busy, setBusy] = useState(false);
  // Offer the folder this window was opened for (never the app's own data folder), unless one is typed already.
  useEffect(() => {
    if (repo.suggested) return undefined;
    let live = true;
    describeLaunchFolder().then((found) => { if (live && found?.path) setRoot((now) => now || found.path); });
    return () => { live = false; };
  }, [repo.suggested]);
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

/** Files in the diff that can run code on this computer: listed loudly, with their own confirmation. */
function SensitiveBlock({ diff, confirmed, onConfirm, canConfirm }) {
  const files = diff.sensitive ?? [];
  if (!files.length) return null;
  return (
    <div className="core-tasks-sensitive" role="alert" aria-label={`Files that can run code in ${diff.task}`}>
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      <div>
        <strong>This diff changes {files.length === 1 ? "a file" : `${files.length} files`} that can run code on your computer.</strong>
        <p>Install scripts, lockfiles, git settings and hooks, CI workflows and npm settings run or change programs when you install, push or merge. Test files are listed too, because a test can change what the approved test checks or run code when it is run. The test you approved is not listed while it is exactly as you approved it. Read each one in the diff below before approving.</p>
        <ul>{files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
        {canConfirm && (
          <label className="core-tasks-sensitive-confirm">
            <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />
            I read the changes to {files.length === 1 ? "this file" : `these ${files.length} files`} and they are safe to run on my computer
          </label>
        )}
      </div>
    </div>
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

const sizeOf = (bytes, approx) => `${approx ? "over " : ""}${bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`}`;

/** Advanced view: task folders nobody is working in, with owner, size and why each is kept. The person chooses. */
function KeptFolders({ project, version, onChange }) {
  const [list, setList] = useState(null);
  const [said, setSaid] = useState("");
  const load = useCallback(() => coreGet("/worktrees", project).then(setList, (e) => setSaid(e.message)), [project]);
  useEffect(() => { load(); }, [load, version]);
  const call = async (path, done) => {
    setSaid("");
    try { setSaid(done(await corePost(path, project, {}))); } catch (e) { setSaid(e.message); }
    load();
    onChange();
  };
  if (!list) return said ? <p className="core-tasks-warn" role="alert">{said}</p> : null;
  return (
    <section className="core-card core-tasks-folders" aria-label="Folders nobody is working in">
      <h3>Folders nobody is working in</h3>
      <p className="core-muted">Perfect Planner removes a task's folder by itself only when the task is finished and nothing in the folder can be lost. The rest are kept and listed here. Removing a folder keeps the work on its branch.</p>
      {list.folders.length === 0 && <p className="core-muted">None. Every task folder belongs to a task still being worked on.</p>}
      <ul>
        {list.folders.map((f) => (
          <li key={f.task}>
            <strong>{f.task}</strong> <span className="core-muted">{f.branch} · Owner: {f.owner ?? "unknown"} · {sizeOf(f.sizeBytes, f.sizeApproximate)}</span>
            <ul>{f.why.map((why) => <li key={why}>{why}</li>)}</ul>
            {f.removable && <button type="button" className="core-button" onClick={() => call(`/worktrees/${encodeURIComponent(f.task)}/remove`, () => `Removed the folder for ${f.task}. Its work stays on ${f.branch}.`)}>Remove folder for {f.task}</button>}
          </li>
        ))}
      </ul>
      <button type="button" className="core-button" onClick={() => call("/worktrees/clean", (r) => (r.removed.length ? `Removed ${r.removed.length} ${r.removed.length === 1 ? "folder" : "folders"}: ${r.removed.map((x) => x.task).join(", ")}.` : "Nothing was safe to remove."))}>Clean up safe folders</button>
      {said && <p className="core-tasks-line" role="status">{said}</p>}
    </section>
  );
}

function TaskCard({ task, repoRoot, project, act, busy, notice, dispatchFor, onDispatched, onHideDispatch, showRepo }) {
  const [model, setModel] = useState(task.dispatch?.model ?? DEFAULT_WORKER_MODEL);
  const [diff, setDiff] = useState(null);
  const [diffError, setDiffError] = useState(null);
  const [sensitiveConfirmed, setSensitiveConfirmed] = useState(false);
  const [sendBack, setSendBack] = useState(false);
  const [notes, setNotes] = useState("");
  const [releasing, setReleasing] = useState(false);
  const [releaseReason, setReleaseReason] = useState("");
  const [doing, setDoing] = useState("");
  const stage = STAGE[task.stage] ?? { label: task.stage, tone: "" };
  const id = task.id;
  const working = busy === id;
  const run = async (step, path, body) => { setDoing(step); try { return await act(id, step, path, body); } finally { setDoing(""); } };
  // Why "Check the work" is greyed or slow, in plain words.
  const checking = working && doing === "check";
  const checkNote = checking ? "Running the approved test in the worker's folder. This can take a minute or more." : working ? "Another step on this task is still running." : task.checkReady?.note ?? "";
  const folder = task.worktree && task.worktree.state && task.worktree.state !== "ok" ? task.worktree : null;
  const base = task.worktree?.base ?? "main";

  const showDiff = async () => {
    setDiffError(null);
    setSensitiveConfirmed(false);
    try { setDiff(await coreGet(`/tasks/${id}/diff`, project)); } catch (error) { setDiffError(error); }
  };

  const startWorker = async () => {
    const result = await run("dispatch", `/tasks/${id}/dispatch`, model.trim() ? { model: model.trim() } : {});
    if (result) onDispatched(result);
  };

  // A worker holds the task (claimed, or blocked while still holding it): the person can free it.
  const canRelease = Boolean(task.owner) && (task.status === "claimed" || task.status === "blocked");
  // A diff that was sent back (by the person or by Jev) is no longer the task's change.
  const diffStillWanted = task.stage === "review-diff" || task.stage === "ready-to-merge";
  const canStart = !["done", "ready-to-merge", "review-diff"].includes(task.stage) && task.status !== "claimed";

  return (
    <article className="core-card core-tasks-card" aria-label={`${task.label} ${task.title}`} data-stage={task.stage}>
      <header>
        <div>
          <span className="core-tasks-id">{task.label}</span>
          {showRepo && <span className="core-pill core-tasks-repo-pill">{task.repo}</span>}
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

      {task.jev && <JevLine label="Jev on the test" line={task.jev.test} />}
      {task.jev && ["review-diff", "ready-to-merge", "reopened"].includes(task.stage) && <JevLine label="Jev on the change" line={task.jev.diff} />}
      {task.owner && task.status !== "done" && <p className="core-tasks-line"><span className="core-muted">Worker</span> {task.owner}</p>}
      {task.lastProgress && <p className="core-tasks-line"><span className="core-muted">Latest</span> {task.lastProgress}</p>}
      {task.proofs.length > 0 && <p className="core-tasks-line"><span className="core-muted">Proof</span> {task.proofs.map((p) => `${p.kind} ${p.link.slice(0, 12)}`).join(", ")}</p>}
      {task.check && task.stage !== "done" && (
        <p className="core-tasks-line"><span className="core-muted">Last check</span> {task.check.passed ? "passed" : "failed"}{task.check.commit ? ` at ${task.check.commit.slice(0, 12)}` : ""}</p>
      )}
      {task.merged && <p className="core-tasks-line"><span className="core-muted">Merged</span> {task.merged.commit?.slice(0, 12)}</p>}
      <WorkHeader
        facts={[
          ["Repository", repoRoot, true],
          ["Branch", task.worktree?.branch],
          ["Base", task.worktree ? base : null],
          ["Worker", task.owner],
          ["Model", task.dispatch?.model],
          ["Started", task.dispatch?.issuedAt?.replace("T", " ").slice(0, 16)],
          ["Worktree", task.worktree ? `${task.worktree.path} · port ${task.worktree.port}` : null, true],
          ["Contract", task.test ? (task.approval ? "Test approved" : "Test proposed") : "No test yet"],
          ["File scope", task.claims?.length ? `${task.claims.length} claimed` : null],
        ]}
      />

      {folder && (
        <p className="core-tasks-notice warn" role="status">
          {folder.note}{" "}
          {folder.state === "missing" && <button type="button" className="core-button" onClick={() => run("recreate", `/tasks/${id}/recreate-folder`)} disabled={working}>Recreate the folder</button>}
        </p>
      )}
      {task.waitingFor && task.stage !== "done" && <p className="core-tasks-warn">{task.waitingFor.message}</p>}
      {task.claims?.length > 0 && <p className="core-tasks-line"><span className="core-muted">File claims</span> {task.claims.join(", ")}{task.staleClaims ? ` (${task.staleClaims}, so these can be released)` : ""}</p>}

      {notice && !(folder && notice.text.startsWith(folder.note)) && <p className={`core-tasks-notice ${notice.tone}`} role="status">{notice.text}</p>}

      <div className="core-tasks-actions">
        {canStart && !dispatchFor && (
          <span className="core-tasks-start">
            <label>Worker model<input value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" /></label>
            <button type="button" className={`core-button ${task.stage === "needs-test" ? "primary" : ""}`} onClick={startWorker} disabled={working || Boolean(task.waitingFor)} title={task.waitingFor?.message}>
              {working ? <SpinnerGapIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />} {task.dispatch ? "Start worker again" : "Start worker"}
            </button>
          </span>
        )}
        {(task.stage === "test-proposed" || task.stage === "test-approved") && (
          <button type="button" className="core-button primary" onClick={() => run("approve-test", `/tasks/${id}/approve-test`, { test: task.test.entry })} disabled={working || !task.worktree}>
            {task.stage === "test-proposed" ? "Approve test" : "Run the test again"}
          </button>
        )}
        {task.jev?.test?.canRetry && (
          <button type="button" className="core-button primary" onClick={() => run("approve-test", `/tasks/${id}/approve-test`, { test: task.test.entry })} disabled={working || !task.worktree}>
            {task.jev.test.state === "waiting" ? "Ask Jev to review the test" : "Ask Jev again"}
          </button>
        )}
        {task.stage === "building" && (
          <button type="button" className="core-button primary" onClick={() => run("check", `/tasks/${id}/check`)} disabled={working || task.checkReady?.ok === false} aria-describedby={checkNote ? `${id}-check-why` : undefined}>
            {checking ? <><SpinnerGapIcon aria-hidden="true" /> Checking…</> : "Check the work"}
          </button>
        )}
        {(task.stage === "review-diff" || task.stage === "ready-to-merge") && (
          <>
            <button type="button" className="core-button" onClick={showDiff}>Show diff</button>
            {task.stage === "review-diff" && (
              <button type="button" className="core-button primary" onClick={() => run("approve-diff", `/tasks/${id}/approve-diff`, { commit: diff.commit, ...(diff.sensitive?.length ? { confirmSensitive: diff.sensitive } : {}) })} disabled={working || !diff || (diff.sensitive?.length > 0 && !sensitiveConfirmed)} title={!diff ? "Read the diff first" : diff.sensitive?.length > 0 && !sensitiveConfirmed ? "Confirm the files that can run code first" : undefined}>
                Approve diff{diff ? ` at ${String(diff.commit).slice(0, 12)}` : ""}
              </button>
            )}
            {task.stage === "review-diff" && <button type="button" className="core-button" onClick={() => setSendBack(true)}>Send back</button>}
            {task.stage === "ready-to-merge" && (
              <button type="button" className="core-button primary" onClick={() => run("merge", `/tasks/${id}/merge`, { commit: task.diffApproval?.commit })} disabled={working}>
                {working ? <SpinnerGapIcon aria-hidden="true" /> : <GitMergeIcon aria-hidden="true" />} Merge into {base}
              </button>
            )}
          </>
        )}
        {canRelease && !releasing && (
          <button type="button" className="core-button" onClick={() => setReleasing(true)} disabled={working}>Release claim</button>
        )}
        {task.worktree && task.stage !== "done" && (
          <button type="button" className="core-button" onClick={() => run("update", `/tasks/${id}/update-from-main`)} disabled={working} title="Merges the newest work from the main line into this task's own folder. Refused, with nothing changed, if the worker has unsaved changes or the two clash.">Bring this task up to date with {base}</button>
        )}
        {task.staleClaims && task.claims?.length > 0 && (
          <button type="button" className="core-button" onClick={() => run("release-claims", `/tasks/${id}/release-claims`)} disabled={working}>Release file claims</button>
        )}
      </div>

      {task.stage === "building" && checkNote && <p id={`${id}-check-why`} className={task.checkReady?.ok === false && !working ? "core-tasks-warn" : "core-muted core-tasks-line"}>{checkNote}</p>}

      {canRelease && releasing && (
        <form className="core-tasks-sendback" aria-label={`Release ${task.label}`} onSubmit={async (e) => { e.preventDefault(); const ok = await run("release", `/tasks/${id}/release`, { owner: task.owner, ...(releaseReason.trim() ? { reason: releaseReason.trim() } : {}) }); if (ok) { setReleasing(false); setReleaseReason(""); } }}>
          <p className="core-muted">Release this task so another worker can take it. Its worktree and commits are kept. {task.owner} can no longer work on it.</p>
          <label>Why (optional)<input value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} autoComplete="off" /></label>
          <button type="submit" className="core-button primary" disabled={working}>Release {task.label}</button>
          <button type="button" className="core-button" onClick={() => setReleasing(false)}>Cancel</button>
        </form>
      )}

      {task.stage === "needs-test" && task.worktree && <OwnTestForm onSave={(body) => run("test", `/tasks/${id}/test`, body)} />}

      {sendBack && (
        <form className="core-tasks-sendback" onSubmit={async (e) => { e.preventDefault(); const ok = await run("reject", `/tasks/${id}/reject`, { notes: notes.trim() }); if (ok) { setSendBack(false); setNotes(""); } }}>
          <label>What should change<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></label>
          <button type="submit" className="core-button primary" disabled={!notes.trim() || working}>Send back to the worker</button>
          <button type="button" className="core-button" onClick={() => setSendBack(false)}>Cancel</button>
        </form>
      )}

      {diffError && <p className="core-tasks-warn" role="alert">{diffError.message}</p>}
      {diff && diffStillWanted && <SensitiveBlock diff={diff} confirmed={sensitiveConfirmed} onConfirm={setSensitiveConfirmed} canConfirm={task.stage === "review-diff"} />}
      {diff && diffStillWanted && <DiffView diff={diff} />}

      {dispatchFor && <DispatchPanel dispatch={dispatchFor} onClose={onHideDispatch} />}
    </article>
  );
}


const BATCH_ICON = { merged: "Merged", approved: "Approved", skipped: "Skipped", failed: "Failed" };

/** Worker limit, Start all, and where every task is in the line. All counts come from the host's ledger view. */
function QueuePanel({ data, post, busy, onStarted, onNotice }) {
  const { queue, settings } = data;
  const [model, setModel] = useState(DEFAULT_WORKER_MODEL);
  const [batch, setBatch] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const start = queue.notStarted.filter((t) => t.why === "Can start now.");
  const run = async (key, fn) => {
    setError(null);
    setResult(null);
    onNotice(key);
    try { await fn(); } catch (e) { setError(e); } finally { onNotice(null); }
  };
  const save = (body) => run("settings", () => post("/tasks/settings", body));
  const startAll = () => run("start-all", async () => {
    const r = await post("/tasks/start-all", model.trim() ? { model: model.trim() } : {});
    onStarted(r.started);
    setResult({ started: r.started.length, refused: r.refused });
  });
  // Read every waiting diff, then offer the clean ones together. A diff with a flagged file is never in the batch.
  const load = () => run("batch-load", async () => {
    const ids = [...queue.waitingForYou, ...queue.readyToMerge];
    const diffs = await Promise.all(queue.waitingForYou.map((id) => coreGet(`/tasks/${id}/diff`, data.project)));
    const byId = Object.fromEntries(diffs.map((d) => [d.task.replace(/\.a\d+$/, ""), d]));
    const tasks = Object.fromEntries(data.tasks.map((t) => [t.id, t]));
    setBatch({
      clean: ids.filter((id) => tasks[id].stage === "ready-to-merge" || !byId[id]?.sensitive.length).map((id) => ({ id, title: tasks[id].title, commit: byId[id]?.commit ?? tasks[id].diffApproval.commit, files: byId[id]?.files, ready: tasks[id].stage === "ready-to-merge" })),
      flagged: ids.filter((id) => tasks[id].stage === "review-diff" && byId[id]?.sensitive.length).map((id) => ({ id, title: tasks[id].title, files: byId[id].sensitive })),
    });
  });
  const merge = () => run("batch", async () => {
    const r = await post("/tasks/batch", { items: batch.clean.map(({ id, commit }) => ({ id, commit })) });
    setResult({ batch: r.results });
    setBatch(null);
  });
  const waiting = queue.waitingForYou.length + queue.readyToMerge.length;
  return (
    <section className="core-card core-tasks-queue" aria-label="Worker queue">
      <header>
        <h3>Queue</h3>
        <span className="core-muted">{queue.running.length} of {queue.limit} workers running · {queue.notStarted.length} not started · {queue.waitingForYou.length} diffs to read · {queue.readyToMerge.length} ready to merge · {queue.done} done</span>
      </header>
      <div className="core-tasks-actions">
        <label>Workers at once
          <select value={queue.limit} onChange={(e) => save({ limit: Number(e.target.value) })} disabled={Boolean(busy)}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>Worker model<input value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" /></label>
        <button type="button" className="core-button primary" onClick={startAll} disabled={Boolean(busy) || !start.length} title={start.length ? undefined : "No task can start right now"}>
          {busy === "start-all" ? <SpinnerGapIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />} Start all ({Math.min(start.length, Math.max(0, queue.limit - queue.running.length))})
        </button>
        <label className="core-tasks-switch"><span>
          <input type="checkbox" checked={settings.autoMerge} onChange={(e) => save({ autoMerge: e.target.checked })} disabled={Boolean(busy)} /> Merge right after I approve a diff with no flagged files
        </span></label>
      </div>
      {queue.notStarted.length > 0 && (
        <ul className="core-tasks-queue-list" aria-label="Tasks not started">
          {queue.notStarted.map((t) => <li key={t.id}><code>{t.id}</code> {t.why}</li>)}
        </ul>
      )}
      {waiting > 1 && !batch && (
        <button type="button" className="core-button" onClick={load} disabled={Boolean(busy)}>Review {waiting} finished tasks together</button>
      )}
      {batch && (
        <div className="core-tasks-batch" role="region" aria-label="Approve together">
          {batch.clean.length > 0 && <>
            <strong>{batch.clean.length} with no flagged files</strong>
            <ul>{batch.clean.map((t) => <li key={t.id}><code>{t.id}</code> {t.title} <span className="core-muted">{t.ready ? "already approved, ready to merge" : (t.files ?? []).join(", ")}</span></li>)}</ul>
            <button type="button" className="core-button primary" onClick={merge} disabled={Boolean(busy)}>
              {busy === "batch" ? <SpinnerGapIcon aria-hidden="true" /> : <GitMergeIcon aria-hidden="true" />} Approve and merge these {batch.clean.length}
            </button>
          </>}
          {batch.flagged.length > 0 && <>
            <strong>{batch.flagged.length} to read yourself</strong>
            <ul>{batch.flagged.map((t) => <li key={t.id}><code>{t.id}</code> {t.title} <span className="core-muted">flagged: {t.files.join(", ")}</span></li>)}</ul>
          </>}
          <button type="button" className="core-button" onClick={() => setBatch(null)}>Close</button>
        </div>
      )}
      {result?.started !== undefined && <p className="core-tasks-notice good" role="status">Started {result.started} worker{result.started === 1 ? "" : "s"}; the commands are on each card.{result.refused.map((r) => ` ${r.id}: ${r.message}`).join("")}</p>}
      {result?.batch && (
        <ul className="core-tasks-notice" role="status" aria-label="Batch result">
          {result.batch.map((r) => <li key={r.id}><strong>{r.id} {BATCH_ICON[r.outcome]}.</strong> {withTail(r.message)}</li>)}
        </ul>
      )}
      {error && <p className="core-tasks-warn" role="alert">{error.message}</p>}
    </section>
  );
}

const NOTICE = {
  dispatch: () => null,
  "merge-group": (r) => ({ tone: r.merged?.length ? "good" : "warn", text: r.message ?? `Merged ${r.merged.map((m) => `${m.task} (${m.repo})`).join(" and ")}.` }),
  test: () => ({ tone: "good", text: "Test saved. Approve it to run it on today's code." }),
  "approve-test": (r) => {
    if (!r.failsFirst) return { tone: "bad", text: `Approved, but ${r.reason ?? "the test did not fail on today's code"}${r.output ? `\n\n${tail(r.output)}` : ""}` };
    if (!r.jev) return { tone: "good", text: "Approved. The test fails on today's code, as it should, so the worker can claim the task now." };
    if (r.jev.state === "approved") return { tone: "good", text: "Approved. The test fails on today's code, as it should, and Jev found no gaps, so the worker can claim the task now." };
    const reasons = r.jev.reasons?.length ? ` ${r.jev.reasons.join(" ")}` : "";
    return { tone: r.jev.state === "gaps" ? "bad" : "warn", text: `Approved, and the test fails on today's code, but the worker cannot start yet. ${r.jev.message}${reasons}${r.jev.canRetry ? " Press Ask Jev again to try again." : ""}` };
  },
  recreate: (r) => ({ tone: "good", text: `Recreated the folder for ${r.recreated} from its branch ${r.branch}. The work saved on it is back.${r.ledgerNote ? ` ${r.ledgerNote}` : ""}` }),
  check: (r) => (r.passed
    ? { tone: "good", text: `The approved test passes in the worktree at ${String(r.commit ?? "").slice(0, 12)}. Review the diff next.` }
    : { tone: "bad", text: withTail(r.reason ?? "The test failed.", r.output) }),
  "approve-diff": (r) => {
    if (r.merged) return { tone: "good", text: `Approved and merged into ${r.into} at ${String(r.commit ?? "").slice(0, 12)} (auto-merge is on). The test passed on the merge and the task is done.` };
    if (r.autoMergeStopped) return { tone: "bad", text: `Approved, but auto-merge stopped: ${r.autoMergeStopped}` };
    if (r.approved === false && r.reopenedAs) return { tone: "warn", text: `Jev sent the change back, so it was not approved. ${(r.jev?.reasons ?? []).join(" ")} Reopened as ${r.reopenedAs}; the worker's files are kept. Start a worker on it when you are ready.` };
    return { tone: "good", text: `${r.jev?.state === "approved" ? "Jev read the change and found no problems, and you approved it. " : "Diff approved. "}Merging reruns the test on the merged code first.` };
  },
  reject: (r) => ({ tone: "warn", text: `Reopened as ${r.reopenedAs}. Start a worker on it when you are ready.` }),
  release: (r) => ({ tone: "warn", text: `Released ${r.released} from ${r.from}. Its worktree and commits are kept; start a worker on it when you are ready.` }),
  update: (r) => ({ tone: r.updated ? "warn" : "", text: r.message }),
  "release-claims": (r) => ({ tone: "good", text: r.message }),
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
  const advanced = useAdvanced();
  const addRepo = async (name, root) => resource.post("/repos", { name, root });
  const removeRepo = (name) => act("repo", "repo", "/repos/remove", { name });
  const mergeGroup = (group) => act(`group:${group.group}`, "merge-group", `/tasks/groups/${group.group}/merge`, { commits: Object.fromEntries(group.tasks.map((id) => [id, data.tasks.find((t) => t.id === id)?.diffApproval?.commit])) });
  const manyRepos = (data?.repos?.length ?? 0) > 1;

  return (
    <CoreScreen
      id="tasks"
      title="Tasks"
      purpose="Start a worker on a task, approve its test, check the work, approve the diff and merge. Each step is yours and lands on the ledger."
      resource={resource}
      empty={<><strong>No tasks yet.</strong>Approve the plan in Deep planning, or add your own task there, and the tasks appear here.</>}
    >
      {data && !data.repo?.ok && <RepoPicker repo={data.repo} onSave={saveRepo} />}
      {data?.repo?.ok && data.queue && data.tasks.length > 0 && <QueuePanel data={{ ...data, project: resource.project }} post={resource.post} busy={busy} onNotice={setBusy} onStarted={(list) => setDispatches((all) => ({ ...all, ...Object.fromEntries(list.map((d) => [d.task, d])) }))} />}
      {data?.repo?.ok && !manyRepos && (
        <p className="core-muted core-tasks-repo-line">Workers branch from <code>{data.repo.root}</code></p>
      )}
      {data?.repo?.ok && data.repos && <RepoBar repos={data.repos} onAdd={addRepo} onRemove={removeRepo} />}
      {notices.repo && <p className={`core-tasks-notice ${notices.repo.tone}`}>{notices.repo.text}</p>}
      {data?.groups?.map((group) => <GroupBar key={group.group} group={group} tasks={data.tasks} busy={busy === `group:${group.group}`} notice={notices[`group:${group.group}`]} onMerge={mergeGroup} />)}
      {advanced && data?.repo?.ok && <KeptFolders project={resource.project} version={data.tasks.map((t) => `${t.id}${t.stage}${t.worktree?.state ?? ""}`).join()} onChange={resource.reload} />}
      {data && data.tasks.length > 0 && <CostPanel />}
      {data && data.tasks.length > 0 && (
        <div className="core-tasks-list">
          {data.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              showRepo={manyRepos}
              repoRoot={(data.repos?.find((r) => r.name === (task.repo ?? "main")) ?? data.repo)?.root}
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
