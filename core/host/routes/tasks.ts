import { checkRequest } from "../../gate/execution";
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
import { deriveState, sensitiveChanges, testSupportFiles, unalteredPins, type GateState } from "../../gate/index";
import { isAuthoritative, type Actor, type LedgerEntry } from "../../ledger/index";
import type { AgentKind } from "../agentKinds";
import { attemptLabel, unmetDependencies, waitingMessage, type TaskView } from "../../mcp/index";
import { DispatchWorktreeError, WorktreeError, WorktreeManager, git, headIdentity, refreshCarriedSettings, runGit, WORKTREES_ACTOR, type WorktreeInfo } from "../../worktrees/index";
import type { CoreHost } from "../host";
import type { CoreProject } from "../project";
import { HttpError, type Router } from "../router";
import { AGENT_SERVER_NAME, agentEntryPath, connectLine, nodeBinary, quoteFor, tokenFilePath, writeTokenFile } from "./agents";

export { quoteFor };
import { localPerson, localPersonId } from "./people";
import { annotate, checkReadiness, quietLabels, registerWorktreeCareRoutes, tidy, withHygieneLock } from "./worktreeCare";
import { PRIMARY_REPO, readRepos } from "../../repos/index";
import { sandboxStatus } from "../../exec/index";
import { replayRoster } from "../../people/index";
import { protectRepository } from "../project";
import { chosenRepoRoot, repoRefusal } from "../protectedRoots";
import { syncJevPolicy } from "./decisions";
import { jevActor, jevApprovedDiff, jevView, reviewDiffWithJev, reviewTestWithJev, sendBackNotes, type JevLine } from "./jev-review";
import { repoClaimRefusal, repoNamespaceFor } from "../repoClaim";
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
// The ledger is the task board's authority.  Git folder housekeeping is useful
// context, but a slow or wedged git child must not leave the board loading.
const OPTIONAL_GIT_VIEW_MS = 2_500;
const OPTIONAL_GIT_CACHE_MS = 4_000;

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
  discovery?: "pending" | "unavailable";
  discoveryIdentity?: string;
  root?: string;
  reason?: string;
  /** The folder the person already imported (this project's own folder), offered as the starting answer. */
  suggested?: string;
}

// ---------- the repository the worktrees branch from ----------

function repoFile(project: CoreProject): string {
  return path.join(project.root, ".perfect-planner", REPO_FILE);
}

const topCache = new Map<string, { top: string; identity: string }>();

/** Test-only: clear the process-local repo-top cache so mocked Git reads are not reused across cases. */
export function __resetGitTopCacheForTests(): void {
  topCache.clear();
}

export async function gitTop(dir: string): Promise<string | null> {
  // A network path (\\host\share, //host/share) is never a project's git folder, and even looking at it makes Windows
  // talk to that machine (and offer this user's credentials). Refused before anything touches it.
  if (isNetworkPath(dir)) return null;
  if (!fs.existsSync(dir)) return null;
  // Asked of git again whenever HEAD, its branch, the .git entry or the repo config changed (headIdentity), and for
  // any folder whose state cannot be read that way; an unchanged repo is not re-verified on every request.
  const repoIdentity = headIdentity(dir);
  const cacheKey = process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir);
  const known = repoIdentity ? topCache.get(cacheKey) : undefined;
  if (known && known.identity === repoIdentity && fs.existsSync(known.top)) return known.top;
  // Both answers come from one Git invocation, narrowing (but not eliminating) the gap between
  // top-level discovery and HEAD verification. `--verify` still makes an unborn or otherwise
  // invalid HEAD fail closed. The final line is the verified commit id; everything before its
  // delimiter is the top-level path and must retain meaningful whitespace and newlines.
  const identity = await runGit(dir, ["rev-parse", "--show-toplevel", "--verify", "HEAD^{commit}"]).catch(() => null);
  if (!identity || identity.code !== 0) return null;
  const output = identity.stdout.replace(/\r?\n$/, "");
  const head = /(?:^|\n)([0-9a-f]{40}|[0-9a-f]{64})$/i.exec(output);
  if (!head || head.index === 0) return null;
  const top = output.slice(0, head.index);
  const real = fs.realpathSync(top);
  // Remembered only if nothing it depends on moved while git was being asked.
  if (repoIdentity && headIdentity(dir) === repoIdentity) {
    topCache.delete(cacheKey);
    topCache.set(cacheKey, { top: real, identity: repoIdentity });
    if (topCache.size > 64) topCache.delete(topCache.keys().next().value as string);
  }
  return real;
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
  // The app's own data folder is never a project's repo, and never offered as one (it would send workers there).
  const candidate = typeof chosen === "string" && chosen ? chosen : project.appData ? "" : project.root;
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
  const suggested = extra || ownData || project.appData || repoRefusal(project.root) ? undefined : project.root;
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

