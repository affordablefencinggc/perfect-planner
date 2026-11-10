import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitExecutable, isLocalWindowsPath, isWithin, NO_CWD_SEARCH_ENV } from "../exec/index";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout as bytes, for binary-exact reads such as git cat-file. */
  stdoutBytes: Buffer;
}

export interface GitOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  /**
   * Hooks folder to use instead of none. Host git never runs the repo's own hooks (.git/hooks or a
   * core.hooksPath from repo config); pass the app's own hooks here when the host wants them.
   */
  hooksPath?: string;
}

/**
 * Settings from the user's own global and system git config that are copied into the app's private
 * global config, because nothing works without them: who commits, which folders git may open
 * (safe.directory) and line-ending handling. None of them names a program.
 */
const CARRIED_SETTINGS = ["user.name", "user.email", "safe.directory", "core.autocrlf", "core.eol", "core.longpaths", "core.symlinks"];

/**
 * The repo's own config and hooks are writable by any program on the PC, and git would run what they
 * name (hooks, fsmonitor, external diff, filters, merge drivers) as the host. Every host git call
 * therefore runs with these fixed on the command line, which outranks every config file.
 */
const fixedConfig = (hooksPath: string, attributesFile: string): string[] => [
  `core.hooksPath=${hooksPath}`,
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "diff.external=",
  `core.attributesFile=${attributesFile}`,
  "core.askPass=",
  "core.quotepath=off",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "gc.auto=0",
  "maintenance.auto=false",
  // Settings that would change what a diff shows the person.
  "diff.relative=false",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  `diff.orderFile=${attributesFile}`,
  "diff.ignoreSubmodules=none",
  "color.ui=false",
  // Signature checks run gpg.program (or gpg.ssh.program) from the repo config.
  "log.showSignature=false",
  "merge.verifySignatures=false",
  // The host never talks to a remote; ext:: and the other transports (ssh, a remote's uploadpack) run programs.
  "protocol.allow=never",
];

const directGitCache = new Map<string, string>();

/**
 * On Windows the git on PATH is usually <Git>\cmd\git.exe, a small launcher that only starts
 * <Git>\mingw64\bin\git.exe: every host git call then costs two process starts. Where that real git sits in
 * the same install (its real path inside the real path of the launcher's install folder, on a local drive),
 * run it directly. Anything else, and every other platform, keeps the program that was found on PATH.
 * The host never runs hooks, aliases or ssh, so it needs none of the PATH setup the launcher adds.
 */
export function directGit(program: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return program;
  const known = directGitCache.get(program);
  if (known !== undefined) return known;
  let chosen = program;
  try {
    const launcherDir = path.win32.dirname(program);
    if (path.win32.basename(program).toLowerCase() === "git.exe" && path.win32.basename(launcherDir).toLowerCase() === "cmd") {
      const installDir = path.win32.dirname(launcherDir);
      const candidate = path.win32.join(installDir, "mingw64", "bin", "git.exe");
      const realInstall = realpathSync.native(installDir);
      const realCandidate = realpathSync.native(candidate);
      if (statSync(realCandidate).isFile() && isLocalWindowsPath(realCandidate) && isWithin(realInstall, realCandidate, path.win32)) chosen = candidate;
    }
  } catch {
    // No such file or no access: keep the program from PATH.
  }
  directGitCache.set(program, chosen);
  return chosen;
}

/** Commands whose output is a diff: never through an external diff program or a textconv filter. */
const DIFF_COMMANDS = new Set(["diff", "show", "log", "diff-tree", "diff-index", "diff-files"]);

/**
 * Commands that never run a filter program or merge driver: they read refs, objects, config or the
 * worktree list. Every other command (checkout, status, diff, add, merge, hash-object, blame, ...) is
 * first checked with filterPrograms and refused while the repo config names one.
 */
