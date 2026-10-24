// Tasks screen (spec §4.1, §5): the person runs the core loop from the app.
// Dispatch a worker on a task (a worktree, a worker token for that task only,
// the brief and the command to paste), approve its test (then the gate runs it
// and it must fail first), check the work (the gate runs the approved test in
// the worktree), approve the diff, and merge (the gate reruns the test on the
// merge before it moves the branch and writes task.done).
//
// Every POST here is a person action: the host only routes it with the person
// cookie the app window holds, so a person's signed entry can only come from
// this screen. Agents never reach these routes; they use the MCP tools.
import fs from "node:fs";
import path from "node:path";
import { deriveState, sensitiveChanges, testSupportFiles, type GateState } from "../../gate/index";
import type { Actor } from "../../ledger/index";
import type { AgentKind } from "../agentKinds";
import { attemptLabel, unmetDependencies, waitingMessage, type TaskView } from "../../mcp/index";
import { WorktreeError, WorktreeManager, git, refreshCarriedSettings, runGit, WORKTREES_ACTOR, type WorktreeInfo } from "../../worktrees/index";
import type { CoreHost } from "../host";
import type { CoreProject } from "../project";
import { HttpError, type Router } from "../router";
import { AGENT_SERVER_NAME, agentEntryPath, connectLine, nodeBinary, quoteFor, tokenFilePath, writeTokenFile } from "./agents";

export { quoteFor };
import { localPerson, localPersonId } from "./people";
import { PRIMARY_REPO, readRepos } from "../../repos/index";
import { replayRoster } from "../../people/index";
import { protectRepository } from "../project";
import { chosenRepoRoot, repoRefusal } from "../protectedRoots";
import { syncJevPolicy } from "./decisions";
import { jevActor, jevApprovedDiff, jevView, reviewDiffWithJev, reviewTestWithJev, sendBackNotes, type JevLine } from "./jev-review";
import { repoClaimRefusal } from "../repoClaim";
import { isNetworkPath } from "../tokenFile";

// Kept here too for older imports; they live in ../protectedRoots so connect.mjs can use them without the routes.
export { chosenRepoRoot, repoRefusal };

const REPO_FILE = "repo.json";
const MANAGER = "tasks.worktrees";
const MANAGERS = "tasks.worktrees.all";
const GROUP_MERGES = "tasks.groupMerges";
const DISPATCHES = "tasks.dispatches";
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const MAX_DIFF = 200_000;

/** Where a task stands, in the order a person drives it. */
export type TaskStage =
  | "needs-test"
  | "test-proposed"
  | "test-approved"
  | "test-passes-already"
  /** A Jev key is saved and Jev has not approved the test yet (not asked, no answer, or not sure). */
  | "waiting-for-jev"
  | "jev-found-gaps"
  | "ready-to-claim"
  | "building"
  | "review-diff"
  | "ready-to-merge"
  | "reopened"
  | "done";

interface Dispatch {
  task: string;
  model?: string;
  issuedAt: string;
  /** In memory only, so a new dispatch can revoke the previous worker's token. */
  token: string;
}

export interface RepoState {
  /** The repo's name in this project: "main" for the first one. */
  name: string;
  ok: boolean;
  root?: string;
  reason?: string;
  /** The folder the person already imported (this project's own folder), offered as the starting answer. */
  suggested?: string;
}

// ---------- the repository the worktrees branch from ----------

function repoFile(project: CoreProject): string {
  return path.join(project.root, ".perfect-planner", REPO_FILE);
}

export async function gitTop(dir: string): Promise<string | null> {
  // A network path (\\host\share, //host/share) is never a project's git folder, and even looking at it makes Windows
  // talk to that machine (and offer this user's credentials). Refused before anything touches it.
  if (isNetworkPath(dir)) return null;
  if (!fs.existsSync(dir)) return null;
  const top = await runGit(dir, ["rev-parse", "--show-toplevel"]).catch(() => null);
  if (!top || top.code !== 0) return null;
  const head = await runGit(dir, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => null);
  if (!head || head.code !== 0) return null;
  return fs.realpathSync(top.stdout.trim());
}

/** The git folder of a repo of this project: the person's chosen one (else the project folder) for "main", the registered folder for the others. */
export async function repoState(project: CoreProject, name: string | null = null): Promise<RepoState> {
  const repoName = name ?? PRIMARY_REPO;
  const extra = repoName === PRIMARY_REPO ? undefined : readRepos(project.root).repos.find((repo) => repo.name === repoName);
  if (repoName !== PRIMARY_REPO && !extra) {
    return { name: repoName, ok: false, reason: `This project has no repo named "${repoName.slice(0, 40)}". Add it in Tasks, or send the task back to the plan.` };
  }
  let chosen: string | undefined = extra?.root;
  if (!extra) {
    try {
      chosen = (JSON.parse(fs.readFileSync(repoFile(project), "utf8")) as { root?: unknown }).root as string | undefined;
    } catch {
      chosen = undefined;
    }
  }
  const candidate = typeof chosen === "string" && chosen ? chosen : project.root;
  const top = await gitTop(candidate);
  // git found the repo by walking up from the folder: a whole drive or the home folder (a dotfiles repo)
  // is never the project's repo, so it is neither used nor protected.
  const refusal = top ? repoRefusal(top) : null;
  if (top && !refusal) {
    // One git folder, one project: another project's worktrees must never be handed to this one (core/host/repoClaim.ts).
    const taken = await repoClaimRefusal(project, top, { write: false });
    return taken ? { name: repoName, ok: false, reason: taken } : { name: repoName, ok: true, root: top };
  }
  // The host's own folder for this project (<app data>/projects/<key>) is never a suggestion: the person's
  // imported folder is offered by the screen instead.
  const ownData = path.basename(path.dirname(project.root)) === "projects";
  const suggested = extra || ownData || repoRefusal(project.root) ? undefined : project.root;
  if (refusal) return { name: repoName, ok: false, reason: refusal, suggested };
  return {
    name: repoName,
    ok: false,
    suggested,
    reason: extra
      ? `The folder of repo "${repoName}" (${extra.root}) is no longer a git repository with a commit. Tasks in the other repos are not affected.`
      : chosen
        ? `${chosen} is no longer a git repository with a commit. Choose your project's git folder again.`
        : "Workers need your project's git folder (with at least one commit) to branch from. Choose it below.",
  };
}

/**
 * One merge at a time per git folder. A merge fast-forwards the folder's checked-out branch (index, files, then the
 * ref), so two at once could interleave and leave staged files behind that make every later merge say "uncommitted
 * changes". Merges for different folders still run side by side.
 */
const mergeQueues = new Map<string, Promise<unknown>>();
async function oneMergeAtATime<T>(root: string, run: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const before = mergeQueues.get(key) ?? Promise.resolve();
  const turn = before.then(run, run);
  const settled = turn.then(() => undefined, () => undefined);
  mergeQueues.set(key, settled);
  try {
    return await turn;
  } finally {
    if (mergeQueues.get(key) === settled) mergeQueues.delete(key);
  }
}

async function requireRepo(project: CoreProject, name: string | null = null): Promise<string> {
  const repo = await repoState(project, name);
  if (!repo.ok || !repo.root) throw new HttpError(409, repo.name === PRIMARY_REPO ? "NO_REPO" : "REPO_MISSING", repo.reason ?? "Choose your project's git folder first.");
  const taken = await repoClaimRefusal(project, repo.root, { write: true });
  if (taken) throw new HttpError(409, "REPO_IN_USE", taken);
  project.protectRoots([repo.root]);
  return repo.root;
}

