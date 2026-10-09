// Git watcher fallback for the core loop. Every tick it reads each task
// worktree (committed and uncommitted changes), writes ledger entries for new
// commits and file collisions, and flags claimed tasks that went quiet.
// The ledger is the only source of truth: all dedupe state is rebuilt from
// ledger.entries(), so a restarted watcher never writes a duplicate.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseCommitLog,
  parseImplementsRefs,
  parseNulList,
  parseStatusZ,
  parseWorktreePorcelain,
} from "./gitParsers.mjs";

const execFileAsync = promisify(execFile);
const TASK_ID = /^T-\d+(?:\.a\d+)?$/;
const TASK_BRANCH = /^pp\/(T-\d+(?:\.a\d+)?)$/;
const QUESTION_ID = /^Q-\d+$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const SYSTEM_ACTOR = Object.freeze({ kind: "system", id: "git-watcher" });
const LOG_FORMAT = "--format=%H%x1f%s%x1f%b%x1f%cI%x1e";
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_STALL_MS = 15 * 60 * 1000;
// Local files copied into every worktree (spec §5) must not count as collisions.
// An entry ending in "/" ignores a whole directory; any other entry ignores one path.
const DEFAULT_IGNORE_PATHS = Object.freeze([".claude/settings.local.json", ".perfect-planner/"]);

// Git revisions are passed as argv, but a leading "-" would still be read as an
// option (for example "--output=<file>"), so refs must match a safe shape.
export function assertSafeRef(ref, label = "ref") {
  if (
    typeof ref !== "string" ||
    !SAFE_REF.test(ref) ||
    ref.includes("..") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock")
  ) {
    throw new TypeError(`refusing unsafe git ${label}: ${JSON.stringify(ref)}`);
  }
}

function isIgnoredPath(file, ignorePaths) {
  return ignorePaths.some((pattern) => (pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern));
}

