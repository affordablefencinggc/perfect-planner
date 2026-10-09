// The agent CLIs the one-line connect knows how to register with. Shared by
// connect.mjs and the Connect agent route; kept apart from agentConnect.ts
// because that file runs as a program when it is the entry point.
export type AgentKind = "claude" | "gemini" | "codex";

export const AGENTS: Record<AgentKind, { cli: string; label: string }> = {
  claude: { cli: "claude", label: "Claude Code" },
  gemini: { cli: "gemini", label: "Gemini CLI" },
  codex: { cli: "codex", label: "Codex CLI" },
};

export const AGENT_KINDS = Object.keys(AGENTS) as AgentKind[];
