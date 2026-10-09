// Hermetic Git environment for the node:test suite.
//
// The suite creates real repositories and runs real Git. Product code refuses
// any inherited GIT_CONFIG* or routing variable (see guardedGitRunner.mjs and
// verify-secrets.mjs), and a developer's or CI runner's global config can add
// commit signing, hooks paths or URL rewrites. So tests must not inherit
// either. Importing this module (directly, or through `node --import`) once
// per process:
//   - removes inherited GIT_* routing, config and override variables;
//   - points HOME, USERPROFILE and XDG_CONFIG_HOME at a private temp profile
//     whose .gitconfig sets a fixed identity, no signing and no hooks path.
// Child processes spawned with `{ ...process.env }` inherit the same profile.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const marker = "PERFECT_PLANNER_HERMETIC_GIT_HOME";

// Variables that only describe the terminal or proxy are kept; anything that
// can change which repository, config or executable Git uses is dropped.
const keep = new Set(["GIT_SSL_CAINFO", "GIT_TERMINAL_PROMPT"]);

export const gitIdentity = Object.freeze({ name: "Perfect Planner Test", email: "tests@perfect-planner.invalid" });

function gitConfigText() {
  return [
    "[user]",
    `\tname = ${gitIdentity.name}`,
    `\temail = ${gitIdentity.email}`,
    "[init]",
    "\tdefaultBranch = main",
    "[commit]",
    "\tgpgsign = false",
    "[tag]",
    "\tgpgsign = false",
    "[core]",
    "\tautocrlf = false",
    "[advice]",
    "\tdetachedHead = false",
    "",
  ].join("\n");
}

export function applyHermeticGitEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_") && !keep.has(upper)) delete env[key];
  }
  // Reuse the parent's profile so every test process shares one, and so a
  // nested import is a no-op.
  let home = env[marker];
  if (!home) {
    home = mkdtempSync(path.join(tmpdir(), "pp-test-home-"));
    mkdirSync(path.join(home, "xdg", "git"), { recursive: true });
    writeFileSync(path.join(home, ".gitconfig"), gitConfigText());
    env[marker] = home;
    if (env === process.env) process.once("exit", () => { try { rmSync(home, { recursive: true, force: true }); } catch {} });
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, "xdg");
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export function hermeticGitEnv(extra = {}) {
  return { ...applyHermeticGitEnv({ ...process.env }), ...extra };
}

// Creates an initialised repository with the fixed identity configured
// locally as well, so tests that later replace HOME still commit.
export function createTempRepo(prefix = "pp-repo-", { initialCommit = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const run = (args) => execFileSync("git", args, { cwd: root, env: hermeticGitEnv(), stdio: "pipe" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", gitIdentity.name]);
  run(["config", "user.email", gitIdentity.email]);
  run(["config", "commit.gpgsign", "false"]);
  if (initialCommit) {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    run(["add", "README.md"]);
    run(["commit", "-q", "-m", "initial"]);
  }
  return { root, git: (args) => run(args).toString("utf8"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

applyHermeticGitEnv();
