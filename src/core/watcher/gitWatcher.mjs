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
const SYSTEM_ACTOR = Object.freeze({ kind: "system", id: "git-watcher" });
const LOG_FORMAT = "--format=%H%x1f%s%x1f%b%x1f%cI%x1e";
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_STALL_MS = 15 * 60 * 1000;

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
async function readChangedFiles(gitCommand, worktreePath, base) {
  const committed = parseNulList(
    await runGit(gitCommand, worktreePath, ["diff", "--name-only", "-z", `${base}...HEAD`]),
  );
  const uncommitted = parseStatusZ(
    await runGit(gitCommand, worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  return [...new Set([...committed, ...uncommitted])].sort();
}

async function readNewCommits(gitCommand, worktreePath, base) {
  const stdout = await runGit(gitCommand, worktreePath, ["log", `${base}..HEAD`, LOG_FORMAT]);
  // git prints newest first; the ledger should receive them oldest first.
  return parseCommitLog(stdout).reverse();
}

// Default worktree discovery: every worktree on a branch named pp/T-<n>.
export async function listTaskWorktrees({ repoRoot, git = "git", base = "main" }) {
  const stdout = await runGit(git, repoRoot, ["worktree", "list", "--porcelain"]);
  const worktrees = [];
  for (const entry of parseWorktreePorcelain(stdout)) {
    const match = entry.branch ? TASK_BRANCH.exec(entry.branch) : null;
    if (!match) continue;
    worktrees.push({ task: match[1], path: entry.path, branch: entry.branch, base });
  }
  return worktrees;
}

// Rebuild dedupe and stall state from one ledger entry. Replaying the full
// ledger in order yields the same state a long-running watcher holds.
function applyEntry(index, entry) {
  const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
  const subject = typeof entry.subject === "string" ? entry.subject : "";
  const atMs = Date.parse(entry.at);

  if (entry.type === "commit.observed" && evidence[0]) {
    index.commits.add(`${subject}|${evidence[0]}`);
  }
  if (entry.type === "collision.detected" && evidence[0]) {
    index.collisions.add(`${subject}|${evidence[0]}`);
  }
  if (entry.type === "task.blocked" && entry.reason === "stalled") {
    if (evidence[0]) index.stalls.add(`${subject}|${evidence[0]}`);
    return;
  }
  if (!TASK_ID.test(subject)) return;

  const state = index.tasks.get(subject) ?? { claimed: false, lastActivity: null, lastActivityAt: null };
  const touches = entry.type === "task.progress" || entry.type === "commit.observed";
  const claims = entry.type === "task.claimed" || entry.type === "task.reopened";
  const releases =
    entry.type === "task.blocked" ||
    entry.type === "task.proof" ||
    entry.type === "task.done" ||
    entry.type === "worktree.removed";

  if (claims) state.claimed = true;
  if (releases) state.claimed = false;
  if ((claims || touches) && Number.isFinite(atMs)) {
    if (state.lastActivity === null || atMs >= state.lastActivity) {
      state.lastActivity = atMs;
      state.lastActivityAt = entry.at;
    }
  }
  index.tasks.set(subject, state);
}

function createIndex() {
  return { processed: 0, commits: new Set(), collisions: new Set(), stalls: new Set(), tasks: new Map() };
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
  integrationBranch = "main",
  listWorktrees,
} = {}) {
  if (!ledger || typeof ledger.append !== "function" || typeof ledger.entries !== "function") {
    throw new TypeError("createGitWatcher requires a ledger with append() and entries()");
  }
  const discover =
    listWorktrees ?? (() => listTaskWorktrees({ repoRoot, git, base: integrationBranch }));

  const index = createIndex();
  let timer = null;
  let inFlight = null;

  async function syncIndex() {
    const entries = await ledger.entries();
    for (let position = index.processed; position < entries.length; position += 1) {
      applyEntry(index, entries[position]);
    }
    index.processed = entries.length;
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
        files = await readChangedFiles(git, worktree.path, worktree.base);
        commits = await readNewCommits(git, worktree.path, worktree.base);
      } catch (error) {
        result.errors.push({ stage: "git", task: worktree.task, message: errorMessage(error) });
        continue;
      }
      states.push({ task: worktree.task, files });

      for (const commit of commits) {
        const key = `${worktree.task}|${commit.hash}`;
        if (index.commits.has(key)) continue;
        const summary = commit.subject ? `${commit.hash.slice(0, 7)} ${commit.subject}` : `commit ${commit.hash.slice(0, 7)}`;
        const refs = parseImplementsRefs(commit.body ? `${commit.subject}\n${commit.body}` : commit.subject);
        const entry = await write({
          type: "commit.observed",
          subject: worktree.task,
          summary,
          evidence: [commit.hash],
          ...(refs.length > 0 ? { refs } : {}),
        });
        if (entry) index.commits.add(key);
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
