import { useState } from "react";
import { PlayIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { corePost } from "./coreApi.js";
import "./TaskTerminalPanel.css";

const PRESETS = ["git status", "git diff --stat", "npm run test:core", "npm run typecheck:core"];

// A task-scoped command pane. The host runs one allowlisted, read-only command in the task's
// worktree with no shell; this panel shows the exact command, the exit code and the transcript
// hash. It is not a full interactive shell and it does not write to the ledger.
export function TaskTerminalPanel({ taskId, project, hasWorktree = true }) {
  const [command, setCommand] = useState("git status");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (event) => {
    event.preventDefault();
    if (!command.trim() || busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      setResult(await corePost(`/tasks/${taskId}/terminal`, project, { command }));
    } catch (failure) {
      setError(failure?.message ?? "The command did not run.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="task-terminal" aria-label="Task terminal">
      <header>
        <TerminalWindowIcon weight="duotone" aria-hidden="true" />
        <div>
          <h4>Terminal</h4>
          <p>One read-only command in this task's worktree. No shell, no writes, no saved secrets.</p>
        </div>
      </header>
      {!hasWorktree ? (
        <p className="task-terminal-empty" role="status">This task has no worktree. It is advisory only, so there is no folder to run in.</p>
      ) : (
        <>
          <div className="task-terminal-presets" role="group" aria-label="Suggested commands">
            {PRESETS.map((preset) => (
              <button key={preset} type="button" className="core-button" disabled={busy} onClick={() => setCommand(preset)}>{preset}</button>
            ))}
          </div>
          <form className="task-terminal-form" onSubmit={run}>
            <label className="task-terminal-input">
              <span aria-hidden="true">$</span>
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                aria-label="Command"
                autoComplete="off"
                spellCheck="false"
                disabled={busy}
              />
            </label>
            <button type="submit" className="core-button primary" disabled={busy || !command.trim()}>
              <PlayIcon aria-hidden="true" /> {busy ? "Running…" : "Run"}
            </button>
          </form>
          {error && <p role="alert" className="task-terminal-error">{error}</p>}
          {result && (
            <div className="task-terminal-result">
              <p className="task-terminal-meta">
                exit <strong className={result.exitCode === 0 ? "ok" : "bad"}>{result.exitCode}</strong>
                {" · "}{result.durationMs} ms
                {" · "}<code>{result.cwd}</code>
              </p>
              <pre tabIndex={0} aria-label="Command output">{result.stdout || result.stderr || "(no output)"}</pre>
              {result.stdout && result.stderr && (
                <details><summary>stderr</summary><pre>{result.stderr}</pre></details>
              )}
              <p className="task-terminal-hash">transcript {String(result.transcriptHash ?? "").slice(0, 16)}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default TaskTerminalPanel;
