// Task contracts on the Tasks screen's routes: what a task may change, the check of the finished work
// against it, and the person's widening. The rules live in core/planning (the contract and its signing)
// and core/gate (the check); this file only reads the ledger, calls them and shapes the answers.
//
// Nothing here trusts the worktree: where the work started comes from the signed worktree.created entry,
// the limits come from the signed contract, and a worker can only ask (ask_main) for more.
import { checkContract, latestContractVerdict, patternProblem, recordContractVerdict, type ContractCheck } from "../../gate/index";
import { isAuthoritative, type LedgerEntry } from "../../ledger/index";
import type { TaskView } from "../../mcp/index";
import { planningRoot } from "./planning";
import { ContractError, baseTaskId, contractOf, listRepoFiles, widenContract, type ContractView, type RepoIndex } from "../../planning/index";
import { WORKTREES_ACTOR, git, type WorktreeInfo, type WorktreeManager } from "../../worktrees/index";
import type { CoreProject } from "../project";
import { repoRefusal } from "../protectedRoots";
import { HttpError } from "../router";
import { localPerson } from "./people";

const SCAN_KEY = "contract.repoScan";
const SCAN_TTL_MS = 10_000;
const FULL_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// ---------- the repo's files, for guessing which files a task needs ----------

/** The folder planning reads the repo's file list from: the repo the person chose, else the project folder (never a drive or the home folder). */
function scanRoot(project: CoreProject): string | undefined {
  const root = planningRoot(project);
  return repoRefusal(root) ? undefined : root;
}

/** The repo's file list (names only, nothing opened), kept for a few seconds so one screen load reads the folder once. */
export function repoIndex(project: CoreProject): RepoIndex {
  const root = scanRoot(project);
  if (!root) return { files: [], truncated: false };
  const cached = project.state.get(SCAN_KEY) as { root: string; at: number; index: RepoIndex } | undefined;
  if (cached && cached.root === root && Date.now() - cached.at < SCAN_TTL_MS) return cached.index;
  const index = listRepoFiles(root);
  project.state.set(SCAN_KEY, { root, at: Date.now(), index });
  return index;
}

// ---------- reading the contract ----------

/** The commit the task's worktree branched from, as the manager's signed worktree.created entry recorded it (never the editable registry). */
export function signedBase(entries: readonly LedgerEntry[], label: string): string | undefined {
  let base: string | undefined;
  for (const e of entries) {
    if (e.type !== "worktree.created" || e.subject !== label || !isAuthoritative(e)) continue;
    if (e.actor.kind !== WORKTREES_ACTOR.kind || e.actor.id !== WORKTREES_ACTOR.id) continue;
    const sha = typeof e.data?.baseSha === "string" ? e.data.baseSha.toLowerCase() : "";
    base = FULL_SHA.test(sha) ? sha : undefined;
  }
  return base;
}

/** The task's contract as the Tasks screen shows it, or null when the task has none. */
export function contractCard(entries: readonly LedgerEntry[], taskId: string, label: string) {
  const view = contractOf(entries, taskId);
  if (!view) return null;
  const verdict = latestContractVerdict(entries, label);
  return {
    status: view.status,
    ...(view.problem ? { problem: view.problem } : {}),
    ...(view.plan ? { plan: view.plan } : {}),
    clauses: view.contract.clauses,
    doneWhen: view.contract.doneWhen,
    /** What the owner signed. */
    listed: view.contract.allowedFiles,
    /** The signed list plus every widening: what the task may change. */
    allowedFiles: view.allowedFiles,
    sizeCap: view.contract.sizeCap,
    flags: view.flags.map((f) => f.message),
    flagsAccepted: view.flagsAccepted,
    widened: view.widened.map((w) => ({ decision: w.decision, files: w.files, by: w.by, at: w.at, ...(w.reason ? { reason: w.reason } : {}), ...(w.question ? { question: w.question } : {}) })),
    check: verdict ? { ok: verdict.ok, commit: verdict.commit, files: verdict.files, lines: verdict.lines, ...(verdict.reason ? { reason: verdict.reason } : {}) } : null,
  };
}

/** Refuses (409) while a task's contract is not the one the owner signed. Null when the task has no contract. */
export function signedContract(entries: readonly LedgerEntry[], taskId: string): ContractView | null {
  const view = contractOf(entries, taskId);
  if (view && view.status !== "signed") {
    throw new HttpError(409, "CONTRACT_UNSIGNED", `${view.problem ?? `The contract on ${view.task} is not signed.`} Nothing was started or checked. Approve the plan again, or ask for the task to be rewritten.`);
  }
  return view;
}

/** A line or two for the worker's brief; the full text is on the Tasks screen. */
export function briefContract(view: ContractView | null): string[] {
  if (!view) return [];
  const cap = view.contract.sizeCap;
  return [
    "Your contract (the owner signed it; Perfect Planner measures your work against it and refuses anything outside it):",
    `- You may change only: ${view.allowedFiles.length ? view.allowedFiles.join(", ") : "nothing yet (ask first)"}.`,
    `- At most ${cap.maxFiles} changed file${cap.maxFiles === 1 ? "" : "s"} and ${cap.maxLines} changed lines in all.`,
    "- Dependency files and lockfiles (package.json, package-lock.json and the like) count as outside unless they are listed above. Never touch .perfect-planner or .git.",
    "- Need another file? Call ask_main with the file and why. Only the owner can widen your contract; you cannot, and no answer you write counts.",
    "",
  ];
}

