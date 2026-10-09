import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, runGit } from "../worktrees/git";
import { ensureRequiredIgnores, PRIVATE_DIR, privatePaths, stagedPrivatePaths } from "../worktrees/ignores";
import { lines, realDir, samePath } from "../worktrees/platform";
import { isAuthoritative } from "../ledger/index";
import { GATE_ACTOR, evidenceValue, type Actor, type EntryDraft, type LedgerEntry, type LedgerPort } from "../worktrees/ports";
import { TASK_ID } from "../worktrees/types";
import { DEFAULT_TIMEOUT_MS, isConclusiveFailure, runTestCommand, type TestRunResult, type TestRunner } from "./run";

export type Phase = "baseline" | "worktree" | "merge";

export interface TestOutcome {
  /** Ledger number of the test.passed / test.failed entry. */
  n: string;
  passed: boolean;
  phase: Phase;
  commit?: string;
}

export interface GateState {
  taskId: string;
  /** "T-14" for T-14, T-14.a2, T-14.a3. */
  baseId: string;
  attempt: number;
  /** The current test.defined entry. Definitions, baselines, Jev's test verdicts and approvals carry over from earlier attempts. */
  definition?: { n: string; command: string; actor: Actor; files: string[] };
  /** The baseline run, with the content hashes of the test files it ran (see pinTestFiles). */
  baseline?: TestOutcome & { pins: Pins };
  /** Approval pins the test: the command plus the content hash of every test file. */
  /** Latest Jev verdict on the current definition. */
  jev?: { n: string; verdict: "approve" | "gaps"; gaps: string[] };
  approval?: { n: string; actor: Actor; pins: Pins; pin: string };
  /** Latest worktree run of the current definition for this attempt. */
  worktree?: TestOutcome;
  /** Latest post-merge run of the current definition for this attempt. */
  merge?: TestOutcome;
  /** Commits (full sha) this attempt's current, unaltered test has passed on, outside the baseline. */
  passedCommits: string[];
  /**
   * Latest approving review of the diff at the commit it reviewed. Counts only when the ledger verified
   * its signature: a person's own entry, or the gate's entry recording Jev's verdict.
   */
  diffApproval?: { n: string; commit: string; reviewer: Actor; byPerson: boolean };
  /** Latest merge approval: only a person's own signed entry, naming the commit they approved. */
  mergeApproval?: { n: string; commit: string; actor: Actor };
  merged?: { n: string; commit: string };
  done?: { n: string };
  reopenedAs?: string;
  /** Plain-language stage, for display. */
  stage: "undefined" | "defined" | "approved" | "baseline-passes" | "baseline-confirmed" | "proven" | "done" | "reopened";
  /** Every ledger entry the state was built from, oldest first. */
  history: { n: string; type: string; summary: string }[];
}

export type Refusal = { ok: false; reason: string };
/** Repo-relative test file -> sha256 of its content with CRLF read as LF. */
export type Pins = Record<string, string>;
export type Ok<T> = { ok: true } & T;

export interface RunReport {
  entry: LedgerEntry;
  run: TestRunResult;
  commit?: string;
}

export interface MergeOptions {
  repoRoot: string;
  branch: string;
  integrationBranch: string;
  /**
   * The person merging. They must have approved the merge at the branch tip with their own signed entry
   * (approveMerge); naming them here is not approval. Written on merge.done and task.done.
   */
  actor: Actor;
  /**
   * Prepare the throwaway merge candidate before the test runs there, e.g. install dependencies.
   * Default: link node_modules from the task's worktree (or the main checkout) into the candidate.
   */
  prepare?: (candidateDir: string) => Promise<void>;
}

export interface DefineOptions {
  /**
   * Test files to pin, relative to the checkout. Files named in the command (node check.mjs,
   * vitest run tests/x.test.ts) are found automatically; name the rest here.
   */
  files?: string[];
}

export interface ApproveOptions {
  /** Checkout to read the test files from; their content hashes are what gets approved. */
  cwd: string;
  /** Jev's review of the test: "approve", or the gaps it found (which refuse approval). */
  jevVerdict?: "approve" | string[];
  /** The Jev actor writing the verdict; required with jevVerdict (the ledger needs its model). */
  jev?: Actor;
}

/** The slice of the ledger the gate reads; core/ledger's Ledger satisfies it. */
export type LedgerReader = Pick<LedgerPort, "entries">;

export interface TestGateOptions {
  ledger: LedgerPort;
  /** Clock for timestamp(); the ledger stamps its own entries. */
  now?: () => Date;
  run?: TestRunner;
  /** Per test run. Default 10 minutes. */
  timeoutMs?: number;
}

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

export function parseTaskId(taskId: string): { baseId: string; attempt: number } {
  if (!TASK_ID.test(taskId)) throw new GateError(`"${taskId}" is not a task id like T-14 or T-14.a2.`);
  const match = /^(T-\d+)(?:\.a(\d+))?$/.exec(taskId)!;
  return { baseId: match[1]!, attempt: match[2] ? Number(match[2]) : 1 };
}

export function attemptId(baseId: string, attempt: number): string {
  return attempt <= 1 ? baseId : `${baseId}.a${attempt}`;
}

