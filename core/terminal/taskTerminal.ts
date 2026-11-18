// The task-scoped terminal: one read-only command at a time, inside one task's worktree, with no
// shell. A person types a command; this module decides whether it is one of the few read-only forms
// the pane runs, splits it into arguments itself (no shell, no globbing, no redirection, no
// variable expansion), starts the program directly with shell:false, and returns a bounded
// transcript plus a sha256 of exactly what it returned. That hash is the audit handle: nothing here
// writes to the signed ledger, so the transcript is the record of what ran.
//
// Two families never reach spawn: dir, type, Get-ChildItem and Get-Content are shell built-ins that
// cannot be started without a shell, and a shell is exactly what this pane refuses. Their read-only
// forms are served by a confined in-process reader instead. Everything else is a real program,
// resolved from PATH by core/exec (never from the worktree) and started with shell:false.
//
// The allowlist is deliberately small: six read-only Git commands, four npm test/typecheck scripts,
// `node --test`, `npx vitest run`, and the read-only file/listing commands. Anything else, and every
// command that changes a repository or deletes a file, is refused with a plain reason.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gitExecutable, isLocalWindowsPath, isWithin, NO_CWD_SEARCH_ENV } from "../exec/index";
import { npmCliPath } from "../worktrees/index";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_COMMAND_CHARS = 2_000;

/** A command the pane refuses before anything is started, with a status the route can answer with. */
export type TaskCommandErrorCode =
  | "EMPTY_COMMAND"
  | "COMMAND_TOO_LONG"
  | "SHELL_METACHARACTER"
  | "UNBALANCED_QUOTE"
  | "EMPTY_ARGUMENT"
  | "NOT_ALLOWED"
  | "INVALID_CWD"
  | "OUTSIDE_CWD"
  | "PROGRAM_NOT_FOUND";

export class TaskCommandError extends Error {
  readonly code: TaskCommandErrorCode;
  /** 400 for a command the person can correct; 409 for the folder or a program missing here. */
  readonly status: number;

  constructor(code: TaskCommandErrorCode, message: string, status = 400) {
    super(message);
    this.name = "TaskCommandError";
    this.code = code;
    this.status = status;
  }
}

export type TaskCommandProgram = "git" | "node" | "npm" | "npx" | "builtin";

export interface TaskCommandPlan {
  program: TaskCommandProgram;
  /** The command as typed, split into arguments. Never passed through a shell. */
  tokens: string[];
  /** For git: where its subcommand sits in tokens (after safe global flags); -1 otherwise. */
  subcommandIndex: number;
}

export interface TaskCommandRunOptions {
  cwd: string;
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** The environment the program sees; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** Test seam only: replaces child_process.spawn. The host never sets it. */
  spawn?: typeof spawn;
}

export interface TaskCommandResult {
  /** The command exactly as typed. */
  command: string;
  /** The real path of the folder it ran in. */
  cwd: string;
  /** The program's exit code, or null when it was killed or never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** sha256 of the command, exit code and the exact (redacted) stdout and stderr returned. */
  transcriptHash: string;
  /** True when output was dropped from the front to stay inside the byte cap. */
  truncated: boolean;
  /** Bytes dropped from the front of stdout and stderr together. */
  droppedBytes: number;
  /** True when the deadline passed and the program was stopped. */
  timedOut: boolean;
}

// ---------- tokenizing and the allowlist ----------

