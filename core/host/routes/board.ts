// One board for the whole coding workflow, across every plan in the active project.
// It is a read-only fold over the ledger the host already holds: nothing here starts a
// worker, claims a file or writes an entry.
//
// The board exists because progress was split across plan pages: a task's stage lived
// on the plan that created it, failures lived in the screen that happened to run the
// check, and shipping lived in the bottom dock. This route puts the same authoritative
// facts in one place and derives, without inventing anything, what needs a person.
//
// Other projects on the computer are listed with their recorded counts only. Their
// ledgers are not re-opened here: a second writer lock or a signature re-check is not
// something a board should cause. "Open that project" is the honest next step.
import fs from "node:fs";
import path from "node:path";
import { costView, readPrices, type CostView } from "../../cost/index";
import { deriveState } from "../../gate/index";
import { FileStore, isAuthoritative, verifyChain, type LedgerEntry } from "../../ledger/index";
import { attemptLabel, foldBoard, unmetDependencies, waitingMessage, type TaskStatus, type TaskView } from "../../mcp/index";
import { replayRoster } from "../../people/index";
import { PRIVATE_DIR } from "../../worktrees/index";
import { recordedWorkerDispatch, recordedWorkerReport, stageOf, taskSettings, type TaskStage } from "./tasks";
import type { Router } from "../router";

/** How long a claimed task may go without a reported sign of life before it is called stalled. */
export const STALL_MS = 15 * 60 * 1000;
/** A worker-reported activity younger than this is shown as working; older is quiet, then stalled. */
export const FRESH_MS = 10 * 60 * 1000;

export type BoardColumnId = "needs-test" | "ready" | "building" | "review" | "ship" | "blocked" | "done";

export const BOARD_COLUMNS: ReadonlyArray<{ id: BoardColumnId; label: string; hint: string }> = Object.freeze([
  { id: "needs-test", label: "Needs a test", hint: "Write the done-when test, then approve it" },
  { id: "ready", label: "Ready", hint: "Can start as soon as a worker slot is free" },
  { id: "building", label: "Building", hint: "A worker holds this task" },
  { id: "review", label: "Review", hint: "Check the diff and the proof" },
  { id: "ship", label: "Ready to ship", hint: "Approved; merge it when you mean to" },
  { id: "blocked", label: "Blocked", hint: "Needs a decision, a dependency or a handover" },
  { id: "done", label: "Shipped", hint: "Merged and recorded on the ledger" },
]);

export type BoardHealth = "working" | "finished" | "quiet" | "stalled" | "failed" | "blocked" | "review" | "ship" | "ready" | "done" | "idle";

export interface BoardAttention {
  code: string;
  /** "stop" is a hard stop, "risk" needs a person soon, "info" is context. */
  level: "stop" | "risk" | "info";
  message: string;
  /** What the person can do next, in plain words. */
  action: string;
}

export interface BoardUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  unpricedTokens: number;
}

export interface BoardTask {
  project: string;
  projectLabel: string;
  id: string;
  label: string;
  title: string;
  column: BoardColumnId;
  stage: TaskStage;
  status: TaskStatus;
  attempt: number;
  phase: string | null;
  owner: string | null;
  assignee: string | null;
  model: string | null;
  requestedModel: string | null;
  reportedModel: string | null;
  modelConflict: boolean;
  health: BoardHealth;
  healthLabel: string;
  createdAt: string | null;
  updatedAt: string | null;
  ageMs: number | null;
  progress: { text: string; at: string } | null;
  progressAgeMs: number | null;
  activity: "working" | "waiting" | "finished" | null;
  proofs: number;
  check: { passed: boolean; commit?: string } | null;
  test: string | null;
  merged: boolean;
  branch: string | null;
  worktree: string | null;
  claims: string[];
  staleClaims: string | null;
  dependsOn: string[];
  waitingFor: string | null;
  attention: BoardAttention[];
  usage: BoardUsage;
}

export interface BoardProject {
  key: string;
  label: string;
  /** The project this board is showing in full. */
  active: boolean;
  readable: boolean;
  reason?: string;
  /** Recorded task.created lines (and done lines for the others). Not a signature re-check. */
  tasks: number;
  done: number;
}