/** The worktree manager for one repo of the project. Ledgers that share a git folder each get their own (see repoClaim.ts). */
async function manager(project: CoreProject, root: string, name: string | null = null): Promise<WorktreeManager> {
  const real = fs.realpathSync(root);
  const namespace = await repoNamespaceFor(project, real);
  let all = project.state.get(MANAGERS) as Map<string, WorktreeManager> | undefined;
  if (!all) {
    all = new Map();
    project.state.set(MANAGERS, all);
  }
  const key = namespace ? `${real}#${namespace}` : real;
  let current = all.get(key);
  if (!current) {
    current = new WorktreeManager({ repoRoot: root, ledger: project.ledger, maxParallel: parallelCap(), ...(namespace ? { namespace } : {}) });
    all.set(key, current);
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

/** Historical owner-selected identity, never a live worker or a runtime-model attestation. */
export function recordedWorkerDispatch(entries: readonly LedgerEntry[], label: string) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.subject !== label || entry.type !== "task.progress" || !isAuthoritative(entry, { personOnly: true })) continue;
    const value = entry.data?.workerDispatch;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const data = value as Record<string, unknown>;
    if (data.version !== 1 || typeof data.requestedAt !== "string" || !Number.isFinite(Date.parse(data.requestedAt))) continue;
    if (data.requestedModel !== undefined && (typeof data.requestedModel !== "string" || !MODEL.test(data.requestedModel))) continue;
    return { requestedAt: data.requestedAt, ...(typeof data.requestedModel === "string" ? { requestedModel: data.requestedModel } : {}) };
  }
  return null;
}

/** A signed receipt proves which self-report arrived, not the runtime model. */
export function recordedWorkerReport(entries: readonly LedgerEntry[], label: string, owner?: string | null) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.subject !== label || entry.actor.kind !== "system" || entry.actor.id !== "worker-identity" || !isAuthoritative(entry)) continue;
    const raw = entry.data?.workerReport;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    if (value.version !== 1 || typeof value.worker !== "string" || (owner && value.worker !== owner)) continue;
    if (value.reportedModel !== null && typeof value.reportedModel !== "string") continue;
    return { worker: value.worker, reportedModel: value.reportedModel, at: entry.at, entry: entry.n };
  }
  return null;
}