/** Shell syntax this pane does not implement, and never silently ignores. */
const SHELL_CHARACTER = /[;&|<>`$()\r\n\0]/;

/**
 * Split one command into arguments without a shell: whitespace separates, single or double quotes
 * group. No escapes, no globbing, no expansion. Shell characters are refused before this runs, so a
 * quoted "$(rm -rf .)" is still refused rather than treated as text.
 */
export function tokenizeTaskCommand(command: string): string[] {
  if (typeof command !== "string") throw new TaskCommandError("EMPTY_COMMAND", "Type a command to run.");
  const text = command.trim();
  if (!text) throw new TaskCommandError("EMPTY_COMMAND", "Type a command to run.");
  if (text.length > MAX_COMMAND_CHARS) {
    throw new TaskCommandError("COMMAND_TOO_LONG", `Keep the command under ${MAX_COMMAND_CHARS} characters.`);
  }
  const shell = SHELL_CHARACTER.exec(text);
  if (shell) {
    throw new TaskCommandError(
      "SHELL_METACHARACTER",
      `"${shell[0]}" is a shell character. This pane runs one command without a shell, so type the program and its arguments only.`,
    );
  }
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) throw new TaskCommandError("UNBALANCED_QUOTE", "Close the quote before running the command.");
  if (started) tokens.push(current);
  if (!tokens.length) throw new TaskCommandError("EMPTY_COMMAND", "Type a command to run.");
  if (tokens.some((token) => token === "")) {
    throw new TaskCommandError("EMPTY_ARGUMENT", "Remove the empty argument (\"\" or '').");
  }
  return tokens;
}

const GIT_READ = new Set(["status", "diff", "log", "branch", "rev-parse", "show"]);
const GIT_CHANGES = new Set(["reset", "clean", "push", "checkout", "switch", "merge", "rebase", "commit", "stash", "add", "rm", "mv", "restore", "pull", "fetch", "clone", "tag", "cherry-pick", "revert", "apply", "am", "bisect", "worktree", "submodule", "config", "gc", "prune", "filter-branch", "update-ref", "symbolic-ref"]);
/** Git global flags that only change what is read, never which repository or program is used. */
const GIT_SAFE_GLOBALS = new Set(["--no-pager", "--no-optional-locks", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"]);
/** Options that make Git write a file or start another program; none of these is a read. */
const GIT_WRITING_OPTION = [/^--output(?:=|$)/, /^--ext-diff$/, /^--textconv$/, /^--no-index$/, /^--open-files-in-pager(?:=|$)/];
/** `git branch` may list; it may not create, rename, delete or set anything up. */
const GIT_BRANCH_READ = [
  /^-a$/, /^--all$/, /^-r$/, /^--remotes$/, /^-v+$/, /^--verbose$/, /^-l$/, /^--list(?:=.*)?$/,
  /^--show-current$/, /^--contains(?:=.*)?$/, /^--no-contains(?:=.*)?$/, /^--merged(?:=.*)?$/,
  /^--no-merged(?:=.*)?$/, /^--points-at(?:=.*)?$/, /^--sort(?:=.*)?$/, /^--format(?:=.*)?$/,
  /^--column(?:=.*)?$/, /^--no-column$/, /^-i$/, /^--ignore-case$/, /^-q$/, /^--quiet$/,
  /^--abbrev(?:=.*)?$/, /^--no-abbrev$/,
];
const NPM_SCRIPTS = new Set(["test", "test:core", "typecheck:core"]);
const LISTING = new Set(["ls", "dir", "Get-ChildItem"]);
const READING = new Set(["cat", "type"]);
const DENIED_PROGRAMS: Record<string, string> = {
  rm: "rm deletes files, so it is never run from this pane.",
  del: "del deletes files, so it is never run from this pane.",
  rmdir: "rmdir deletes folders, so it is never run from this pane.",
  curl: "curl talks to the network, so it is never run from this pane.",
  wget: "wget talks to the network, so it is never run from this pane.",
  ssh: "ssh starts a remote session, so it is never run from this pane.",
  powershell: "powershell starts a shell, so it is never run from this pane.",
  pwsh: "pwsh starts a shell, so it is never run from this pane.",
  cmd: "cmd starts a shell, so it is never run from this pane.",
  bash: "bash starts a shell, so it is never run from this pane.",
  sh: "sh starts a shell, so it is never run from this pane.",
};

function notAllowed(message: string): TaskCommandError {
  return new TaskCommandError("NOT_ALLOWED", message);
}

function planGit(rest: string[]): { subcommandIndex: number } {
  let index = 0;
  while (index < rest.length && GIT_SAFE_GLOBALS.has(rest[index]!)) index += 1;
  const sub = rest[index];
  if (!sub) {
    throw notAllowed("Name what Git should show: git status, git diff, git log, git branch, git rev-parse or git show.");
  }
  if (GIT_CHANGES.has(sub)) {
    throw notAllowed(`git ${sub} changes the repository, so it is not run here. Committing, merging, resetting and pushing stay a person action on the Tasks screen.`);
  }
  if (!GIT_READ.has(sub)) {
    throw notAllowed(`git ${sub} is not one of the read-only Git commands this pane runs (status, diff, log, branch, rev-parse, show).`);
  }
  const args = rest.slice(index + 1);
  if (sub === "branch") {
    for (const arg of args) {
      if (!arg.startsWith("-")) {
        throw notAllowed("git branch only lists branches here; creating, renaming or deleting one is a person action on the Tasks screen.");
      }
      if (!GIT_BRANCH_READ.some((pattern) => pattern.test(arg))) {
        throw notAllowed(`git branch ${arg} is not a read-only listing.`);
      }
    }
  }
  if (sub === "diff" || sub === "log" || sub === "show") {
    const writing = args.find((arg) => GIT_WRITING_OPTION.some((pattern) => pattern.test(arg)));
    if (writing) throw notAllowed(`git ${sub} ${writing} would write a file or start another program, so it is not run here.`);
  }
  return { subcommandIndex: index + 1 };
}

function planNpm(args: string[]): void {
  const sub = args[0];
  if (sub === "test") {
    if (args.length > 1 && args[1] !== "--") throw notAllowed("npm test takes no options here; put test-runner options after --.");
    return;
  }
  if (sub === "run") {
    const script = args[1];
    if (!script || !NPM_SCRIPTS.has(script)) {
      throw notAllowed("Only these npm scripts run here: test, test:core and typecheck:core.");
    }
    if (args.length > 2 && args[2] !== "--") throw notAllowed(`npm run ${script} takes no options here; put script options after --.`);
    return;
  }
  throw notAllowed("Only npm test, npm run test, npm run test:core and npm run typecheck:core run here.");
}

function planNpx(args: string[]): void {
  if (args[0] !== "vitest" || args[1] !== "run") throw notAllowed("Only npx vitest run runs here.");
  for (const arg of args.slice(2)) {
    if (arg.startsWith("-")) throw notAllowed("Options are not run here; name the test files instead.");
  }
}

function planNode(args: string[]): void {
  if (args[0] !== "--test") throw notAllowed("Only node --test runs here (with optional test file names).");
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-")) throw notAllowed("Options are not run here; name the test files instead.");
  }
}

function planReadOnly(program: string, args: string[]): void {
  if (program === "pwd") {
    if (args.length) throw notAllowed("pwd takes no arguments here.");
    return;
  }
  if (LISTING.has(program)) {
    const paths = args.filter((arg) => !arg.startsWith("-"));
    const flags = args.filter((arg) => arg.startsWith("-"));
    if (paths.length > 1) throw notAllowed(`${program} shows one folder at a time here.`);
    if (flags.some((flag) => !["-a", "--all", "-Force"].includes(flag))) {
      throw notAllowed(`${program} only lists a folder here (options: -a, --all, -Force).`);
    }
    return;
  }
  if (program === "Get-Content") {
    const rest = args.filter((arg) => arg !== "-Raw");
    if (rest.length !== 1 || rest[0]!.startsWith("-")) throw notAllowed("Get-Content reads one file here: Get-Content [-Raw] <file>.");
    return;
  }
  // cat and type
  if (args.length !== 1 || args[0]!.startsWith("-")) throw notAllowed(`${program} reads one file here: ${program} <file>.`);
}

/**
 * Check one command against the allowlist and split it into arguments. Pure: it reads nothing and
 * starts nothing. Throws TaskCommandError with a plain reason for every refused command.
 */
export function parseTaskCommand(command: string): TaskCommandPlan {
  const tokens = tokenizeTaskCommand(command);
  const head = tokens[0]!;
  const rest = tokens.slice(1);
  if (head === "git") return { program: "git", tokens, ...planGit(rest) };
  if (head === "npm") {
    planNpm(rest);
    return { program: "npm", tokens, subcommandIndex: -1 };
  }
  if (head === "npx") {
    planNpx(rest);
    return { program: "npx", tokens, subcommandIndex: -1 };
  }
  if (head === "node") {
    planNode(rest);
    return { program: "node", tokens, subcommandIndex: -1 };
  }
  if (head === "pwd" || LISTING.has(head) || READING.has(head) || head === "Get-Content") {
    planReadOnly(head, rest);
    return { program: "builtin", tokens, subcommandIndex: -1 };
  }
  if (DENIED_PROGRAMS[head]) throw notAllowed(DENIED_PROGRAMS[head]!);
  throw notAllowed(`"${head}" is not one of the read-only commands this pane runs. Use git status, git diff, git log, ls, cat, npm test or node --test.`);
}

// ---------- environment redaction ----------

/** Environment names whose values are treated as secrets and never shown in a transcript. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** Replace every value of a secret-looking environment variable with [redacted]. Pure. */
export function redactEnvValues(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text;
  const values = [...new Set(
    Object.entries(env)
      .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 4)
      .map(([, value]) => value as string),
  )].sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) if (out.includes(value)) out = out.split(value).join("[redacted]");
  return out;
}

/** sha256 of the command, exit code and the exact stdout and stderr returned. Unambiguous by JSON framing. */
export function transcriptDigest(command: string, exitCode: number | null, stdout: string, stderr: string): string {
  return createHash("sha256").update(JSON.stringify([command, exitCode, stdout, stderr]), "utf8").digest("hex");
}

// ---------- the runner ----------

function clampTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(value), MAX_TIMEOUT_MS);
}

function clampOutput(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_OUTPUT_BYTES;
  return Math.min(Math.floor(value), MAX_OUTPUT_BYTES);
}

function realWorkdir(cwd: string): string {
  if (typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd)) {
    throw new TaskCommandError("INVALID_CWD", "The task's folder must be a full path, so no command was run.", 409);
  }
  let real: string;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    throw new TaskCommandError("INVALID_CWD", `The task's folder (${cwd}) is not there, so no command was run.`, 409);
  }
  if (process.platform === "win32" && !isLocalWindowsPath(real)) {
    throw new TaskCommandError("INVALID_CWD", "The task's folder is on a network or device path, so no command was run.", 409);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new TaskCommandError("INVALID_CWD", `The task's folder (${cwd}) cannot be read, so no command was run.`, 409);
  }
  if (!stat.isDirectory()) {
    throw new TaskCommandError("INVALID_CWD", `The task's folder (${cwd}) is not a folder, so no command was run.`, 409);
  }
  return real;
}