export interface BoardView {
  generatedAt: string;
  project: string;
  projects: BoardProject[];
  columns: typeof BOARD_COLUMNS;
  tasks: BoardTask[];
  totals: {
    tasks: number;
    working: number;
    needsYou: number;
    blocked: number;
    ship: number;
    done: number;
    failed: number;
    stalled: number;
    attention: number;
  };
  attention: Array<BoardAttention & { task: string; project: string; title: string }>;
  plan: { approved: boolean; latest: string | null; at: string | null; count: number; entry: string | null };
  budget: { tokenBudget: number | null; tokensSpent: number; state: "uncapped" | "ok" | "reached" };
  guards: {
    containment: "contained" | "not-contained";
    prePush: string;
    secretScan: "installed" | "not-installed" | "opted-out" | "unknown";
    malware: "not-assessed";
    dependencyAudit: "not-run";
    ledger: { ok: boolean; entries: number; firstBad?: string };
  };
}

interface TaskFacts {
  check: { passed: boolean; commit?: string } | null;
  requestedModel: string | null;
  reportedModel: string | null;
  branch: string | null;
  worktree: string | null;
}

function projectLabel(folder: string, key: string): string {
  try {
    const repo = JSON.parse(fs.readFileSync(path.join(folder, PRIVATE_DIR, "repo.json"), "utf8")) as { root?: unknown };
    if (typeof repo.root === "string" && repo.root) return path.basename(repo.root);
  } catch {
    // No repo chosen yet: the project key is the honest name.
  }
  return key;
}

/** A read-only count for a project this board is not showing: recorded lines, not re-verified signatures. */
function recordedCounts(folder: string): { tasks: number; done: number; chainOk: boolean; reason?: string } {
  try {
    const loaded = new FileStore(folder).load();
    const chain = verifyChain(loaded.entries);
    return {
      tasks: loaded.entries.filter((entry) => entry.type === "task.created").length,
      done: loaded.entries.filter((entry) => entry.type === "task.done").length,
      chainOk: chain.ok,
      ...(loaded.parseError ? { reason: `The ledger could not be read past ${loaded.parseError.n}.` } : chain.ok ? {} : { reason: "The ledger fails its tamper check." }),
    };
  } catch (error) {
    return { tasks: 0, done: 0, chainOk: false, reason: error instanceof Error ? error.message : "The ledger could not be read." };
  }
}

function latestPlan(entries: readonly LedgerEntry[]): { approved: boolean; latest: string | null; at: string | null; count: number; entry: string | null } {
  const approvals = entries.filter((entry) => entry.type === "plan.approved" && isAuthoritative(entry, { personOnly: true }));
  const last = approvals[approvals.length - 1];
  return { approved: Boolean(last), latest: last?.subject ?? null, at: last?.at ?? null, count: approvals.length, entry: last?.n ?? null };
}

function createdEntry(entries: readonly LedgerEntry[], id: string): LedgerEntry | undefined {
  return entries.find((entry) => entry.type === "task.created" && entry.subject === id);
}

function phaseOf(entry: LedgerEntry | undefined): string | null {
  const phase = entry?.data?.phase;
  return typeof phase === "string" ? phase : null;
}

/** The branch and folder a worktree receipt recorded for this task, if one exists. */
function worktreeOf(entries: readonly LedgerEntry[], id: string, label: string): { branch: string | null; path: string | null } {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "worktree.created") continue;
    if (entry.subject !== id && entry.subject !== label) continue;
    const branch = entry.data?.branch;
    const path = entry.data?.path;
    return { branch: typeof branch === "string" ? branch : null, path: typeof path === "string" ? path : null };
  }
  return { branch: null, path: null };
}

function columnFor(task: TaskView, stage: TaskStage): BoardColumnId {
  if (task.status === "done" || stage === "done") return "done";
  if (task.status === "blocked" || stage === "reopened" || stage === "jev-found-gaps") return "blocked";
  if (stage === "needs-test" || stage === "test-proposed") return "needs-test";
  if (stage === "building") return "building";
  if (stage === "review-diff") return "review";
  if (stage === "ready-to-merge") return "ship";
  return "ready";
}

