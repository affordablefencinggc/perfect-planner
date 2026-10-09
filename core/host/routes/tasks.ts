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
import os from "node:os";
import path from "node:path";
import { deriveState, type GateState } from "../../gate/index";
import type { Actor } from "../../ledger/index";
import { attemptLabel, type TaskView } from "../../mcp/index";
import { WorktreeError, WorktreeManager, git, runGit, WORKTREES_ACTOR, type WorktreeInfo } from "../../worktrees/index";
import type { CoreHost } from "../host";
import type { CoreProject } from "../project";
import { HttpError, type Router } from "../router";
import { AGENT_SERVER_NAME, agentEntryPath, connectLine, quoteFor, tokenFilePath, writeTokenFile } from "./agents";

export { quoteFor };
import { localPerson, localPersonId } from "./people";
import { protectRepository } from "../project";

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
}

// ---------- the repository the worktrees branch from ----------

function repoFile(project: CoreProject): string {
  return path.join(project.root, ".perfect-planner", REPO_FILE);
}

/**
 * The repo folder the person picked for a project (kept in its .perfect-planner/), read without running
 * anything, so the host can protect it before its first git run. Never a whole drive or the home folder.
 */
export function chosenRepoRoot(projectRoot: string): string | undefined {
  try {
    const root = (JSON.parse(fs.readFileSync(path.join(projectRoot, ".perfect-planner", REPO_FILE), "utf8")) as { root?: unknown }).root;
    return typeof root === "string" && path.isAbsolute(root) && !repoRefusal(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

async function gitTop(dir: string): Promise<string | null> {
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
  const candidate = typeof chosen === "string" && chosen ? chosen : project.root;
  const top = await gitTop(candidate);
  // git found the repo by walking up from the folder: a whole drive or the home folder (a dotfiles repo)
  // is never the project's repo, so it is neither used nor protected.
  const refusal = top ? repoRefusal(top) : null;
  if (top && !refusal) return { ok: true, root: top };
  if (refusal) return { ok: false, reason: refusal };
  return {
    ok: false,
    reason: chosen
      ? `${chosen} is no longer a git repository with a commit. Choose your project's git folder again.`
      : "Workers need your project's git folder (with at least one commit) to branch from. Choose it below.",
  };
}

/** Folders that are never a project to hand to workers: a whole drive or the home folder itself. */
export function repoRefusal(top: string, home = os.homedir()): string | null {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const dir = real(top);
  if (same(path.dirname(dir), dir)) return `${dir} is a whole drive. Choose your project's own git folder.`;
  if (same(dir, real(home))) return `${dir} is your home folder. Choose your project's own git folder.`;
  return null;
}

async function requireRepo(project: CoreProject): Promise<string> {
  const repo = await repoState(project);
  if (!repo.ok || !repo.root) throw new HttpError(409, "NO_REPO", repo.reason ?? "Choose your project's git folder first.");
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

function viewTask(project: CoreProject, task: TaskView, worktrees: WorktreeInfo[]) {
  const label = attemptLabel(task);
  const gate = deriveState(project.entries(), label);
  const tree = worktrees.find((w) => w.taskId === label);
  const dispatch = dispatches(project).get(label);
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
    stage: stageOf(task, gate),
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
    history: gate.history.slice(-12),
  };
}

async function listWorktrees(project: CoreProject, repo: RepoState): Promise<WorktreeInfo[]> {
  if (!repo.ok || !repo.root) return [];
  return manager(project, repo.root).list().catch(() => []);
}

async function overview(project: CoreProject) {
  const repo = await repoState(project);
  const worktrees = await listWorktrees(project, repo);
  const tasks = [...project.service.board().values()].map((task) => viewTask(project, task, worktrees));
  return { repo, tasks };
}

function findTask(project: CoreProject, id: string): TaskView {
  const task = project.service.board().get(id);
  if (!task) throw new HttpError(404, "NOT_FOUND", `${id} is not on the board. Approve the plan or add the task first.`);
  return task;
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
  const json = JSON.stringify({ mcpServers: { [AGENT_SERVER_NAME]: { command: "node", args: [entry], env: { PP_BRIDGE_URL: bridgeUrl, PP_AGENT_TOKEN_FILE: tokenFile } } } }, null, 2);
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
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  if (model !== undefined && !MODEL.test(model)) throw new HttpError(400, "INVALID", "Name the worker's model in letters, digits and . _ : / - (for example claude-sonnet-4).");
  const label = attemptLabel(task);
  const worktrees = manager(project, root);
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
    // Shipping safety follows the folder: release rules on, and the pre-push secret scan installed there.
    const protection = await protectRepository(project.ledger, top);
    fs.mkdirSync(path.dirname(repoFile(project)), { recursive: true });
    fs.writeFileSync(repoFile(project), JSON.stringify({ root: top, at: new Date().toISOString() }, null, 2));
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
   */
  router.post("/tasks/:id/approve-test", async ({ project, params, body }) => {
    const task = findTask(project, params.id!);
    const label = attemptLabel(task);
    const tree = await worktreeFor(project, label);
    const gate = project.service.gate;
    const state = gate.state(label);
    if (!state.approval) {
      // Bound to the definition the person read: a worker re-proposing a different test meanwhile makes this stale.
      if (!state.definition || bodyOf(body).test !== state.definition.n) throw stale("The test changed since you looked at it. Read the new one, then approve it.");
      refuse(gate.approve(label, localPerson(project), { cwd: tree.path }));
    }
    const first = await gate.confirmFailsFirst(label, tree.path);
    return {
      approved: true,
      failsFirst: first.ok,
      ...(first.ok ? {} : { reason: first.reason }),
      ...(first.run ? { output: first.run.outputTail } : {}),
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
    const files = (await git(tree.path, ["diff", "--name-only", "--no-renames", tree.baseSha, tip])).split(/\r?\n/).filter(Boolean).sort();
    const text = await git(tree.path, ["diff", "--no-color", "--no-renames", tree.baseSha, tip]);
    return { task: attemptLabel(task), base: tree.baseSha, commit: tip, files, text: text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n… diff cut at ${MAX_DIFF} characters` : text, truncated: text.length > MAX_DIFF };
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
    refuse(project.service.gate.approveDiff(attemptLabel(task), localPerson(project)));
    return overview(project);
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
    // The click is the person's merge approval: signed with their key, in their own window's request,
    // for exactly this commit. The gate refuses to merge without it (never reachable from an agent).
    const state = deriveState(project.entries(), label);
    if (!state.mergeApproval || state.mergeApproval.commit !== approved) refuse(project.service.gate.approveMerge(label, localPerson(project), approved));
    const merged = await project.service.gate.mergeAndVerify(label, { repoRoot: root, branch: tree.branch, integrationBranch: tree.baseRef, actor: localPerson(project) });
    if (!merged.ok) throw new HttpError(409, "REFUSED", merged.reason);
    revokeWorker(project, label);
    dispatches(project).delete(label);
    const removed = await manager(project, root).remove(label, WORKTREES_ACTOR).catch((error: Error) => ({ error: error.message }));
    return { merged: true, commit: merged.mergeCommit, into: tree.baseRef, removed, ...(await overview(project)) };
  });
}