async function runGit(gitCommand, cwd, args) {
  const { stdout } = await execFileAsync(gitCommand, args, {
    cwd,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

// Files a worktree touches: committed since base plus uncommitted/untracked.
async function readChangedFiles(gitCommand, worktreePath, base, ignorePaths) {
  assertSafeRef(base, "base");
  const committed = parseNulList(
    await runGit(gitCommand, worktreePath, ["diff", "--name-only", "-z", `${base}...HEAD`]),
  );
  const uncommitted = parseStatusZ(
    await runGit(gitCommand, worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  return [...new Set([...committed, ...uncommitted])]
    .filter((file) => !isIgnoredPath(file, ignorePaths))
    .sort();
}

async function readNewCommits(gitCommand, worktreePath, base) {
  assertSafeRef(base, "base");
  const stdout = await runGit(gitCommand, worktreePath, ["log", `${base}..HEAD`, LOG_FORMAT]);
  // git prints newest first; the ledger should receive them oldest first.
  return parseCommitLog(stdout).reverse();
}

// Default worktree discovery: every worktree on a branch named pp/T-<n>.
export async function listTaskWorktrees({ repoRoot, git = "git", base }) {
  assertSafeRef(base, "base");
  const stdout = await runGit(git, repoRoot, ["worktree", "list", "--porcelain"]);
  const worktrees = [];
  for (const entry of parseWorktreePorcelain(stdout)) {
    const match = entry.branch ? TASK_BRANCH.exec(entry.branch) : null;
    if (!match) continue;
    worktrees.push({ task: match[1], path: entry.path, branch: entry.branch, base });
  }
  return worktrees;
}

function createIndex() {
  return {
    processed: 0,
    lastN: null,
    commits: new Set(),
    collisions: new Set(),
    stalls: new Set(),
    tasks: new Map(),
    openQuestions: new Map(),
  };
}

function newTaskState(index, task) {
  const state = { claimed: false, lastActivity: null, lastActivityAt: null };
  index.tasks.set(task, state);
  return state;
}

function noteActivity(state, atMs, at) {
  if (!Number.isFinite(atMs)) return;
  if (state.lastActivity === null || atMs >= state.lastActivity) {
    state.lastActivity = atMs;
    state.lastActivityAt = at;
  }
}

function firstTaskIn(values) {
  return values.find((value) => typeof value === "string" && TASK_ID.test(value)) ?? null;
}

// Rebuild dedupe and stall state from one ledger entry. Replaying the full
// ledger in order yields the same state a long-running watcher holds.
function applyEntry(index, entry) {
  const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
  const subject = typeof entry.subject === "string" ? entry.subject : "";
  const atMs = Date.parse(entry.at);

  // Commits are deduped by hash alone, so one commit is observed once no
  // matter how many task worktrees reach it.
  if (entry.type === "commit.observed" && evidence[0]) {
    index.commits.add(evidence[0]);
  }
  if (entry.type === "collision.detected" && evidence[0]) {
    index.collisions.add(`${subject}|${evidence[0]}`);
  }
  // A resolved collision may be detected again if the same pair overlaps later.
  if (entry.type === "collision.resolved") {
    if (evidence[0]) {
      index.collisions.delete(`${subject}|${evidence[0]}`);
    } else {
      for (const key of [...index.collisions]) {
        if (key.startsWith(`${subject}|`)) index.collisions.delete(key);
      }
    }
  }
  // A blocking question pauses only the asking worker. While it is open the
  // task is not stalled; the answer counts as activity. Strict-ledger shape
  // (core/relay askMain): question.asked subject Q-n with data { task, blocking };
  // question.answered subject Q-n. A top-level `blocking` flag and a task id in
  // evidence are still accepted for older entries.
  const data = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {};
  if (entry.type === "question.asked" && (data.blocking === true || entry.blocking === true)) {
    const dataTask = typeof data.task === "string" ? data.task.replace(/\.a\d+$/, "") : null;
    const task = dataTask && TASK_ID.test(dataTask) ? dataTask : TASK_ID.test(subject) ? subject : firstTaskIn(evidence);
    const questionId = QUESTION_ID.test(subject) ? subject : entry.n;
    if (task && questionId) index.openQuestions.set(questionId, task);
  }
  if (entry.type === "question.answered") {
    const questionId = QUESTION_ID.test(subject) ? subject : evidence[0];
    const task = index.openQuestions.get(questionId);
    if (task) {
      index.openQuestions.delete(questionId);
      noteActivity(index.tasks.get(task) ?? newTaskState(index, task), atMs, entry.at);
    }
  }
  if (entry.type === "task.blocked" && entry.reason === "stalled") {
    if (evidence[0]) index.stalls.add(`${subject.replace(/\.a\d+$/, "")}|${evidence[0]}`);
    return;
  }
  if (!TASK_ID.test(subject)) return;

  // Every attempt of a task (T-3, T-3.a2) shares one branch and one watch state.
  const taskKey = subject.replace(/\.a\d+$/, "");
  const state = index.tasks.get(taskKey) ?? newTaskState(index, taskKey);
  // task.proof shows the worker is still active, so it is activity, not a release.
  const touches =
    entry.type === "task.progress" || entry.type === "commit.observed" || entry.type === "task.proof";
  const claims = entry.type === "task.claimed" || entry.type === "task.reopened";
  const releases =
    entry.type === "task.blocked" || entry.type === "task.done" || entry.type === "worktree.removed";

  if (claims) state.claimed = true;
  if (releases) state.claimed = false;
  if (claims || touches) noteActivity(state, atMs, entry.at);
}

function hasOpenQuestion(index, task) {
  for (const owner of index.openQuestions.values()) {
    if (owner === task) return true;
  }
  return false;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createGitWatcher({
  repoRoot,
  ledger,
  intervalMs = 3000,
  stallMs = DEFAULT_STALL_MS,
  now = () => new Date(),
  git = "git",
  integrationBranch,
  listWorktrees,
  ignorePaths = DEFAULT_IGNORE_PATHS,
} = {}) {
  if (!ledger || typeof ledger.append !== "function" || typeof ledger.entries !== "function") {
    throw new TypeError("createGitWatcher requires a ledger with append() and entries()");
  }
  if (!Array.isArray(ignorePaths) || ignorePaths.some((path) => typeof path !== "string")) {
    throw new TypeError("ignorePaths must be an array of path strings");
  }
  if (!listWorktrees) {
    // No default integration branch: guessing "main" could diff against the wrong base.
    if (integrationBranch === undefined) {
      throw new TypeError("createGitWatcher requires integrationBranch when listWorktrees is not given");
    }
    assertSafeRef(integrationBranch, "integrationBranch");
  }
  const discover =
    listWorktrees ?? (() => listTaskWorktrees({ repoRoot, git, base: integrationBranch }));

  let index = createIndex();
  let timer = null;
  let inFlight = null;

  async function syncIndex() {
    const entries = await ledger.entries();
    // If the list no longer extends what was already replayed (it shrank, or it
    // is now a different window), replay from scratch so no entry is skipped.
    const consistent =
      index.processed === 0 ||
      (entries.length >= index.processed && entries[index.processed - 1]?.n === index.lastN);
    if (!consistent) index = createIndex();
    for (let position = index.processed; position < entries.length; position += 1) {
      applyEntry(index, entries[position]);
    }
    index.processed = entries.length;
    index.lastN = entries.length > 0 ? entries[entries.length - 1]?.n ?? null : null;
  }

  async function runTick() {
    const result = { written: [], errors: [] };
    let writesBlocked = false;

    async function write(fields) {
      if (writesBlocked) return null;
      try {
        const entry = await ledger.append({ actor: SYSTEM_ACTOR, ...fields });
        result.written.push({ n: entry.n, type: entry.type, subject: entry.subject });
        return entry;
      } catch (error) {
        result.errors.push({ stage: "append", type: fields.type, subject: fields.subject, code: error?.code, message: errorMessage(error) });
        if (error?.code === "LEDGER_CHAIN_BROKEN" || error?.code === "LEDGER_LOCKED") writesBlocked = true;
        return null;
      }
    }

    try {
      await syncIndex();
    } catch (error) {
      result.errors.push({ stage: "entries", message: errorMessage(error) });
      return result;
    }

    let worktrees = [];
    try {
      worktrees = (await discover()) ?? [];
    } catch (error) {
      result.errors.push({ stage: "listWorktrees", message: errorMessage(error) });
    }

    // Phase 1: read every worktree and record its new commits.
    const states = [];
    for (const worktree of worktrees) {
      let files;
      let commits;
      try {
        files = await readChangedFiles(git, worktree.path, worktree.base, ignorePaths);
        commits = await readNewCommits(git, worktree.path, worktree.base);
      } catch (error) {
        result.errors.push({ stage: "git", task: worktree.task, message: errorMessage(error) });
        continue;
      }
      states.push({ task: worktree.task, files });

      for (const commit of commits) {
        if (index.commits.has(commit.hash)) continue;
        const summary = commit.subject ? `${commit.hash.slice(0, 7)} ${commit.subject}` : `commit ${commit.hash.slice(0, 7)}`;
        const refs = parseImplementsRefs(commit.body ? `${commit.subject}\n${commit.body}` : commit.subject);
        let commitFiles = [];
        try {
          commitFiles = parseNulList(
            await runGit(git, worktree.path, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", commit.hash]),
          ).filter((file) => !isIgnoredPath(file, ignorePaths));
        } catch (error) {
          result.errors.push({ stage: "git", task: worktree.task, message: errorMessage(error) });
        }
        const entry = await write({
          type: "commit.observed",
          subject: worktree.task,
          summary,
          evidence: [commit.hash],
          ...(refs.length > 0 ? { refs } : {}),
          // The strict ledger's replay reads the commit from data (board task.commits).
          data: { sha: commit.hash, files: commitFiles, message: commit.subject || summary },
        });
        if (entry) index.commits.add(commit.hash);
      }
    }

    // Phase 2: two worktrees on different tasks touching the same file.
    for (let i = 0; i < states.length; i += 1) {
      for (let j = i + 1; j < states.length; j += 1) {
        const first = states[i];
        const second = states[j];
        if (first.task === second.task) continue;
        const [low, high] = first.task < second.task ? [first, second] : [second, first];
        const subject = `${low.task}+${high.task}`;
        const secondFiles = new Set(second.files);
        for (const file of first.files) {
          if (!secondFiles.has(file)) continue;
          const key = `${subject}|${file}`;
          if (index.collisions.has(key)) continue;
          const entry = await write({
            type: "collision.detected",
            subject,
            summary: `${file} changed in ${low.task} and ${high.task}`,
            evidence: [file],
            // The subject "T-1+T-2" is not a task id, so name the tasks and file in data
            // for the ledger's board (collisions[].tasks / .files).
            data: { files: [file], tasks: [low.task, high.task] },
          });
          if (entry) index.collisions.add(key);
        }
      }
    }

    // Phase 3: claimed tasks with no commits or progress for stallMs.
    try {
      await syncIndex();
    } catch (error) {
      result.errors.push({ stage: "entries", message: errorMessage(error) });
      return result;
    }
    const nowMs = now().getTime();
    for (const [task, state] of index.tasks) {
      if (!state.claimed || state.lastActivity === null) continue;
      if (nowMs - state.lastActivity < stallMs) continue;
      if (hasOpenQuestion(index, task)) continue;
      const evidence = `activity:${state.lastActivityAt}`;
      const key = `${task}|${evidence}`;
      if (index.stalls.has(key)) continue;
      const entry = await write({
        type: "task.blocked",
        subject: task,
        summary: `stalled: no commits or progress since ${state.lastActivityAt}`,
        reason: "stalled",
        evidence: [evidence],
      });
      if (entry) index.stalls.add(key);
    }

    return result;
  }

  function tick() {
    if (!inFlight) {
      inFlight = runTick().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch(() => {});
      }, intervalMs);
      tick().catch(() => {});
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (inFlight) await inFlight.catch(() => {});
    },
  };
}