function healthFor(task: TaskView, column: BoardColumnId, now: number, facts: TaskFacts, agentLive: boolean | null): { health: BoardHealth; label: string } {
  if (column === "done") return { health: "done", label: "Shipped" };
  if (facts.check?.passed === false) return { health: "failed", label: "Test failed" };
  if (column === "blocked") return { health: "blocked", label: "Blocked" };
  if (column === "ship") return { health: "ship", label: "Approved, waiting to merge" };
  if (column === "review") return { health: "review", label: "Waiting for your review" };
  if (task.status !== "claimed") {
    // A task that already has a worktree or a progress record is not untouched: it came back
    // from a worker. Saying "not started" here would contradict the Tasks screen.
    if (facts.worktree || task.lastProgress) return { health: "ready", label: "Ready to claim" };
    return { health: "idle", label: "Not started" };
  }
  // A fresh report from a worker that is no longer checked in is still a dropped worker:
  // the report may predate the disconnect by seconds, and the token is already dead.
  if (agentLive === false) return { health: "stalled", label: "Worker not checked in" };
  const activityAt = Date.parse(String(task.workerActivity?.at ?? ""));
  const progressAt = Date.parse(String(task.lastProgressAt ?? ""));
  const activityFresh = Number.isFinite(activityAt) && now - activityAt < FRESH_MS;
  const progressFresh = Number.isFinite(progressAt) && now - progressAt < FRESH_MS;
  if (task.workerActivity?.activity === "working" && activityFresh) return { health: "working", label: "Working" };
  if (task.workerActivity?.activity === "finished" && activityFresh) return { health: "finished", label: "Finished, awaiting your check" };
  if (progressFresh) return { health: "quiet", label: "Quiet, last sign of life within 10 minutes" };
  if ((Number.isFinite(progressAt) && now - progressAt >= STALL_MS) || (Number.isFinite(activityAt) && now - activityAt >= STALL_MS)) {
    return { health: "stalled", label: "Stalled: no sign of life for 15 minutes" };
  }
  if (!Number.isFinite(progressAt) && !Number.isFinite(activityAt)) return { health: "stalled", label: "Claimed, but no progress was ever reported" };
  return { health: "quiet", label: "Quiet" };
}

function usageFor(cost: CostView, id: string): BoardUsage {
  const row = cost.byTask.find((item) => item.key === id);
  if (!row) return { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, unpricedTokens: 0 };
  return {
    calls: row.calls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    usd: Math.round(row.usd * 1e4) / 1e4,
    unpricedTokens: row.unpricedTokens,
  };
}

function attentionFor(options: {
  task: TaskView;
  stage: TaskStage;
  health: BoardHealth;
  now: number;
  planEntry: string | null;
  createdEntry: string | null;
  agentLive: boolean | null;
  facts: TaskFacts;
}): BoardAttention[] {
  const { task, stage, health, now, planEntry, createdEntry, agentLive, facts } = options;
  const out: BoardAttention[] = [];
  if (facts.check?.passed === false) {
    out.push({ code: "test-failed", level: "stop", message: `${task.id}'s approved test failed on the last run.`, action: "Read the failure, fix the cause, then run the check again." });
  }
  if (task.status === "blocked") {
    out.push({ code: "blocked", level: "risk", message: `${task.id} is blocked.`, action: "Open the task, answer what blocks it, then release the claim or send it back." });
  }
  if (stage === "reopened") {
    out.push({ code: "reopened", level: "risk", message: `${task.id} was sent back for another attempt.`, action: "Dispatch the next attempt; the previous worktree and claims are kept." });
  }
  if (health === "stalled") {
    out.push({ code: "stalled", level: "stop", message: `${task.id} has had no worker sign of life for 15 minutes.`, action: "Release the claim, then hand the task over or dispatch a new worker. The worktree is kept." });
  }
  if (agentLive === false && task.status === "claimed") {
    out.push({ code: "disconnected", level: "risk", message: `${task.id}'s worker is not checked in any more.`, action: "A restart ends every connection. Release the claim and dispatch again; the work is kept." });
  }
  if (facts.requestedModel && facts.reportedModel && facts.requestedModel !== facts.reportedModel) {
    out.push({ code: "model-conflict", level: "risk", message: `${task.id} asked for ${facts.requestedModel}, but the worker reported ${facts.reportedModel}.`, action: "Check which model actually worked before accepting the result." });
  }
  if (planEntry && createdEntry && planEntry > createdEntry && task.status !== "done") {
    out.push({ code: "plan-changed", level: "risk", message: `The plan was approved after ${task.id} was created.`, action: "Re-read the plan and confirm this task still says what the plan now asks for." });
  }
  if (task.lastProgressAt && Number.isFinite(Date.parse(task.lastProgressAt)) && now - Date.parse(task.lastProgressAt) > 24 * 60 * 60 * 1000 && task.status === "claimed") {
    out.push({ code: "stale-day", level: "risk", message: `${task.id} has not reported progress for more than a day.`, action: "Release the claim and decide whether to continue or hand it over." });
  }
  return out;
}