/**
 * The host's git hardening, narrowed to the six read-only commands above: no hooks, fsmonitor,
 * external diff, textconv, signature check or transport can start another program. The worktrees
 * module owns the full hardening for commands that change the repository; none of those run here.
 */
const GIT_FIXED_CONFIG = [
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "diff.external=",
  "core.askPass=",
  "color.ui=false",
  "log.showSignature=false",
  "protocol.allow=never",
];

function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {
    ...env,
    ...NO_CWD_SEARCH_ENV,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0",
  };
  // A parent git process or a hook can export these: they would point at another repo, inject
  // config, or name a program for git to run.
  for (const key of Object.keys(clean)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|SYSTEM)$/.test(key)) delete clean[key];
  }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_EXEC_PATH", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_TEMPLATE_DIR", "GIT_ALLOW_PROTOCOL", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_OBJECT_DIRECTORY"]) {
    delete clean[key];
  }
  return clean;
}

function gitArguments(plan: TaskCommandPlan): string[] {
  const args = plan.tokens.slice(1);
  const at = plan.subcommandIndex - 1;
  const sub = plan.tokens[plan.subcommandIndex];
  // Diff output is read by a person: never through an external diff program or a textconv filter.
  if (sub === "diff" || sub === "log" || sub === "show") {
    return [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)];
  }
  return args;
}

