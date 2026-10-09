// Hermetic environment for the node:test suite. Every tests/*.test.mjs file
// imports this first, so plain `npm test`, a single `node --test` file and
// scripts/run-tests.mjs all behave the same on Windows, macOS and Linux.
//
// The suite creates real repositories and temp-folder fixtures. Product code
// refuses inherited GIT_CONFIG* or routing variables (guardedGitRunner.mjs,
// verify-secrets.mjs) and any aliased path, and a machine's global Git config
// can add signing, hooks paths or URL rewrites. Once per process this module:
//   - removes inherited GIT_* routing, config and override variables;
//   - points HOME, USERPROFILE and XDG_CONFIG_HOME at a private temp profile
//     whose .gitconfig sets a fixed identity, no signing and no hooks path;
//   - points TMPDIR/TMP/TEMP at the canonical (symlink-free) temp folder.
// Child processes spawned with `{ ...process.env }` inherit the same setup.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

// The stores under test refuse redirected paths, and the system temp folder
// is itself an alias on macOS (/var -> /private/var) and on Windows runners
// (8.3 short names). Point every temp variable at the canonical path so
// fixtures created under os.tmpdir() are not mistaken for redirections.
function canonicalTemp(env) {
  let canonical;
  try { canonical = realpathSync.native(tmpdir()); } catch { return; }
  for (const key of ["TMPDIR", "TMP", "TEMP"]) if (key in env || key === (process.platform === "win32" ? "TEMP" : "TMPDIR")) env[key] = canonical;
}

export function applyHermeticGitEnv(env = process.env) {
  canonicalTemp(env);
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