/** The worktrees the git watcher should read, or the plain reason it cannot see any. Errors are not swallowed: an unreadable list is not an empty one. */
export async function worktreesForWatcher(project: CoreProject): Promise<{ repo: RepoState; list: WorktreeInfo[] }> {
  const { repos, worktrees, inspection } = await allRepos(project, { tidyFolders: false });
  const repo = repos[0]!;
  if (!repo.ok && !repo.discovery && !fs.existsSync(repoFile(project))) return { repo, list: [] };
  const unreadable = repos.map((candidate) => ({ repo: candidate, result: inspection.get(candidate.name)! })).find(({ result }) => result.state !== "ready");
  if (unreadable) {
    const reason = unreadable.result.state === "pending"
      ? "Git worktree inspection is still running."
      : unreadable.result.state === "unavailable"
        ? unreadable.result.reason
        : "Git worktree inspection is unavailable.";
    throw new Error(`Cannot safely watch worktrees for ${unreadable.repo.name}: ${reason}`);
  }
  // A done task's folder is about to be removed (or waits for its clean-up), and a clean-up may be removing others right now:
  // a git process of ours inside one would keep Windows from removing it.
  const board = project.service.board();
  const quiet = quietLabels(project);
  return { repo, list: worktrees.filter((tree) => !quiet.has(tree.taskId) && board.get(tree.taskId.replace(/\.a\d+$/, ""))?.status !== "done") };
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

type FolderInfo = WorktreeInfo & { state?: string; note?: string };
export type OptionalGitResult<T> =
  | { state: "ready"; value: T }
  | { state: "pending" }
  | { state: "unavailable"; reason: string };

interface OptionalGitView<T> { failure?: string; inFlight: Promise<T> | null; value: T | undefined; updatedAt: number; }

/**
 * A bounded view of optional Git facts.  Timing out a reader deliberately does
 * not cancel it: the next poll joins the same read instead of starting another
 * Git child.  Crucially, pending or failed inspection is not an empty list.
 */
export function createOptionalGitCache<T>({ timeoutMs = OPTIONAL_GIT_VIEW_MS, cacheMs = OPTIONAL_GIT_CACHE_MS, now = () => Date.now() } = {}) {
  const entries = new Map<string, OptionalGitView<T>>();
  // Invalidating cached facts must not forget an operating-system read still
  // using this project's folders. Lifetime and freshness are separate.
  const active = new Set<Promise<T>>();
  let closing = false;
  async function read(key: string, load: () => Promise<T>): Promise<OptionalGitResult<T>> {
    if (closing) return { state: "unavailable", reason: "Project is closing; Git inspection is stopped." };
    let entry = entries.get(key);
    if (!entry) { entry = { inFlight: null, value: undefined, updatedAt: 0 }; entries.set(key, entry); }
    // A failure arriving after a caller timed out must be observable on the next poll.
    if (entry.failure !== undefined) { const reason = entry.failure; delete entry.failure; return { state: "unavailable", reason }; }
    if (entry.value !== undefined && now() - entry.updatedAt < cacheMs) return { state: "ready", value: entry.value };
    if (!entry.inFlight) {
      const target = entry;
      target.inFlight = Promise.resolve().then(load).then((value) => {
        target.value = value;
        target.updatedAt = now();
        return value;
      }, (error) => {
        target.failure = error instanceof Error ? error.message : "Git inspection failed.";
        throw error;
      }).finally(() => { target.inFlight = null; });
      const operation = target.inFlight;
      active.add(operation);
      // Both branches handle settlement; this observer creates no unhandled rejection.
      void operation.then(() => active.delete(operation), () => active.delete(operation));
      // A timed-out caller must not leave a later rejection unobserved.
      void target.inFlight.catch(() => undefined);
    }
    const inFlight = entry.inFlight;
    // Assigned immediately above when missing; retain an explicit guard for
    // TypeScript and never represent an impossible cache fault as no folders.
    if (!inFlight) return { state: "unavailable", reason: "Git inspection could not be started." };
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        inFlight.then((value) => ({ timedOut: false as const, value })),
        new Promise<{ timedOut: true }>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); }),
      ]);
      return result.timedOut ? { state: "pending" } : { state: "ready", value: result.value };
    } catch (error) {
      delete entry.failure; // This caller observed the rejection; an immediate retry is allowed.
      return { state: "unavailable", reason: error instanceof Error ? error.message : "Git inspection failed." };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    read,
    invalidate: (key: string) => entries.delete(key),
    clear: () => entries.clear(),
    beginClose: () => { closing = true; },
    drain: async () => {
      closing = true;
      await Promise.allSettled([...active]);
      entries.clear();
    },
  };
}

