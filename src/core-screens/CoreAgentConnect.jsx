import { useEffect, useState } from "react";
import { ArrowClockwiseIcon, CheckCircleIcon, CopyIcon, PlugsConnectedIcon, SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { copyText } from "../project/connectAgentSetup.js";
import { CoreLoading, ReadOnlyNotice, StartHistoryNotice, useAdvanced } from "./CoreScreen.jsx";
import { useCoreResource } from "./coreApi.js";
import "./coreScreens.css";
import "./CoreAgentConnect.css";

// One-click Connect agent (core/host/routes/agents.ts). The token never reaches
// this window: the app writes it to a file only this user can read, and the line
// shown here names that file. The line is dropped once the agent checks in.
export const CONNECT_POLL_MS = 1500;

const ROLE_LABEL = { main: "Main chat", worker: "Worker", observer: "Read-only" };

// The agents the one line can set up (core/host/agentKinds.ts). Each gets the same
// five steps; only the CLI it registers with and the program you start differ.
export const AGENT_CHOICES = [
  { id: "claude", label: "Claude Code", start: "start Claude Code there" },
  { id: "gemini", label: "Gemini CLI", start: "start Gemini CLI there (choose Trust folder if it asks)" },
  { id: "codex", label: "Codex CLI", start: "start Codex there" },
];
const AGENT_KEY = "pp.connect.agent";

function rememberedAgent() {
  try {
    const saved = localStorage.getItem(AGENT_KEY);
    return AGENT_CHOICES.some((a) => a.id === saved) ? saved : "claude";
  } catch {
    return "claude";
  }
}

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
  const [pending, setPending] = useState(null); // the connect response (no token in it)
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [copied, setCopied] = useState(null);
  const [justConnected, setJustConnected] = useState(null);
  const [agentKind, setAgentKind] = useState(rememberedAgent);
  const resource = useCoreResource("/agents", { isEmpty: () => false, pollMs: pending ? CONNECT_POLL_MS : 0 });

  const data = resource.status === "ready" ? resource.data : null;
  const agents = data?.agents ?? [];
  const linked = pending && data ? data.connections?.find((c) => c.id === pending.connection)?.agent : null;
  const checkedIn = linked ? agents.find((a) => a.id === linked) : null;

  // Once the agent has checked in, forget the command.
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

  const pickAgent = (id) => {
    setAgentKind(id);
    setCopied(null);
    try { localStorage.setItem(AGENT_KEY, id); } catch { /* remembering the pick is only a convenience */ }
  };
  const choice = AGENT_CHOICES.find((a) => a.id === agentKind) ?? AGENT_CHOICES[0];
  const command = pending ? (pending.lines?.[choice.id] ?? pending.claudeCode) : "";

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

      {resource.status === "no-session" && <ReadOnlyNotice />}

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
          <StartHistoryNotice onStarted={() => { setActionError(null); resource.reload(); }} />
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
              <div className="core-agent-connect-agents" role="radiogroup" aria-label="Your agent">
                {AGENT_CHOICES.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={a.id === choice.id}
                    className={`core-button${a.id === choice.id ? " primary" : ""}`}
                    onClick={() => pickAgent(a.id)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <p>
                Open a terminal in the folder your agent will work in and paste this one line. It connects {choice.label} to Perfect Planner for that folder
                and installs the Perfect Planner skill for {choice.label} on this computer. Then {choice.start} and say{" "}
                <strong>check in with Perfect Planner</strong>. Already in {choice.label}? Paste the line into the chat; it shows you the line and runs it only after you say yes.
              </p>
              {choice.id === "codex" && <p className="core-muted">Codex keeps one Perfect Planner connection for the whole computer, so this replaces any earlier Codex connection.</p>}
              {pending.warning && <p className="core-agent-connect-warn">{pending.warning}</p>}
              <div className="core-agent-connect-snippet">
                <div className="core-agent-connect-snippet-head">
                  <strong>{choice.label} command</strong>
                  <button type="button" className="core-button" onClick={() => copy("cmd", command)} aria-label={`Copy the ${choice.label} command`}>
                    {copied?.id === "cmd" && copied.ok ? <><CheckCircleIcon aria-hidden="true" /> Copied</> : <><CopyIcon aria-hidden="true" /> Copy</>}
                  </button>
                </div>
                <pre tabIndex={0} aria-label={`${choice.label} command`} data-connect-command><code>{command}</code></pre>
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
              <p className="core-muted">The line holds no key: it names a file on this computer that only you can read. Disconnecting deletes that file.</p>
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
                    {agent.quiet && <span className="core-muted"> · not heard from lately</span>}
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

          {data?.skillLine && (
            <details className="core-agent-connect-json" data-skill-only>
              <summary>Install the skill only</summary>
              <p className="core-muted">
                Teaches every Claude Code, Gemini CLI and Codex CLI session on this computer, in every folder, how to work with Perfect Planner. No key, nothing connected.
                Paste it into any terminal once; run it again after updating Perfect Planner.
              </p>
              <div className="core-agent-connect-snippet">
                <div className="core-agent-connect-snippet-head">
                  <strong>Skill install</strong>
                  <button type="button" className="core-button" onClick={() => copy("skill", data.skillLine)} aria-label="Copy the skill install line">
                    {copied?.id === "skill" && copied.ok ? <><CheckCircleIcon aria-hidden="true" /> Copied</> : <><CopyIcon aria-hidden="true" /> Copy</>}
                  </button>
                </div>
                <pre tabIndex={0} aria-label="Skill install line"><code>{data.skillLine}</code></pre>
              </div>
            </details>
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