/** Parallel worktrees per project: 10 unless PP_MAX_PARALLEL says otherwise. */
function parallelCap(): number {
  const wanted = Number(process.env.PP_MAX_PARALLEL);
  return Number.isInteger(wanted) && wanted >= 1 && wanted <= 50 ? wanted : 10;
}

/** The repo a task belongs to, from its signed task.created (null: the project's first repo). */
function repoOfLabel(project: CoreProject, label: string): string | null {
  return project.service.board().get(label.replace(/\.a\d+$/, ""))?.repo ?? null;
}

function manager(project: CoreProject, root: string, name: string | null = null): WorktreeManager {
  const real = fs.realpathSync(root);
  let all = project.state.get(MANAGERS) as Map<string, WorktreeManager> | undefined;
  if (!all) {
    all = new Map();
    project.state.set(MANAGERS, all);
  }
  let current = all.get(real);
  if (!current) {
    current = new WorktreeManager({ repoRoot: root, ledger: project.ledger, maxParallel: parallelCap() });
    all.set(real, current);
    project.protectRoots([current.repoRoot, current.worktreeRoot]);
  }
  // The first repo's manager stays where older readers (the connect roots, tests) look for it.
  if (!name || name === PRIMARY_REPO) project.state.set(MANAGER, current);
  return current;
}

function dispatches(project: CoreProject): Map<string, Dispatch> {
  let map = project.state.get(DISPATCHES) as Map<string, Dispatch> | undefined;
  if (!map) {
    map = new Map();
    project.state.set(DISPATCHES, map);
  }
  return map;
}

/** The worktrees the git watcher should read, or the plain reason it cannot see any. Errors are not swallowed: an unreadable list is not an empty one. */
export async function worktreesForWatcher(project: CoreProject): Promise<{ repo: RepoState; list: WorktreeInfo[] }> {
  const { repos, worktrees } = await allRepos(project);
  const repo = repos[0]!;
  // A done task's folder is about to be removed (or waits for its clean-up): a git process of ours inside it would keep Windows from removing it.
  const board = project.service.board();
  return { repo, list: worktrees.filter((tree) => board.get(tree.taskId.replace(/\.a\d+$/, ""))?.status !== "done") };
}

/**
 * Why the file claims a worktree holds are stale (nobody is going to use them), or null when a worker is on the
 * task. Stale: the folder is gone, the task left the board or is done, the attempt was sent back and replaced,
 * or the task is not held by any worker and none has been started on it.
 */
function staleClaimReason(project: CoreProject, tree: WorktreeInfo, board: ReadonlyMap<string, TaskView>): string | null {
  const task = board.get(tree.taskId.replace(/\.a\d+$/, ""));
  if (!fs.existsSync(tree.path)) return `${tree.taskId}'s folder is gone`;
  if (!task) return `${tree.taskId} is no longer on the board`;
  if (task.status === "done") return `${tree.taskId} is done`;
  const current = attemptLabel(task);
  if (current !== tree.taskId) return `${tree.taskId} was sent back and is now ${current}`;
  if ((task.owner && (task.status === "claimed" || task.status === "blocked")) || dispatches(project).has(tree.taskId)) return null;
  return deriveState(project.entries(), tree.taskId).worktree?.passed === false
    ? `${tree.taskId} has no worker on it and its last check failed`
    : `${tree.taskId} has no worker on it`;
}

// ---------- worker limit, auto-merge switch and the queue ----------

const SETTINGS_FILE = "tasks-settings.json";
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 8;
const MAX_BATCH = 50;

export interface TaskSettings {
  /** How many workers may run at once; Start all stops there and the rest wait. */
  limit: number;
  /** When on, approving a diff that touches no flagged file merges it straight away. */
  autoMerge: boolean;
}

function settingsFile(project: CoreProject): string {
  return path.join(project.root, ".perfect-planner", SETTINGS_FILE);
}

export function taskSettings(project: CoreProject): TaskSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(project), "utf8")) as { limit?: unknown; autoMerge?: unknown };
    const limit = typeof raw.limit === "number" && Number.isInteger(raw.limit) && raw.limit >= 1 && raw.limit <= MAX_LIMIT ? raw.limit : DEFAULT_LIMIT;
    return { limit, autoMerge: raw.autoMerge === true };
  } catch {
    return { limit: DEFAULT_LIMIT, autoMerge: false };
  }
}

/** A worker is running on the task and has not handed in work yet; a task waiting on a diff or a merge holds no slot. */
function hasWorker(task: { stage: string; status: string; dispatch: unknown }): boolean {
  return Boolean(task.dispatch || task.status === "claimed") && !["done", "review-diff", "ready-to-merge", "reopened"].includes(task.stage);
}

function queueOf(tasks: Array<ReturnType<typeof viewTask>>, limit: number) {
  const running = tasks.filter(hasWorker);
  const slots = Math.max(0, limit - running.length);
  const notStarted = tasks.filter((t) => !hasWorker(t) && !["done", "review-diff", "ready-to-merge"].includes(t.stage));
  let free = slots;
  return {
    limit,
    running: running.map((t) => t.id),
    notStarted: notStarted.map((t) => {
      if (t.waitingFor) return { id: t.id, why: t.waitingFor.message };
      if (free > 0) {
        free -= 1;
        return { id: t.id, why: "Can start now." };
      }
      return { id: t.id, why: `Waiting for a free worker (limit ${limit}).` };
    }),
    waitingForYou: tasks.filter((t) => t.stage === "review-diff").map((t) => t.id),
    readyToMerge: tasks.filter((t) => t.stage === "ready-to-merge").map((t) => t.id),
    done: tasks.filter((t) => t.stage === "done").length,
  };
}

// ---------- the view ----------

export function stageOf(task: TaskView, gate: GateState): TaskStage {
  if (task.status === "done" || gate.done) return "done";
  if (gate.reopenedAs) return "reopened";
  if (!gate.definition) return "needs-test";
  if (!gate.approval) return "test-proposed";
  if (!gate.baseline) return "test-approved";
  if (gate.baseline.passed) return "test-passes-already";
  if (task.status !== "claimed") return "ready-to-claim";
  const tip = gate.worktree?.passed ? gate.worktree.commit?.toLowerCase() : undefined;
  if (!tip) return "building";
  return gate.diffApproval?.commit === tip ? "ready-to-merge" : "review-diff";
}

function personSummary(actor: Actor | undefined) {
  return actor ? { kind: actor.kind, id: actor.id, ...(actor.model ? { model: actor.model } : {}) } : undefined;
}

