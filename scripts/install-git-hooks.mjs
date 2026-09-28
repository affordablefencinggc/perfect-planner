import { spawnSync } from "node:child_process";
import { chmod, lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const bundledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.githooks");
const requiredHooks = ["pre-commit", "pre-push"];
const fail = (message) => { throw new Error(message); };
const gitRoutingOverrides = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]);
const hasGitOverride = () => Object.keys(process.env).some((key) => gitRoutingOverrides.has(key.toUpperCase()) || key.toUpperCase().startsWith("GIT_CONFIG"));
function git(args, allowMissing = false) {
  const result = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" } });
  if (allowMissing && result.status === 1) return null;
  if (result.error || result.status !== 0) fail("Git could not verify this checkout or its hook configuration.");
  return result.stdout.trim();
}
const samePath = (left, right) => path.relative(left, right) === "";

try {
  if (hasGitOverride()) {
    fail("Run the installer without Git repository or command configuration overrides.");
  }
  const canonicalRoot = await realpath(root);
  const checkoutRoot = await realpath(git(["rev-parse", "--show-toplevel"]));
  if (!samePath(canonicalRoot, checkoutRoot)) fail("Run the installer from the Git repository root.");
  const hooksRoot = path.join(canonicalRoot, ".githooks");
  const directory = await lstat(hooksRoot).catch(() => null);
  if (!directory?.isDirectory() || directory.isSymbolicLink() || !samePath(await realpath(hooksRoot), hooksRoot)) {
    fail("The bundled .githooks directory is missing or redirected.");
  }
  for (const name of requiredHooks) {
    const hook = path.join(hooksRoot, name);
    const info = await lstat(hook).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) fail(`The bundled ${name} hook is missing or is not a regular file.`);
    if (!(await readFile(hook)).equals(await readFile(path.join(bundledRoot, name)))) fail(`The ${name} hook differs from the bundled Perfect Planner hook.`);
  }
  const effective = git(["config", "--get-all", "core.hooksPath"], true);
  if (effective !== null && effective.split("\n").some((value) => value !== ".githooks")) {
    fail("An existing core.hooksPath is configured. Preserve or explicitly migrate those hooks before installing.");
  }
  if (effective === null) {
    const defaultHooks = path.resolve(canonicalRoot, git(["rev-parse", "--git-path", "hooks"]));
    const entries = await readdir(defaultHooks, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.name.endsWith(".sample") || entry.name.startsWith(".")) continue;
      const info = await lstat(path.join(defaultHooks, entry.name));
      if (info.isSymbolicLink() || (info.isFile() && (process.platform === "win32" || (info.mode & 0o111)))) {
        fail("Existing hooks are active in the Git hooks directory. Preserve or explicitly migrate them before installing.");
      }
    }
  }
  if (process.platform !== "win32") {
    for (const name of requiredHooks) {
      const hook = path.join(hooksRoot, name);
      await chmod(hook, (await lstat(hook)).mode | 0o111);
      if (((await lstat(hook)).mode & 0o111) !== 0o111) fail(`The ${name} hook could not be made executable.`);
    }
  }
  // An inherited value is insufficient: persist the binding in this checkout's
  // own config, without treating an included/global file as a local install.
  const local = git(["config", "--local", "--no-includes", "--get-all", "core.hooksPath"], true);
  if (local !== ".githooks") git(["config", "--local", "--replace-all", "core.hooksPath", ".githooks"]);
  if (git(["config", "--local", "--no-includes", "--get-all", "core.hooksPath"]) !== ".githooks") fail("The local hooks configuration could not be verified.");
  if (git(["config", "--get-all", "core.hooksPath"]).split("\n").some((value) => value !== ".githooks")) fail("The effective hooks configuration could not be verified.");
  process.stdout.write("Perfect Planner Git hooks installed and verified from .githooks. Hook execution still requires a commit or push.\n");
} catch (error) {
  const message = error instanceof Error && !error.code ? error.message : "The hook files or checkout could not be verified.";
  process.stderr.write(`Perfect Planner hooks were not installed: ${message}\n`);
  process.exitCode = 1;
}