// ---------- dispatch ----------

/**
 * An earlier attempt of the same task holds the same files in its claims, and its worker is gone. Its
 * claims are freed (the worktree and branch stay) so they do not block the next attempt.
 */
export async function freeOlderAttempts(worktrees: WorktreeManager, view: ContractView, label: string): Promise<void> {
  for (const old of await worktrees.list()) {
    if (old.taskId !== label && baseTaskId(old.taskId) === view.task && old.claims.length) await worktrees.dropClaims(old.taskId);
  }
}

// ---------- check the work ----------

/** Files other running tasks have claimed: a change there is refused even when this task's list covers it. */
function otherClaims(worktrees: readonly WorktreeInfo[], view: ContractView) {
  return worktrees.filter((w) => baseTaskId(w.taskId) !== view.task && w.claims.length > 0).map((w) => ({ taskId: w.taskId, claims: w.claims }));
}

/**
 * Measures the worker's commits against the signed contract and writes the gate's verdict. Run before
 * anything from the worktree is executed: work that breaks its contract is never run by "Check the work".
 */
export async function checkWork(project: CoreProject, label: string, tree: WorktreeInfo, view: ContractView, worktrees: readonly WorktreeInfo[]): Promise<ContractCheck> {
  const entries = project.entries();
  const base = signedBase(entries, label);
  if (!base) {
    throw new HttpError(409, "NO_BASE", `There is no signed record of where ${label} started, so its work cannot be measured against its contract. Nothing was checked. Start the worker again on a fresh attempt.`);
  }
  const tip = (await git(tree.path, ["rev-parse", "HEAD"])).trim().toLowerCase();
  const pinned = Object.keys(project.service.gate.state(label).approval?.pins ?? {});
  const check = await checkContract(tree.path, {
    base,
    tip,
    limits: { allowedFiles: view.allowedFiles, sizeCap: view.contract.sizeCap },
    context: { taskLabel: label, otherClaims: otherClaims(worktrees, view), approvedTestFiles: pinned },
  });
  recordContractVerdict(project.ledger, label, check);
  return check;
}

// ---------- widening ----------

function fileList(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\r\n,]+/) : [];
  if (raw !== undefined && !Array.isArray(raw) && typeof raw !== "string") throw new HttpError(400, "INVALID", "Name the files as a list of paths.");
  const files = items.map((item) => {
    if (typeof item !== "string") throw new HttpError(400, "INVALID", "Every file path must be text.");
    return item.trim();
  }).filter(Boolean);
  if (!files.length) throw new HttpError(400, "INVALID", "Name the files or folders to allow.");
  if (files.length > 40) throw new HttpError(400, "INVALID", "Allow at most 40 files or folders at a time.");
  return files;
}

/**
 * The person widens one task's contract. Only the person's own window reaches this (every POST here needs
 * the person cookie), the entry is signed with their key, and a worker's request (ask_main) is just a
 * question until they do it. Files another running task has claimed are refused, so widening cannot be used to
 * reach into a second task's files.
 */
export async function widenTask(project: CoreProject, task: TaskView, label: string, worktrees: WorktreeManager | undefined, body: Record<string, unknown>) {
  const files = fileList(body.files);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) throw new HttpError(400, "INVALID", "Say why you are allowing these files.");
  const question = body.question === undefined || body.question === "" ? undefined : body.question;
  if (question !== undefined && (typeof question !== "string" || !/^Q-[1-9]\d{0,8}$/.test(question))) throw new HttpError(400, "INVALID", "The question must be a number like Q-4.");
  const view = contractOf(project.entries(), task.id);
  if (!view) throw new HttpError(409, "NO_CONTRACT", `${task.id} has no contract, so it is not limited to any files and there is nothing to widen.`);
  if (view.status !== "signed") throw new HttpError(409, "CONTRACT_UNSIGNED", `${view.problem ?? `The contract on ${task.id} is not signed.`} Widening it would not make it count.`);
  for (const file of files) {
    const problem = patternProblem(file);
    if (problem) throw new HttpError(400, "INVALID", `${file}: ${problem}`);
  }
  // A running worker's files are claimed as it goes: the same check dispatch makes, so a second task's files stay its own.
  if (worktrees && (await worktrees.get(label))) {
    const conflicts = await worktrees.claim(label, files);
    if (conflicts.length) {
      throw new HttpError(409, "CLAIMED", `Another running task has claimed ${[...new Set(conflicts.map((c) => `${c.mine} (${c.taskId} holds ${c.theirs})`))].join(", ")}. Nothing was allowed. Finish or send back that task first.`);
    }
  }
  try {
    return widenContract(project.ledger, localPerson(project), { task: task.id, files, reason, ...(question ? { question } : {}) });
  } catch (error) {
    if (error instanceof ContractError) {
      const status = error.code === "NOT_PERSON" ? 403 : error.code === "UNKNOWN_TASK" ? 404 : error.code === "NO_CONTRACT" || error.code === "UNSIGNED" ? 409 : 400;
      throw new HttpError(status, error.code, error.message);
    }
    throw error;
  }
}