function viewTask(project: CoreProject, task: TaskView, worktrees: WorktreeInfo[], board: ReadonlyMap<string, TaskView>, assignments: ReadonlyMap<string, string>) {
  const label = attemptLabel(task);
  const gate = deriveState(project.entries(), label);
  const tree = worktrees.find((w) => w.taskId === label);
  const dispatch = dispatches(project).get(label);
  const jev = jevView(project.entries(), label, gate, project.policy.requireJevTestReview === true);
  let stage = stageOf(task, gate);
  // With a Jev key saved the card says what is really missing: Jev's review, not "waiting for the worker".
  if (jev?.required) {
    if (stage === "ready-to-claim" && jev.test && jev.test.state !== "approved") stage = jev.test.state === "gaps" ? "jev-found-gaps" : "waiting-for-jev";
    // A diff approved before the key was saved, or by anyone but the person, is read and signed again.
    if (stage === "ready-to-merge" && (jev.diff?.state !== "approved" || !gate.diffApproval?.byPerson)) stage = "review-diff";
  }
  const unmet = task.status === "done" ? [] : unmetDependencies(board, task);
  const staleClaims = tree?.claims.length ? staleClaimReason(project, tree, board) : null;
  return {
    id: task.id,
    label,
    repo: task.repo ?? PRIMARY_REPO,
    group: task.group,
    title: task.title,
    status: task.status,
    owner: task.owner,
    /** The person the owner gave this task to (People), when they did. */
    assignee: assignments.get(task.id) ?? null,
    attempt: task.attempt,
    clauses: task.clauses,
    lastProgress: task.lastProgress,
    proofs: task.proofs.map((p) => ({ kind: p.kind, link: p.link })),
    stage,
    jev,
    test: gate.definition
      ? { command: gate.definition.command, files: gate.definition.files, by: personSummary(gate.definition.actor), entry: gate.definition.n }
      : null,
    approval: gate.approval ? { entry: gate.approval.n, by: personSummary(gate.approval.actor) } : null,
    baseline: gate.baseline ? { passed: gate.baseline.passed, entry: gate.baseline.n } : null,
    check: gate.worktree ? { passed: gate.worktree.passed, commit: gate.worktree.commit, entry: gate.worktree.n } : null,
    diffApproval: gate.diffApproval ? { commit: gate.diffApproval.commit, by: personSummary(gate.diffApproval.reviewer), entry: gate.diffApproval.n } : null,
    merged: gate.merged ?? null,
    worktree: tree ? { path: tree.path, branch: tree.branch, base: tree.baseRef, port: tree.port } : null,
    dispatch: dispatch ? { issuedAt: dispatch.issuedAt, ...(dispatch.model ? { model: dispatch.model } : {}) } : null,
    // Why this task cannot start yet (dispatch refuses it for the same reason), in plain words; null when nothing blocks it.
    waitingFor: unmet.length ? { tasks: unmet.map((d) => d.id), message: waitingMessage(label, unmet) } : null,
    // File claims this task's worktree holds, and, when nobody is working on it, why they can be released.
    claims: tree?.claims ?? [],
    staleClaims,
    history: gate.history.slice(-12),
  };
}

async function listWorktrees(project: CoreProject, repo: RepoState): Promise<WorktreeInfo[]> {
  if (!repo.ok || !repo.root) return [];
  const list = await manager(project, repo.root, repo.name).list().catch(() => []);
  // Only other repos are tagged: the first repo's worktrees look exactly as they always did.
  return repo.name === PRIMARY_REPO ? list : list.map((info) => ({ ...info, repo: repo.name }));
}

/** Every repo of the project (the first one, then the extra ones) with the worktrees in each. A repo that cannot be read has its reason and no worktrees. */
async function allRepos(project: CoreProject): Promise<{ repos: RepoState[]; worktrees: WorktreeInfo[] }> {
  const names = [PRIMARY_REPO, ...readRepos(project.root).repos.map((repo) => repo.name)];
  const repos = await Promise.all(names.map((name) => repoState(project, name)));
  const lists = await Promise.all(repos.map((repo) => listWorktrees(project, repo)));
  return { repos, worktrees: lists.flat() };
}

export async function overview(project: CoreProject) {
  const { repos, worktrees } = await allRepos(project);
  const board = project.service.board();
  const assignments = replayRoster(project.entries(), project.ledger.owner).assignments;
  const tasks = [...board.values()].map((task) => viewTask(project, task, worktrees, board, assignments));
  const settings = taskSettings(project);
  return { repo: repos[0]!, settings, queue: queueOf(tasks, settings.limit), repos: repos.map((repo) => ({ ...repo, worktrees: worktrees.filter((w) => (w.repo ?? PRIMARY_REPO) === repo.name).length })), tasks, groups: taskGroups(tasks) };
}

/** Tasks split from one plan task over several repos, in task order, with whether every part is ready to merge. */
function taskGroups(tasks: { id: string; group: string | null; stage: TaskStage; repo: string }[]) {
  const groups = new Map<string, typeof tasks>();
  for (const task of tasks) if (task.group) groups.set(task.group, [...(groups.get(task.group) ?? []), task]);
  return [...groups].filter(([, members]) => members.length > 1).map(([group, members]) => ({ group, tasks: members.map((m) => m.id), ready: members.every((m) => m.stage === "ready-to-merge"), done: members.every((m) => m.stage === "done") }));
}

function findTask(project: CoreProject, id: string): TaskView {
  const task = project.service.board().get(id);
  if (!task) throw new HttpError(404, "NOT_FOUND", `${id} is not on the board. Approve the plan or add the task first.`);
  return task;
}

/**
 * Plain text when git cannot name a committer (null when it can). A missing name and email gets the two
 * commands to run; any other git failure gets a generic message so it is not blamed on the identity.
 * The app only shows the commands; it never sets the person's git config or invents an identity.
 * The copy of the person's git settings is refreshed first, so a name set a minute ago counts without a restart.
 */
export async function gitIdentityRefusal(root: string): Promise<string | null> {
  refreshCarriedSettings();
  const ident = await runGit(root, ["var", "GIT_COMMITTER_IDENT"]).catch((error: Error) => ({ code: -1, stdout: "", stderr: error.message }));
  if (ident.code === 0) return null;
  if (!/identity unknown|unable to auto-detect|no email was given|no name was given|empty ident/i.test(`${ident.stderr}${ident.stdout}`)) {
    return "Git did not answer when the app asked it who you are, so nothing was merged and your work is safe. Press Merge again; if it keeps happening, check that Git still opens from a terminal.";
  }
  return [
    "Git on this computer does not know your name and email yet, so it cannot record the merge. Nothing was merged and your work is safe.",
    "Run these two commands once in a terminal (use your own name and email), then press Merge again:",
    'git config --global user.name "Your Name"',
    'git config --global user.email "you@example.com"',
  ].join("\n");
}

function stale(message: string): HttpError {
  return new HttpError(409, "STALE", message);
}

function sameCommit(a: unknown, b: string | undefined): boolean {
  return typeof a === "string" && /^[0-9a-f]{40}$/i.test(a) && typeof b === "string" && a.toLowerCase() === b.trim().toLowerCase();
}

function refuse(result: { ok: boolean; reason?: string }): void {
  if (!result.ok) throw new HttpError(409, "REFUSED", result.reason ?? "Refused.");
}

async function worktreeFor(project: CoreProject, label: string): Promise<WorktreeInfo> {
  const name = repoOfLabel(project, label);
  const root = await requireRepo(project, name);
  const tree = await manager(project, root, name).get(label);
  if (!tree) throw new HttpError(409, "NO_WORKTREE", `${label} has no worktree yet. Start a worker on it first.`);
  return tree;
}

// ---------- the brief a worker gets ----------

// Single quotes in both shells, so a path can never run $(...) or `...`: POSIX ends and reopens the
// quote around a ', PowerShell doubles it.

