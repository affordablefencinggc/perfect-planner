// The one line Connect agent hands out: `node connect.mjs <bridge url> <token file>`.
// Run in the folder the agent will work in, it registers the perfect-planner-core
// MCP server with Claude Code for that folder (replacing an older registration,
// so pasting a fresh line after an app restart just works) and installs the
// perfect-planner-connect skill for the user, so the agent knows the loop rules.
// The line names the file the app wrote the token to, never the token itself, so
// nothing secret lands in shell history, a chat transcript or ~/.claude.json.
// `node connect.mjs --skill-only` installs just the skill, with no token, so every
// Claude Code session on this computer has it before anything is connected.
// Bundled to dist/core-host/connect.mjs next to agent.mjs and skill/SKILL.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable, isNetworkPath, launchFor } from "./tokenFile";

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
  remove: string[];
  add: string[];
  skillFrom: string;
  skillTo: string;
}

export function connectPlan(options: { bridgeUrl: string; tokenFile: string; here: string; home: string }): ConnectPlan {
  const agent = path.join(options.here, "agent.mjs");
  return {
    remove: ["mcp", "remove", SERVER, "-s", "local"],
    add: ["mcp", "add", SERVER, "-s", "local", "--env", `PP_BRIDGE_URL=${options.bridgeUrl}`, "--env", `PP_AGENT_TOKEN_FILE=${options.tokenFile}`, "--", process.execPath, agent],
    skillFrom: path.join(options.here, "skill", "SKILL.md"),
    skillTo: path.join(options.home, ".claude", "skills", SKILL, "SKILL.md"),
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
    // An unusual claude.cmd still runs through cmd.exe, which expands % and splits on ".
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

/** Copies the skill to the user's own Claude folder (every repo on this computer), replacing an older copy. */
export function installSkill(plan: Pick<ConnectPlan, "skillFrom" | "skillTo">, here: string): void {
  const text = fs
    .readFileSync(plan.skillFrom, "utf8")
    .replaceAll(SKILL_PROGRAM_PLACEHOLDER, path.join(here, "connect.mjs"))
    .replaceAll(SKILL_NODE_PLACEHOLDER, bundledNodePath(here));
  fs.mkdirSync(path.dirname(plan.skillTo), { recursive: true });
  fs.writeFileSync(plan.skillTo, text);
}

/**
 * Runs Claude Code from the project folder (claude mcp add -s local registers that folder) without a
 * shell, by the absolute path found on PATH, so a claude or claude.cmd planted in the repo never runs.
 */
function claude(args: string[]) {
  const program = findExecutable("claude", process.env, process.cwd());
  if (!program) return { error: Object.assign(new Error("claude not found"), { code: "ENOENT" }), status: null, stdout: "", stderr: "" };
  const launch = launchFor(program, args, "@anthropic-ai/claude-code/cli.js");
  return spawnSync(launch.command, launch.args, {
    encoding: "utf8",
    windowsHide: true,
    ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
    // Windows: never resolve a bare program name (node, git) from the current folder either.
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
  });
}

function main(argv: string[]): number {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (argv.length === 1 && argv[0] === "--skill-only") {
    const plan = connectPlan({ bridgeUrl: "", tokenFile: "", here, home: os.homedir() });
    try {
      installSkill(plan, here);
    } catch (error) {
      process.stderr.write(`Perfect Planner: could not install the skill (${(error as Error).message}).\n`);
      return 1;
    }
    process.stdout.write(`Installed the ${SKILL} skill for every Claude Code session on this computer (${plan.skillTo}).\n`);
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
  const plan = connectPlan({ bridgeUrl, tokenFile, here, home: os.homedir() });

  let skill = false;
  try {
    installSkill(plan, here);
    skill = true;
  } catch (error) {
    process.stderr.write(`Perfect Planner: could not install the skill (${(error as Error).message}). Connecting anyway.\n`);
  }

  claude(plan.remove); // nothing to remove the first time; that is fine
  const added = claude(plan.add);
  if (added.error || added.status !== 0) {
    const missing = (added.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    process.stderr.write(
      missing
        ? "Perfect Planner: Claude Code (the claude command) is not installed here. For another agent, use the MCP settings from Connect agent instead.\n"
        : `Perfect Planner: claude mcp add failed.\n${added.stderr || added.stdout}\n`,
    );
    return 1;
  }
  process.stdout.write(
    [
      `Connected this folder (${process.cwd()}) to Perfect Planner.`,
      skill ? `Installed the ${SKILL} skill for every Claude Code session on this computer.` : "",
      "Next: start Claude Code in this folder and say: check in with Perfect Planner",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