const optionalRepoViews = new WeakMap<CoreProject, ReturnType<typeof createOptionalGitCache<RepoState>>>();
const optionalGitViews = new WeakMap<CoreProject, ReturnType<typeof createOptionalGitCache<FolderInfo[]>>>();
interface AllocationReceipt { selection: string; root: string; repo: string; tree: FolderInfo; }
const allocatedWorktrees = new WeakMap<CoreProject, Map<string, AllocationReceipt>>();
const closingProjects = new WeakSet<CoreProject>();
function optionalCache(project: CoreProject) {
  let cache = optionalGitViews.get(project);
  if (!cache) {
    cache = createOptionalGitCache<FolderInfo[]>();
    if (closingProjects.has(project)) cache.beginClose();
    optionalGitViews.set(project, cache);
  }
  return cache;
}
export function beginCloseOptionalGitViews(project: CoreProject): void {
  closingProjects.add(project);
  optionalGitViews.get(project)?.beginClose();
  optionalRepoViews.get(project)?.beginClose();
}
export async function drainOptionalGitViews(project: CoreProject): Promise<void> {
  beginCloseOptionalGitViews(project);
  // Host shutdown waits for optional readers too: a still-running git process
  // can otherwise retain a Windows handle inside a just-closed test worktree.
  const cache = optionalGitViews.get(project);
  await Promise.all([cache?.drain(), optionalRepoViews.get(project)?.drain()]);
  allocatedWorktrees.delete(project);
}
function rememberAllocatedWorktree(project: CoreProject, repo: string | null, root: string, tree: FolderInfo, selection: string) {
  let known = allocatedWorktrees.get(project);
  if (!known) { known = new Map(); allocatedWorktrees.set(project, known); }
  const name = repo ?? PRIMARY_REPO;
  known.set(name + "\u0000" + tree.taskId, { selection, root, repo: name, tree: name === PRIMARY_REPO ? tree : { ...tree, repo: name } });
}
function optionalWorktreeKey(repo: RepoState, options: { tidyFolders?: boolean }) {
  // Root and access state are part of the identity: a changed/refused repo may
  // never inherit folder facts from its previous root.
  return `${options.tidyFolders === false ? "watch" : "board"}\u0000${repo.name}\u0000${repo.ok ? repo.root ?? "" : `refused:${repo.reason ?? "unknown"}`}`;
}
function invalidateOptionalWorktreeView(project: CoreProject, repo: RepoState, options: { tidyFolders?: boolean } = {}) {
  optionalCache(project).invalidate(optionalWorktreeKey(repo, options));
}
function optionalWorktreeView(project: CoreProject, repo: RepoState, options: { tidyFolders?: boolean }): Promise<OptionalGitResult<FolderInfo[]>> {
  if (!repo.ok || !repo.root) return Promise.resolve({ state: "unavailable", reason: repo.reason ?? "This repository is unavailable." });
  return optionalCache(project).read(optionalWorktreeKey(repo, options), () => listWorktrees(project, repo, options));
}

function viewTask(project: CoreProject, task: TaskView, worktrees: FolderInfo[], worktreeKnown: boolean, board: ReadonlyMap<string, TaskView>, assignments: ReadonlyMap<string, string>) {
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
    lastProgress: task.lastProgress ? { text: task.lastProgress, at: task.lastProgressAt } : null,
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
    // undefined means Git facts are not yet safe to report; null means inspected and absent.
    worktree: tree ? { path: tree.path, branch: tree.branch, base: tree.baseRef, port: tree.port, state: tree.state ?? "ok", ...(tree.note ? { note: tree.note } : {}) } : worktreeKnown ? null : undefined,
    dispatch: dispatch ? { issuedAt: dispatch.issuedAt, ...(dispatch.model ? { model: dispatch.model } : {}) } : null,
    workerDispatch: recordedWorkerDispatch(project.entries(), label),
    workerReport: recordedWorkerReport(project.entries(), label, task.owner),
    workerActivity: task.workerActivity ? { ...task.workerActivity,
      afterCheck: Boolean(gate.worktree && project.entries().findIndex(e => e.n === task.workerActivity!.entry) > project.entries().findIndex(e => e.n === gate.worktree!.n)),
    } : null,
    // Why this task cannot start yet (dispatch refuses it for the same reason), in plain words; null when nothing blocks it.
    waitingFor: unmet.length ? { tasks: unmet.map((d) => d.id), message: waitingMessage(label, unmet) } : null,
    // File claims this task's worktree holds, and, when nobody is working on it, why they can be released.
    claims: tree ? tree.claims : worktreeKnown ? [] : undefined,
    staleClaims,
    history: gate.history.slice(-12),
  };
}

async function listWorktrees(project: CoreProject, repo: RepoState, { tidyFolders = true } = {}): Promise<FolderInfo[]> {
  if (!repo.ok || !repo.root) return [];
  const worktrees = await manager(project, repo.root, repo.name);
  // On the first look after the app starts (and when a task finishes) stale records and safe leftovers are tidied; see worktreeCare.
  // The git watcher's look does not tidy: a clean-up waits for the watcher's pass, so the pass must never wait for the clean-up.
  if (tidyFolders) await tidy(project, worktrees, dispatches(project));
  // A rejected Git list is unavailable evidence, never a successful empty
  // list. optionalWorktreeView preserves that distinction for the board and
  // watcher rather than allowing accidental stale-worktree reconciliation.
  const list = await annotate(worktrees, await worktrees.list());
  // Only other repos are tagged: the first repo's worktrees look exactly as they always did.
  return repo.name === PRIMARY_REPO ? list : list.map((info) => ({ ...info, repo: repo.name }));
}