function resolveProgram(plan: TaskCommandPlan, cwd: string, env: NodeJS.ProcessEnv): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const head = plan.tokens[0]!;
  if (plan.program === "git") {
    let file: string;
    try {
      file = gitExecutable(cwd);
    } catch (error) {
      throw new TaskCommandError("PROGRAM_NOT_FOUND", (error as Error).message, 409);
    }
    const fixed = GIT_FIXED_CONFIG.flatMap((setting) => ["-c", setting]);
    return { file, args: ["--no-pager", ...fixed, ...gitArguments(plan)], env: gitEnvironment(env) };
  }
  if (plan.program === "node") return { file: process.execPath, args: plan.tokens.slice(1), env };
  let npmCli: string;
  try {
    npmCli = npmCliPath(cwd, [], env);
  } catch (error) {
    throw new TaskCommandError("PROGRAM_NOT_FOUND", (error as Error).message, 409);
  }
  if (head === "npm") return { file: process.execPath, args: [npmCli, ...plan.tokens.slice(1)], env };
  const npx = path.join(path.dirname(npmCli), "npx-cli.js");
  if (!fs.existsSync(npx)) {
    throw new TaskCommandError("PROGRAM_NOT_FOUND", "npx is not installed next to npm here, so npx vitest run cannot start. Install the project's dependencies in the task's folder and use npm test.", 409);
  }
  // --no-install: never download a package from the network just because it is missing here.
  return { file: process.execPath, args: [npx, "--no-install", ...plan.tokens.slice(1)], env };
}

