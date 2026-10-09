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
import { findExecutable, isWithin, NO_CWD_SEARCH_ENV, registeredRoots } from "../exec/index";
import { AGENT_KINDS, AGENTS, type AgentKind } from "./agentKinds";
import { chosenRepoRoot, repoRefusal } from "./routes/tasks";
import { isNetworkPath } from "./tokenFile";

const SERVER = "perfect-planner-core";
const SKILL = "perfect-planner-connect";
/** Replaced on install with this program's absolute path: the only line the skill may run. */
export const SKILL_PROGRAM_PLACEHOLDER = "{{PP_CONNECT_PROGRAM}}";
/** Replaced on install with the desktop app's bundled Node, the one other first word a line may have. */
export const SKILL_NODE_PLACEHOLDER = "{{PP_NODE_PROGRAM}}";

/**
 * The bundled Node the installed app puts first in its lines: <app>/desktop-host/node[.exe] next to
 * <app>/desktop-host/core-host/connect.mjs. Without a bundled Node the line starts with plain node.
 */
export function bundledNodePath(here: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  return p.join(p.dirname(here), platform === "win32" ? "node.exe" : "node");
}

/**
 * The skill's line check, in code, so the lines the app shows (core/host/routes/agents.ts) and the
 * rule the skill follows cannot drift apart. A line is exactly: the first word (node, or the bundled
 * Node by its exact path, quoted, after PowerShell's & on Windows), this connect.mjs by its exact
 * path, an optional --agent claude|gemini|codex, the loopback bridge, and a local .token file.
 */
export function connectLineProblem(line: string, here: string, platform: NodeJS.Platform = process.platform): string | null {
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  if (/[\r\n]/.test(line)) return "It must be one line.";
  if (/pp_[cw]_/.test(line)) return "It contains a key. Never paste keys; copy a fresh line from Connect agent.";
  // PowerShell also ends a single-quoted string at the curly quotes U+2018-U+201B.
  if (/[\u2018-\u201b]/.test(line)) return "It contains a curly quote, which PowerShell treats as the end of a quoted path.";
  const quoted = windows ? "'((?:[^']|'')*)'" : "'((?:[^']|'\\\\'')*)'";
  const unquote = (value: string) => (windows ? value.replaceAll("''", "'") : value.replaceAll("'\\''", "'"));
  const first = windows ? `(?:node|& ${quoted})` : `(?:node|${quoted})`;
  const shape = new RegExp(`^${first} ${quoted}(?: --agent (claude|gemini|codex))? (http://127\\.0\\.0\\.1:\\d{1,5}) ${quoted}$`);
  const match = shape.exec(line.trim());
  if (!match) return "It is not the shape Connect agent shows: node, connect.mjs, the bridge address and the token file, nothing else.";
  const [, node, program, , , tokenFile] = match as unknown as [string, string | undefined, string, string | undefined, string, string];
  // Defence in depth: no shell metacharacter inside any quoted part, whatever the shell.
  for (const part of [node, program, tokenFile]) if (part !== undefined && /[;|&<>$`]/.test(part)) return "A quoted path contains a shell character (; | & < > $ or `).";
  if (node !== undefined && unquote(node) !== bundledNodePath(here, platform)) return "The Node program is not the one that ships with Perfect Planner.";
  if (unquote(program) !== p.join(here, "connect.mjs")) return "The program is not Perfect Planner's own connect.mjs.";
  const file = unquote(tokenFile);
  if (isNetworkPath(file, platform)) return "The token file must be on this computer, not a network share.";
  if (!p.isAbsolute(file) || !file.endsWith(".token")) return "The last part must be the full path of the .token file the app wrote.";
  return null;
}

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
  if (isNetworkPath(tokenFile, platform)) return "The token file must be on this computer, not a network share.";
  const absolute = platform === "win32" ? path.win32.isAbsolute(tokenFile) : path.posix.isAbsolute(tokenFile);
  if (!absolute || !tokenFile.endsWith(".token")) return "The second part must be the full path of the .token file the app wrote.";
  if (platform === "win32") {
    // cmd.exe and PowerShell read % and " differently; refusing them keeps the path the same in every shell.
    for (const bad of ["%", '"']) if (argv.some((arg) => arg.includes(bad))) return `The path contains ${bad}, which Windows would rewrite. Move Perfect Planner's data to a folder without it.`;
  }
  return null;
}

/**
 * The same check keyed by connect.mjs's absolute path, for callers that know the program rather
 * than its folder (a release run asserting the installed app's line passes, with no live agent).
 */
export function validateConnectLine(line: string, options: { connectProgram: string; platform?: NodeJS.Platform }): string | null {
  const platform = options.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  if (p.basename(options.connectProgram) !== "connect.mjs") return "The connect program must be connect.mjs.";
  return connectLineProblem(line, p.dirname(options.connectProgram), platform);
}