/** Optional discovery is read-only, deadline-bound and owned by the project lifetime.
 * Mutating dispatch continues to call requireRepo/repoState for fresh validation. */
function repoSelectionIdentity(project: CoreProject, name: string): string {
  // A changed selection or removed Git directory invalidates prior discovery.
  let selection = "";
  try { selection = fs.readFileSync(repoFile(project), "utf8"); } catch { /* no chosen repository */ }
  const extra = readRepos(project.root).repos.find((repo) => repo.name === name);
  let selected: string | undefined;
  try { selected = JSON.parse(selection).root; } catch { /* first imported folder */ }
  const candidate = extra?.root ?? (typeof selected === "string" && selected ? selected : project.appData ? "" : project.root);
  let gitStamp = "missing";
  if (candidate && !isNetworkPath(candidate)) {
    try { const stat = fs.statSync(path.join(candidate, ".git")); gitStamp = String(stat.dev) + ":" + stat.ino + (stat.isFile() ? ":" + fs.readFileSync(path.join(candidate, ".git"), "utf8") : ""); } catch { /* absence changes the key immediately */ }
  }
  return JSON.stringify([name, candidate, selection, gitStamp]);
}

async function optionalRepoState(project: CoreProject, name: string): Promise<RepoState> {
  let cache = optionalRepoViews.get(project);
  if (!cache) {
    cache = createOptionalGitCache<RepoState>();
    if (closingProjects.has(project)) cache.beginClose();
    optionalRepoViews.set(project, cache);
  }
  const key = repoSelectionIdentity(project, name);
  const result = await cache.read(key, () => repoState(project, name));
  if (result.state === "ready") return result.value;
  return { name, ok: false, discoveryIdentity: key, discovery: result.state, reason: result.state === "pending" ? "Checking this project's Git folder; the task ledger is ready." : result.reason };
}

/** Every repo of the project (the first one, then the extra ones) with the worktrees in each. A repo that cannot be read has its reason and no worktrees. */
async function allRepos(project: CoreProject, options: { tidyFolders?: boolean } = {}): Promise<{ repos: RepoState[]; worktrees: WorktreeInfo[]; inspection: Map<string, OptionalGitResult<FolderInfo[]>> }> {
  const before = new Map(allocatedWorktrees.get(project));
  const names = [PRIMARY_REPO, ...readRepos(project.root).repos.map((repo) => repo.name)];
  const repos = await Promise.all(names.map((name) => optionalRepoState(project, name)));
  // Worktree listing may invoke Git and optional hygiene.  It is not allowed to
  // delay the ledger view; the next poll fills the optional folder facts in.
  const known = allocatedWorktrees.get(project);
  // Snapshot which receipts predate this inspection. An old in-flight response
  // must not retire a receipt created by a concurrent dispatch.
  const results = await Promise.all(repos.map((repo) => repo.discovery === "pending" ? Promise.resolve({ state: "pending" as const }) : optionalWorktreeView(project, repo, options)));
  const inspection = new Map(repos.map((repo, index) => [repo.name, results[index]! ]));
  const listed = results.flatMap((result) => result.state === "ready" ? result.value : []);
  // A dispatch's actual create/get result is safe positive evidence even while
  // a replacement optional scan is pending. It never implies other trees are absent.
  for (const [key, receipt] of known ?? []) {
    const repo = repos.find((candidate) => candidate.name === receipt.repo);
    const result = repo && inspection.get(repo.name);
    const current = project.service.board().get(receipt.tree.taskId.replace(/\.a\d+$/, ""));
    const sameRoot = (repo?.ok && repo.root === receipt.root)
      || (repo?.discovery === "pending" && repo.discoveryIdentity === receipt.selection);
    const sameAttempt = current && attemptLabel(current) === receipt.tree.taskId && current.status !== "done";
    if (!sameRoot || !sameAttempt || result?.state === "unavailable") {
      if (before.get(key) === receipt) known!.delete(key);
      continue;
    }
    if (result?.state === "ready") {
      // A watcher scan must not consume the board's pending dispatch receipt.
      if (options.tidyFolders !== false && before.get(key) === receipt) known!.delete(key);
      continue;
    }
    if (result?.state === "pending" && !listed.some((item) => item.taskId === receipt.tree.taskId && (item.repo ?? PRIMARY_REPO) === receipt.repo)) listed.push(receipt.tree);
  }
  return { repos, inspection, worktrees: listed };
}

