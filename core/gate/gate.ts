import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, runGit } from "../worktrees/git";
import { lines, realDir, samePath } from "../worktrees/platform";
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
  definition?: { n: string; command: string; actor: Actor };
  baseline?: TestOutcome;
  /** Latest Jev verdict on the current definition. */
  jev?: { n: string; verdict: "approve" | "gaps"; gaps: string[] };
  approval?: { n: string; actor: Actor };
  /** Latest worktree run of the current definition for this attempt. */
  worktree?: TestOutcome;
  /** Latest post-merge run of the current definition for this attempt. */
  merge?: TestOutcome;
  /** Commits (full sha) this attempt's current test has passed on, outside the baseline. */
  passedCommits: string[];
  merged?: { n: string; commit: string };
  done?: { n: string };
  reopenedAs?: string;
  /** Plain-language stage, for display. */
  stage: "undefined" | "defined" | "baseline-confirmed" | "baseline-passes" | "approved" | "proven" | "done" | "reopened";
  /** Every ledger entry the state was built from, oldest first. */
  history: { n: string; type: string; summary: string }[];
}

export type Refusal = { ok: false; reason: string };
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
  /** Who approved the merge (the person acting on Jev's diff review). Written on merge.done and task.done. */
  actor: Actor;
}

export interface ApproveOptions {
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
    switch (entry.type) {
      case "test.defined": {
        state.definition = { n: entry.n, command: dataString(entry, "test") ?? evidenceValue(entry, "test") ?? "", actor: entry.actor };
        state.baseline = state.jev = state.approval = state.worktree = state.merge = undefined;
        passed.clear();
        break;
      }
      case "test.passed":
      case "test.failed": {
        if (!forCurrent) break;
        const outcome: TestOutcome = { n: entry.n, passed: entry.type === "test.passed", phase: phase ?? "worktree", commit: dataString(entry, "commit") ?? evidenceValue(entry, "commit") };
        // An inconclusive baseline (timeout, crash, missing command) clears any earlier one.
        if (outcome.phase === "baseline") state.baseline = entry.data?.conclusive === false ? undefined : outcome;
        else if (outcome.phase === "worktree") state.worktree = outcome;
        else state.merge = outcome;
        if (outcome.phase !== "baseline" && outcome.passed && outcome.commit) passed.add(outcome.commit.toLowerCase());
        break;
      }
      case "review.verdict": {
        if (evidenceValue(entry, "scope") !== "test" || !forCurrent) break;
        const verdict = evidenceValue(entry, "verdict") === "approve" ? "approve" : "gaps";
        const gaps = entry.evidence.filter((item) => item.startsWith("gap:")).map((item) => item.slice(4));
        state.jev = { n: entry.n, verdict, gaps };
        break;
      }
      case "test.approved": {
        if (forCurrent) state.approval = { n: entry.n, actor: entry.actor };
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
      : state.approval && state.worktree?.passed
        ? "proven"
        : state.approval
          ? "approved"
          : state.baseline?.passed === false
            ? "baseline-confirmed"
            : state.baseline?.passed
              ? "baseline-passes"
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
  if (!state.baseline) return `${id}'s test has not been run on the current code yet.`;
  if (state.baseline.passed) return `${id}'s test already passes on the current code.`;
  if (!state.approval) return `${id}'s test is waiting for the owner's approval.`;
  return null;
}

/**
 * A ledger rule (register with ledger.addRule): task.claimed is refused for a task whose
 * current done-when test is not approved (spec 5.1).
 */
export function gateRule(): (draft: EntryDraft, ledger: LedgerReader) => string | null {
  return (draft, ledger) => {
    if (draft.type !== "task.claimed") return null;
    const subject = draft.subject.trim();
    if (!TASK_ID.test(subject)) return null;
    const refusal = startRefusal(deriveState(ledger.entries(), subject));
    return refusal ? `${subject} cannot be claimed: ${refusal}` : null;
  };
}

async function headOf(cwd: string): Promise<string | undefined> {
  if (!existsSync(cwd)) return undefined;
  const result = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
  return result?.code === 0 ? result.stdout.trim() : undefined;
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

  define(taskId: string, command: string, actor: Actor, refs: string[] = []): Ok<{ entry: LedgerEntry }> | Refusal {
    parseTaskId(taskId);
    const trimmed = command.trim();
    if (!trimmed) throw new GateError("A done-when test needs a runnable command.");
    if (/[\r\n]/.test(trimmed)) throw new GateError("A done-when test command must be one line.");
    const state = this.state(taskId);
    if (state.done) return { ok: false, reason: `${taskId} is already done.` };
    if (state.reopenedAs) return { ok: false, reason: `${taskId} was reopened as ${state.reopenedAs}; define the test there.` };
    const entry = this.ledger.append({
      type: "test.defined",
      actor,
      subject: taskId,
      summary: oneLine(`Done-when test for ${taskId}: ${trimmed}`),
      reason: state.definition ? `Replaces ${state.definition.n}; any earlier approval no longer applies.` : undefined,
      evidence: [`test:${trimmed}`],
      refs,
      data: { test: trimmed },
    });
    return { ok: true, entry };
  }

  /** Run the defined test on the current code; it must fail before work starts (spec 6.2). */
  async confirmFailsFirst(taskId: string, cwd: string): Promise<Ok<RunReport> | (Refusal & Partial<RunReport>)> {
    const state = this.state(taskId);
    if (!state.definition) return { ok: false, reason: `${taskId} has no done-when test yet.` };
    if (state.done || state.reopenedAs) return { ok: false, reason: `${taskId} is ${state.stage}.` };
    if (!existsSync(cwd)) return { ok: false, reason: `${cwd} does not exist, so a failure there would prove nothing.` };
    const definition = state.definition;
    const commit = await headOf(cwd);
    const run = await this.run(definition.command, cwd, { timeoutMs: this.timeoutMs });
    const draft = {
      actor: GATE_ACTOR,
      subject: taskId,
      evidence: [`test:${definition.command}`, `definition:${definition.n}`, "phase:baseline", ...(commit ? [`commit:${commit}`] : []), ...runEvidence(run)],
      data: { test: definition.command, definition: definition.n, phase: "baseline", afterMerge: false, ...(commit ? { commit } : {}) },
    };
    if (run.passed) {
      const entry = this.ledger.append({
        ...draft,
        type: "test.passed",
        summary: `Done-when test for ${taskId} already passes before any work`,
        reason: "A test that passes on the current code proves nothing; tighten it and define it again.",
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

  approve(taskId: string, approver: Actor, options: ApproveOptions = {}): Ok<{ entry: LedgerEntry; verdict?: LedgerEntry }> | (Refusal & { verdict?: LedgerEntry }) {
    const state = this.state(taskId);
    if (!state.definition) return { ok: false, reason: `${taskId} has no done-when test to approve.` };
    if (state.done || state.reopenedAs) return { ok: false, reason: `${taskId} is ${state.stage}.` };
    if (state.approval) return { ok: false, reason: `${taskId}'s current test is already approved (${state.approval.n}).` };
    if (!state.baseline) return { ok: false, reason: "Run the test on the current code first; it has to fail before it can be approved." };
    if (state.baseline.passed) return { ok: false, reason: "The test passes on the current code, so it proves nothing. Define a stricter test." };
    const definition = state.definition;
    let verdict: LedgerEntry | undefined;
    const jev = options.jevVerdict;
    if (jev !== undefined) {
      if (!options.jev) throw new GateError("A Jev verdict needs the Jev actor (with its model).");
      if (Array.isArray(jev)) {
        const gaps = jev.map((gap) => oneLine(gap)).filter(Boolean);
        if (!gaps.length) throw new GateError('A Jev verdict is "approve" or a non-empty list of gaps.');
        verdict = this.ledger.append({
          type: "review.verdict",
          actor: options.jev,
          subject: taskId,
          summary: `Jev found ${gaps.length} gap${gaps.length === 1 ? "" : "s"} in ${taskId}'s done-when test`,
          reason: oneLine(gaps.join("; "), 500),
          evidence: ["scope:test", "verdict:gaps", `definition:${definition.n}`, ...gaps.map((gap) => `gap:${gap}`)],
          data: { scope: "test", verdict: "gaps", test: definition.command, definition: definition.n, gaps },
        });
        return { ok: false, reason: `Jev found gaps in the test: ${gaps.join("; ")}`, verdict };
      }
      if (jev !== "approve") throw new GateError('A Jev verdict is "approve" or a list of gaps.');
      verdict = this.ledger.append({
        type: "review.verdict",
        actor: options.jev,
        subject: taskId,
        summary: `Jev found no gaps in ${taskId}'s done-when test`,
        evidence: ["scope:test", "verdict:approve", `definition:${definition.n}`],
        data: { scope: "test", verdict: "approve", test: definition.command, definition: definition.n },
      });
    } else if (state.jev?.verdict === "gaps") {
      return { ok: false, reason: `Jev's open gaps on this test must be resolved first: ${state.jev.gaps.join("; ")}` };
    }
    const entry = this.ledger.append({
      type: "test.approved",
      actor: approver,
      subject: taskId,
      summary: oneLine(`Done-when test for ${taskId} approved: ${definition.command}`),
      evidence: [`test:${definition.command}`, `definition:${definition.n}`, `baseline:${state.baseline.n}`, ...(verdict ? [`review:${verdict.n}`] : [])],
      data: { test: definition.command, definition: definition.n },
    });
    return { ok: true, entry, verdict };
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
    const run = await this.run(definition.command, worktreePath, { timeoutMs: this.timeoutMs });
    const draft = {
      actor: GATE_ACTOR,
      subject: taskId,
      evidence: [`test:${definition.command}`, `definition:${definition.n}`, "phase:worktree", `commit:${commit}`, ...runEvidence(run)],
      data: { test: definition.command, definition: definition.n, phase: "worktree", afterMerge: false, commit },
    };
    if (run.passed) {
      const entry = this.ledger.append({ ...draft, type: "test.passed", summary: `Done-when test for ${taskId} passes in its worktree at ${commit.slice(0, 12)}` });
      return { ok: true, entry, run, commit };
    }
    const entry = this.ledger.append({ ...draft, type: "test.failed", summary: `Done-when test for ${taskId} fails in its worktree at ${commit.slice(0, 12)}`, reason: failureReason(run) });
    return { ok: false, reason: `The test fails in the worktree (${describeRun(run)}).`, entry, run, commit, output: run.outputTail };
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
    const { repoRoot, branch, integrationBranch, actor } = options;
    const entries: LedgerEntry[] = [];
    const refuse = (reason: string, extra: { output?: string; run?: TestRunResult; mergeCommit?: string } = {}) => ({ ok: false as const, reason, entries, ...extra });
    const state = this.state(taskId);
    const refusal = startRefusal(state);
    if (refusal) return refuse(refusal);
    const definition = state.definition!;
    const tip = await runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    if (tip.code !== 0) return refuse(`Branch ${branch} does not exist.`);
    const branchTip = tip.stdout.trim();
    if (!(state.worktree?.passed && state.worktree.commit === branchTip)) {
      return refuse(`${branch} is at ${branchTip.slice(0, 12)}, but the test has not passed in the worktree at that commit. Run prove first.`);
    }
    const base = await runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${integrationBranch}^{commit}`]);
    if (base.code !== 0) return refuse(`Integration branch ${integrationBranch} does not exist.`);
    const oldIntegration = base.stdout.trim();

    const parent = realDir(mkdtempSync(path.join(os.tmpdir(), "pp-gate-")));
    const candidate = path.join(parent, "candidate");
    let added = false;
    try {
      await git(repoRoot, ["worktree", "add", "--detach", candidate, oldIntegration]);
      added = true;
      const proof = (commit: string, run?: TestRunResult) => ({
        actor: GATE_ACTOR,
        subject: taskId,
        evidence: [`test:${definition.command}`, `definition:${definition.n}`, "phase:merge", `commit:${commit}`, `branch:${branch}`, `integration:${integrationBranch}`, ...(run ? runEvidence(run) : [])],
        data: { test: definition.command, definition: definition.n, phase: "merge", afterMerge: true, commit },
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
          actor,
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
          actor,
          subject: taskId,
          summary: `${taskId} is done: its approved test passes on ${integrationBranch} at ${mergeCommit.slice(0, 12)}`,
          evidence: [`commit:${mergeCommit}`, `test:${definition.command}`, `definition:${definition.n}`, `proof:${passed.n}`],
          data: { commit: mergeCommit, test: definition.command },
        }),
      );
      return { ok: true, mergeCommit, entries, run };
    } finally {
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

  /** Jev rejects the diff: record the verdict, reopen the task under its next attempt id, return that id (spec 5.5). */
  reject(taskId: string, reviewer: Actor, notes: string | string[]): Ok<{ newTaskId: string; entries: LedgerEntry[] }> | Refusal {
    const list = (Array.isArray(notes) ? notes : [notes]).map((note) => oneLine(note, 500)).filter(Boolean);
    if (!list.length) throw new GateError("A rejection needs notes the worker can act on.");
    const state = this.state(taskId);
    if (state.done) return { ok: false, reason: `${taskId} is already done.` };
    if (state.reopenedAs) return { ok: false, reason: `${taskId} was already reopened as ${state.reopenedAs}.` };
    const newTaskId = nextAttemptId(taskId);
    if (!TASK_ID.test(newTaskId)) return { ok: false, reason: `${taskId} has run out of attempts.` };
    const reason = oneLine(list.join("; "), 500);
    const verdict = this.ledger.append({
      type: "review.verdict",
      actor: reviewer,
      subject: taskId,
      summary: `Diff for ${taskId} rejected`,
      reason,
      evidence: ["scope:diff", "verdict:reject", ...(state.worktree?.commit ? [`commit:${state.worktree.commit}`] : []), ...list.map((note) => `note:${note}`)],
      data: { scope: "diff", verdict: "reject", notes: list },
    });
    const reopened = this.ledger.append({
      type: "task.reopened",
      actor: reviewer,
      subject: taskId,
      summary: `${taskId} goes back to the worker as ${newTaskId}`,
      reason,
      evidence: [`attempt:${newTaskId}`, `verdict:${verdict.n}`],
      data: { attempt: newTaskId, notes: list },
    });
    return { ok: true, newTaskId, entries: [verdict, reopened] };
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