/** The last `cap` bytes of a string, with how many bytes were dropped. */
function boundText(text: string, cap: number): { text: string; dropped: number } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= cap) return { text, dropped: 0 };
  return { text: buffer.subarray(buffer.length - cap).toString("utf8"), dropped: buffer.length - cap };
}

interface BuiltinResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  dropped: number;
}

/** Resolve a path the built-in reader may touch: inside cwd lexically, and again through links. */
function resolveInside(cwd: string, target: string): string {
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
  if (!isWithin(cwd, resolved)) {
    throw new TaskCommandError("OUTSIDE_CWD", `"${target}" is outside this task's folder, so it was not read.`);
  }
  let real: string | undefined;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    real = undefined;
  }
  if (real && !isWithin(cwd, real)) {
    throw new TaskCommandError("OUTSIDE_CWD", `"${target}" leads outside this task's folder, so it was not read.`);
  }
  return real ?? resolved;
}

function missing(program: string, target: string): BuiltinResult {
  return { stdout: "", stderr: `${program}: ${target}: No such file or directory\n`, exitCode: 1, dropped: 0 };
}

function runBuiltin(tokens: string[], cwd: string, cap: number): BuiltinResult {
  const program = tokens[0]!;
  const args = tokens.slice(1);
  if (program === "pwd") return { stdout: `${cwd}\n`, stderr: "", exitCode: 0, dropped: 0 };
  if (LISTING.has(program)) {
    const target = args.find((arg) => !arg.startsWith("-")) ?? ".";
    const folder = resolveInside(cwd, target);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return missing(program, target);
    }
    const shown = entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 5_000);
    const text = shown.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n");
    const bounded = boundText(text ? `${text}\n` : "", cap);
    const omitted = entries.length > shown.length ? entries.length - shown.length : 0;
    const note = omitted ? `${program}: ${omitted} more entries were not listed.\n` : "";
    return { stdout: bounded.text, stderr: note, exitCode: 0, dropped: bounded.dropped };
  }
  const target = args.find((arg) => arg !== "-Raw")!;
  const file = resolveInside(cwd, target);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return missing(program, target);
  }
  if (!stat.isFile()) return { stdout: "", stderr: `${program}: ${target}: Is a folder, not a file\n`, exitCode: 1, dropped: 0 };
  const start = Math.max(0, stat.size - cap);
  let buffer: Buffer;
  try {
    if (start === 0) {
      buffer = fs.readFileSync(file);
    } else {
      const handle = fs.openSync(file, "r");
      try {
        buffer = Buffer.alloc(stat.size - start);
        fs.readSync(handle, buffer, 0, buffer.length, start);
      } finally {
        fs.closeSync(handle);
      }
    }
  } catch {
    return { stdout: "", stderr: `${program}: ${target}: Could not be read\n`, exitCode: 1, dropped: 0 };
  }
  return { stdout: buffer.toString("utf8"), stderr: "", exitCode: 0, dropped: stat.size - buffer.length };
}

