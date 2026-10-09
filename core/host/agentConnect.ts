// The one line Connect agent hands out: `node connect.mjs --agent <agent> <bridge url> <token>`.
// Run in the folder the agent will work in, it registers the perfect-planner-core
// MCP server with that agent's own CLI (replacing an older registration, so pasting
// a fresh line after an app restart just works) and installs the
// perfect-planner-connect skill for the user, so the agent knows the loop rules.
// Claude Code, Gemini CLI and Codex CLI all read the same SKILL.md (the Agent Skills
// format), so one source file is copied and the rules cannot drift between agents.
// Without --agent it picks the first of claude, gemini, codex that is installed.
// `node connect.mjs --skill-only` installs just the skill, with no token, so every
// agent session on this computer has it before anything is connected.
// Bundled to dist/core-host/connect.mjs next to agent.mjs and skill/SKILL.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_KINDS, AGENTS, type AgentKind } from "./agentKinds";

const SERVER = "perfect-planner-core";
const SKILL = "perfect-planner-connect";

export interface ConnectPlan {
  agent: AgentKind;
  remove: string[];
  add: string[];
  skillFrom: string;
  /** Claude Code reads ~/.claude/skills; Gemini CLI and Codex CLI both read ~/.agents/skills. */
  skillTo: string[];
}

function register(agent: AgentKind, env: string[], command: string[]): Pick<ConnectPlan, "remove" | "add"> {
  switch (agent) {
    case "claude": // local scope: this folder only, kept in the user's ~/.claude.json, never in the repo
      return {
        remove: ["mcp", "remove", SERVER, "-s", "local"],
        add: ["mcp", "add", SERVER, "-s", "local", ...env.flatMap((e) => ["--env", e]), "--", ...command],
      };
    case "gemini": // project scope: this folder's .gemini/settings.json (kept out of git, see keepOutOfGit)
      return {
        remove: ["mcp", "remove", SERVER, "-s", "project"],
        add: ["mcp", "add", "-s", "project", SERVER, ...command, ...env.flatMap((e) => ["-e", e])],
      };
    case "codex": // Codex has one user-wide list (~/.codex/config.toml), so this replaces any earlier connection
      return {
        remove: ["mcp", "remove", SERVER],
        add: ["mcp", "add", SERVER, ...env.flatMap((e) => ["--env", e]), "--", ...command],
      };
  }
}

export function connectPlan(options: { bridgeUrl: string; token: string; here: string; home: string; agent?: AgentKind }): ConnectPlan {
  const agent = options.agent ?? "claude";
  const env = [`PP_BRIDGE_URL=${options.bridgeUrl}`, `PP_AGENT_TOKEN=${options.token}`];
  return {
    agent,
    ...register(agent, env, [process.execPath, path.join(options.here, "agent.mjs")]),
    skillFrom: path.join(options.here, "skill", "SKILL.md"),
    skillTo: [path.join(options.home, ".claude", "skills", SKILL, "SKILL.md"), path.join(options.home, ".agents", "skills", SKILL, "SKILL.md")],
  };
}

/** cmd.exe needs claude.cmd / gemini.cmd / codex.cmd through a shell; quote anything with spaces for it. */
const winQuote = (arg: string) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg);

function run(cli: string, args: string[]) {
  const windows = process.platform === "win32";
  return spawnSync(cli, windows ? args.map(winQuote) : args, { encoding: "utf8", shell: windows });
}

const installed = (agent: AgentKind) => {
  const probe = run(AGENTS[agent].cli, ["--version"]);
  return !probe.error && probe.status === 0;
};

/** The first agent CLI found on this computer, in the order Perfect Planner was built and proven with. */
export function detectAgent(isInstalled: (agent: AgentKind) => boolean = installed): AgentKind | null {
  return AGENT_KINDS.find(isInstalled) ?? null;
}

/** Copies the skill to the user's own agent folders (every repo on this computer), replacing older copies. */
export function installSkill(plan: Pick<ConnectPlan, "skillFrom" | "skillTo">): void {
  for (const to of plan.skillTo) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(plan.skillFrom, to);
  }
}

