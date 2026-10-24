import { useEffect, useRef, useState } from "react";
import { PlayIcon, StopIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useCoreResource } from "./coreApi.js";
import "./coreScreens.css";
import "./CoreTerminal.css";

// The script pane (core/host/routes/terminal.ts). A fixed list of one-click scripts: pick one, read the
// exact command, press Run. What you type goes to the program only; the host never stores or returns it.
export const TERMINAL_POLL_MS = 700;
const GROUPS = ["Agents", "Cloud", "Code"];

export function CoreTerminal() {
  const [picked, setPicked] = useState(null);
  const [line, setLine] = useState("");
  const [hide, setHide] = useState(true);
  const [error, setError] = useState(null);
  const outRef = useRef(null);
  const list = useCoreResource("/terminal/scripts", { isEmpty: () => false });
  const [running, setRunning] = useState(false);
  const run = useCoreResource("/terminal/run", { isEmpty: () => false, pollMs: running ? TERMINAL_POLL_MS : 0 });
  const scripts = list.status === "ready" ? list.data?.scripts ?? [] : [];
  const state = run.status === "ready" ? run.data : { state: "idle", output: "" };
  const script = scripts.find((s) => s.id === picked);
  const active = state.state === "running";
  useEffect(() => { setRunning(active); }, [active]);
  useEffect(() => { if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight; }, [state.output]);

  const act = async (path, body) => {
    setError(null);
    try { await run.post(path, body ?? {}); if (path === "/terminal/run") setRunning(true); } catch (e) { setError(e); }
  };
  const send = async (event) => {
    event.preventDefault();
    if (!active) return;
    const text = line;
    setLine("");
    await act("/terminal/input", { text, secret: hide });
  };

  if (list.status !== "ready" || !scripts.length) return null;
  return (
    <section className="core-terminal core-card" aria-labelledby="core-terminal-title">
      <div className="core-terminal-head">
        <TerminalWindowIcon weight="duotone" aria-hidden="true" />
        <div>
          <h3 id="core-terminal-title">Terminal</h3>
          <p>Pick a script, read what it will run, then press Run. Nothing starts on its own, and what you type is never saved.</p>
        </div>
      </div>
      {GROUPS.map((group) => (
        <div key={group} className="core-terminal-group" role="group" aria-label={group}>
          <small>{group}</small>
          <div>
            {scripts.filter((s) => s.group === group).map((s) => (
              <button key={s.id} type="button" className="core-button" aria-pressed={picked === s.id} disabled={active} onClick={() => setPicked(s.id)}>{s.label}</button>
            ))}
          </div>
        </div>
      ))}
      {script && (
        <div className="core-terminal-plan">
          <p>{script.about}</p>
          <pre aria-label="The command that will run">{script.shown}</pre>
          <button type="button" className="core-button" disabled={active} onClick={() => act("/terminal/run", { script: script.id })}><PlayIcon aria-hidden="true" /> Run</button>
        </div>
      )}
      <pre ref={outRef} className="core-terminal-out" tabIndex={0} aria-label="Script output" data-state={state.state}>{state.output || "Output shows here."}</pre>
      {active && (
        <form className="core-terminal-in" onSubmit={send}>
          <input type={hide ? "password" : "text"} value={line} onChange={(e) => setLine(e.target.value)} aria-label="Type a reply to the script" autoComplete="off" spellCheck="false" />
          <button type="submit" className="core-button">Send</button>
          <label><input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} /> Hide what I type</label>
          <button type="button" className="core-button" onClick={() => act("/terminal/stop")}><StopIcon aria-hidden="true" /> Stop</button>
        </form>
      )}
      {!active && state.state !== "idle" && <p className="core-muted" role="status">{state.state === "done" ? "Finished." : state.state === "stopped" ? "Stopped." : "It did not finish."}</p>}
      {error && <p className="core-agent-connect-warn" role="status">{error.message}</p>}
    </section>
  );
}

export default CoreTerminal;