const NO_PROGRAM_COMMANDS = new Set(["rev-parse", "symbolic-ref", "show-ref", "for-each-ref", "merge-base", "ls-tree", "rev-list", "update-ref", "config", "init", "var", "count-objects", "verify-commit", "check-ref-format", "branch"]);

/** True when git could run a filter program or merge driver for this command line. */
function mayRunPrograms(args: readonly string[], command: string | undefined): boolean {
  if (!command) return false;
  const rest = args.slice(args.indexOf(command) + 1);
  // `worktree list/remove/prune` touch no file content; `worktree add` checks files out.
  if (command === "worktree") return rest[0] === "add" || rest[0] === "move" || rest[0] === "repair";
  // Plain `cat-file blob|-p|-t|-s|-e` reads objects; --filters and --textconv run programs.
  if (command === "cat-file") return rest.some((arg) => arg.startsWith("--filters") || arg.startsWith("--textconv") || arg.startsWith("--batch"));
  return !NO_PROGRAM_COMMANDS.has(command);
}

interface Hardening {
  hooksPath: string;
  attributesFile: string;
  globalConfig: string;
}

let hardening: Hardening | undefined;

/**
 * A hooks path that can never hold a hook, so nothing written by another program is ever run. On
 * POSIX that is /dev/null (a device, so /dev/null/pre-commit cannot exist). Not on Windows: there
 * Git looks /dev/null up as C:\dev\null, a folder any user may create, and NUL is relative to the repo
 * (<repo>\NUL\<hook>, makeable with \\?\ paths). It uses the git program's own path instead: while git.exe
 * is a file nothing can sit inside it, and whoever can replace git.exe needs no hook.
 */
export function hooklessPath(program: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? program : "/dev/null";
}