export function boardView(options: {
  activeKey: string;
  activeLabel: string;
  activeRoot: string;
  activeEntries: readonly LedgerEntry[];
  otherFolders?: Array<{ key: string; folder: string }>;
  now?: number;
  agents?: Array<{ id: string }>;
  tokenBudget?: number | null;
  guards?: Partial<BoardView["guards"]>;
}): BoardView {
  const now = options.now ?? Date.now();
  const entries = options.activeEntries;
  const board = foldBoard(entries);
  const roster = replayRoster(entries);
  const plan = latestPlan(entries);
  const cost = costView(entries, board, readPrices(options.activeRoot));
  const tasks: BoardTask[] = [];
  let tokensSpent = 0;
  let working = 0; let blocked = 0; let ship = 0; let done = 0;

  for (const task of board.values()) {
    const attempt = attemptLabel(task);
    const gate = deriveState(entries, attempt);
    const stage = stageOf(task, gate);
    const column = columnFor(task, stage);
    const dispatch = recordedWorkerDispatch(entries, attempt);
    const report = recordedWorkerReport(entries, attempt, task.owner);
    const tree = worktreeOf(entries, task.id, attempt);
    const facts: TaskFacts = {
      check: gate.worktree ? { passed: gate.worktree.passed, ...(gate.worktree.commit ? { commit: gate.worktree.commit } : {}) } : null,
      requestedModel: dispatch?.requestedModel ?? null,
      reportedModel: report?.reportedModel ?? null,
      branch: tree.branch,
      worktree: tree.path,
    };
    const health = healthFor(task, column, now, facts, task.owner ? Boolean(options.agents?.find((item) => item.id === task.owner)) : null);
    const created = createdEntry(entries, task.id);
    const createdAt = created?.at ?? null;
    const usage = usageFor(cost, task.id);
    tokensSpent += usage.inputTokens + usage.outputTokens;
    const unmet = unmetDependencies(board, task);
    if (column === "building" && health.health === "working") working += 1;
    if (column === "blocked") blocked += 1;
    if (column === "ship") ship += 1;
    if (column === "done") done += 1;
    tasks.push({
      project: options.activeKey,
      projectLabel: options.activeLabel,
      id: task.id,
      label: attempt,
      title: task.title,
      column,
      stage,
      status: task.status,
      attempt: task.attempt,
      phase: phaseOf(created),
      owner: task.owner,
      assignee: roster.assignments.get(task.id) ?? null,
      model: facts.reportedModel ?? facts.requestedModel,
      requestedModel: facts.requestedModel,
      reportedModel: facts.reportedModel,
      modelConflict: Boolean(facts.requestedModel && facts.reportedModel && facts.requestedModel !== facts.reportedModel),
      health: health.health,
      healthLabel: health.label,
      createdAt,
      updatedAt: task.lastProgressAt ?? null,
      ageMs: createdAt ? Math.max(0, now - Date.parse(createdAt)) : null,
      progress: task.lastProgress ? { text: task.lastProgress, at: task.lastProgressAt ?? "" } : null,
      progressAgeMs: task.lastProgressAt ? Math.max(0, now - Date.parse(task.lastProgressAt)) : null,
      activity: task.workerActivity?.activity ?? null,
      proofs: task.proofs.length,
      check: facts.check,
      test: gate.definition?.command ?? null,
      merged: Boolean(gate.merged),
      branch: facts.branch,
      worktree: facts.worktree,
      claims: [],
      staleClaims: null,
      dependsOn: [...task.dependsOn],
      waitingFor: unmet.length ? waitingMessage(attempt, unmet) : null,
      attention: attentionFor({
        task, stage, health: health.health, now, planEntry: plan.entry, createdEntry: created?.n ?? null,
        agentLive: task.owner ? Boolean(options.agents?.find((item) => item.id === task.owner)) : null,
        facts,
      }),
      usage,
    });
  }

  const attention = tasks.flatMap((task) => task.attention.map((item) => ({ ...item, task: task.label, project: task.project, title: task.title })));
  const budget = options.tokenBudget ?? null;
  if (budget != null && tokensSpent >= budget) {
    attention.push({
      code: "token-budget",
      level: "stop",
      message: `The token budget is spent (${tokensSpent.toLocaleString()} of ${budget.toLocaleString()} reported tokens).`,
      action: "Raise the cap below or hand the remaining work over; new workers will not start.",
      task: "project",
      project: options.activeKey,
      title: "Token budget",
    });
  }
  const others = (options.otherFolders ?? []).map(({ key, folder }) => {
    const counts = recordedCounts(folder);
    return {
      key,
      label: projectLabel(folder, key),
      active: false,
      readable: counts.chainOk,
      ...(counts.reason ? { reason: counts.reason } : {}),
      tasks: counts.tasks,
      done: counts.done,
    } satisfies BoardProject;
  });
  return {
    generatedAt: new Date(now).toISOString(),
    project: options.activeKey,
    projects: [{ key: options.activeKey, label: options.activeLabel, active: true, readable: true, tasks: board.size, done }, ...others],
    columns: BOARD_COLUMNS,
    tasks,
    totals: {
      tasks: tasks.length,
      working,
      needsYou: tasks.filter((task) => task.column === "review" || task.column === "ship").length,
      blocked,
      ship,
      done,
      failed: tasks.filter((task) => task.check?.passed === false).length,
      stalled: tasks.filter((task) => task.health === "stalled").length,
      attention: attention.length,
    },
    attention: attention.sort((left, right) => {
      const rank = { stop: 0, risk: 1, info: 2 } as const;
      return rank[left.level] - rank[right.level];
    }),
    plan,
    budget: { tokenBudget: budget, tokensSpent, state: budget == null ? "uncapped" : tokensSpent >= budget ? "reached" : "ok" },
    guards: {
      containment: "not-contained",
      prePush: "unknown",
      secretScan: "unknown",
      malware: "not-assessed",
      dependencyAudit: "not-run",
      ledger: { ok: true, entries: entries.length },
      ...options.guards,
    },
  };
}

