// The one line Connect agent hands out: `node connect.mjs --agent <agent> <bridge url> <token file>`.
// Run in the folder the agent will work in, it registers the perfect-planner-core
// MCP server with that agent's own CLI (replacing an older registration, so
// pasting a fresh line after an app restart just works) and installs the
// perfect-planner-connect skill for the user, so the agent knows the loop rules.
// Claude Code, Gemini CLI and Codex CLI all read the same SKILL.md (the Agent Skills
// format), so one source file is copied and the rules cannot drift between agents.
// Without --agent it picks the first of claude, gemini, codex that is installed.
// The line names the file the app wrote the token to, never the token itself, so
// nothing secret lands in shell history, a chat transcript or any agent's config.
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
/** Replaced on install with this program's absolute path: the only line the skill may run. */
export const SKILL_PROGRAM_PLACEHOLDER = "{{PP_CONNECT_PROGRAM}}";

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
    case "claude": // local scope: this folder only, kept in the user's ~/.claude.json
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

export function connectPlan(options: { bridgeUrl: string; tokenFile: string; here: string; home: string; agent?: AgentKind }): ConnectPlan {
  const agent = options.agent ?? "claude";
  const env = [`PP_BRIDGE_URL=${options.bridgeUrl}`, `PP_AGENT_TOKEN_FILE=${options.tokenFile}`];
  return {
    agent,
    ...register(agent, env, [process.execPath, path.join(options.here, "agent.mjs")]),
    skillFrom: path.join(options.here, "skill", "SKILL.md"),
    skillTo: [path.join(options.home, ".claude", "skills", SKILL, "SKILL.md"), path.join(options.home, ".agents", "skills", SKILL, "SKILL.md")],
  };
}

/** Why these arguments are not a connect line from the app, or null when they are. */
export function connectArgsProblem(argv: string[], platform: NodeJS.Platform = process.platform): string | null {
  if (argv.length !== 2) return "Copy the whole line from Connect agent in the app: the bridge address and the token file, nothing else.";
  const [bridgeUrl, tokenFile] = argv as [string, string];
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(bridgeUrl)) return "The bridge address must be the app's loopback address, http://127.0.0.1:<port>.";
  if (/pp_[cw]_/.test(tokenFile)) return "That looks like a key. Never paste keys; copy the line from Connect agent, which names the token file instead.";
  const absolute = platform === "win32" ? path.win32.isAbsolute(tokenFile) : path.posix.isAbsolute(tokenFile);
  if (!absolute || !tokenFile.endsWith(".token")) return "The second part must be the full path of the .token file the app wrote.";
  if (platform === "win32") {
    // claude, gemini and codex are .cmd files on Windows, so it runs through cmd.exe, which expands % and splits on ".
    for (const bad of ["%", '"']) if (argv.some((arg) => arg.includes(bad))) return `The path contains ${bad}, which Windows would rewrite. Move Perfect Planner's data to a folder without it.`;
  }
  return null;
}

/** Copies the skill to the user's own agent folders (every repo on this computer), replacing older copies. */
export function installSkill(plan: Pick<ConnectPlan, "skillFrom" | "skillTo">, here: string): void {
  const text = fs.readFileSync(plan.skillFrom, "utf8").replaceAll(SKILL_PROGRAM_PLACEHOLDER, path.join(here, "connect.mjs"));
  for (const to of plan.skillTo) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, text);
  }
}

function run(cli: string, args: string[]) {
  const windows = process.platform === "win32";
  const quoted = windows ? args.map((arg) => (/[\s&|<>^()]/.test(arg) ? `"${arg}"` : arg)) : args;
  return spawnSync(cli, quoted, { encoding: "utf8", shell: windows });
}

const installed = (agent: AgentKind) => {
  const probe = run(AGENTS[agent].cli, ["--version"]);
  return !probe.error && probe.status === 0;
};

/** The first agent CLI found on this computer, in the order Perfect Planner was built and proven with. */
export function detectAgent(isInstalled: (agent: AgentKind) => boolean = installed): AgentKind | null {
  return AGENT_KINDS.find(isInstalled) ?? null;
}

/**
 * Gemini keeps the server registration in .gemini/settings.json inside the folder. It names this
 * computer's token file and Node, so in a git checkout list it in .git/info/exclude; the exclude
 * file is local to this checkout and changes nothing anyone else sees.
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
export function parseArgs(argv: string[]): { agent?: string; rest: string[] } {
  const rest: string[] = [];
  let agent: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") agent = argv[++i] ?? "";
    else if (arg.startsWith("--agent=")) agent = arg.slice("--agent=".length);
    else rest.push(arg);
  }
  return { agent, rest };
}

function main(all: string[]): number {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { agent: picked, rest: argv } = parseArgs(all);
  if (picked !== undefined && !AGENT_KINDS.includes(picked as AgentKind)) {
    process.stderr.write(`Perfect Planner: --agent must be one of ${AGENT_KINDS.join(", ")}.\n`);
    return 2;
  }
  if (argv.length === 1 && argv[0] === "--skill-only") {
    const plan = connectPlan({ bridgeUrl: "", tokenFile: "", here, home: os.homedir() });
    try {
      installSkill(plan, here);
    } catch (error) {
      process.stderr.write(`Perfect Planner: could not install the skill (${(error as Error).message}).\n`);
      return 1;
    }
    process.stdout.write(`Installed the ${SKILL} skill for every Claude Code, Gemini CLI and Codex CLI session on this computer.\n`);
    return 0;
  }
  const problem = connectArgsProblem(argv) ?? (process.platform === "win32" && /[%"]/.test(here + process.execPath) ? "Perfect Planner or Node.js is installed in a folder whose name has % or \", which Windows would rewrite." : null);
  if (problem) {
    process.stderr.write(`Perfect Planner: ${problem}\n`);
    return 2;
  }
  const [bridgeUrl, tokenFile] = argv as [string, string];
  if (!fs.existsSync(tokenFile)) {
    process.stderr.write("Perfect Planner: the token file is gone (the app restarted, or you disconnected). Click Connect agent again for a fresh line.\n");
    return 2;
  }
  const agent = (picked as AgentKind | undefined) ?? detectAgent();
  if (!agent) {
    process.stderr.write("Perfect Planner: none of claude, gemini or codex is installed here. For another agent, use the MCP settings from Connect agent instead.\n");
    return 1;
  }
  const { cli, label } = AGENTS[agent];
  const plan = connectPlan({ bridgeUrl, tokenFile, here, home: os.homedir(), agent });

  let skill = false;
  try {
    installSkill(plan, here);
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
      agent === "codex" ? "Connected Codex CLI to Perfect Planner (Codex keeps one connection for this computer)." : `Connected ${label} in this folder (${process.cwd()}) to Perfect Planner.`,
      ignored ? "Kept .gemini/settings.json out of git; it belongs to this computer." : "",
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
