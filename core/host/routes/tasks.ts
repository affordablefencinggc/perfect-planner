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
import { attemptLabel, unmetDependencies, waitingMessage, type TaskView } from "../../mcp/index";
import { WorktreeError, WorktreeManager, git, refreshCarriedSettings, runGit, WORKTREES_ACTOR, type WorktreeInfo } from "../../worktrees/index";
import type { CoreHost } from "../host";
import type { CoreProject } from "../project";
import { HttpError, type Router } from "../router";
import { AGENT_SERVER_NAME, agentEntryPath, connectLine, nodeBinary, quoteFor, tokenFilePath, writeTokenFile } from "./agents";

export { quoteFor };
import { localPerson, localPersonId } from "./people";
import { annotate, checkReadiness, prepareForDispatch, registerWorktreeCareRoutes, tidy, withHygieneLock } from "./worktreeCare";
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

async function gitTop(dir: string): Promise<string | null> {
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

/** The person's chosen repo, else the project folder when it is a git checkout with a commit. */
export async function repoState(project: CoreProject): Promise<RepoState> {
  let chosen: string | undefined;
  try {
    chosen = (JSON.parse(fs.readFileSync(repoFile(project), "utf8")) as { root?: unknown }).root as string | undefined;
  } catch {
    chosen = undefined;
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
    return taken ? { ok: false, reason: taken } : { ok: true, root: top };
  }
  const suggested = project.appData || repoRefusal(project.root) ? undefined : project.root;
  if (refusal) return { ok: false, reason: refusal, suggested };
  return {
    ok: false,
    suggested,
    reason: chosen
      ? `${chosen} is no longer a git repository with a commit. Choose your project's git folder again.`
      : "Workers need your project's git folder (with at least one commit) to branch from. Choose it below.",
  };
}

async function requireRepo(project: CoreProject): Promise<string> {
  const repo = await repoState(project);
  if (!repo.ok || !repo.root) throw new HttpError(409, "NO_REPO", repo.reason ?? "Choose your project's git folder first.");
  const taken = await repoClaimRefusal(project, repo.root, { write: true });
  if (taken) throw new HttpError(409, "REPO_IN_USE", taken);
  project.protectRoots([repo.root]);
  return repo.root;
}

function manager(project: CoreProject, root: string): WorktreeManager {
  let current = project.state.get(MANAGER) as WorktreeManager | undefined;
  if (!current || current.repoRoot !== fs.realpathSync(root)) {
    current = new WorktreeManager({ repoRoot: root, ledger: project.ledger });
    project.state.set(MANAGER, current);
    project.protectRoots([current.repoRoot, current.worktreeRoot]);
  }
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
  const repo = await repoState(project);
  if (!repo.ok || !repo.root) return { repo, list: [] };
  // A done task's folder is about to be removed (or waits for its clean-up): a git process of ours inside it would keep Windows from removing it.
  const board = project.service.board();
  const list = (await manager(project, repo.root).list()).filter((tree) => board.get(tree.taskId.replace(/\.a\d+$/, ""))?.status !== "done");
  return { repo, list };
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

function viewTask(project: CoreProject, task: TaskView, worktrees: FolderInfo[], board: ReadonlyMap<string, TaskView>) {
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
    title: task.title,
    status: task.status,
    owner: task.owner,
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
    worktree: tree ? { path: tree.path, branch: tree.branch, base: tree.baseRef, port: tree.port, state: tree.state ?? "ok", ...(tree.note ? { note: tree.note } : {}) } : null,
    dispatch: dispatch ? { issuedAt: dispatch.issuedAt, ...(dispatch.model ? { model: dispatch.model } : {}) } : null,
    // Why this task cannot start yet (dispatch refuses it for the same reason), in plain words; null when nothing blocks it.
    waitingFor: unmet.length ? { tasks: unmet.map((d) => d.id), message: waitingMessage(label, unmet) } : null,
    // File claims this task's worktree holds, and, when nobody is working on it, why they can be released.
    claims: tree?.claims ?? [],
    staleClaims,
    history: gate.history.slice(-12),
  };
}

async function listWorktrees(project: CoreProject, repo: RepoState): Promise<FolderInfo[]> {
  if (!repo.ok || !repo.root) return [];
  const worktrees = manager(project, repo.root);
  // On the first look after the app starts (and when a task finishes) stale records and safe leftovers are tidied; see worktreeCare.
  await tidy(project, worktrees, dispatches(project));
  return annotate(worktrees, await worktrees.list().catch(() => []));
}

async function overview(project: CoreProject) {
  const repo = await repoState(project);
  const worktrees = await listWorktrees(project, repo);
  const board = project.service.board();
  const tasks = [...board.values()].map((task) => viewTask(project, task, worktrees, board));
  // What is missing before "Check the work" can run, in plain words (only while a task is being built).
  await Promise.all(tasks.filter((task) => task.stage === "building" && task.worktree).map(async (task) => Object.assign(task, { checkReady: await checkReadiness({ proofs: task.proofs, worktree: task.worktree! }) })));
  return { repo, tasks };
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
  const root = await requireRepo(project);
  const tree = await manager(project, root).get(label);
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
  return { setup, start, json, shell: windows ? "PowerShell" : "Terminal" };
}

// ---------- routes ----------

function bodyOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

async function dispatch(project: CoreProject, host: CoreHost, id: string, body: Record<string, unknown>) {
  if (!host.bridgeEnabled) throw new HttpError(503, "BRIDGE_OFF", "Agent connections are turned off for this app, so a worker has nothing to connect to.");
  const root = await requireRepo(project);
  const task = findTask(project, id);
  if (task.status === "done") throw new HttpError(409, "DONE", `${id} is already done.`);
  // A task whose dependencies are not done yet does not start: say which ones, in plain words.
  const unmet = unmetDependencies(project.service.board(), task);
  if (unmet.length) throw new HttpError(409, "WAITING_FOR_DEPENDENCY", waitingMessage(attemptLabel(task), unmet));
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  if (model !== undefined && !MODEL.test(model)) throw new HttpError(400, "INVALID", "Name the worker's model in letters, digits and . _ : / - (for example claude-sonnet-4).");
  const label = attemptLabel(task);
  const worktrees = manager(project, root);
  await prepareForDispatch(worktrees, label);
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
  const person = localPersonId(project);
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
  const root = await requireRepo(project);
  const task = findTask(project, id);
  const label = attemptLabel(task);
  if (task.status === "done") throw new HttpError(409, "DONE", `${label} is already done.`);
  await worktreeFor(project, label);
  let result;
  try {
    result = await manager(project, root).updateFromMain(label);
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
  const root = await requireRepo(project);
  const tree = await manager(project, root).get(id);
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
  const done = await manager(project, root).releaseClaims(id, files);
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
  return { files, sensitive: sensitiveChanges(files, pinned, support).sort() };
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
  router.post("/tasks/:id/approve-diff", async ({ project, params, body }) => {
    const task = findTask(project, params.id!);
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
    return { approved: true, ...(jev ? { jev } : {}), ...(await overview(project)) };
  });

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
  router.post("/tasks/:id/merge", async ({ project, params, body }) => {
    const task = findTask(project, params.id!);
    const label = attemptLabel(task);
    const root = await requireRepo(project);
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
    const merged = await project.service.gate.mergeAndVerify(label, { repoRoot: root, branch: tree.branch, integrationBranch: tree.baseRef, actor: localPerson(project) });
    if (!merged.ok) throw new HttpError(409, "REFUSED", withOutputTail(merged.reason, merged.output));
    revokeWorker(project, label);
    dispatches(project).delete(label);
    // A watcher pass that began before the task was done may still have git running in its folder, which Windows will not remove.
    await project.watch?.tick();
    const removed = await manager(project, root).remove(label, WORKTREES_ACTOR).catch((error: Error) => ({ error: error.message }));
    return { merged: true, commit: merged.mergeCommit, into: tree.baseRef, removed, ...(await overview(project)) };
  });

  registerWorktreeCareRoutes(router, { requireRepo, manager, dispatched: dispatches, findTask, overview });
}
