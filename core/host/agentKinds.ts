// The agent CLIs the one-line connect knows how to register with. Shared by
// connect.mjs and the Connect agent route; kept apart from agentConnect.ts
// because that file runs as a program when it is the entry point.
export type AgentKind = "claude" | "gemini" | "codex";

/** npmEntry: the script behind the npm .cmd shim on Windows, so it runs under node with no cmd.exe. */
export const AGENTS: Record<AgentKind, { cli: string; label: string; npmEntry: string }> = {
  claude: { cli: "claude", label: "Claude Code", npmEntry: "@anthropic-ai/claude-code/cli.js" },
  gemini: { cli: "gemini", label: "Gemini CLI", npmEntry: "@google/gemini-cli/bundle/gemini.js" },
  codex: { cli: "codex", label: "Codex CLI", npmEntry: "@openai/codex/bin/codex.js" },
};

export const AGENT_KINDS = Object.keys(AGENTS) as AgentKind[];