/** Copy the person's own carried settings (reading config runs nothing) into `target`, which must already exist. */
export function copyCarriedSettings(program: string, root: string, target: string): void {
  // Read only the allowlisted settings, once per scope. Previously this did
  // fourteen synchronous child launches on startup and every identity refresh.
  const pattern = "^(" + CARRIED_SETTINGS.map((key) => key.replaceAll(".", "\\.")).join("|") + ")$";
  const scopes: Array<Map<string, string[]>> = [];
  for (const scope of ["--system", "--global"]) {
    const settings = new Map<string, string[]>();
    try {
      const out = execFileSync(program, ["config", scope, "--null", "--get-regexp", pattern], { cwd: root, env: { ...process.env, ...NO_CWD_SEARCH_ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000 });
      for (const record of out.split("\0")) {
        const split = record.indexOf("\n");
        if (split < 0) continue;
        const key = record.slice(0, split), value = record.slice(split + 1);
        if (!CARRIED_SETTINGS.includes(key) || !value) continue;
        settings.set(key, [...(settings.get(key) ?? []), value]);
      }
    } catch { /* No allowed settings in this scope; preserve the existing best-effort behavior. */ }
    scopes.push(settings);
  }
  // Keep the earlier precedence: for each allowed key, system values precede
  // global values; multiple safe.directory values remain separate entries.
  for (const key of CARRIED_SETTINGS) for (const settings of scopes) for (const value of settings.get(key) ?? []) {
    execFileSync(program, ["config", "--file", target, "--add", key, value], { cwd: root, env: { ...process.env, ...NO_CWD_SEARCH_ENV }, stdio: "ignore", windowsHide: true, timeout: 10_000 });
  }
}

/**
 * Pick up settings the person changed since this run started, such as the name and email they just set
 * after being asked to. The app's private config is rebuilt beside the old one and swapped in whole, so a
 * git process running meanwhile sees either copy, never half of one. Best effort: on failure the old copy stays.
 */
export function refreshCarriedSettings(): void {
  if (!hardening) return;
  const { globalConfig } = hardening;
  const root = path.dirname(globalConfig);
  const next = path.join(root, `gitconfig.${process.pid}.next`);
  try {
    const program = gitExecutable(root);
    writeFileSync(next, "");
    copyCarriedSettings(program, root, next);
    chmodSync(next, 0o444);
    // A read-only file cannot be replaced on Windows.
    chmodSync(globalConfig, 0o644);
    renameSync(next, globalConfig);
  } catch {
    try {
      rmSync(next, { force: true });
      chmodSync(globalConfig, 0o444);
    } catch {
      // Nothing more to do; the earlier copy keeps working.
    }
  }
}

/** The app's empty attributes file and private global config, made once per process. */
function hardeningFiles(program: string): Hardening {
  if (hardening) return hardening;
  const root = mkdtempSync(path.join(os.tmpdir(), "pp-git-"));
  const hooksPath = hooklessPath(program);
  const attributesFile = path.join(root, "attributes");
  writeFileSync(attributesFile, "");
  const globalConfig = path.join(root, "gitconfig");
  writeFileSync(globalConfig, "");
  copyCarriedSettings(program, root, globalConfig);
  chmodSync(attributesFile, 0o444);
  chmodSync(globalConfig, 0o444);
  process.once("exit", () => {
    try {
      chmodSync(attributesFile, 0o644);
      chmodSync(globalConfig, 0o644);
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort: a temp folder left behind holds no secrets.
    }
  });
  hardening = { hooksPath, attributesFile, globalConfig };
  return hardening;
}

export class GitHardeningError extends Error {}

/** The attributes file (also the diff order file) must still be an empty file; git is not run otherwise. */
function checkHardening(files: Hardening): void {
  let size = -1;
  try {
    const stat = lstatSync(files.attributesFile);
    if (stat.isFile()) size = stat.size;
  } catch {
    // missing
  }
  if (size !== 0) {
    throw new GitHardeningError(`Perfect Planner's empty git attributes file (${files.attributesFile}) was changed, so git could be told to run a program. Git was not run. Restart Perfect Planner; it makes a fresh one.`);
  }
}

const baseEnv = (globalConfig: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...NO_CWD_SEARCH_ENV,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    LC_ALL: "C",
    // The user's global and system config are replaced by the app's own copy of a few safe settings.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0",
  };
  // A hook or parent git process can export these; they would silently point us at another repo,
  // inject config, or name programs for git to run.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|SYSTEM)$/.test(key)) delete env[key];
  }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_EXEC_PATH", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_TEMPLATE_DIR", "GIT_ALLOW_PROTOCOL", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_OBJECT_DIRECTORY"]) delete env[key];
  return env;
};

/** The git command in args (the first argument that is not a global option). */
function subcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-c" || arg === "-C") index += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

export class GitProgramRefusedError extends Error {}

const PROGRAM_KEYS = "^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver)$";
// One hardened `git config` query must find both program settings and conditional
// includes. Keeping this as one expression avoids a second process for every
// source we inspect, while still asking Git (rather than parsing config files)
// for its exact key spelling, precedence and origin records.
const POLICY_KEYS = "^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|include\\.path|includeif\\..*\\.path)$";
const MAX_INCLUDE_FILES = 64;

/** Records from `git config -z --show-origin --get-regexp`: `<origin>\0<key>\n<value>\0` per entry. */
function originRecords(stdout: string): { origin: string; key: string; value?: string }[] {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const records: { origin: string; key: string; value?: string }[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const entry = fields[index + 1]!;
    const newline = entry.indexOf("\n");
    records.push(newline < 0 ? { origin: fields[index]!, key: entry } : { origin: fields[index]!, key: entry.slice(0, newline), value: entry.slice(newline + 1) });
  }
  // An odd field left over means the output was not what we asked for.
  if (fields.length % 2) records.push({ origin: "", key: "" });
  return records;
}

/**
 * Where git reads an include path given in config file `origin`, or a reason it can't be worked out
 * the way git would: only `~/` (the home folder), absolute paths and paths beside the file are followed.
 * `~user/`, `%(prefix)/` and includes from anything but a file are refused, never skipped.
 */