/** T-14 -> T-14.a2 -> T-14.a3. */
export function nextAttemptId(taskId: string): string {
  const { baseId, attempt } = parseTaskId(taskId);
  return attemptId(baseId, attempt + 1);
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function lastLine(text: string): string {
  const all = lines(text);
  return all.length ? oneLine(all[all.length - 1]!) : "";
}

function describeRun(run: TestRunResult): string {
  if (run.timedOut) return `timed out after ${run.durationMs} ms`;
  if (run.exitCode === null) return "did not run";
  return `exit code ${run.exitCode}`;
}

function failureReason(run: TestRunResult): string {
  const last = lastLine(run.outputTail);
  return oneLine(last ? `${describeRun(run)}: ${last}` : describeRun(run));
}

function runEvidence(run: TestRunResult): string[] {
  return [`exit:${run.exitCode ?? "none"}`, `duration-ms:${run.durationMs}`, ...(run.timedOut ? ["timed-out:true"] : [])];
}

function dataString(entry: LedgerEntry, key: string): string | undefined {
  const value = entry.data?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Definition number a proof entry refers to: data.definition, else evidence "definition:<n>". */
function definitionOf(entry: LedgerEntry): string | undefined {
  return dataString(entry, "definition") ?? evidenceValue(entry, "definition");
}

function phaseOf(entry: LedgerEntry): Phase | undefined {
  const phase = dataString(entry, "phase") ?? evidenceValue(entry, "phase");
  if (phase === "baseline" || phase === "worktree" || phase === "merge") return phase;
  return entry.data?.afterMerge === true ? "merge" : undefined;
}

function dataPins(entry: LedgerEntry): Pins {
  const value = entry.data?.pins;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
}

function dataFiles(entry: LedgerEntry): string[] {
  const value = entry.data?.files;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Hash text the same whichever line endings the checkout uses. */
function contentHash(content: Buffer): string {
  return createHash("sha256").update(content.toString("latin1").replace(/\r\n/g, "\n"), "latin1").digest("hex");
}

/** One hash for a whole set of pins, recorded on every proof so a pass can be matched to the approved test. */
export function pinDigest(pins: Pins): string {
  return createHash("sha256").update(Object.keys(pins).sort().map((file) => `${file}=${pins[file]}`).join("\n")).digest("hex");
}

function normalizeTestFile(file: string): string | undefined {
  const clean = path.posix.normalize(file.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!clean || clean === "." || clean.startsWith("../") || clean === ".." || path.isAbsolute(file.trim()) || /^[a-z]:/i.test(clean)) return undefined;
  return clean;
}

function isFileIn(cwd: string, file: string): boolean {
  try {
    return statSync(path.join(cwd, file)).isFile();
  } catch {
    return false;
  }
}

/** The command's arguments that name files in cwd, plus the files named explicitly. */
export function testFilesOf(command: string, cwd: string, named: readonly string[] = []): string[] {
  const tokens = [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
  const found = new Set<string>();
  for (const token of [...named, ...tokens.filter((token) => !token.startsWith("-"))]) {
    const file = normalizeTestFile(token);
    if (file && isFileIn(cwd, file)) found.add(file);
  }
  return [...found].sort();
}

/** Content hashes of the test files as they are on disk in cwd. */
export function pinTestFiles(cwd: string, files: readonly string[]): Pins {
  const pins: Pins = {};
  for (const file of files) if (isFileIn(cwd, file)) pins[file] = contentHash(readFileSync(path.join(cwd, file)));
  return pins;
}

/** Pinned files that are missing or differ in cwd: on disk, and in the commit checked out there. */
async function changedTestFiles(cwd: string, pins: Pins): Promise<string[]> {
  const changed = new Set<string>();
  const onDisk = pinTestFiles(cwd, Object.keys(pins));
  const isRepo = (await headOf(cwd)) !== undefined;
  for (const [file, hash] of Object.entries(pins)) {
    if (onDisk[file] !== hash) changed.add(file);
    if (!isRepo) continue;
    // The committed copy counts too: an ignored or assume-unchanged file could hide a rewritten test from git status.
    const committed = await runGit(cwd, ["cat-file", "blob", `HEAD:${file}`]).catch(() => undefined);
    if (committed?.code === 0 && contentHash(committed.stdoutBytes) !== hash) changed.add(file);
  }
  return [...changed].sort();
}

/** The ledger, worker tokens and task worktrees in .perfect-planner/ must never be committed. */
function privateRefusal(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).join(", ");
  return `${PRIVATE_DIR}/ holds the ledger and worker tokens and must never be committed, but these are staged or committed: ${shown}${paths.length > 5 ? ` and ${paths.length - 5} more` : ""}. Remove them from the branch's commits (git rm --cached alone leaves them in history), then prove again.`;
}

/** Replay the ledger into one task's gate state. Pure. */
export function deriveState(entries: readonly LedgerEntry[], taskId: string): GateState {
  const { baseId, attempt } = parseTaskId(taskId);
  const state: GateState = { taskId, baseId, attempt, passedCommits: [], stage: "undefined", history: [] };
  const passed = new Set<string>();
  const inLineage = (subject: string): boolean => {
    if (!TASK_ID.test(subject)) return false;
    const parsed = parseTaskId(subject);
    return parsed.baseId === baseId && parsed.attempt <= attempt;
  };
  for (const entry of entries) {
    if (!inLineage(entry.subject)) continue;
    const own = entry.subject === taskId;
    const phase = phaseOf(entry);
    const aboutTheTest = entry.type === "test.defined" || entry.type === "test.approved" || phase === "baseline" || (entry.type === "review.verdict" && evidenceValue(entry, "scope") === "test");
    if (!own && !aboutTheTest) continue;
    state.history.push({ n: entry.n, type: entry.type, summary: entry.summary });
    const forCurrent = state.definition !== undefined && definitionOf(entry) === state.definition.n;
    // Results, merges, done and reopen only count when the ledger verified who wrote them.
    if (["test.passed", "test.failed", "merge.done", "task.done", "task.reopened"].includes(entry.type) && !isAuthoritative(entry)) continue;
    switch (entry.type) {
      case "test.defined": {
        state.definition = { n: entry.n, command: dataString(entry, "test") ?? evidenceValue(entry, "test") ?? "", actor: entry.actor, files: dataFiles(entry) };
        state.baseline = state.jev = state.approval = state.worktree = state.merge = undefined;
        passed.clear();
        break;
      }
      case "test.passed":
      case "test.failed": {
        if (!forCurrent) break;
        const outcome: TestOutcome = { n: entry.n, passed: entry.type === "test.passed", phase: phase ?? "worktree", commit: dataString(entry, "commit") ?? evidenceValue(entry, "commit") };
        // An inconclusive baseline (timeout, crash, missing command) clears any earlier one.
        if (outcome.phase === "baseline") {
          // Only a conclusive run of the test exactly as approved counts as the baseline.
          const pinned = state.approval !== undefined && dataString(entry, "pin") === state.approval.pin;
          state.baseline = entry.data?.conclusive === false || !pinned ? undefined : { ...outcome, pins: dataPins(entry) };
        }
        else if (outcome.phase === "worktree") state.worktree = outcome;
        else state.merge = outcome;
        // A pass only counts for the test exactly as approved.
        const pinned = state.approval !== undefined && dataString(entry, "pin") === state.approval.pin;
        if (outcome.phase !== "baseline" && outcome.passed && outcome.commit && pinned) passed.add(outcome.commit.toLowerCase());
        break;
      }
      case "review.verdict": {
        if (own && evidenceValue(entry, "scope") === "diff") {
          // An unsigned entry (an agent claiming to be Jev, say) is information, never approval.
          if (!isAuthoritative(entry)) break;
          const commit = (dataString(entry, "commit") ?? evidenceValue(entry, "commit") ?? "").toLowerCase();
          const byPerson = isAuthoritative(entry, { personOnly: true });
          const recorded = entry.data?.reviewer as Actor | undefined;
          const reviewer = byPerson ? entry.actor : recorded?.kind === "jev" ? recorded : undefined;
          const approves = evidenceValue(entry, "verdict") === "approve" && reviewer !== undefined;
          state.diffApproval = approves && commit ? { n: entry.n, commit, reviewer, byPerson } : undefined;
          break;
        }
        if (own && evidenceValue(entry, "scope") === "merge") {
          // Only the person's own signed entry approves a merge; nobody can approve it on their behalf.
          if (!isAuthoritative(entry, { personOnly: true })) break;
          const commit = (dataString(entry, "commit") ?? evidenceValue(entry, "commit") ?? "").toLowerCase();
          const approves = evidenceValue(entry, "verdict") === "approve";
          state.mergeApproval = approves && commit ? { n: entry.n, commit, actor: entry.actor } : undefined;
          break;
        }
        if (evidenceValue(entry, "scope") !== "test" || !forCurrent) break;
        // Jev's verdict on the test is recorded by the gate (signed); an unsigned one is information only.
        if (!isAuthoritative(entry)) break;
        const verdict = evidenceValue(entry, "verdict") === "approve" ? "approve" : "gaps";
        const gaps = entry.evidence.filter((item) => item.startsWith("gap:")).map((item) => item.slice(4));
        state.jev = { n: entry.n, verdict, gaps };
        break;
      }
      case "test.approved": {
        // Only a person's approval counts, whatever an entry's data says.
        if (forCurrent && isAuthoritative(entry, { personOnly: true })) {
          const pins = dataPins(entry);
          state.approval = { n: entry.n, actor: entry.actor, pins, pin: dataString(entry, "pin") ?? pinDigest(pins) };
          state.baseline = undefined;
        }
        break;
      }
      case "merge.done": {
        state.merged = { n: entry.n, commit: dataString(entry, "commit") ?? evidenceValue(entry, "commit") ?? "" };
        break;
      }
      case "task.done": {
        state.done = { n: entry.n };
        break;
      }
      case "task.reopened": {
        state.reopenedAs = dataString(entry, "attempt") ?? evidenceValue(entry, "attempt");
        break;
      }
      default:
        break;
    }
  }
  state.passedCommits = [...passed];
  state.stage = state.reopenedAs
    ? "reopened"
    : state.done
      ? "done"
      : state.approval && state.baseline?.passed === false && state.worktree?.passed
        ? "proven"
        : state.baseline?.passed === false
          ? "baseline-confirmed"
          : state.baseline?.passed
            ? "baseline-passes"
            : state.approval
              ? "approved"
              : state.definition
                ? "defined"
                : "undefined";
  return state;
}

/** Why a task may not start yet, or null when it may (spec 5.1). */
export function startRefusal(state: GateState): string | null {
  const id = state.taskId;
  if (state.done) return `${id} is already done.`;
  if (state.reopenedAs) return `${id} was reopened as ${state.reopenedAs}.`;
  if (!state.definition) return `${id} has no done-when test.`;
  if (!state.approval) return `${id}'s test is waiting for the owner's approval.`;
  if (!state.baseline) return `${id}'s test has not been run on the current code yet.`;
  if (state.baseline.passed) return `${id}'s test already passes on the current code.`;
  // Jev may review the test after the person approved it; open gaps stop work until Jev clears them.
  if (state.jev?.verdict === "gaps") return `Jev found gaps in ${id}'s test: ${state.jev.gaps.join("; ")}. Jev has to clear them, or the test has to be redefined and approved again.`;
  return null;
}

/**
 * A ledger rule (register with ledger.addRule): task.claimed is refused for a task whose
 * current done-when test is not approved (spec 5.1).
 */
export function gateRule(): (draft: EntryDraft, ledger: LedgerReader) => string | null {
  return (draft, ledger) => {
    if (draft.type !== "task.claimed" && draft.type !== "task.done") return null;
    const subject = draft.subject.trim();
    if (!TASK_ID.test(subject)) return null;
    const state = deriveState(ledger.entries(), subject);
    if (draft.type === "task.claimed") {
      const refusal = startRefusal(state);
      return refusal ? `${subject} cannot be claimed: ${refusal}` : null;
    }
    if (draft.actor.kind !== GATE_ACTOR.kind || draft.actor.id !== GATE_ACTOR.id) {
      return `${subject} cannot be marked done by ${draft.actor.kind} ${draft.actor.id}: only the gate writes task.done, after the approved test passes on the merged code.`;
    }
    const commit = draft.evidence?.find((item) => item.startsWith("commit:"))?.slice("commit:".length).trim().toLowerCase();
    if (!state.approval || !commit || !state.passedCommits.includes(commit)) {
      return `${subject} cannot be marked done: its approved, unaltered test has not passed at ${commit ? commit.slice(0, 12) : "a named commit"}.`;
    }
    return null;
  };
}

async function headOf(cwd: string): Promise<string | undefined> {
  if (!existsSync(cwd)) return undefined;
  const result = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
  return result?.code === 0 ? result.stdout.trim() : undefined;
}

const DEPENDENCY_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", ".npmrc"];

function sameFile(a: string, b: string): boolean {
  const read = (file: string) => (existsSync(file) ? contentHash(readFileSync(file)) : "missing");
  return read(a) === read(b);
}

/**
 * Give the merge candidate dependencies the worker never touched. The task's own node_modules is
 * never used: it is ignored by git, so edits to it (vitest itself, say) would pass unseen. When the
 * candidate's package files match the integration checkout's, its node_modules is linked in (a
 * junction on Windows); when the task changed them, a clean `npm ci` (or `npm install` without a
 * lockfile) runs in the candidate.
 * Returns the link path so the caller can remove it before the candidate.
 */
async function cleanDependencies(repoRoot: string, integrationBranch: string, candidate: string, run: TestRunner, timeoutMs: number): Promise<{ linked?: string; failure?: string }> {
  let checkout = repoRoot;
  let current: string | undefined;
  for (const line of lines(await git(repoRoot, ["worktree", "list", "--porcelain"]))) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${integrationBranch}` && current) checkout = current;
  }
  const source = path.join(checkout, "node_modules");
  const target = path.join(candidate, "node_modules");
  if (existsSync(target)) return { failure: "The merged code contains a node_modules folder; dependencies must come from a clean install." };
  const unchanged = DEPENDENCY_FILES.every((file) => sameFile(path.join(candidate, file), path.join(checkout, file)));
  if (unchanged && existsSync(source)) {
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    return { linked: target };
  }
  if (unchanged || !existsSync(path.join(candidate, "package.json"))) return {};
  const lock = ["package-lock.json", "npm-shrinkwrap.json"].some((file) => existsSync(path.join(candidate, file)));
  const command = lock ? "npm ci --prefer-offline --no-audit --no-fund" : "npm install --prefer-offline --no-audit --no-fund --no-package-lock";
  const install = await run(command, candidate, { timeoutMs });
  return install.passed ? {} : { failure: `A clean dependency install in the merge candidate failed (${describeRun(install)}).` };
}

const IMPORT_SPECIFIER = /(?:\bimport\s*(?:[^"'`;]*?\bfrom\s*)?|\bexport\s*[^"'`;]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const IMPORT_EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".json"];

/**
 * Files the approved test depends on, in either of the given commits: everything the pinned test
 * files import (relative imports, followed transitively) and files named in package.json scripts
 * or in the test command. A change to any of them can change what the test checks.
 */
export async function testSupportFiles(repoRoot: string, commits: readonly string[], pinned: readonly string[], command: string): Promise<Set<string>> {
  const support = new Set<string>();
  for (const commit of commits) {
    const tracked = new Set(lines((await runGit(repoRoot, ["ls-tree", "-r", "--name-only", commit])).stdout));
    const show = async (file: string) => {
      const result = await runGit(repoRoot, ["cat-file", "blob", `${commit}:${file}`]);
      return result.code === 0 ? result.stdout : "";
    };
    const named = (text: string) => [...text.matchAll(/[^\s"'`;&|<>()]+/g)].map((match) => normalizeTestFile(match[0])).filter((file): file is string => !!file && tracked.has(file));
    for (const file of named(command)) support.add(file);
    try {
      const scripts = (JSON.parse(await show("package.json")) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const value of Object.values(scripts)) if (typeof value === "string") for (const file of named(value)) support.add(file);
    } catch {
      // No package.json, or not valid JSON: nothing to follow.
    }
    const queue = [...pinned];
    const seen = new Set(queue);
    while (queue.length && seen.size < 2000) {
      const file = queue.shift()!;
      for (const match of (await show(file)).matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) continue;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        const target = [...IMPORT_EXTENSIONS.map((ext) => base + ext), ...IMPORT_EXTENSIONS.slice(1).map((ext) => `${base}/index${ext}`)].find((candidate) => tracked.has(candidate));
        if (!target || seen.has(target)) continue;
        seen.add(target);
        support.add(target);
        queue.push(target);
      }
    }
  }
  return support;
}

/** Files whose change can alter what the approved test checks without touching the test itself. */
export function sensitiveChanges(changed: readonly string[], pinned: readonly string[], support: ReadonlySet<string> = new Set()): string[] {
  const pinnedDirs = new Set(pinned.map((file) => path.posix.dirname(file)));
  return changed.filter((file) => {
    const base = path.posix.basename(file);
    if (support.has(file) || DEPENDENCY_FILES.includes(base)) return true;
    // Test setup and teardown files (vitest.setup.mjs, jest-setup.js, global-teardown.ts).
    if (/(^|[._-])(setup|teardown|globalsetup)([._-]|$)/i.test(base)) return true;
    // Tool and build configuration: vitest.config.ts, tsconfig.json, babel, jest, .mocharc and the like.
    if (/(^|\.)config\.[cm]?[jt]s$|^tsconfig.*\.json$|^\.?(babel|jest|mocha|vitest|vite|eslint|prettier)rc/i.test(base)) return true;
    // Test support: helpers, fixtures, mocks and other tests can change what the approved test sees.
    if (/(^|\/)(tests?|__tests__|specs?|fixtures|helpers|support|mocks|__mocks__)\//i.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
    // Anything beside a pinned test file (outside the project root) is treated as one of its helpers.
    const dir = path.posix.dirname(file);
    return dir !== "." && pinnedDirs.has(dir);
  });
}

/**
 * The acceptance-test gate. Stateless: every decision replays ledger.entries().
 * Test outcomes and protocol refusals come back as { ok: false, reason }; malformed input
 * (bad task id, empty command, missing notes) throws GateError; ledger refusals throw LedgerError.
 */
export class TestGate {
  private readonly ledger: LedgerPort;
  private readonly now: () => Date;
  private readonly run: TestRunner;
  private readonly timeoutMs: number;

  constructor(options: TestGateOptions) {
    this.ledger = options.ledger;
    this.now = options.now ?? (() => new Date());
    this.run = options.run ?? runTestCommand;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  state(taskId: string): GateState {
    return deriveState(this.ledger.entries(), taskId);
  }

  define(taskId: string, command: string, actor: Actor, refs: string[] = [], options: DefineOptions = {}): Ok<{ entry: LedgerEntry }> | Refusal {
    parseTaskId(taskId);
    const trimmed = command.trim();
    if (!trimmed) throw new GateError("A done-when test needs a runnable command.");
    if (/[\r\n]/.test(trimmed)) throw new GateError("A done-when test command must be one line.");
    const files = [...new Set((options.files ?? []).map((file) => {
      const clean = normalizeTestFile(file);
      if (!clean) throw new GateError(`"${file}" is not a test file path inside the project.`);
      return clean;
    }))].sort();
    const state = this.state(taskId);
    if (state.done) return { ok: false, reason: `${taskId} is already done.` };
    if (state.reopenedAs) return { ok: false, reason: `${taskId} was reopened as ${state.reopenedAs}; define the test there.` };
    const entry = this.ledger.append({
      type: "test.defined",
      actor,
      subject: taskId,
      summary: oneLine(`Done-when test for ${taskId}: ${trimmed}`),
      reason: state.definition ? `Replaces ${state.definition.n}; any earlier approval no longer applies.` : undefined,
      evidence: [`test:${trimmed}`, ...files.map((file) => `file:${file}`)],
      refs,
      data: { test: trimmed, ...(files.length ? { files } : {}) },
    });
    return { ok: true, entry };
  }

  /**
   * Run the approved test on the current code; it must fail before work starts (spec 6.2).
   * Nothing an agent wrote is run until a person has approved it.
   */
  async confirmFailsFirst(taskId: string, cwd: string): Promise<Ok<RunReport> | (Refusal & Partial<RunReport>)> {
    const state = this.state(taskId);
    if (!state.definition) return { ok: false, reason: `${taskId} has no done-when test yet.` };
    if (state.done || state.reopenedAs) return { ok: false, reason: `${taskId} is ${state.stage}.` };
    if (!state.approval) return { ok: false, reason: `${taskId}'s test must be approved by a person before Perfect Planner runs it.` };
    if (!existsSync(cwd)) return { ok: false, reason: `${cwd} does not exist, so a failure there would prove nothing.` };
    const definition = state.definition;
    const approval = state.approval;
    const commit = await headOf(cwd);
    // The ledger and worker tokens live in .perfect-planner/; keep `git add -A` from ever picking them up.
    if (commit) await ensureRequiredIgnores(cwd);
    const base = {
      actor: GATE_ACTOR,
      subject: taskId,
      evidence: [`test:${definition.command}`, `definition:${definition.n}`, "phase:baseline", ...(commit ? [`commit:${commit}`] : []), `pin:${approval.pin}`],
      data: { test: definition.command, definition: definition.n, phase: "baseline", afterMerge: false, pin: approval.pin, pins: approval.pins, ...(commit ? { commit } : {}) },
    };
    const tampered = await changedTestFiles(cwd, approval.pins);
    if (tampered.length) {
      const entry = this.ledger.append({
        ...base,
        type: "test.failed",
        summary: `${taskId}'s test files differ from the approved ones in ${path.basename(cwd)}; the test was not run`,
        reason: `Changed since approval: ${tampered.join(", ")}`,
        evidence: [...base.evidence, "conclusive:false", ...tampered.map((file) => `tampered:${file}`)],
        data: { ...base.data, conclusive: false, tampered },
      });
      return { ok: false, reason: `The test files differ from the approved ones (${tampered.join(", ")}).`, entry, commit };
    }
    const run = await this.run(definition.command, cwd, { timeoutMs: this.timeoutMs });
    const draft = { ...base, evidence: [...base.evidence, ...runEvidence(run)] };
    if (run.passed) {
      const entry = this.ledger.append({
        ...draft,
        type: "test.passed",
        summary: `Done-when test for ${taskId} already passes before any work`,
        reason: "A test that passes on the current code proves nothing; tighten it, define it again and get it approved.",
      });
      return { ok: false, reason: "The test already passes on the current code, so it cannot prove the task.", entry, run, commit };
    }
    if (!isConclusiveFailure(run)) {
      // Recorded, but as inconclusive: a timeout, crash or missing command says nothing about the code.
      const entry = this.ledger.append({
        ...draft,
        evidence: [...draft.evidence, "conclusive:false"],
        data: { ...draft.data, conclusive: false },
        type: "test.failed",
        summary: `Done-when test for ${taskId} did not run to a result on the current code`,
        reason: failureReason(run),
      });
      return { ok: false, reason: "The test timed out, crashed or could not start, so it has not shown that it fails. Fix the command and run it again.", entry, run, commit };
    }
    const entry = this.ledger.append({ ...draft, type: "test.failed", summary: `Done-when test for ${taskId} fails on the current code, as it should`, reason: failureReason(run) });
    return { ok: true, entry, run, commit };
  }

  /**
   * A person approves the test: the command and the exact content of its test files, read from
   * options.cwd. The test then has to fail on the current code (confirmFailsFirst) before work starts.
   */
  approve(taskId: string, approver: Actor, options: ApproveOptions): Ok<{ entry: LedgerEntry; verdict?: LedgerEntry }> | (Refusal & { verdict?: LedgerEntry }) {
    const state = this.state(taskId);
    if (!state.definition) return { ok: false, reason: `${taskId} has no done-when test to approve.` };
    if (state.done || state.reopenedAs) return { ok: false, reason: `${taskId} is ${state.stage}.` };
    if (state.approval) return { ok: false, reason: `${taskId}'s current test is already approved (${state.approval.n}).` };
    if (approver.kind !== "person") return { ok: false, reason: `Only a person can approve a done-when test, not ${approver.kind} ${approver.id}.` };
    if (!options?.cwd || !existsSync(options.cwd)) return { ok: false, reason: "Approval needs the checkout holding the test files, so their content can be pinned." };
    const definition = state.definition;
    const pins = pinTestFiles(options.cwd, testFilesOf(definition.command, options.cwd, definition.files));
    if (!Object.keys(pins).length) {
      return { ok: false, reason: "No test file could be pinned, so an agent could change the test after approval. Name the test file(s) when defining the test." };
    }
    const unpinned = definition.files.filter((file) => !(file in pins));
    if (unpinned.length) return { ok: false, reason: `These named test files do not exist yet: ${unpinned.join(", ")}.` };
    const pin = pinDigest(pins);
    let verdict: LedgerEntry | undefined;
    const jev = options.jevVerdict;
    if (jev !== undefined) {
      if (!options.jev) throw new GateError("A Jev verdict needs the Jev actor (with its model).");
      verdict = this.recordTestVerdict(taskId, definition, options.jev, jev);
      if (evidenceValue(verdict, "verdict") === "gaps") {
        return { ok: false, reason: `Jev found gaps in the test: ${(verdict.data?.gaps as string[]).join("; ")}`, verdict };
      }
    } else if (state.jev?.verdict === "gaps") {
      return { ok: false, reason: `Jev's open gaps on this test must be resolved first: ${state.jev.gaps.join("; ")}` };
    }
    const entry = this.ledger.append({
      type: "test.approved",
      actor: approver,
      subject: taskId,
      summary: oneLine(`Done-when test for ${taskId} approved: ${definition.command}`),
      evidence: [`test:${definition.command}`, `definition:${definition.n}`, `pin:${pin}`, ...Object.entries(pins).map(([file, hash]) => `pin:${file}=${hash}`), ...(verdict ? [`review:${verdict.n}`] : [])],
      data: { test: definition.command, definition: definition.n, pins, pin },
    });
    return { ok: true, entry, verdict };
  }

  /**
   * Record Jev's review of the current test, before or after the person's approval. Gaps found after
   * approval stop work (canStart, prove, merge) until Jev records "approve" or the test is redefined.
   * Written by the gate, so it signs for any in-process caller: never expose it on an agent route.
   */
  reviewTest(taskId: string, jev: Actor, verdict: "approve" | string[]): Ok<{ entry: LedgerEntry }> | Refusal {
    const state = this.state(taskId);
    if (!state.definition) return { ok: false, reason: `${taskId} has no done-when test to review.` };
    if (state.done || state.reopenedAs) return { ok: false, reason: `${taskId} is ${state.stage}.` };
    if (jev.kind !== "jev") return { ok: false, reason: `Only Jev reviews a test here, not ${jev.kind} ${jev.id}.` };
    return { ok: true, entry: this.recordTestVerdict(taskId, state.definition, jev, verdict) };
  }

  private recordTestVerdict(taskId: string, definition: NonNullable<GateState["definition"]>, jev: Actor, verdict: "approve" | string[]): LedgerEntry {
    if (Array.isArray(verdict)) {
      const gaps = verdict.map((gap) => oneLine(gap)).filter(Boolean);
      if (!gaps.length) throw new GateError('A Jev verdict is "approve" or a non-empty list of gaps.');
      return this.ledger.append({
        type: "review.verdict",
        actor: GATE_ACTOR,
        subject: taskId,
        summary: `Jev found ${gaps.length} gap${gaps.length === 1 ? "" : "s"} in ${taskId}'s done-when test`,
        reason: oneLine(gaps.join("; "), 500),
        evidence: ["scope:test", "verdict:gaps", `definition:${definition.n}`, `reviewer:jev:${jev.id}`, ...gaps.map((gap) => `gap:${gap}`)],
        data: { scope: "test", verdict: "gaps", test: definition.command, definition: definition.n, gaps, reviewer: jev },
      });
    }
    if (verdict !== "approve") throw new GateError('A Jev verdict is "approve" or a list of gaps.');
    return this.ledger.append({
      type: "review.verdict",
      actor: GATE_ACTOR,
      subject: taskId,
      summary: `Jev found no gaps in ${taskId}'s done-when test`,
      evidence: ["scope:test", "verdict:approve", `definition:${definition.n}`, `reviewer:jev:${jev.id}`],
      data: { scope: "test", verdict: "approve", test: definition.command, definition: definition.n, reviewer: jev },
    });
  }

  canStart(taskId: string): { ok: boolean; reason: string } {
    const state = this.state(taskId);
    const refusal = startRefusal(state);
    return refusal ? { ok: false, reason: refusal } : { ok: true, reason: `${taskId}'s test is approved (${state.approval!.n}).` };
  }

  /** Run the approved test in the worker's worktree at its HEAD; the worker's own report is never trusted (spec 5.4). */
  async prove(taskId: string, worktreePath: string): Promise<Ok<RunReport & { commit: string }> | (Refusal & Partial<RunReport> & { output?: string })> {
    const state = this.state(taskId);
    const refusal = startRefusal(state);
    if (refusal) return { ok: false, reason: refusal };
    const definition = state.definition!;
    const commit = await headOf(worktreePath);
    if (!commit) return { ok: false, reason: `${worktreePath} is not a git checkout with a commit.` };
    const status = await runGit(worktreePath, ["status", "--porcelain", "--untracked-files=normal"]);
    if (status.code !== 0) return { ok: false, reason: `git status failed in ${worktreePath}: ${status.stderr.trim()}` };
    const dirty = lines(status.stdout);
    if (dirty.length) return { ok: false, reason: `Commit or remove these changes first; the test only counts against a commit: ${dirty.slice(0, 10).join(", ")}` };
    await ensureRequiredIgnores(worktreePath);
    const leaked = await stagedPrivatePaths(worktreePath);
    if (leaked.length) return { ok: false, reason: privateRefusal(leaked) };
    const approval = state.approval!;
    const base = {
      actor: GATE_ACTOR,
      subject: taskId,
      evidence: [`test:${definition.command}`, `definition:${definition.n}`, "phase:worktree", `commit:${commit}`, `pin:${approval.pin}`],
      data: { test: definition.command, definition: definition.n, phase: "worktree", afterMerge: false, commit, pin: approval.pin },
    };
    const tampered = await changedTestFiles(worktreePath, approval.pins);
    if (tampered.length) {
      const entry = this.ledger.append({
        ...base,
        type: "test.failed",
        summary: `${taskId} changed its approved test at ${commit.slice(0, 12)}; the test was not run`,
        reason: `Changed since approval: ${tampered.join(", ")}`,
        evidence: [...base.evidence, "conclusive:false", ...tampered.map((file) => `tampered:${file}`)],
        data: { ...base.data, conclusive: false, tampered },
      });
      return { ok: false, reason: `The approved test was changed (${tampered.join(", ")}). Restore it, or define a new test and get it approved again.`, entry, commit };
    }
    const run = await this.run(definition.command, worktreePath, { timeoutMs: this.timeoutMs });
    const draft = { ...base, evidence: [...base.evidence, ...runEvidence(run)] };
    if (run.passed) {
      const entry = this.ledger.append({ ...draft, type: "test.passed", summary: `Done-when test for ${taskId} passes in its worktree at ${commit.slice(0, 12)}` });
      return { ok: true, entry, run, commit };
    }
    const entry = this.ledger.append({ ...draft, type: "test.failed", summary: `Done-when test for ${taskId} fails in its worktree at ${commit.slice(0, 12)}`, reason: failureReason(run) });
    return { ok: false, reason: `The test fails in the worktree (${describeRun(run)}).`, entry, run, commit, output: run.outputTail };
  }

  /**
   * Jev or a person approves the diff at a commit (default: the commit the test last passed on in the
   * worktree). mergeAndVerify only merges a branch whose tip has such a verdict (spec 5.5).
   * Signs for any in-process caller: never expose it to agents (MCP or agent routes). See README.
   */
  approveDiff(taskId: string, reviewer: Actor, commit?: string): Ok<{ entry: LedgerEntry }> | Refusal {
    const state = this.state(taskId);
    if (state.done || state.reopenedAs) return { ok: false, reason: `${taskId} is ${state.stage}.` };
    if (reviewer.kind !== "jev" && reviewer.kind !== "person") return { ok: false, reason: `Only Jev or a person can approve a diff, not ${reviewer.kind} ${reviewer.id}.` };
    const reviewed = (commit ?? state.worktree?.commit ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(reviewed)) return { ok: false, reason: "Name the full commit that was reviewed." };
    // A person signs their own approval. Jev's verdict is recorded by the gate (signed by the app), so a
    // process that merely calls itself Jev in the ledger can never approve a diff.
    const entry = this.ledger.append({
      type: "review.verdict",
      actor: reviewer.kind === "person" ? reviewer : GATE_ACTOR,
      subject: taskId,
      summary: `Diff for ${taskId} approved by ${reviewer.kind === "jev" ? "Jev" : reviewer.id} at ${reviewed.slice(0, 12)}`,
      evidence: ["scope:diff", "verdict:approve", `commit:${reviewed}`, `reviewer:${reviewer.kind}:${reviewer.id}`],
      data: { scope: "diff", verdict: "approve", commit: reviewed, reviewer },
    });
    return { ok: true, entry };
  }

  /**
   * A person approves merging the task at a commit (default: the commit whose diff was approved). The
   * entry is theirs and signed with their key; mergeAndVerify only merges a branch whose tip has one.
   * Signs for any in-process caller: never expose it to agents (MCP or agent routes). See README.
   */
  approveMerge(taskId: string, person: Actor, commit?: string): Ok<{ entry: LedgerEntry }> | Refusal {
    const state = this.state(taskId);
    if (state.done || state.reopenedAs) return { ok: false, reason: `${taskId} is ${state.stage}.` };
    if (person.kind !== "person") return { ok: false, reason: `Only a person can approve a merge, not ${person.kind} ${person.id}.` };
    const approved = (commit ?? state.diffApproval?.commit ?? state.worktree?.commit ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(approved)) return { ok: false, reason: "Name the full commit whose merge is approved." };
    const entry = this.ledger.append({
      type: "review.verdict",
      actor: person,
      subject: taskId,
      summary: `Merge of ${taskId} at ${approved.slice(0, 12)} approved by ${person.id}`,
      evidence: ["scope:merge", "verdict:approve", `commit:${approved}`],
      data: { scope: "merge", verdict: "approve", commit: approved },
    });
    if (!isAuthoritative(entry, { personOnly: true })) {
      return { ok: false, reason: `The ledger could not verify ${person.id}'s signature, so this does not approve the merge.` };
    }
    return { ok: true, entry };
  }

  /**
   * Merge the task branch into a throwaway candidate of the integration branch, rerun the test there,
   * and only on a pass move the integration branch forward and write task.done (spec 5.5).
   * The integration branch is never left on an untested commit.
   */
  async mergeAndVerify(
    taskId: string,
    options: MergeOptions,
  ): Promise<Ok<{ mergeCommit: string; entries: LedgerEntry[]; run: TestRunResult }> | (Refusal & { entries: LedgerEntry[]; output?: string; run?: TestRunResult; mergeCommit?: string })> {
    const { repoRoot, branch, integrationBranch, actor, prepare } = options;
    const entries: LedgerEntry[] = [];
    const refuse = (reason: string, extra: { output?: string; run?: TestRunResult; mergeCommit?: string } = {}) => ({ ok: false as const, reason, entries, ...extra });
    const state = this.state(taskId);
    const refusal = startRefusal(state);
    if (refusal) return refuse(refusal);
    const definition = state.definition!;
    const approval = state.approval!;
    const tip = await runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    if (tip.code !== 0) return refuse(`Branch ${branch} does not exist.`);
    const branchTip = tip.stdout.trim();
    if (!(state.worktree?.passed && state.worktree.commit === branchTip && state.passedCommits.includes(branchTip.toLowerCase()))) {
      return refuse(`${branch} is at ${branchTip.slice(0, 12)}, but the test has not passed in the worktree at that commit. Run prove first.`);
    }
    if (state.diffApproval?.commit !== branchTip.toLowerCase()) {
      return refuse(`The diff at ${branchTip.slice(0, 12)} has not been approved by Jev or a person.`);
    }
    const forkPoint = await runGit(repoRoot, ["merge-base", `refs/heads/${integrationBranch}`, branchTip]);
    if (forkPoint.code !== 0) return refuse(`Could not find where ${branch} left ${integrationBranch}, so its changes cannot be checked.`);
    const changed = lines((await runGit(repoRoot, ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", forkPoint.stdout.trim(), branchTip])).stdout);
    await ensureRequiredIgnores(repoRoot);
    // Any commit on the branch, not only its tip: a token committed and later removed is still in history.
    const history = await runGit(repoRoot, ["-c", "core.quotePath=false", "log", "--name-only", "--format=", "--no-renames", `${forkPoint.stdout.trim()}..${branchTip}`, "--", `:(icase)${PRIVATE_DIR}`]);
    if (history.code !== 0) return refuse(`Could not check ${branch}'s commits for ${PRIVATE_DIR}/ files: ${oneLine(history.stderr)}`);
    const leaked = [...new Set(privatePaths([...changed, ...lines(history.stdout)]))];
    if (leaked.length) return refuse(privateRefusal(leaked));
    const support = await testSupportFiles(repoRoot, [forkPoint.stdout.trim(), branchTip], Object.keys(approval.pins), definition.command);
    const sensitive = sensitiveChanges(changed, Object.keys(approval.pins), support);
    if (sensitive.length && !state.diffApproval.byPerson) {
      return refuse(`The diff changes ${sensitive.join(", ")}, which can change what the approved test checks; a person has to approve this diff.`);
    }
    if (actor.kind !== "person") return refuse(`A person approves the merge, not ${actor.kind} ${actor.id}.`);
    // Naming a person is not their approval: the merge needs their own signed entry for this exact tip.
    const mergeApproval = state.mergeApproval;
    if (mergeApproval?.commit !== branchTip.toLowerCase()) {
      return refuse(`The merge has not been approved by a person at ${branchTip.slice(0, 12)}; they approve it with their own signed entry.`);
    }
    if (mergeApproval.actor.id !== actor.id) {
      return refuse(`The merge was approved by ${mergeApproval.actor.id}, not ${actor.id}.`);
    }
    const approver = mergeApproval.actor;
    const base = await runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${integrationBranch}^{commit}`]);
    if (base.code !== 0) return refuse(`Integration branch ${integrationBranch} does not exist.`);
    const oldIntegration = base.stdout.trim();

    const parent = realDir(mkdtempSync(path.join(os.tmpdir(), "pp-gate-")));
    const candidate = path.join(parent, "candidate");
    let added = false;
    let linked: string | undefined;
    try {
      await git(repoRoot, ["worktree", "add", "--detach", candidate, oldIntegration]);
      added = true;
      const proof = (commit: string, run?: TestRunResult) => ({
        actor: GATE_ACTOR,
        subject: taskId,
        evidence: [`test:${definition.command}`, `definition:${definition.n}`, "phase:merge", `commit:${commit}`, `branch:${branch}`, `integration:${integrationBranch}`, `pin:${approval.pin}`, ...(run ? runEvidence(run) : [])],
        data: { test: definition.command, definition: definition.n, phase: "merge", afterMerge: true, commit, pin: approval.pin },
      });
      const merge = await runGit(candidate, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} (${taskId}) into ${integrationBranch}`, branchTip]);
      if (merge.code !== 0) {
        const output = `${merge.stdout}${merge.stderr}`.trim();
        const conflicted = lines((await runGit(candidate, ["diff", "--name-only", "--diff-filter=U"])).stdout);
        const draft = proof(oldIntegration);
        entries.push(
          this.ledger.append({
            ...draft,
            type: "test.failed",
            summary: `${branch} does not merge cleanly into ${integrationBranch}`,
            reason: oneLine(conflicted.length ? `Merge conflict in ${conflicted.join(", ")}` : `git merge failed: ${lastLine(output) || "no output"}`),
            evidence: [...draft.evidence, "merge:conflict", ...conflicted.map((file) => `file:${file}`)],
          }),
        );
        return refuse(`Merge conflict; ${integrationBranch} was left untouched.`, { output });
      }
      const mergeCommit = await git(candidate, ["rev-parse", "HEAD"]);
      const tampered = await changedTestFiles(candidate, approval.pins);
      if (tampered.length) {
        const draft = proof(mergeCommit);
        entries.push(
          this.ledger.append({
            ...draft,
            type: "test.failed",
            summary: `The approved test for ${taskId} is different after merging into ${integrationBranch}; the test was not run`,
            reason: `Changed since approval: ${tampered.join(", ")}`,
            evidence: [...draft.evidence, "conclusive:false", ...tampered.map((file) => `tampered:${file}`)],
            data: { ...draft.data, conclusive: false, tampered },
          }),
        );
        return refuse(`The approved test is different after the merge (${tampered.join(", ")}); ${integrationBranch} was left untouched.`, { mergeCommit });
      }
      // The candidate is a bare checkout; the test usually needs the project's dependencies.
      if (prepare) await prepare(candidate);
      else {
        const deps = await cleanDependencies(repoRoot, integrationBranch, candidate, this.run, this.timeoutMs);
        linked = deps.linked;
        if (deps.failure) return refuse(`${deps.failure} ${integrationBranch} was left untouched.`, { mergeCommit });
      }
      const run = await this.run(definition.command, candidate, { timeoutMs: this.timeoutMs });
      if (!run.passed) {
        entries.push(this.ledger.append({ ...proof(mergeCommit, run), type: "test.failed", summary: `Done-when test for ${taskId} fails after merging into ${integrationBranch}`, reason: failureReason(run) }));
        return refuse(`The test fails after the merge (${describeRun(run)}); ${integrationBranch} was left untouched.`, { output: run.outputTail, run, mergeCommit });
      }

      const advanced = await this.advance(repoRoot, integrationBranch, oldIntegration, mergeCommit, candidate);
      if (!advanced.ok) return refuse(advanced.reason, { run, mergeCommit });

      // From here on, no awaits: the pass, the merge and done land together, so nothing
      // (a commit.observed, say) can slip between the pass and task.done.
      const passed = this.ledger.append({ ...proof(mergeCommit, run), type: "test.passed", summary: `Done-when test for ${taskId} passes after merging into ${integrationBranch}` });
      entries.push(passed);
      entries.push(
        this.ledger.append({
          type: "merge.done",
          actor: approver,
          subject: taskId,
          summary: `Merged ${branch} into ${integrationBranch} at ${mergeCommit.slice(0, 12)}`,
          evidence: [`commit:${mergeCommit}`, `from:${oldIntegration}`, `branch:${branch}`, `branch-tip:${branchTip}`, `integration:${integrationBranch}`],
          data: { commit: mergeCommit, from: oldIntegration, branch, branchTip, integration: integrationBranch },
        }),
      );
      this.assertCanFinish(taskId, mergeCommit);
      entries.push(
        this.ledger.append({
          type: "task.done",
          // Only the gate writes done (see gateRule); the person who approved the merge is named in the entry.
          actor: GATE_ACTOR,
          subject: taskId,
          summary: `${taskId} is done: its approved test passes on ${integrationBranch} at ${mergeCommit.slice(0, 12)}`,
          evidence: [`commit:${mergeCommit}`, `test:${definition.command}`, `definition:${definition.n}`, `proof:${passed.n}`, `pin:${approval.pin}`, `approved-by:${approver.kind}:${approver.id}`, `merge-approval:${mergeApproval.n}`],
          data: { commit: mergeCommit, test: definition.command, pin: approval.pin, approvedBy: approver, mergeApproval: mergeApproval.n },
        }),
      );
      return { ok: true, mergeCommit, entries, run };
    } finally {
      // Drop the link itself first, so removing the candidate can never reach into the real node_modules.
      if (linked) unlinkSync(linked);
      if (added) await runGit(repoRoot, ["worktree", "remove", "--force", candidate]);
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await runGit(repoRoot, ["worktree", "prune"]);
    }
  }

  /** Fast-forward the integration branch from oldSha to nextSha, through its checkout if it has one. */
  private async advance(repoRoot: string, integrationBranch: string, oldSha: string, nextSha: string, candidate: string): Promise<{ ok: true } | Refusal> {
    const list = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    let current: string | undefined;
    let checkout: string | undefined;
    for (const line of lines(list)) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
      else if (line === `branch refs/heads/${integrationBranch}` && current && !samePath(current, candidate)) checkout = current;
    }
    if (!checkout) {
      const update = await runGit(repoRoot, ["update-ref", "-m", "perfect-planner: verified merge", `refs/heads/${integrationBranch}`, nextSha, oldSha]);
      if (update.code !== 0) return { ok: false, reason: `${integrationBranch} moved while the test ran; nothing was changed. ${oneLine(update.stderr)}`.trim() };
      return { ok: true };
    }
    const status = await runGit(checkout, ["status", "--porcelain", "--untracked-files=no"]);
    if (status.code !== 0 || lines(status.stdout).length) {
      return { ok: false, reason: `${integrationBranch} is checked out at ${checkout} with uncommitted changes; commit or stash them, then merge again.` };
    }
    if ((await headOf(checkout)) !== oldSha) return { ok: false, reason: `${integrationBranch} moved while the test ran; nothing was changed.` };
    const ff = await runGit(checkout, ["merge", "--ff-only", "--quiet", nextSha]);
    if (ff.code !== 0) return { ok: false, reason: `Could not fast-forward ${integrationBranch} at ${checkout}: ${oneLine(ff.stderr || ff.stdout)}` };
    return { ok: true };
  }

  /**
   * Jev rejects the diff: record the verdict, reopen the task under its next attempt id, return that id (spec 5.5).
   * Pass `verdict` (the ledger number of a rejection the reviewer already wrote, e.g. core/jev's signed one)
   * to cite it instead of writing another.
   */
  reject(taskId: string, reviewer: Actor, notes: string | string[], options: { verdict?: string } = {}): Ok<{ newTaskId: string; entries: LedgerEntry[] }> | Refusal {
    const list = (Array.isArray(notes) ? notes : [notes]).map((note) => oneLine(note, 500)).filter(Boolean);
    if (!list.length) throw new GateError("A rejection needs notes the worker can act on.");
    const state = this.state(taskId);
    if (state.done) return { ok: false, reason: `${taskId} is already done.` };
    if (state.reopenedAs) return { ok: false, reason: `${taskId} was already reopened as ${state.reopenedAs}.` };
    const newTaskId = nextAttemptId(taskId);
    if (!TASK_ID.test(newTaskId)) return { ok: false, reason: `${taskId} has run out of attempts.` };
    const reason = oneLine(list.join("; "), 500);
    let verdict: LedgerEntry | undefined;
    if (options.verdict !== undefined) {
      verdict = this.ledger.entries().find((entry) => entry.n === options.verdict);
      if (!verdict || verdict.type !== "review.verdict" || verdict.subject !== taskId) throw new GateError(`${options.verdict} is not a review verdict on ${taskId}.`);
      if (evidenceValue(verdict, "scope") !== "diff" || evidenceValue(verdict, "verdict") !== "reject") throw new GateError(`${options.verdict} is not a rejection of ${taskId}'s diff.`);
    }
    const written: LedgerEntry[] = [];
    verdict ??= this.ledger.append({
      type: "review.verdict",
      actor: reviewer,
      subject: taskId,
      summary: `Diff for ${taskId} rejected`,
      reason,
      evidence: ["scope:diff", "verdict:reject", ...(state.worktree?.commit ? [`commit:${state.worktree.commit}`] : []), ...list.map((note) => `note:${note}`)],
      data: { scope: "diff", verdict: "reject", notes: list },
    });
    if (verdict.n !== options.verdict) written.push(verdict);
    const reopened = this.ledger.append({
      type: "task.reopened",
      // The reviewer (often Jev) only gives the verdict; reopening is the gate's own act.
      actor: GATE_ACTOR,
      subject: taskId,
      summary: `${taskId} goes back to the worker as ${newTaskId}`,
      reason,
      evidence: [`attempt:${newTaskId}`, `verdict:${verdict.n}`, `reviewer:${reviewer.kind}:${reviewer.id}`],
      data: { attempt: newTaskId, notes: list, verdict: verdict.n, reviewer },
    });
    written.push(reopened);
    return { ok: true, newTaskId, entries: written };
  }

  /**
   * Spec 2.4, mirrored from the ledger's own check: task.done needs a test.passed of the current
   * approved test at the commit being finished. Throws GateError when not.
   */
  assertCanFinish(taskId: string, headSha: string): void {
    const state = this.state(taskId);
    if (state.done) throw new GateError(`${taskId} is already done (${state.done.n}).`);
    if (state.reopenedAs) throw new GateError(`${taskId} was reopened as ${state.reopenedAs}.`);
    if (!state.approval) throw new GateError(`${taskId} has no approved done-when test.`);
    if (!state.passedCommits.includes(headSha.trim().toLowerCase())) {
      throw new GateError(`${taskId} cannot finish: no test.passed for its approved test at ${headSha.slice(0, 12)}.`);
    }
  }

  /** The gate's clock, for callers that stamp results. */
  timestamp(): string {
    return this.now().toISOString();
  }
}