/** Copies the skill to the user's own agent folders (every repo on this computer), replacing older copies. */
export function installSkill(plan: Pick<ConnectPlan, "skillFrom" | "skillTo">, here: string): void {
  const text = fs
    .readFileSync(plan.skillFrom, "utf8")
    .replaceAll(SKILL_PROGRAM_PLACEHOLDER, path.join(here, "connect.mjs"))
    .replaceAll(SKILL_NODE_PLACEHOLDER, bundledNodePath(here));
  for (const to of plan.skillTo) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, text);
  }
}


export interface Launch {
  command: string;
  args: string[];
}

/**
 * The folders no agent CLI may be started from: the current folder, the project folder that owns the
 * token file (<project>/.perfect-planner/tokens/x.token) and the repo the person picked for it. Never found
 * by walking up to .git.
 */
export function protectFor(tokenFile: string | null): string[] {
  if (!tokenFile) return [];
  const project = path.dirname(path.dirname(path.dirname(tokenFile)));
  const repo = chosenRepoRoot(project);
  // A whole drive or the home folder is never a protected root: it would hide ~/.local/bin/claude.
  return [project, ...(repo ? [repo] : [])].filter((root) => !repoRefusal(root));
}

/**
 * How to start an agent CLI (claude, gemini, codex) without a shell, by core/exec's finder, so one planted in the project,
 * the picked repo or a PATH folder that links into either never runs. On Windows a claude.exe runs as
 * itself; on macOS and Linux an npm-installed claude (a node script) runs under this Node, never
 * through its `env node` shebang; an npm shim (claude.cmd) is never run: its package entry runs under this Node instead, and only
 * when that entry also lies outside every protected folder. Null when no usable Claude Code is found.
 */
export function agentLaunch(
  agent: AgentKind,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  protect: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Launch | null {
  const { cli, npmEntry } = AGENTS[agent];
  const program = findExecutable(cli, env, cwd, platform, protect, [".exe", ".cmd"]);
  if (!program) return null;
  if (platform !== "win32") return nodeScript(program) ? { command: process.execPath, args: [program, ...args] } : { command: program, args };
  if (!/\.cmd$/i.test(program)) return { command: program, args };
  // The npm package entry the shim (claude.cmd, gemini.cmd, codex.cmd) starts; it runs under this Node instead.
  const entry = path.join(path.dirname(program), "node_modules", ...npmEntry.split("/"));
  let real: string;
  try {
    if (!fs.statSync(entry).isFile()) return null;
    real = fs.realpathSync.native(entry);
  } catch {
    return null;
  }
  const roots = [cwd, ...protect, ...registeredRoots()];
  if (roots.some((root) => isWithin(root, entry) || isWithin(root, real) || isWithin(safeReal(root), real))) return null;
  return { command: process.execPath, args: [entry, ...args] };
}

/** Claude Code's launch (kept for callers that only start Claude Code). */
export function claudeLaunch(args: string[], env: NodeJS.ProcessEnv, cwd: string, protect: readonly string[], platform: NodeJS.Platform = process.platform): Launch | null {
  return agentLaunch("claude", args, env, cwd, protect, platform);
}

/**
 * True for an npm-installed agent CLI on macOS and Linux: a link to a .js file or a script starting
 * `#!/usr/bin/env node`. Its shebang would look node up on PATH, where a planted node could sit, so
 * it runs under this Node instead.
 */
function nodeScript(program: string): boolean {
  try {
    if (/\.[cm]?js$/i.test(fs.realpathSync.native(program))) return true;
    const fd = fs.openSync(program, "r");
    try {
      const head = Buffer.alloc(128);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      return /^#!\s*\S*\/env\s+(?:-S\s+)?node(?:\s|$)/.test(head.subarray(0, read).toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function safeReal(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Windows: never resolve a bare program name (node, git) from the current folder either. */
const SAFE_ENV = { ...process.env, ...NO_CWD_SEARCH_ENV };

/** Runs the agent's CLI from the project folder (its mcp add registers that folder). */
function run(agent: AgentKind, args: string[], tokenFile: string | null) {
  const launch = agentLaunch(agent, args, process.env, process.cwd(), protectFor(tokenFile));
  if (!launch) return { error: Object.assign(new Error(`${AGENTS[agent].cli} not found`), { code: "ENOENT" }), status: null, stdout: "", stderr: "" };
  return spawnSync(launch.command, launch.args, { encoding: "utf8", windowsHide: true, env: SAFE_ENV });
}

const installed = (agent: AgentKind) => agentLaunch(agent, [], process.env, process.cwd(), []) !== null;

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
  const git = findExecutable("git", process.env, folder, process.platform, []);
  if (!git) return false;
  const probe = spawnSync(git, ["rev-parse", "--git-path", "info/exclude"], { cwd: folder, encoding: "utf8", windowsHide: true, env: SAFE_ENV });
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

  run(agent, plan.remove, tokenFile); // nothing to remove the first time; that is fine
  const added = run(agent, plan.add, tokenFile);
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
