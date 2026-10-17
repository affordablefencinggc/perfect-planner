import { useEffect, useState } from "react";
import { ArrowClockwiseIcon, CheckCircleIcon, CopyIcon, PlugsConnectedIcon, SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { copyText } from "../project/connectAgentSetup.js";
import { CoreLoading, useAdvanced } from "./CoreScreen.jsx";
import { useCoreResource } from "./coreApi.js";
import "./coreScreens.css";
import "./CoreAgentConnect.css";

// One-click Connect agent (core/host/routes/agents.ts). The token only ever
// lives in this component's memory, inside the command shown once; it is never
// written to storage and is dropped as soon as the agent checks in.
export const CONNECT_POLL_MS = 1500;

const ROLE_LABEL = { main: "Main chat", worker: "Worker", observer: "Read-only" };

// The relay marks a model the agent named itself as "unverified:<name>": show it as self-reported.
export function modelLabel(model) {
  if (!model) return "";
  const text = String(model);
  return text.startsWith("unverified:") ? `${text.slice("unverified:".length)}, self-reported` : text;
}

function describeAgent(agent) {
  return agent.model ? `${agent.name} (${modelLabel(agent.model)})` : agent.name;
}

export function CoreAgentConnect() {
  const advanced = useAdvanced();
  const [pending, setPending] = useState(null); // the connect response, token included
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [copied, setCopied] = useState(null);
  const [justConnected, setJustConnected] = useState(null);
  const resource = useCoreResource("/agents", { isEmpty: () => false, pollMs: pending ? CONNECT_POLL_MS : 0 });

  const data = resource.status === "ready" ? resource.data : null;
  const agents = data?.agents ?? [];
  const linked = pending && data ? data.connections?.find((c) => c.id === pending.connection)?.agent : null;
  const checkedIn = linked ? agents.find((a) => a.id === linked) : null;

  // Once the agent has checked in, forget the command (and the token in it).
  useEffect(() => {
    if (!checkedIn) return;
    setJustConnected(checkedIn);
    setPending(null);
    setCopied(null);
  }, [checkedIn]);

  const connect = async () => {
    setBusy(true);
    setActionError(null);
    setJustConnected(null);
    try {
      setPending(await resource.post("/agents/connect", {}));
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (agent) => {
    setActionError(null);
    try {
      await resource.post("/agents/revoke", { agent: agent.id });
      if (justConnected?.id === agent.id) setJustConnected(null);
    } catch (error) {
      setActionError(error);
    }
  };

  const copy = async (id, text) => setCopied({ id, ok: await copyText(text) });

  const live = agents.filter((a) => !a.revoked);

  return (
    <section className="core-screen-connect core-card" aria-labelledby="core-agent-connect-title" data-state={resource.status}>
      <div className="core-agent-connect-head">
        <span className="core-agent-connect-icon" aria-hidden="true"><PlugsConnectedIcon weight="duotone" /></span>
        <div>
          <h3 id="core-agent-connect-title">Connect an agent</h3>
          <p className="core-muted">
            Give your coding agent its own way to check in. The first agent you connect becomes your main chat: it answers questions from the agents working on tasks.
          </p>
        </div>
      </div>

      {resource.status === "loading" && <CoreLoading label="Loading connected agents" />}

      {resource.status === "error" && (
        <div className="core-agent-connect-error" role="status">
          <WarningCircleIcon weight="fill" aria-hidden="true" />
          <div>
            <strong>The local service is not answering.</strong>
            <p>{resource.error?.message || "Perfect Planner could not reach its local service."} Agents cannot connect until it is running.</p>
          </div>
          <button type="button" className="core-button" onClick={resource.reload}><ArrowClockwiseIcon aria-hidden="true" /> Try again</button>
        </div>
      )}

      {resource.status === "ready" && (
        <>
          {!pending && (
            <div className="core-agent-connect-actions">
              <button type="button" className="core-button primary" onClick={connect} disabled={busy}>
                {busy ? <SpinnerGapIcon aria-hidden="true" /> : <PlugsConnectedIcon aria-hidden="true" />} Connect agent
              </button>
            </div>
          )}

          {actionError && <p className="core-agent-connect-warn" role="status">{actionError.message}</p>}

          {pending && (
            <div className="core-agent-connect-setup">
              <p>Paste this into a terminal on this computer. It adds Perfect Planner to Claude Code; then start Claude Code and ask it to check in.</p>
              {pending.warning && <p className="core-agent-connect-warn">{pending.warning}</p>}
              <div className="core-agent-connect-snippet">
                <div className="core-agent-connect-snippet-head">
                  <strong>Claude Code command</strong>
                  <button type="button" className="core-button" onClick={() => copy("cmd", pending.claudeCode)} aria-label="Copy the Claude Code command">
                    {copied?.id === "cmd" && copied.ok ? <><CheckCircleIcon aria-hidden="true" /> Copied</> : <><CopyIcon aria-hidden="true" /> Copy</>}
                  </button>
                </div>
                <pre tabIndex={0} aria-label="Claude Code command" data-connect-command><code>{pending.claudeCode}</code></pre>
              </div>
              <details className="core-agent-connect-json">
                <summary>Using another agent? Copy the settings instead</summary>
                <p className="core-muted">Add this to your agent's MCP settings file (for example .cursor/mcp.json). If the file already lists servers, add only this entry.</p>
                <div className="core-agent-connect-snippet">
                  <div className="core-agent-connect-snippet-head">
                    <strong>MCP settings</strong>
                    <button type="button" className="core-button" onClick={() => copy("json", pending.json)} aria-label="Copy the MCP settings">
                      {copied?.id === "json" && copied.ok ? <><CheckCircleIcon aria-hidden="true" /> Copied</> : <><CopyIcon aria-hidden="true" /> Copy</>}
                    </button>
                  </div>
                  <pre tabIndex={0} aria-label="MCP settings"><code>{pending.json}</code></pre>
                </div>
              </details>
              {copied && !copied.ok && <p className="core-agent-connect-warn">Copy did not work here. Select the text and copy it by hand.</p>}
              <p className="core-muted">This command holds a private key for this agent. It is shown only now; keep it to yourself.</p>
            </div>
          )}

          <div className="core-agent-connect-status" role="status" aria-live="polite">
            {pending && <span className="core-agent-connect-waiting"><SpinnerGapIcon aria-hidden="true" /> Waiting for the agent to check in…</span>}
            {!pending && justConnected && (
              <span className="core-agent-connect-done">
                <CheckCircleIcon weight="fill" aria-hidden="true" />{" "}
                {justConnected.role === "main"
                  ? `Connected: ${describeAgent(justConnected)} is your main chat.`
                  : `Connected: ${describeAgent(justConnected)} can read the board. Your main chat is another agent.`}
              </span>
            )}
          </div>

          {live.length > 0 ? (
            <ul className="core-agent-connect-list" aria-label="Connected agents">
              {live.map((agent) => (
                <li key={agent.id}>
                  <div>
                    <strong>{agent.name}</strong>
                    {agent.model && <span className="core-muted"> · {modelLabel(agent.model)}</span>}
                    {agent.task && <span className="core-muted"> · {agent.task}</span>}
                    {advanced && <code className="core-advanced"> {agent.id}</code>}
                  </div>
                  <span className={`core-pill ${agent.role === "main" ? "good" : ""}`}>{ROLE_LABEL[agent.role] ?? agent.role}</span>
                  {agent.connection && (
                    <button type="button" className="core-button" onClick={() => revoke(agent)} aria-label={`Disconnect ${agent.name}`}>Disconnect</button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            !pending && <p className="core-empty">No agents are connected yet.</p>
          )}

          {advanced && (
            <dl className="core-agent-connect-advanced core-advanced">
              <dt>Bridge</dt>
              <dd><code>{data?.bridge?.url ?? "Not started yet"}</code></dd>
              {pending && <><dt>Connection</dt><dd><code>{pending.connection}</code></dd></>}
              {pending && <><dt>Agent program</dt><dd><code>{pending.agentPath}</code></dd></>}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

export default CoreAgentConnect;
