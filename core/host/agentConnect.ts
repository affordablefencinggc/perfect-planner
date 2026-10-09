// The one line Connect agent hands out: `node connect.mjs <bridge url> <token>`.
// Run in the folder the agent will work in, it registers the perfect-planner-core
// MCP server with Claude Code for that folder (replacing an older registration,
// so pasting a fresh line after an app restart just works) and installs the
// perfect-planner-connect skill for the user, so the agent knows the loop rules.
// `node connect.mjs --skill-only` installs just the skill, with no token, so every
// Claude Code session on this computer has it before anything is connected.
// Bundled to dist/core-host/connect.mjs next to agent.mjs and skill/SKILL.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = "perfect-planner-core";
const SKILL = "perfect-planner-connect";

export interface ConnectPlan {
  remove: string[];
  add: string[];
  skillFrom: string;
  skillTo: string;
}

export function connectPlan(options: { bridgeUrl: string; token: string; here: string; home: string }): ConnectPlan {
  const agent = path.join(options.here, "agent.mjs");
  return {
    remove: ["mcp", "remove", SERVER, "-s", "local"],
    add: ["mcp", "add", SERVER, "-s", "local", "--env", `PP_BRIDGE_URL=${options.bridgeUrl}`, "--env", `PP_AGENT_TOKEN=${options.token}`, "--", process.execPath, agent],
    skillFrom: path.join(options.here, "skill", "SKILL.md"),
    skillTo: path.join(options.home, ".claude", "skills", SKILL, "SKILL.md"),
  };
}

/** cmd.exe needs claude.cmd through a shell; quote anything with spaces for it. */
const winQuote = (arg: string) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg);

function claude(args: string[]) {
  const windows = process.platform === "win32";
  return spawnSync("claude", windows ? args.map(winQuote) : args, { encoding: "utf8", shell: windows });
}

/** Copies the skill to the user's own Claude folder (every repo on this computer), replacing an older copy. */
export function installSkill(plan: Pick<ConnectPlan, "skillFrom" | "skillTo">): void {
  fs.mkdirSync(path.dirname(plan.skillTo), { recursive: true });
  fs.copyFileSync(plan.skillFrom, plan.skillTo);
}

function main(argv: string[]): number {
  if (argv[0] === "--skill-only") {
    const plan = connectPlan({ bridgeUrl: "", token: "", here: path.dirname(fileURLToPath(import.meta.url)), home: os.homedir() });
    try {
      installSkill(plan);
    } catch (error) {
      process.stderr.write(`Perfect Planner: could not install the skill (${(error as Error).message}).\n`);
      return 1;
    }
    process.stdout.write(`Installed the ${SKILL} skill for every Claude Code session on this computer (${plan.skillTo}).\n`);
    return 0;
  }
  const [bridgeUrl, token] = argv;
  if (!bridgeUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(bridgeUrl) || !token || !/^pp_[cw]_[\w-]{16,}$/.test(token)) {
    process.stderr.write("Perfect Planner: copy the whole line from Connect agent in the app; it ends with the bridge address and a pp_ key.\n");
    return 2;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const plan = connectPlan({ bridgeUrl, token, here, home: os.homedir() });

  let skill = false;
  try {
    installSkill(plan);
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