/**
 * Gemini keeps the server (token included) in .gemini/settings.json inside the folder.
 * In a git checkout, list that file in .git/info/exclude so the key is never committed;
 * the exclude file is local to this checkout and changes nothing anyone else sees.
 */
export function keepOutOfGit(folder: string): boolean {
  const probe = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: folder, encoding: "utf8" });
  if (probe.error || probe.status !== 0) return false;
  const exclude = path.resolve(folder, probe.stdout.trim());
  const line = "/.gemini/settings.json";
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (current.split(/\r?\n/).includes(line)) return true;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
  return true;
}

/** Splits `--agent x` (or `--agent=x`) out of the arguments, wherever it sits. */
export function parseArgs(argv: string[]): { agent?: string; skillOnly: boolean; rest: string[] } {
  const rest: string[] = [];
  let agent: string | undefined;
  let skillOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skill-only") skillOnly = true;
    else if (arg === "--agent") agent = argv[++i] ?? "";
    else if (arg.startsWith("--agent=")) agent = arg.slice("--agent=".length);
    else rest.push(arg);
  }
  return { agent, skillOnly, rest };
}

function main(argv: string[]): number {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const args = parseArgs(argv);
  if (args.agent !== undefined && !AGENT_KINDS.includes(args.agent as AgentKind)) {
    process.stderr.write(`Perfect Planner: --agent must be one of ${AGENT_KINDS.join(", ")}.\n`);
    return 2;
  }

  if (args.skillOnly) {
    const plan = connectPlan({ bridgeUrl: "", token: "", here, home: os.homedir() });
    try {
      installSkill(plan);
    } catch (error) {
      process.stderr.write(`Perfect Planner: could not install the skill (${(error as Error).message}).\n`);
      return 1;
    }
    process.stdout.write(`Installed the ${SKILL} skill for every Claude Code, Gemini CLI and Codex CLI session on this computer.\n`);
    return 0;
  }

  const [bridgeUrl, token] = args.rest;
  if (!bridgeUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(bridgeUrl) || !token || !/^pp_[cw]_[\w-]{16,}$/.test(token)) {
    process.stderr.write("Perfect Planner: copy the whole line from Connect agent in the app; it ends with the bridge address and a pp_ key.\n");
    return 2;
  }
  const agent = (args.agent as AgentKind | undefined) ?? detectAgent();
  if (!agent) {
    process.stderr.write("Perfect Planner: none of claude, gemini or codex is installed here. For another agent, use the MCP settings from Connect agent instead.\n");
    return 1;
  }
  const { cli, label } = AGENTS[agent];
  const plan = connectPlan({ bridgeUrl, token, here, home: os.homedir(), agent });

  let skill = false;
  try {
    installSkill(plan);
    skill = true;
  } catch (error) {
    process.stderr.write(`Perfect Planner: could not install the skill (${(error as Error).message}). Connecting anyway.\n`);
  }

  run(cli, plan.remove); // nothing to remove the first time; that is fine
  const added = run(cli, plan.add);
  if (added.error || added.status !== 0) {
    const missing = (added.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    process.stderr.write(
      missing
        ? `Perfect Planner: ${label} (the ${cli} command) is not installed here. Pick your agent in Connect agent, or use the MCP settings it shows.\n`
        : `Perfect Planner: ${cli} mcp add failed.\n${added.stderr || added.stdout}\n`,
    );
    return 1;
  }
  const ignored = agent === "gemini" && keepOutOfGit(process.cwd());
  process.stdout.write(
    [
      agent === "codex" ? `Connected Codex CLI to Perfect Planner (Codex keeps one connection for this computer).` : `Connected ${label} in this folder (${process.cwd()}) to Perfect Planner.`,
      ignored ? "Kept .gemini/settings.json out of git, because it holds this connection's key." : "",
      skill ? `Installed the ${SKILL} skill for ${label} on this computer.` : "",
      agent === "gemini"
        ? "Next: start Gemini CLI in this folder, choose Trust folder if it asks, and say: check in with Perfect Planner"
        : `Next: start ${label} in this folder and say: check in with Perfect Planner`,
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