/**
 * Whether approved test commands run inside the OS sandbox. True only when the person opted in
 * (PP_CONTAIN_TESTS=1, the same switch testRunnerFor reads), this is Linux and bubblewrap works.
 * Never true on Windows or macOS. Anything else is "not contained", and the screen says so.
 */
export async function containmentView(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<{ contained: boolean; by?: "bubblewrap" }> {
  if (env.PP_CONTAIN_TESTS !== "1" || platform !== "linux") return { contained: false };
  return (await sandboxStatus(platform, env)).kind === "bubblewrap" ? { contained: true, by: "bubblewrap" } : { contained: false };
}

export async function overview(project: CoreProject) {
  const { repos, worktrees, inspection } = await allRepos(project);
  const board = project.service.board();
  const assignments = replayRoster(project.entries(), project.ledger.owner).assignments;
  const tasks = [...board.values()].map((task) => {
    const repo = task.repo ?? PRIMARY_REPO;
    return viewTask(project, task, worktrees, inspection.get(repo)?.state === "ready", board, assignments);
  });
  // What is missing before "Check the work" can run, in plain words (only while a task is being built).
  await Promise.all(tasks.filter((task) => task.stage === "building" && task.worktree).map(async (task) => Object.assign(task, { checkReady: await checkReadiness({ proofs: task.proofs, worktree: task.worktree! }) })));
  const settings = taskSettings(project);
  return {
    repo: repos[0]!, containment: await containmentView(), settings, queue: queueOf(tasks, settings.limit),
    repos: repos.map((repo) => {
      const result = inspection.get(repo.name)!;
      return { ...repo, worktrees: result.state === "ready" ? worktrees.filter((w) => (w.repo ?? PRIMARY_REPO) === repo.name).length : undefined, worktreeInspection: result.state === "ready" ? "ready" : result.state, ...(result.state === "unavailable" ? { worktreeInspectionReason: result.reason } : {}) };
    }),
    tasks, groups: taskGroups(tasks),
  };
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

async function worktreeFor(project: CoreProject, label: string, validatedRoot?: string): Promise<WorktreeInfo> {
  const name = repoOfLabel(project, label);
  const root = validatedRoot ?? await requireRepo(project, name);
  const tree = await (await manager(project, root, name)).get(label);
  if (!tree) throw new HttpError(409, "NO_WORKTREE", `${label} has no worktree yet. Start a worker on it first.`);
  if (!fs.existsSync(tree.path)) throw new HttpError(409, "WORKTREE_MISSING", `The folder for ${label} was deleted outside Perfect Planner. Its work is safe on the branch ${tree.branch}; press "Recreate the folder" on this task first.`);
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
    "4. Build it in small commits. report_progress after each step with explicit activity: working while doing work, waiting when paused, finished when this work is complete. Omitted activity does not show busy. ask_main when you need a decision (a blocking question pauses only you).",
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
    claude: { setup: agentSetup("claude"), start: `claude ${brief}`, note: "Use only when you explicitly choose Claude Code." },
    gemini: { setup: agentSetup("gemini"), start: `gemini --approval-mode auto_edit -i ${brief}`, note: "Choose Trust folder first (start gemini once in the task folder), or the set-up command is refused." },
    codex: { setup: agentSetup("codex"), start: `codex -s workspace-write -a on-request ${brief}`, note: "Codex keeps one connection for this computer, so this replaces any other Codex worker's." },
  };
  return { setup, start: agents.codex.start, json, agents, shell: windows ? "PowerShell" : "Terminal" };
}

// ---------- routes ----------

function bodyOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

async function dispatch(project: CoreProject, host: CoreHost, id: string, body: Record<string, unknown>) {
  if (!host.bridgeEnabled) throw new HttpError(503, "BRIDGE_OFF", "Agent connections are turned off for this app, so a worker has nothing to connect to.");
  const repoName = repoOfLabel(project, id);
  const selectionAtDispatch = repoSelectionIdentity(project, repoName ?? PRIMARY_REPO);
  const root = await requireRepo(project, repoName);
  const task = findTask(project, id);
  if (task.status === "done") throw new HttpError(409, "DONE", `${id} is already done.`);
  // A task whose dependencies are not done yet does not start: say which ones, in plain words.
  const unmet = unmetDependencies(project.service.board(), task);
  if (unmet.length) throw new HttpError(409, "WAITING_FOR_DEPENDENCY", waitingMessage(attemptLabel(task), unmet));
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  if (model !== undefined && !MODEL.test(model)) throw new HttpError(400, "INVALID", "Name the worker's model in letters, digits and . _ : / - (for example claude-sonnet-4).");
  const label = attemptLabel(task);
  const worktrees = await manager(project, root, repoName);
  const tree = await worktrees.getOrCreateForDispatch({ taskId: label, actor: localPerson(project) }).catch((error: unknown) => {
    if (error instanceof DispatchWorktreeError) {
      throw new HttpError(409, error.reason === "missing" ? "WORKTREE_MISSING" : "WORKTREE_UNLINKED", error.message);
    }
    if (error instanceof WorktreeError) throw new HttpError(409, "WORKTREE", error.message);
    throw error;
  });
  // A just-created/reused worktree must be visible on the very next board and
  // watcher read, rather than hidden behind the optional Git view TTL.
  const repo: RepoState = { name: repoName ?? PRIMARY_REPO, ok: true, root };
  invalidateOptionalWorktreeView(project, repo);
  invalidateOptionalWorktreeView(project, repo, { tidyFolders: false });
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
  // Persist only the person's selection, never credentials or a claim that the CLI used it.
  project.ledger.append({ actor: localPerson(project), type: "task.progress", subject: label,
    summary: "Worker connection prepared", evidence: [], refs: [],
    data: { workerDispatch: { version: 1, requestedAt: record.issuedAt, ...(model ? { requestedModel: model } : {}) } },
  });
  // Publish positive evidence at successful handoff, after the async dispatch
  // work. Pending discovery can reuse it only for this exact selection identity.
  rememberAllocatedWorktree(project, repoName, root, tree, selectionAtDispatch);
  optionalRepoViews.get(project)?.clear();
  invalidateOptionalWorktreeView(project, repo);
  invalidateOptionalWorktreeView(project, repo, { tidyFolders: false });
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
    result = await (await manager(project, root, repoName)).updateFromMain(label);
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
  const tree = await (await manager(project, root, repoName)).get(id);
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
  const done = await (await manager(project, root, repoName)).releaseClaims(id, files);
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
  // A committed release must not wait for optional Git inspection of this or other tasks.
  return { released: label, from: owner, entry: entry.n };
}

/**
 * What the worker changed from where the worktree branched to the tip, plus the files among them the gate
 * itself treats as sensitive (core/gate sensitiveChanges: install scripts, lockfiles, git attributes and
 * hooks, workflows, npm and build settings, and the approved test's own support files). The diff screen
 * lists those in a block that needs its own confirmation, so the person reads them before approving.
 */
async function changedFiles(project: CoreProject, label: string, tree: { path: string; baseSha: string }, tip: string): Promise<{ files: string[]; sensitive: string[] }> {
  const state = deriveState(project.entries(), label);
  const pinned = Object.keys(state.approval?.pins ?? {});
  // Three independent reads of the same two commits: the list of changed files, the files the test depends on, and which pinned files are untouched.
  const [listed, support, unchanged] = await Promise.all([
    git(tree.path, ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", tree.baseSha, tip]),
    state.definition ? testSupportFiles(tree.path, [tree.baseSha, tip], pinned, state.definition.command) : Promise.resolve(new Set<string>()),
    state.approval ? unalteredPins(tree.path, tip, state.approval.pins) : Promise.resolve(new Set<string>()),
  ]);
  const files = listed.split(/\r?\n/).filter(Boolean).sort();
  return { files, sensitive: sensitiveChanges(files, pinned, support, unchanged).sort() };
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
  router.post("/tasks/:id/dispatch", ({ project, host, params, body }) => withHygieneLock(project, () => dispatch(project, host, params.id!, bodyOf(body))));

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
  router.get("/tasks/:id/check-input", async ({ project, params }) => {
    const task = findTask(project, params.id!);
    const attempt = attemptLabel(task);
    const state = deriveState(project.entries(), attempt);
    if (!state.definition || !state.approval) throw new HttpError(409, "CHECK_NOT_READY", "Approve the task's test before preparing a check.");
    const tree = await worktreeFor(project, attempt);
    const commit = await git(tree.path, ["rev-parse", "HEAD"]);
    return { attempt, expected: { definitionEntry: state.definition.n, approvalEntry: state.approval.n, pin: state.approval.pin, commit } };
  });

  router.get("/tasks/:id/checks/:requestId", ({ project, params }) => {
    const saved = project.service.gate.checks.status(params.requestId!);
    if (!saved || saved.execution.attempt.replace(/\.a\d+$/, "") !== params.id) throw new HttpError(404, "NOT_FOUND", "This task has no recorded check with that request ID.");
    return saved;
  });

  router.post("/tasks/:id/check", async ({ project, params, body }) => {
    let request;
    try { request = checkRequest(body); } catch (error) { throw new HttpError(400, "INVALID_CHECK_REQUEST", (error as Error).message); }
    if (request.attempt.replace(/\.a\d+$/, "") !== params.id) throw new HttpError(400, "INVALID_CHECK_REQUEST", "The saved request names a different task.");
    const scope = JSON.stringify([project.root, project.entries()[0]?.hash]);
    const run = await project.service.gate.proveRequest(request, scope, async () => {
      const current = findTask(project, params.id!);
      if (attemptLabel(current) !== request.attempt) throw stale("This task has a newer attempt. The saved check cannot run there.");
      return (await worktreeFor(project, request.attempt)).path;
    });
    if (!run.ok && !run.run && !run.entry) refuse(run);
    return { passed: run.ok, ...(run.commit ? { commit: run.commit } : {}),
      ...(run.ok ? {} : { reason: run.reason }), ...(run.run ? { output: run.run.outputTail } : {}),
      entry: run.entry?.n, execution: run.entry?.data?.execution };
  });

  /** GET /tasks/:id/diff: what the worker changed, from where the worktree branched to its tip. */
  router.get("/tasks/:id/diff", async ({ project, params }) => {
    const task = findTask(project, params.id!);
    const tree = await worktreeFor(project, attemptLabel(task));
    const tip = await git(tree.path, ["rev-parse", "HEAD"]);
    const [{ files, sensitive }, text] = await Promise.all([
      changedFiles(project, attemptLabel(task), tree, tip),
      git(tree.path, ["diff", "--no-color", "--no-renames", tree.baseSha, tip]),
    ]);
    return { task: attemptLabel(task), base: tree.baseSha, commit: tip, files, sensitive, text: text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n… diff cut at ${MAX_DIFF} characters` : text, truncated: text.length > MAX_DIFF };
  });

  /** POST /tasks/:id/approve-diff: the person approves the diff at the commit the test passed on. */
  const approveDiff = async (project: CoreProject, id: string, body: unknown) => {
    const task = findTask(project, id);
    const label = attemptLabel(task);
    const passed = deriveState(project.entries(), label).worktree;
    // The router has authenticated the person's request. The signed check can
    // already refuse an absent/wrong commit without discovering Git folders.
    if (!passed?.passed || !sameCommit(bodyOf(body).commit, passed.commit)) {
      throw stale("The work changed since you reviewed it. Check it again and read the new diff before approving.");
    }
    // One fresh validated tree for this request, never a cross-request cache.
    const tree = await worktreeFor(project, label);
    const tip = await git(tree.path, ["rev-parse", "HEAD"]);
    // The actual current HEAD must still be exactly the checked/reviewed commit.
    if (!sameCommit(bodyOf(body).commit, tip) || !sameCommit(passed.commit, tip)) {
      throw stale("The work changed since you reviewed it. Check it again and read the new diff before approving.");
    }
    // Files that can run code on this machine need their own confirmation, naming exactly those files.
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
    const tree = await worktreeFor(project, label, root);
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
    await project.watch?.waitForCurrentTick();
    const removed = await (await manager(project, root, task.repo)).remove(label, WORKTREES_ACTOR).catch((error: Error) => ({ error: error.message }));
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

  registerWorktreeCareRoutes(router, { requireRepo, manager, repoNames: (project) => [null, ...readRepos(project.root).repos.map((repo) => repo.name)], repoOf: repoOfLabel, dispatched: dispatches, findTask, overview });
}