interface SpawnTask {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  program: { file: string; args: string[]; env: NodeJS.ProcessEnv };
  timeoutMs: number;
  cap: number;
  started: number;
  spawnImpl: typeof spawn;
}

function spawnTask(task: SpawnTask): Promise<TaskCommandResult> {
  return new Promise<TaskCommandResult>((resolve) => {
    const chunks: { stream: "stdout" | "stderr"; data: Buffer }[] = [];
    let size = 0;
    let dropped = 0;
    let settled = false;
    let timedOut = false;
    let note = "";
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;

    const keep = (stream: "stdout" | "stderr", chunk: Buffer) => {
      chunks.push({ stream, data: chunk });
      size += chunk.length;
      // Drop whole chunks from the front; a single oversized chunk keeps its own tail.
      while (size > task.cap && chunks.length) {
        const first = chunks[0]!;
        const over = size - task.cap;
        if (first.data.length <= over) {
          size -= first.data.length;
          dropped += first.data.length;
          chunks.shift();
        } else {
          first.data = first.data.subarray(over);
          size -= over;
          dropped += over;
        }
      }
    };

    const collected = (stream: "stdout" | "stderr") =>
      Buffer.concat(chunks.filter((chunk) => chunk.stream === stream).map((chunk) => chunk.data)).toString("utf8");

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      const stdout = redactEnvValues(collected("stdout"), task.env);
      let stderr = redactEnvValues(collected("stderr"), task.env);
      if (timedOut) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}[Stopped after ${task.timeoutMs} ms: it was still running.]\n`;
      if (note) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}\n`;
      const exitCode = timedOut ? null : code;
      resolve({
        command: task.command,
        cwd: task.cwd,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - task.started,
        transcriptHash: transcriptDigest(task.command, exitCode, stdout, stderr),
        truncated: dropped > 0,
        droppedBytes: dropped,
        timedOut,
      });
    };

    let child: ChildProcess;
    try {
      child = task.spawnImpl(task.program.file, task.program.args, {
        cwd: task.cwd,
        env: task.program.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"] as Array<"ignore" | "pipe">,
      });
    } catch (error) {
      note = `It could not be started: ${(error as Error).message}`;
      settle(null);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => keep("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => keep("stderr", chunk));
    child.on("error", (error) => {
      note = `It could not be started: ${error.message}`;
      settle(null);
    });
    child.on("close", (code) => settle(code));
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; close (or the grace timer) still reports it honestly.
      }
      // A grandchild can outlive its parent and hold the pipes open: answer anyway, and say so.
      grace = setTimeout(() => settle(null), 2_000);
    }, task.timeoutMs);
  });
}

/**
 * Run one allowlisted read-only command in `cwd`, with no shell, bounded output and a deadline.
 * Resolves with the transcript (never a rejection for a non-zero exit); rejects with
 * TaskCommandError for a refused command or an unusable folder. Pure with respect to the ledger:
 * it never writes an entry, so the returned transcriptHash is the audit handle.
 */
export async function runTaskCommand(options: TaskCommandRunOptions): Promise<TaskCommandResult> {
  const command = typeof options.command === "string" ? options.command : "";
  const plan = parseTaskCommand(command);
  const cwd = realWorkdir(options.cwd);
  const env = options.env ?? process.env;
  const timeoutMs = clampTimeout(options.timeoutMs);
  const cap = clampOutput(options.maxOutputBytes);
  const started = Date.now();

  if (plan.program === "builtin") {
    const builtin = runBuiltin(plan.tokens, cwd, cap);
    const stdout = redactEnvValues(builtin.stdout, env);
    const stderr = redactEnvValues(builtin.stderr, env);
    return {
      command,
      cwd,
      exitCode: builtin.exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      transcriptHash: transcriptDigest(command, builtin.exitCode, stdout, stderr),
      truncated: builtin.dropped > 0,
      droppedBytes: builtin.dropped,
      timedOut: false,
    };
  }

  return spawnTask({
    command,
    cwd,
    env,
    program: resolveProgram(plan, cwd, env),
    timeoutMs,
    cap,
    started,
    spawnImpl: options.spawn ?? spawn,
  });
}