function includeTarget(origin: string, value: string | undefined, cwd: string): { file: string } | { refused: string } {
  if (!origin.startsWith("file:")) return { refused: `an include from ${origin || "an unreadable origin"}` };
  if (value === undefined || value === "") return { refused: "an include with no path" };
  if (value.startsWith("%(")) return { refused: `an include path git expands itself (${value})` };
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) return { file: path.join(os.homedir(), value.slice(2)) };
  if (value.startsWith("~")) return { refused: `an include path in another user's home folder (${value})` };
  return { file: path.resolve(path.dirname(path.resolve(cwd, origin.slice("file:".length))), value) };
}

/**
 * Filter programs (filter.<name>.clean/smudge/process) and merge drivers (merge.<name>.driver) named in
 * the repo's config, read with the same hardened settings as every host git call. Reading config runs
 * nothing. Git would run these as the host on checkout, status, diff, add and merge.
 *
 * Conditional includes (includeIf onbranch:, gitdir:, hasconfig:) are read whatever their condition, so a
 * setting that only turns on in a worker's branch or folder, or after a switch, is found before it applies.
 */
const FILTER_CACHE_LIMIT = 128;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

interface FilterCacheEntry {
  paths: string[];
  fingerprint: string;
  programs: string[];
}

interface FilterScan {
  programs: string[];
  paths: Set<string>;
  cacheable: boolean;
}

const filterCache = new Map<string, FilterCacheEntry>();

