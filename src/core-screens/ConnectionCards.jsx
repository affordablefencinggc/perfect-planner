import { CheckCircleIcon, GithubLogoIcon, RobotIcon, TerminalWindowIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useCoreResource } from "./coreApi.js";
import "./ConnectionCards.css";

const STATE_LABEL = {
  connected: "Connected",
  "not-configured": "Not configured",
  "signed-out": "Signed out",
  "not-installed": "Not installed",
  available: "Available",
  checking: "Checking…",
  green: "Green",
  red: "Red",
  pending: "Pending",
  unknown: "Unknown",
  error: "Unavailable",
};

function stateTone(state) {
  if (["connected", "available", "green"].includes(state)) return "ok";
  if (["red", "error", "signed-out", "not-installed"].includes(state)) return "bad";
  return "wait";
}

function Card({ icon, title, state, detail, action }) {
  const tone = stateTone(state);
  return (
    <article className={`connection-card connection-${tone}`}>
      <span className="connection-icon" aria-hidden="true">{icon}</span>
      <div className="connection-body">
        <strong>{title}</strong>
        <span className="connection-state">
          {tone === "ok" ? <CheckCircleIcon weight="fill" aria-hidden="true" /> : <WarningCircleIcon weight="fill" aria-hidden="true" />}
          {STATE_LABEL[state] ?? state}
        </span>
        <small>{detail}</small>
      </div>
      {action}
    </article>
  );
}

// A read-only status strip for the connection drawer. It never claims a connection the host
// has not reported: an endpoint that fails reads "Unavailable", not "Connected".
export function ConnectionCards() {
  const agents = useCoreResource("/agents", { isEmpty: () => false });
  const codex = useCoreResource("/agents/codex-login", { isEmpty: () => false });
  const github = useCoreResource("/github/status", { isEmpty: () => false });
  const terminal = useCoreResource("/terminal/scripts", { isEmpty: () => false });

  const agentCount = agents.status === "ready" ? agents.data?.connections?.length ?? 0 : null;
  const agentState = agents.status === "loading" ? "checking" : agents.status !== "ready" ? "error" : agentCount > 0 ? "connected" : "not-configured";
  const codexState = codex.status === "loading"
    ? "checking"
    : codex.status !== "ready"
      ? "error"
      : codex.data?.loggedIn
        ? "connected"
        : codex.data?.installed
          ? "signed-out"
          : "not-installed";
  const codexDetail = codex.status === "loading"
    ? "Checking the Codex sign-in…"
    : codex.status !== "ready"
      ? "Status could not be read."
      : codex.data?.loggedIn
        ? `Signed in${codex.data.method === "chatgpt" ? " with ChatGPT" : ""}.`
        : codex.data?.installed
          ? "Installed; use Connect agent below to sign in."
          : "The Codex CLI is not installed.";
  const githubState = github.status === "loading" ? "checking" : github.status !== "ready" ? "error" : github.data?.state ?? "unknown";
  const githubDetail = github.status === "loading"
    ? "Checking GitHub…"
    : github.status !== "ready"
      ? "GitHub status could not be read."
      : github.data?.remote
        ? `${github.data.remote}${github.data.sha ? ` · ${String(github.data.sha).slice(0, 8)}` : ""}`
        : github.data?.reason ?? "No GitHub remote or sign-in recorded.";
  const terminalCount = terminal.status === "ready" ? terminal.data?.scripts?.length ?? 0 : null;
  const terminalState = terminal.status === "loading" ? "checking" : terminal.status !== "ready" ? "error" : "available";

  return (
    <section className="connection-cards" aria-label="Connections at a glance">
      <header>
        <strong>Connections</strong>
        <span>What this project can actually reach</span>
      </header>
      <div className="connection-grid">
        <Card
          icon={<RobotIcon weight="duotone" />}
          title="Codex"
          state={codexState}
          detail={codexDetail}
        />
        <Card
          icon={<RobotIcon weight="duotone" />}
          title="Agents"
          state={agentState}
          detail={agents.status === "loading" ? "Checking agent connections…" : agentCount === null ? "Agent status could not be read." : `${agentCount} checked-in connection${agentCount === 1 ? "" : "s"}.`}
        />
        <Card
          icon={<GithubLogoIcon weight="duotone" />}
          title="GitHub"
          state={githubState}
          detail={githubDetail}
        />
        <Card
          icon={<TerminalWindowIcon weight="duotone" />}
          title="Terminal"
          state={terminalState}
          detail={terminal.status === "loading" ? "Checking available scripts…" : terminalCount === null ? "Scripts could not be read." : `${terminalCount} one-click script${terminalCount === 1 ? "" : "s"}.`}
        />
      </div>
    </section>
  );
}

export default ConnectionCards;