export function workerBrief(task: { label: string; title: string; clauses: string[] }, worktree: WorktreeInfo, test: GateState["definition"], approved: boolean): string {
  const testStep = test
    ? approved
      ? `2. The done-when test is already approved: \`${test.command}\`${test.files.length ? ` (${test.files.join(", ")})` : ""}. Do not change it; Perfect Planner refuses work that edits an approved test.`
      : `2. A done-when test is proposed: \`${test.command}\`. Wait for the person to approve it in Perfect Planner, or propose a better one with propose_test.`
    : "2. Test first: write a test that fails on today's code and passes once this task is done. Commit it, then call propose_test with the command and the test file(s). Do not start the work yet.";
  return [
    `You are a Perfect Planner worker on ${task.label}: ${task.title}.`,
    task.clauses.length ? `It implements ${task.clauses.join(", ")}; use the lookup tool to read the exact text.` : "",
    `Work only in this folder: ${worktree.path} (branch ${worktree.branch}, dev server port ${worktree.port}).`,
    "",
    `1. Call hello on the ${AGENT_SERVER_NAME} MCP server with your name and model.`,
    testStep,
    `3. When list_tasks shows ${task.label} with testApproved true, call claim_task. The claim is refused until the person has approved the test and Perfect Planner has seen it fail.`,
    "4. Build it in small commits. report_progress after each step; ask_main when you need a decision (a blocking question pauses only you).",
    "5. When the test passes for you, commit everything and call attach_proof with kind commit and the full commit hash. Perfect Planner runs the approved test itself; the person reviews your diff and merges.",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

/** Ends the task's current worker: its token stops working and its token file is deleted. */
function revokeWorker(project: CoreProject, label: string): void {
  const previous = dispatches(project).get(label);
  if (previous) project.service.tokens.revoke(previous.token);
  fs.rmSync(tokenFilePath(project, label), { force: true });
}

/**
 * The worker's token stays in a file only this user can read; the commands name the file, so the
 * token never lands on a command line, in shell history or in a process list.
 */
export function workerCommands(options: { worktree: string; bridgeUrl: string; tokenFile: string; entry: string; briefFile: string; platform?: NodeJS.Platform }) {
  const { worktree, bridgeUrl, tokenFile, entry, briefFile } = options;
  const windows = (options.platform ?? process.platform) === "win32";
  const quote = quoteFor(windows);
  // Re-runnable: a new attempt in the same worktree replaces the older registration.
  const add = connectLine(bridgeUrl, tokenFile, entry, windows ? "win32" : "linux");
  const setup = windows ? `cd ${quote(worktree)}; ${add}` : `cd ${quote(worktree)} && ${add}`;
  const start = windows ? `claude (Get-Content -Raw ${quote(briefFile)})` : `claude "$(cat ${quote(briefFile)})"`;
  const json = JSON.stringify({ mcpServers: { [AGENT_SERVER_NAME]: { command: nodeBinary(), args: [entry], env: { PP_BRIDGE_URL: bridgeUrl, PP_AGENT_TOKEN_FILE: tokenFile } } } }, null, 2);
  // Gemini CLI and Codex CLI: the same two steps with their own connect line and start command. Both start
  // interactively with the person at the keyboard and ask before running commands (Codex: workspace-write
  // sandbox; Gemini: edits auto-approved, shell asks); neither is ever started with its approve-everything flag.
  const brief = windows ? `(Get-Content -Raw ${quote(briefFile)})` : `"$(cat ${quote(briefFile)})"`;
  const agentSetup = (agent: AgentKind) => {
    const line = connectLine(bridgeUrl, tokenFile, entry, windows ? "win32" : "linux", agent);
    return windows ? `cd ${quote(worktree)}; ${line}` : `cd ${quote(worktree)} && ${line}`;
  };
  const agents = {
    gemini: { setup: agentSetup("gemini"), start: `gemini --approval-mode auto_edit -i ${brief}`, note: "Choose Trust folder first (start gemini once in the task folder), or the set-up command is refused." },
    codex: { setup: agentSetup("codex"), start: `codex -s workspace-write -a on-request ${brief}`, note: "Codex keeps one connection for this computer, so this replaces any other Codex worker's." },
  };
  return { setup, start, json, agents, shell: windows ? "PowerShell" : "Terminal" };
}

// ---------- routes ----------

function bodyOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

async function dispatch(project: CoreProject, host: CoreHost, id: string, body: Record<string, unknown>) {
  if (!host.bridgeEnabled) throw new HttpError(503, "BRIDGE_OFF", "Agent connections are turned off for this app, so a worker has nothing to connect to.");
  const repoName = repoOfLabel(project, id);
  const root = await requireRepo(project, repoName);
  const task = findTask(project, id);
  if (task.status === "done") throw new HttpError(409, "DONE", `${id} is already done.`);
  // A task whose dependencies are not done yet does not start: say which ones, in plain words.
  const unmet = unmetDependencies(project.service.board(), task);
  if (unmet.length) throw new HttpError(409, "WAITING_FOR_DEPENDENCY", waitingMessage(attemptLabel(task), unmet));
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  if (model !== undefined && !MODEL.test(model)) throw new HttpError(400, "INVALID", "Name the worker's model in letters, digits and . _ : / - (for example claude-sonnet-4).");
  const label = attemptLabel(task);
  const worktrees = manager(project, root, repoName);
  let tree = await worktrees.get(label);
  if (!tree) {
    try {
      tree = await worktrees.create({ taskId: label, actor: localPerson(project) });
    } catch (error) {
      if (error instanceof WorktreeError) throw new HttpError(409, "WORKTREE", error.message);
      throw error;
    }
  }
  const bridge = await host.bridge(project);
  // One worker per task at a time: a new dispatch replaces the previous worker's token.
  revokeWorker(project, label);
  // A task given to a person is worked for them; otherwise for the person at this computer.
  const person = replayRoster(project.entries(), project.ledger.owner).assignments.get(task.id) ?? localPersonId(project);
  const token = project.service.tokens.issue({ role: "worker", person, task: task.id, ...(model ? { model } : {}) });
  const record: Dispatch = { task: label, issuedAt: new Date().toISOString(), token, ...(model ? { model } : {}) };
  dispatches(project).set(label, record);

  const gate = deriveState(project.entries(), label);
  const brief = workerBrief({ label, title: task.title, clauses: task.clauses }, tree, gate.definition, Boolean(gate.approval));
  // The brief goes next to the ledger, never into the worktree (an untracked file there would block the check).
  const briefFile = path.join(project.root, ".perfect-planner", "briefs", `${label}.md`);
  fs.mkdirSync(path.dirname(briefFile), { recursive: true });
  fs.writeFileSync(briefFile, `${brief}\n`);
  const tokenFile = writeTokenFile(project, label, token);
  const entry = agentEntryPath();
  const commands = workerCommands({ worktree: tree.path, bridgeUrl: bridge.url, tokenFile, entry: entry.path, briefFile });
  return {
    task: label,
    title: task.title,
    worktree: tree.path,
    branch: tree.branch,
    port: tree.port,
    bridgeUrl: bridge.url,
    tokenFile,
    serverName: AGENT_SERVER_NAME,
    brief,
    briefFile,
    ...(model ? { model } : {}),
    ...commands,
    agentBuilt: entry.built,
    ...(entry.built ? {} : { warning: "The agent program is not built yet. Run npm run build:core-host in the Perfect Planner folder before pasting this." }),
  };
}

const UPDATE_CODES: Record<string, string> = { dirty: "DIRTY_WORKTREE", conflict: "UPDATE_CONFLICT" };

/**
 * Bring the task's worktree up to date with the branch it merges into (manager.updateFromMain). A dirty
 * worktree or a conflict is a plain refusal that leaves the worker's files exactly as they were. A success
 * is the person's signed entry on the ledger.
 */
async function updateFromMain(project: CoreProject, id: string) {
  const repoName = repoOfLabel(project, id);
  const root = await requireRepo(project, repoName);
  const task = findTask(project, id);
  const label = attemptLabel(task);
  if (task.status === "done") throw new HttpError(409, "DONE", `${label} is already done.`);
  await worktreeFor(project, label);
  let result;
  try {
    result = await manager(project, root, repoName).updateFromMain(label);
  } catch (error) {
    if (error instanceof WorktreeError) throw new HttpError(409, "NO_WORKTREE", error.message);
    throw error;
  }
  if (result.status === "refused") throw new HttpError(409, UPDATE_CODES[result.reason ?? ""] ?? "UPDATE_REFUSED", result.message);
  if (result.status === "up-to-date") return { updated: false, message: result.message, ...(await overview(project)) };
  // The earlier check and diff approval were for the old tip; the gate will not merge any other commit.
  const state = deriveState(project.entries(), label);
  const recheck = Boolean(state.worktree || state.diffApproval);
  let warning: string | undefined;
  try {
    project.ledger.append({
      actor: localPerson(project),
      type: "task.progress",
      subject: label,
      summary: `Brought ${label} up to date with ${result.base}`,
      evidence: [`commit:${result.after}`, `base:${result.mergedIn}`],
      refs: [],
      data: { updatedFromMain: true, base: result.base, before: result.before, after: result.after, mergedIn: result.mergedIn, commits: result.commits, fastForward: result.fastForward, by: "person" },
    });
  } catch (error) {
    warning = `The update was made, but it could not be written to the ledger (${(error as Error).message}).`;
  }
  return {
    updated: true,
    message: `${result.message}${recheck ? " The work changed, so run Check the work again and approve the diff again." : ""}`,
    before: result.before,
    after: result.after,
    mergedIn: result.mergedIn,
    commits: result.commits,
    ...(warning ? { warning } : {}),
    ...(await overview(project)),
  };
}

/**
 * Release the file claims a worktree holds when nobody is going to use them: the folder is gone, the task left
 * the board or is done, was sent back, or has no worker on it. Refused while a worker holds the task (release
 * the task first). The person's signed entry names the files and why they were stale.
 */
async function releaseFileClaims(project: CoreProject, id: string, body: Record<string, unknown>) {
  if (!/^T-\d+(?:\.a\d+)?$/.test(id)) throw new HttpError(400, "INVALID", `"${id}" is not a task number like T-14.`);
  const repoName = repoOfLabel(project, id);
  const root = await requireRepo(project, repoName);
  const tree = await manager(project, root, repoName).get(id);
  if (!tree) throw new HttpError(409, "NO_WORKTREE", `${id} has no worktree, so it holds no file claims.`);
  if (!tree.claims.length) return { released: [], message: `${id} holds no file claims.`, ...(await overview(project)) };
  const stale = staleClaimReason(project, tree, project.service.board());
  if (!stale) throw new HttpError(409, "CLAIM_ACTIVE", `${id} is still being worked on, so its file claims are not stale. If its worker is gone, release the task first, then release its files.`);
  const rawFiles = body.files;
  if (rawFiles !== undefined && (!Array.isArray(rawFiles) || rawFiles.some((file) => typeof file !== "string"))) throw new HttpError(400, "INVALID", "files must be a list of file names.");
  const wanted = (rawFiles as string[] | undefined)?.map((file) => file.trim()).filter(Boolean);
  const raw = body.reason;
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw new HttpError(400, "INVALID", "The reason must be text.");
  const reason = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 500) : undefined;
  const files = tree.claims.filter((file) => !wanted || wanted.includes(file));
  if (!files.length) return { released: [], message: `${id} does not hold ${wanted?.length === 1 ? "that file" : "those files"}.`, ...(await overview(project)) };
  // The person's signed record first: if it cannot be written, nothing is released.
  project.ledger.append({
    actor: localPerson(project),
    type: "task.progress",
    subject: id,
    summary: `Released ${files.length === 1 ? "the file claim" : `${files.length} file claims`} held by ${id} (${stale})`,
    ...(reason ? { reason } : {}),
    evidence: files.map((file) => `claim:${file}`),
    refs: [],
    data: { claimsReleased: files, stale, by: "person" },
  });
  const done = await manager(project, root, repoName).releaseClaims(id, files);
  return { released: done.released, remaining: done.remaining, stale, message: `Released ${done.released.join(", ")}. Other tasks can claim ${done.released.length === 1 ? "it" : "them"} now.`, ...(await overview(project)) };
}

async function releaseClaim(project: CoreProject, id: string, body: Record<string, unknown>) {
  const task = findTask(project, id);
  const label = attemptLabel(task);
  if (!task.owner || (task.status !== "claimed" && task.status !== "blocked")) {
    throw new HttpError(409, "NOT_CLAIMED", `${label} is not held by a worker, so there is nothing to release.`);
  }
  // Bound to the worker the person saw: if another worker took it meanwhile, that one is not released.
  if (typeof body.owner === "string" && body.owner !== task.owner) throw stale(`${label} is now held by ${task.owner}. Look again before releasing it.`);
  const raw = body.reason;
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw new HttpError(400, "INVALID", "The reason must be text.");
  const reason = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 500) : undefined;
  const owner = task.owner;
  // The person's own signed entry: the board frees the task (a blocked task stays blocked, without its owner).
  const entry = project.ledger.append({
    actor: localPerson(project),
    type: task.status === "blocked" ? "task.blocked" : "task.progress",
    subject: label,
    summary: `Released ${label} from ${owner}`,
    ...(reason ? { reason } : {}),
    evidence: [],
    refs: [],
    data: { released: true, from: owner, by: "person", worktreeKept: true },
  });
  revokeWorker(project, label);
  project.service.tokens.revokeTask(task.id);
  if (label !== task.id) project.service.tokens.revokeTask(label);
  dispatches(project).delete(label);
  return { released: label, from: owner, entry: entry.n, ...(await overview(project)) };
}