export function registerBoardRoutes(router: Router): void {
  /** GET /board: every plan's tasks in one workflow board for this project. */
  router.get("/board", ({ project, host }) => {
    const agents = project.service.liveAgents().map((agent) => ({ id: agent.id }));
    const protection = protectionFor(project);
    const settings = taskSettings(project);
    return boardView({
      activeKey: project.key,
      activeLabel: projectLabel(project.root, project.key),
      activeRoot: project.root,
      activeEntries: project.entries(),
      otherFolders: host.boardFolders(project.key).filter((folder) => folder.key !== project.key),
      agents,
      tokenBudget: settings.tokenBudget,
      guards: {
        prePush: protection?.prePush.state ?? "unknown",
        secretScan: protection?.prePush.state === "installed" ? "installed" : protection?.prePush.state === "opted-out" ? "opted-out" : protection ? "not-installed" : "unknown",
      },
    });
  });
}

/**
 * The shipping protection report, without making a board read wait for Git. The first read
 * starts the check and says "unknown"; a later poll shows the real state. A board that blocked
 * on installing hooks would take seconds to paint and would look broken.
 */
const protections = new WeakMap<object, { report?: { prePush: { state: string } }; pending: boolean }>();
function protectionFor(project: object & { protection: Promise<{ prePush: { state: string } }> }): { prePush: { state: string } } | null {
  const known = protections.get(project);
  if (known?.report) return known.report;
  if (!known?.pending) {
    protections.set(project, { pending: true });
    project.protection.then(
      (report) => protections.set(project, { report, pending: false }),
      () => protections.set(project, { pending: false }),
    );
  }
  return null;
}

/** Every project with a ledger on this computer, for the board's "other projects" line. */
export function boardFolders(root: string): Array<{ key: string; folder: string }> {
  const projects = path.join(root, "projects");
  let names: string[];
  try { names = fs.readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
  return names
    .filter((name) => fs.existsSync(path.join(projects, name, PRIVATE_DIR, "ledger")))
    .sort()
    .map((name) => ({ key: name, folder: path.join(projects, name) }));
}