function isMissingPath(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Fingerprint a config source's content and identity without starting another Git process. */
function fingerprintPath(file: string): string | undefined {
  let linkStat;
  try {
    linkStat = lstatSync(file);
  } catch (error) {
    return isMissingPath(error) ? "missing" : undefined;
  }

  let link = "";
  if (linkStat.isSymbolicLink()) {
    try {
      link = readlinkSync(file);
    } catch {
      return undefined;
    }
  }
  let targetStat = linkStat;
  if (linkStat.isSymbolicLink()) {
    try {
      targetStat = statSync(file);
    } catch (error) {
      return isMissingPath(error) ? "link:" + link + ":missing" : undefined;
    }
  }

  let content = "";
  if (targetStat.isFile()) {
    if (targetStat.size > MAX_CONFIG_FILE_BYTES) return undefined;
    let bytes: Buffer;
    let after;
    try {
      bytes = readFileSync(file);
      after = statSync(file);
    } catch {
      return undefined;
    }
    if (after.dev !== targetStat.dev || after.ino !== targetStat.ino ||
        after.size !== targetStat.size || after.mtimeMs !== targetStat.mtimeMs) return undefined;
    content = createHash("sha256").update(bytes).digest("hex");
  }

  if (targetStat.isDirectory()) return ["directory", link, targetStat.dev, targetStat.ino].join("\0");
  const kind = targetStat.isFile() ? "file" : "other";
  return [kind, link, targetStat.dev, targetStat.ino, targetStat.size, targetStat.mtimeMs, content].join("\0");
}

/**
 * Locate the config files Git can load from this worktree. The .git markers
 * and pointer files are watched too, so a new or redirected Git directory
 * invalidates a cached policy.
 */
function configDiscoveryPaths(cwd: string): string[] | undefined {
  const paths = new Set<string>();
  if (hardening) paths.add(hardening.globalConfig);

  let directory = path.resolve(cwd);
  let gitDir: string | undefined;
  while (true) {
    const marker = path.join(directory, ".git");
    paths.add(marker);
    let markerStat;
    try {
      markerStat = lstatSync(marker);
    } catch (error) {
      if (!isMissingPath(error)) return undefined;
    }

    if (markerStat) {
      let targetStat = markerStat;
      if (markerStat.isSymbolicLink()) {
        try {
          targetStat = statSync(marker);
        } catch {
          return undefined;
        }
      }
      if (targetStat.isDirectory()) {
        gitDir = marker;
        break;
      }
      if (targetStat.isFile()) {
        if (targetStat.size > 4096) return undefined;
        let contents: string;
        try {
          contents = readFileSync(marker, "utf8");
        } catch {
          return undefined;
        }
        const match = contents.match(/^\s*gitdir:\s*(.+?)\s*$/im);
        if (!match) return undefined;
        gitDir = path.resolve(directory, match[1]!);
        paths.add(gitDir);
        break;
      }
      return undefined;
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  // A bare Git directory has no .git marker of its own.
  if (!gitDir) {
    const head = path.join(path.resolve(cwd), "HEAD");
    const objects = path.join(path.resolve(cwd), "objects");
    const refs = path.join(path.resolve(cwd), "refs");
    try {
      if (lstatSync(head).isFile() && lstatSync(objects).isDirectory() && lstatSync(refs).isDirectory()) gitDir = path.resolve(cwd);
    } catch (error) {
      if (!isMissingPath(error)) return undefined;
    }
  }

  if (gitDir) {
    paths.add(path.join(gitDir, "config"));
    paths.add(path.join(gitDir, "config.worktree"));
    const commonFile = path.join(gitDir, "commondir");
    paths.add(commonFile);
    try {
      const commonStat = statSync(commonFile);
      if (!commonStat.isFile() || commonStat.size > 4096) return undefined;
      const common = readFileSync(commonFile, "utf8").trim();
      if (common) {
        const commonDir = path.resolve(gitDir, common);
        paths.add(commonDir);
        paths.add(path.join(commonDir, "config"));
        paths.add(path.join(commonDir, "config.worktree"));
      }
    } catch (error) {
      if (!isMissingPath(error)) return undefined;
    }
  }

  return [...paths];
}

function policyFingerprint(cwd: string, extraPaths: Iterable<string>): string | undefined {
  const discovered = configDiscoveryPaths(cwd);
  if (!discovered) return undefined;
  const paths = new Set([...discovered, ...extraPaths]);
  const hash = createHash("sha256");
  for (const file of [...paths].sort()) {
    const value = fingerprintPath(file);
    if (value === undefined) return undefined;
    hash.update(path.resolve(file)).update("\0").update(value).update("\0");
  }
  return hash.digest("hex");
}

function filterCacheKey(cwd: string): string | undefined {
  try {
    const resolved = path.resolve(cwd);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return undefined;
  }
}

function readFilterCache(key: string): FilterCacheEntry | undefined {
  const entry = filterCache.get(key);
  if (!entry) return undefined;
  filterCache.delete(key);
  filterCache.set(key, entry);
  return entry;
}

function writeFilterCache(key: string, entry: FilterCacheEntry): void {
  filterCache.delete(key);
  filterCache.set(key, entry);
  if (filterCache.size > FILTER_CACHE_LIMIT) {
    const oldest = filterCache.keys().next().value as string | undefined;
    if (oldest !== undefined) filterCache.delete(oldest);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function scanFilterPrograms(cwd: string): Promise<FilterScan> {
  const found = new Set<string>();
  const discovered = configDiscoveryPaths(cwd);
  const paths = new Set(discovered ?? []);
  let cacheable = discovered !== undefined;
  const seen = new Set<string>();
  const queue: string[][] = [[]];
  while (queue.length) {
    const source = queue.shift()!;
    const policy = await spawnGit(cwd, ["config", ...source, "--includes", "-z", "--show-origin", "--get-regexp", POLICY_KEYS], {});
    if (policy.code !== 0 && policy.code !== 1) cacheable = false;
    for (const record of originRecords(policy.stdout)) {
      if (!record.key || !record.origin) cacheable = false;
      if (record.origin.startsWith("file:")) paths.add(path.resolve(record.origin.slice("file:".length)));
      if (new RegExp(PROGRAM_KEYS).test(record.key)) found.add(record.key);

      if (record.key === "include.path") {
        const target = includeTarget(record.origin, record.value, cwd);
        if ("refused" in target) cacheable = false;
        else paths.add(target.file);
        continue;
      }
      if (!/^includeif\..*\.path$/.test(record.key)) continue;
      const target = includeTarget(record.origin, record.value, cwd);
      if ("refused" in target) {
        found.add("includeIf (" + target.refused + ")");
        continue;
      }
      paths.add(target.file);
      if (seen.has(target.file)) continue;
      seen.add(target.file);
      if (seen.size > MAX_INCLUDE_FILES) {
        found.add("includeIf (more than " + MAX_INCLUDE_FILES + " conditional config files)");
        cacheable = false;
        return { programs: [...found], paths, cacheable };
      }
      if (existsSync(target.file)) queue.push(["--file", target.file]);
    }
  }
  if (hardening) paths.add(hardening.globalConfig);
  return { programs: [...found], paths, cacheable };
}

/** A cached answer for `key` whose config sources still hash to what they did when it was stored. */
function validCachedPrograms(cwd: string, key: string): string[] | undefined {
  const cached = readFilterCache(key);
  if (!cached) return undefined;
  const current = policyFingerprint(cwd, cached.paths);
  if (current && current === cached.fingerprint) return [...cached.programs];
  filterCache.delete(key);
  return undefined;
}

/** Scans in progress, by folder: callers that arrive meanwhile wait for them instead of starting their own git processes. */
const filterScansInFlight = new Map<string, Promise<unknown>>();

export async function filterPrograms(cwd: string): Promise<string[]> {
  const key = filterCacheKey(cwd);
  if (key) {
    const cached = validCachedPrograms(cwd, key);
    if (cached) return cached;
    // The watcher and the routes ask for the same folder at once. One of them scans; the others wait and then
    // take the answer only through the same fingerprint check as any later cache hit. A scan that could not be
    // cached leaves nothing to take, so the waiting caller scans for itself.
    const running = filterScansInFlight.get(key);
    if (running) {
      await running.catch(() => undefined);
      const shared = validCachedPrograms(cwd, key);
      if (shared) return shared;
    }
  }

  const scan = scanAndCacheFilterPrograms(cwd, key);
  if (!key) return scan;
  const mine = scan.catch(() => undefined);
  filterScansInFlight.set(key, mine);
  try {
    return await scan;
  } finally {
    if (filterScansInFlight.get(key) === mine) filterScansInFlight.delete(key);
  }
}

async function scanAndCacheFilterPrograms(cwd: string, key: string | undefined): Promise<string[]> {
  const first = await scanFilterPrograms(cwd);
  if (!key || !first.cacheable) return first.programs;
  const firstPaths = [...first.paths].sort();
  const firstFingerprint = policyFingerprint(cwd, firstPaths);
  if (!firstFingerprint) return first.programs;

  // Confirm a stable result before caching it. Every later use re-hashes the
  // exact config sources and missing include targets before trusting the cache.
  const second = await scanFilterPrograms(cwd);
  const secondPaths = [...second.paths].sort();
  const secondFingerprint = policyFingerprint(cwd, secondPaths);
  const samePrograms = sameStrings([...first.programs].sort(), [...second.programs].sort());
  if (second.cacheable && sameStrings(firstPaths, secondPaths) &&
      firstFingerprint === secondFingerprint && samePrograms) {
    writeFilterCache(key, { paths: secondPaths, fingerprint: secondFingerprint, programs: [...second.programs] });
    return second.programs;
  }

  return [...new Set([...first.programs, ...second.programs])];
}

/**
 * What identifies the git folder a folder belongs to without asking git: the nearest `.git` going up from `cwd`,
 * by its place, kind, volume, file id and creation time (a gitfile also by its size, time and text, which name the
 * git folder). A `.git` folder's own modified time is left out, because git touches it constantly. Undefined where
 * there is no `.git` to point at (a bare repo, no repo, anything unreadable), which is never cached.
 */
function gitEntryMarker(cwd: string): string | undefined {
  let directory = path.resolve(cwd);
  while (true) {
    const entry = path.join(directory, ".git");
    try {
      const stat = lstatSync(entry);
      if (stat.isDirectory()) return ["folder", entry, stat.dev, stat.ino, stat.birthtimeMs].join("\0");
      if (stat.isFile() && stat.size <= 4096) return ["file", entry, stat.dev, stat.ino, stat.birthtimeMs, stat.size, stat.mtimeMs, readFileSync(entry, "utf8")].join("\0");
      return undefined;
    } catch (error) {
      if (!isMissingPath(error)) return undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function statSignature(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "none";
  }
}

/**
 * A fingerprint of everything `git rev-parse --show-toplevel --verify HEAD^{commit}` reads in an ordinary
 * checkout: the `.git` entry (see gitEntryMarker), HEAD, the branch file HEAD names (so the commit it points at),
 * and the repo and worktree config files (core.worktree could move the top folder). Equal fingerprints before and
 * after an answer mean the answer still holds. Undefined where this cannot be known without asking git (a detached
 * or packed ref, a missing file, a bare repo): such folders are always asked about.
 */
export function headIdentity(cwd: string): string | undefined {
  const marker = gitEntryMarker(cwd);
  if (!marker) return undefined;
  try {
    const parts = marker.split("\0");
    const entry = parts[1]!;
    let gitDir = entry;
    if (parts[0] === "file") {
      const match = /^gitdir:\s*(.+?)\s*$/im.exec(parts.slice(7).join("\0"));
      if (!match) return undefined;
      gitDir = path.resolve(path.dirname(entry), match[1]!);
    }
    let commonDir = gitDir;
    if (existsSync(path.join(gitDir, "commondir"))) commonDir = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8");
    const named = /^ref:\s*(refs\/[^\r\n]+?)\s*$/.exec(head);
    // Only a branch whose file holds a full commit id is understood; anything else is left to git.
    if (!named || named[1]!.includes("..")) return undefined;
    const tip = readFileSync(path.join(commonDir, ...named[1]!.split("/")), "utf8").trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(tip)) return undefined;
    return [marker, head, tip, statSignature(path.join(commonDir, "config")), statSignature(path.join(gitDir, "config.worktree"))].join("\u0001");
  } catch {
    return undefined;
  }
}

const COMMON_DIR_TTL_MS = 5 * 60_000;
const COMMON_DIR_LIMIT = 256;
const commonDirCache = new Map<string, { dir: string; marker: string; at: number }>();

/**
 * The git folder shared by every checkout of the repo that contains `cwd` (what `git rev-parse --git-common-dir`
 * says), as an absolute path, or null when git does not say. The answer is kept for a few minutes, but only while
 * the `.git` entry it came from is still the same one (see gitEntryMarker) and the folder is still there; a
 * swapped or rewritten `.git` is asked about again at once.
 */
export async function commonGitDir(cwd: string): Promise<string | null> {
  const key = filterCacheKey(cwd);
  const marker = key ? gitEntryMarker(cwd) : undefined;
  if (key && marker) {
    const known = commonDirCache.get(key);
    if (known && known.marker === marker && Date.now() - known.at < COMMON_DIR_TTL_MS && existsSync(known.dir)) return known.dir;
  }
  const result = await runGit(cwd, ["rev-parse", "--git-common-dir"]).catch(() => null);
  if (!result || result.code !== 0 || !result.stdout.trim()) return null;
  const dir = path.resolve(cwd, result.stdout.trim());
  if (key && marker) {
    commonDirCache.delete(key);
    commonDirCache.set(key, { dir, marker, at: Date.now() });
    if (commonDirCache.size > COMMON_DIR_LIMIT) {
      const oldest = commonDirCache.keys().next().value as string | undefined;
      if (oldest !== undefined) commonDirCache.delete(oldest);
    }
  }
  return dir;
}

function refuseFilters(programs: string[]): void {
  if (!programs.length) return;
  throw new GitProgramRefusedError(
    `This repo's git settings run a program (${programs.join(", ")}) when files are checked out, compared or merged. Perfect Planner will not run it; a person must review and remove it (git config --unset) before continuing.`,
  );
}

/** The new worktree's folder in `git worktree add [options] <path> [<commit-ish>]`. */
function worktreeAddPath(args: readonly string[], at: number): string | undefined {
  for (let index = at + 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return args[index + 1];
    if (arg === "-b" || arg === "-B" || arg === "--reason") index += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

/**
 * Run git without a shell, by its absolute path from PATH (never a git in the repo), with the repo's
 * own hooks and every config setting that runs a program or changes what is shown switched off (see
 * fixedConfig and baseEnv). Diffs never use an external diff or textconv. A command that touches the
 * working tree or file content is refused (GitProgramRefusedError) while the repo config names a
 * filter program or merge driver; only an allow-list of commands skips that check. `worktree add` makes the worktree without files, checks the config as seen from inside
 * it (its branch and folder), and only then checks the files out. Use this for every host git call.
 * Never throws for a non-zero exit; see `git()`.
 */
export async function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const command = subcommand(args);
  const at = command ? args.indexOf(command) : -1;
  const addsWorktree = command === "worktree" && args[at + 1] === "add";
  if (mayRunPrograms(args, command)) refuseFilters(await filterPrograms(cwd));
  if (!addsWorktree) return spawnGit(cwd, args, options);

  const rest = args.slice(at + 2).filter((arg) => arg !== "--checkout");
  const wantsFiles = !rest.includes("--no-checkout");
  const target = worktreeAddPath(args, at + 1);
  const added = await spawnGit(cwd, [...args.slice(0, at + 2), ...(wantsFiles ? ["--no-checkout"] : []), ...rest], options);
  if (added.code !== 0 || !target) return added;
  const folder = path.resolve(cwd, target);
  const programs = await filterPrograms(folder);
  if (programs.length) {
    // Nothing was checked out, so the folder holds no work; take it away again.
    await spawnGit(cwd, ["worktree", "remove", "--force", folder], {});
    refuseFilters(programs);
  }
  if (!wantsFiles || rest.includes("--orphan")) return added;
  const filled = await spawnGit(folder, ["reset", "--hard", "-q"], options);
  return filled.code === 0 ? added : { ...filled, stderr: `${added.stderr}${filled.stderr}` };
}

function spawnGit(cwd: string, args: string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let program: string;
    let files: Hardening;
    try {
      program = directGit(gitExecutable(cwd));
      files = hardeningFiles(program);
      checkHardening(files);
    } catch (error) {
      reject(error);
      return;
    }
    const command = subcommand(args);
    let finalArgs = args;
    if (command && DIFF_COMMANDS.has(command)) {
      const at = args.indexOf(command);
      finalArgs = [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)];
    }
    const fixed = fixedConfig(options.hooksPath ?? files.hooksPath, files.attributesFile).flatMap((setting) => ["-c", setting]);
    const child = spawn(program, ["--no-pager", ...fixed, ...finalArgs], { cwd, env: { ...baseEnv(files.globalConfig), ...options.env, ...NO_CWD_SEARCH_ENV }, windowsHide: true, shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      resolve({ code: code ?? -1, stdout: bytes.toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), stdoutBytes: bytes });
    });
  });
}

export class GitError extends Error {
  constructor(readonly args: string[], readonly result: GitResult) {
    super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** Run git and return trimmed stdout, throwing GitError on a non-zero exit. */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) throw new GitError(args, result);
  return result.stdout.replace(/\r?\n$/, "");
}