/**
 * What the worker changed from where the worktree branched to the tip, plus the files among them the gate
 * itself treats as sensitive (core/gate sensitiveChanges: install scripts, lockfiles, git attributes and
 * hooks, workflows, npm and build settings, and the approved test's own support files). The diff screen
 * lists those in a block that needs its own confirmation, so the person reads them before approving.
 */
async function changedFiles(project: CoreProject, label: string, tree: { path: string; baseSha: string }, tip: string): Promise<{ files: string[]; sensitive: string[] }> {
  const files = (await git(tree.path, ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", tree.baseSha, tip])).split(/\r?\n/).filter(Boolean).sort();
  const state = deriveState(project.entries(), label);
  const pinned = Object.keys(state.approval?.pins ?? {});
  const support = state.definition ? await testSupportFiles(tree.path, [tree.baseSha, tip], pinned, state.definition.command) : new Set<string>();
  // The approved test files themselves are not flagged once the test has passed at this very tip: the gate refuses a
  // pinned file that differs from what the person approved (on disk and in the commit), so they are byte for byte
  // the ones already read at approval. Their helpers, imports and anything else beside them stay flagged.
  const unchanged = state.worktree?.passed && state.worktree.commit?.toLowerCase() === tip.toLowerCase() ? new Set(pinned) : new Set<string>();
  return { files, sensitive: sensitiveChanges(files, pinned, support).filter((file) => !unchanged.has(file)).sort() };
}

/** A refusal plus the end of the test's own output, so the person sees why the test failed. */
export function withOutputTail(reason: string, output?: string): string {
  const tail = (output ?? "").split(/\r?\n/).filter((line) => line.trim()).slice(-20).join("\n").slice(-2000);
  return tail ? `${reason}\n\nEnd of the test output:\n${tail}` : reason;
}

export function registerTaskRoutes(router: Router): void {
  router.get("/tasks", ({ project }) => overview(project));

  /** POST /tasks/repo { root }: the person points workers at their project's git folder. */
  router.post("/tasks/repo", async ({ project, body }) => {
    const raw = bodyOf(body).root;
    if (typeof raw !== "string" || !raw.trim() || !path.isAbsolute(raw.trim())) throw new HttpError(400, "INVALID", "Give the full path of your project's git folder.");
    const top = await gitTop(raw.trim());
    if (!top) throw new HttpError(400, "NOT_GIT", `${raw.trim()} is not a git repository with at least one commit.`);
    const refusal = repoRefusal(top);
    if (refusal) throw new HttpError(400, "NOT_A_PROJECT", refusal);
    // Switching folders under a running worker would strand its worktree and its approvals.
    const current = await repoState(project);
    if (current.ok && current.root !== top && (await listWorktrees(project, current)).length) {
      throw new HttpError(409, "WORKERS_ACTIVE", `Workers still have worktrees in ${current.root}. Merge or send back their tasks before choosing another folder.`);
    }
    // One git folder, one project (core/host/repoClaim.ts). Looked at first, then recorded in repo.json before
    // the claim is taken, because another project tells whether this one still uses a folder by that file.
    const refused = await repoClaimRefusal(project, top, { write: false });
    if (refused) throw new HttpError(409, "REPO_IN_USE", refused);
    let previous: string | undefined;
    try {
      previous = fs.readFileSync(repoFile(project), "utf8");
    } catch {
      previous = undefined;
    }
    fs.mkdirSync(path.dirname(repoFile(project)), { recursive: true });
    fs.writeFileSync(repoFile(project), JSON.stringify({ root: top, at: new Date().toISOString() }, null, 2));
    const lost = await repoClaimRefusal(project, top, { write: true });
    if (lost) {
      // Another project took the folder between the look and the claim: put this project's choice back as it was.
      if (previous === undefined) fs.rmSync(repoFile(project), { force: true });
      else fs.writeFileSync(repoFile(project), previous);
      throw new HttpError(409, "REPO_IN_USE", lost);
    }
    // Shipping safety follows the folder: release rules on, and the pre-push secret scan installed there.
    const protection = await protectRepository(project.ledger, top);
    return { protection, ...(await overview(project)) };
  });

  /** POST /tasks/:id/dispatch { model? }: worktree, worker token for this task, brief and command. */
  router.post("/tasks/:id/dispatch", ({ project, host, params, body }) => dispatch(project, host, params.id!, bodyOf(body)));

  /** POST /tasks/:id/test { command, files }: the person writes the done-when test themselves. */
  router.post("/tasks/:id/test", ({ project, params, body }) => {
    const task = findTask(project, params.id!);
    const { command, files } = bodyOf(body);
    if (typeof command !== "string" || !command.trim()) throw new HttpError(400, "INVALID", "Give the command that runs the test.");
    const list = Array.isArray(files) ? files.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim()) : [];
    if (!list.length) throw new HttpError(400, "INVALID", "Name the test file(s), so their content can be pinned when you approve.");
    let defined;
    try {
      defined = project.service.gate.define(attemptLabel(task), command, localPerson(project), task.clauses, { files: list });
    } catch (error) {
      if ((error as Error).name === "GateError") throw new HttpError(400, "INVALID", (error as Error).message);
      throw error;
    }
    refuse(defined);
    return overview(project);
  });

  /**
   * POST /tasks/:id/approve-test: the person approves the proposed test (pinning its files from the
   * worktree), then the gate runs it there; it must fail on today's code before anyone can claim.
   * With a Jev key saved, Jev then reads the test (spec 6.2) and its verdict is recorded for the gate: the
   * worker can claim only after Jev approves. Pressing it again asks Jev again (no key, outage, a timeout,
   * an unusable answer or a spent monthly budget all leave the task refused). The person's approval is
   * theirs; Jev's can only add a refusal, never stand in for it.
   */
  router.post("/tasks/:id/approve-test", async ({ project, params, body }) => {
    const task = findTask(project, params.id!);
    const label = attemptLabel(task);
    const tree = await worktreeFor(project, label);
    const gate = project.service.gate;
    // A key saved a moment ago counts at once: ask the key store, not the one-minute memory.
    const jevOn = (await syncJevPolicy(project, { fresh: true })).connected;
    let state = gate.state(label);
    const seen = bodyOf(body).test;
    if (!state.approval) {
      // Bound to the definition the person read: a worker re-proposing a different test meanwhile makes this stale.
      if (!state.definition || seen !== state.definition.n) throw stale("The test changed since you looked at it. Read the new one, then approve it.");
      refuse(gate.approve(label, localPerson(project), { cwd: tree.path }));
      state = gate.state(label);
    } else if (jevOn && (!state.definition || seen !== state.definition.n)) {
      throw stale("The test changed since you looked at it. Read the new one, then ask Jev.");
    }
    // A test already seen failing on the original code is not run again for Jev: the worker's newer code
    // would make it pass, and that run would overwrite the baseline the claim depends on.
    const settled = jevOn && state.baseline !== undefined && !state.baseline.passed;
    const first = settled ? null : await gate.confirmFailsFirst(label, tree.path);
    const failsFirst = first ? first.ok : true;
    let jev: JevLine | undefined;
    if (jevOn) {
      jev = failsFirst
        ? await reviewTestWithJev(project, task, label, gate.state(label), tree.path)
        : { state: "waiting", message: "Jev reviews the test once it fails on today's code.", reasons: [], canRetry: false };
      // No answer may mean the key was just removed: look again, so the requirement follows the key at once.
      if (jev.state === "unavailable") await syncJevPolicy(project, { fresh: true });
    }
    return {
      approved: true,
      failsFirst,
      ...(first && !first.ok ? { reason: first.reason } : {}),
      ...(first?.run ? { output: first.run.outputTail } : {}),
      ...(jev ? { jev } : {}),
      ...(await overview(project)),
    };
  });

  /** POST /tasks/:id/check: the gate runs the approved test in the worktree at its last commit. */
  router.post("/tasks/:id/check", async ({ project, params }) => {
    const task = findTask(project, params.id!);
    const label = attemptLabel(task);
    const tree = await worktreeFor(project, label);
    const run = await project.service.gate.prove(label, tree.path);
    if (!run.ok && !run.run && !run.entry) refuse(run);
    return {
      passed: run.ok,
      ...(run.commit ? { commit: run.commit } : {}),
      ...(run.ok ? {} : { reason: run.reason }),
      ...(run.run ? { output: run.run.outputTail } : {}),
      ...(await overview(project)),
    };
  });

  /** GET /tasks/:id/diff: what the worker changed, from where the worktree branched to its tip. */
  router.get("/tasks/:id/diff", async ({ project, params }) => {
    const task = findTask(project, params.id!);
    const tree = await worktreeFor(project, attemptLabel(task));
    const tip = await git(tree.path, ["rev-parse", "HEAD"]);
    const { files, sensitive } = await changedFiles(project, attemptLabel(task), tree, tip);
    const text = await git(tree.path, ["diff", "--no-color", "--no-renames", tree.baseSha, tip]);
    return { task: attemptLabel(task), base: tree.baseSha, commit: tip, files, sensitive, text: text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n… diff cut at ${MAX_DIFF} characters` : text, truncated: text.length > MAX_DIFF };
  });

  /** POST /tasks/:id/approve-diff: the person approves the diff at the commit the test passed on. */
  const approveDiff = async (project: CoreProject, id: string, body: unknown) => {
    const task = findTask(project, id);
    const label = attemptLabel(task);
    const passed = deriveState(project.entries(), label).worktree;
    const tip = await git((await worktreeFor(project, label)).path, ["rev-parse", "HEAD"]);
    // Bound to the commit the person reviewed, which must still be the tip the test passed on.
    if (!sameCommit(bodyOf(body).commit, tip) || !passed?.passed || !sameCommit(passed.commit, tip)) {
      throw stale("The work changed since you reviewed it. Check it again and read the new diff before approving.");
    }
    // Files that can run code on this machine need their own confirmation, naming exactly those files.
    const tree = await worktreeFor(project, label);
    const { sensitive } = await changedFiles(project, label, tree, tip);
    const clean = sensitive.length === 0;
    const confirmed = bodyOf(body).confirmSensitive;
    if (sensitive.length && !(Array.isArray(confirmed) && confirmed.length === sensitive.length && sensitive.every((file) => confirmed.includes(file)))) {
      throw new HttpError(409, "CONFIRM_SENSITIVE", `This diff changes files that can run code on your computer (${sensitive.join(", ")}). Confirm you read them before approving.`);
    }
    // With a Jev key saved, Jev reads the change first (spec 6.3) and the person signs after it, never instead of it.
    let jev: JevLine | undefined;
    if ((await syncJevPolicy(project, { fresh: true })).connected) {
      const review = await reviewDiffWithJev(project, task, label, { worktree: tree.path, baseSha: tree.baseSha, commit: tip, state: deriveState(project.entries(), label) });
      jev = review.line;
      if (jev.state === "gaps") {
        // Jev found problems: the change goes back to the worker as the next attempt, with Jev's reasons; the worktree is kept.
        const sent = project.service.gate.reject(label, jevActor(project, jev), sendBackNotes(jev), { verdict: jev.entry });
        refuse(sent);
        revokeWorker(project, label);
        return { approved: false, reopenedAs: sent.ok ? sent.newTaskId : undefined, jev, ...(await overview(project)) };
      }
      if (jev.state === "unavailable") await syncJevPolicy(project, { fresh: true });
      if (jev.state !== "approved") {
        const code = jev.state === "queued" ? "JEV_BUDGET" : jev.state === "unsure" ? "JEV_UNSURE" : jev.state === "cannot-review" ? "JEV_CANNOT_REVIEW" : "JEV_UNAVAILABLE";
        throw new HttpError(409, code, `${jev.message}${jev.reasons.length ? ` ${jev.reasons.join(" ")}` : ""}${jev.canRetry ? " Press Approve diff to ask Jev again." : ""}`);
      }
    }
    refuse(project.service.gate.approveDiff(attemptLabel(task), localPerson(project)));
    return { approved: true, clean, ...(jev ? { jev } : {}), ...(await overview(project)) };
  };
  router.post("/tasks/:id/approve-diff", ({ project, params, body }) => approveDiffAndMaybeMerge(project, params.id!, body));

  /** POST /tasks/:id/reject { notes }: the diff goes back to the worker as the next attempt. */
  router.post("/tasks/:id/reject", async ({ project, params, body }) => {
    const task = findTask(project, params.id!);
    const notes = bodyOf(body).notes;
    if (typeof notes !== "string" || !notes.trim()) throw new HttpError(400, "INVALID", "Say what the worker should change.");
    const label = attemptLabel(task);
    const result = project.service.gate.reject(label, localPerson(project), notes.trim());
    refuse(result);
    revokeWorker(project, label);
    return { reopenedAs: result.ok ? result.newTaskId : undefined, ...(await overview(project)) };
  });

  /**
   * POST /tasks/:id/release { reason?, owner? }: the person frees a task held by a worker that is gone.
   * Writes the person's signed release, ends the worker's token, and leaves the worktree, its branch and
   * its commits exactly where they are, so the next worker dispatched on the task carries on from them.
   */
  router.post("/tasks/:id/release", ({ project, params, body }) => releaseClaim(project, params.id!, bodyOf(body)));

  /** POST /tasks/:id/update-from-main: merge the integration branch into the task's branch, inside its worktree, never touching unsaved work. */
  router.post("/tasks/:id/update-from-main", ({ project, params }) => updateFromMain(project, params.id!));

  /** POST /tasks/:id/release-claims { files?, reason? }: free the file claims of a task nobody is working on (signed as the person). */
  router.post("/tasks/:id/release-claims", ({ project, params, body }) => releaseFileClaims(project, params.id!, bodyOf(body)));

  /**
   * POST /tasks/:id/merge: merge the worker's branch into the branch it started from. The gate merges
   * into a throwaway candidate, reruns the test there, and only on a pass moves the branch and writes done.
   */
  const mergeTask = async (project: CoreProject, id: string, body: unknown) => {
    const task = findTask(project, id);
    const label = attemptLabel(task);
    const root = await requireRepo(project, task.repo);
    const tree = await worktreeFor(project, label);
    const approved = deriveState(project.entries(), label).diffApproval?.commit;
    if (!approved || !sameCommit(bodyOf(body).commit, approved)) throw stale("Merge the commit whose diff you approved; this screen is out of date.");
    // The diff approval that counts here is the person's own, and with a Jev key saved Jev read this exact commit too.
    if (!deriveState(project.entries(), label).diffApproval?.byPerson) throw stale("You have not approved this diff yourself yet. Press Approve diff first.");
    if ((await syncJevPolicy(project, { fresh: true })).connected && !jevApprovedDiff(project.entries(), label, approved)) {
      throw new HttpError(409, "JEV_NOT_REVIEWED", "Jev has not read this change yet. Press Approve diff so Jev reads it, then merge.");
    }
    // Git cannot write the merge commit without a name and email; say so plainly, before anything is signed.
    const missingIdentity = await gitIdentityRefusal(root);
    if (missingIdentity) throw new HttpError(409, "GIT_IDENTITY_MISSING", missingIdentity);
    // The click is the person's merge approval: signed with their key, in their own window's request,
    // for exactly this commit. The gate refuses to merge without it (never reachable from an agent).
    const state = deriveState(project.entries(), label);
    if (!state.mergeApproval || state.mergeApproval.commit !== approved) refuse(project.service.gate.approveMerge(label, localPerson(project), approved));
    const merged = await oneMergeAtATime(root, () => project.service.gate.mergeAndVerify(label, { repoRoot: root, branch: tree.branch, integrationBranch: tree.baseRef, actor: localPerson(project) }));
    if (!merged.ok) throw new HttpError(409, "REFUSED", withOutputTail(merged.reason, merged.output));
    revokeWorker(project, label);
    dispatches(project).delete(label);
    // A watcher pass that began before the task was done may still have git running in its folder, which Windows will not remove.
    await project.watch?.tick();
    const removed = await manager(project, root, task.repo).remove(label, WORKTREES_ACTOR).catch((error: Error) => ({ error: error.message }));
    return { merged: true, commit: merged.mergeCommit, into: tree.baseRef, removed, ...(await overview(project)) };
  };
  router.post("/tasks/:id/merge", ({ project, params, body }) => mergeTask(project, params.id!, body));

  /**
   * POST /tasks/groups/:group/merge { commits: { "T-5": sha, ... } }: merges the tasks one plan task was split
   * into over several repos, in task order. Nothing is merged unless every part is ready on the commit the
   * person approved. Git cannot make two repos atomic: if a later part is refused, the earlier ones stay
   * merged and the answer says which.
   */
  router.post("/tasks/groups/:group/merge", async ({ project, params, body }) => {
    const group = params.group!;
    const board = project.service.board();
    const members = [...board.values()].filter((task) => task.group === group).sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
    if (members.length < 2) throw new HttpError(404, "NOT_FOUND", "That is not a group of tasks over several repos.");
    const running = (project.state.get(GROUP_MERGES) as Set<string> | undefined) ?? new Set<string>();
    project.state.set(GROUP_MERGES, running);
    if (running.has(group)) throw new HttpError(409, "BUSY", "This group is being merged right now. Wait for it to finish.");
    const commits = bodyOf(body).commits;
    const given = commits && typeof commits === "object" && !Array.isArray(commits) ? (commits as Record<string, unknown>) : {};
    running.add(group);
    try {
      const left = members.filter((task) => task.status !== "done");
      if (!left.length) return { merged: [], message: "Every part of this group is already merged.", ...(await overview(project)) };
      // All or nothing to start: one part that is not ready means no part is merged.
      for (const task of left) {
        const label = attemptLabel(task);
        const gate = deriveState(project.entries(), label);
        if (stageOf(task, gate) !== "ready-to-merge" || !sameCommit(given[task.id], gate.diffApproval?.commit)) {
          throw new HttpError(409, "GROUP_NOT_READY", `${label} (repo ${task.repo ?? PRIMARY_REPO}) is not ready to merge on the commit you approved, so nothing in this group was merged. Finish it, then merge the group again.`);
        }
      }
      const done: { task: string; repo: string; commit: string }[] = [];
      for (const task of left) {
        try {
          const merged = (await mergeTask(project, task.id, { commit: given[task.id] })) as { commit: string };
          done.push({ task: task.id, repo: task.repo ?? PRIMARY_REPO, commit: merged.commit });
        } catch (error) {
          const why = error instanceof HttpError ? error.message : (error as Error).message;
          const rest = left.slice(done.length).map((t) => t.id);
          throw new HttpError(409, "GROUP_PARTLY_MERGED", `${done.length ? `Merged ${done.map((d) => `${d.task} (${d.repo})`).join(", ")}. ` : "Nothing was merged. "}${rest[0]} (repo ${task.repo ?? PRIMARY_REPO}) was refused: ${why}${rest.length > 1 ? ` ${rest.slice(1).join(", ")} were not tried.` : ""} Git cannot undo a merge in another repo, so fix ${rest[0]} and merge the rest on its own.`);
        }
      }
      return { merged: done, ...(await overview(project)) };
    } finally {
      running.delete(group);
    }
  });


  /** With the auto-merge switch on, approving a diff that touches no flagged file merges it right away; any refusal stops at "ready to merge". */
  const approveDiffAndMaybeMerge = async (project: CoreProject, id: string, body: unknown) => {
    const result = (await approveDiff(project, id, body)) as { approved: boolean; clean: boolean };
    if (!result.approved || !result.clean || !taskSettings(project).autoMerge) return result;
    const commit = deriveState(project.entries(), attemptLabel(findTask(project, id))).diffApproval?.commit;
    try {
      return { ...result, ...((await mergeTask(project, id, { commit })) as object) };
    } catch (error) {
      if (error instanceof HttpError) return { ...result, autoMergeStopped: error.message };
      throw error;
    }
  };

  /** POST /tasks/settings { limit?, autoMerge? }: the worker limit and the auto-merge switch. */
  router.post("/tasks/settings", async ({ project, body }) => {
    const { limit, autoMerge } = bodyOf(body);
    if (limit !== undefined && !(typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) throw new HttpError(400, "INVALID", `The worker limit is a whole number from 1 to ${MAX_LIMIT}.`);
    if (autoMerge !== undefined && typeof autoMerge !== "boolean") throw new HttpError(400, "INVALID", "Auto-merge is on or off.");
    const next = { ...taskSettings(project), ...(limit !== undefined ? { limit: limit as number } : {}), ...(autoMerge !== undefined ? { autoMerge: autoMerge as boolean } : {}) };
    fs.mkdirSync(path.dirname(settingsFile(project)), { recursive: true });
    fs.writeFileSync(settingsFile(project), JSON.stringify(next, null, 2));
    return overview(project);
  });

  /** POST /tasks/start-all { model? }: starts workers on the tasks that can start, up to the limit; the rest stay queued. */
  router.post("/tasks/start-all", async ({ project, host, body }) => {
    const { model } = bodyOf(body);
    const first = await overview(project);
    const started: unknown[] = [];
    const refused: Array<{ id: string; message: string }> = [];
    for (const item of first.queue.notStarted) {
      if (item.why !== "Can start now.") continue;
      try {
        started.push(await dispatch(project, host, item.id, { ...(typeof model === "string" ? { model } : {}) }));
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        refused.push({ id: item.id, message: error.message });
      }
    }
    return { started, refused, ...(await overview(project)) };
  });

  /**
   * POST /tasks/batch { items: [{ id, commit }] }: approve and merge the diffs the person was shown, one after another
   * through the same code as a single click. A diff with a flagged file is never approved here, a commit that moved since
   * the screen loaded is skipped, and one failure does not stop the rest.
   */
  router.post("/tasks/batch", async ({ project, body }) => {
    const items = bodyOf(body).items;
    if (!Array.isArray(items) || !items.length || items.length > MAX_BATCH) throw new HttpError(400, "INVALID", `Name between 1 and ${MAX_BATCH} tasks.`);
    const results: Array<{ id: string; outcome: "merged" | "approved" | "skipped" | "failed"; message: string }> = [];
    for (const item of items) {
      const { id, commit } = bodyOf(item);
      if (typeof id !== "string") continue;
      const done = (outcome: "merged" | "approved" | "skipped" | "failed", message: string) => results.push({ id, outcome, message });
      try {
        const task = findTask(project, id);
        const label = attemptLabel(task);
        const stage = (await overview(project)).tasks.find((t) => t.id === id)?.stage;
        const tree = await worktreeFor(project, label);
        const tip = await git(tree.path, ["rev-parse", "HEAD"]);
        if (!sameCommit(commit, tip)) {
          done("skipped", "The work changed since the screen loaded. Open it and read the new diff.");
        } else if (stage === "review-diff") {
          const { sensitive } = await changedFiles(project, label, tree, tip);
          if (sensitive.length) {
            done("skipped", `Touches files that can run code (${sensitive.join(", ")}). Open it and read them.`);
            continue;
          }
          const approved = (await approveDiff(project, id, { commit: tip })) as { approved: boolean };
          if (!approved.approved) {
            done("skipped", "Jev sent the change back, so it was not approved.");
            continue;
          }
          await mergeTask(project, id, { commit: tip });
          done("merged", "Approved and merged.");
        } else if (stage === "ready-to-merge") {
          await mergeTask(project, id, { commit: tip });
          done("merged", "Merged.");
        } else {
          done("skipped", "Not waiting for a diff or a merge.");
        }
      } catch (error) {
        done("failed", error instanceof Error ? error.message : String(error));
      }
    }
    return { results, ...(await overview(project)) };
  });
}
