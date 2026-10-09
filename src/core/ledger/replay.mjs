// Pure replay of ledger entries into the Board view (Core Spec §2: the board, task
// states, docs and releases are views rebuilt by replay). applyEntry is lenient:
// it never throws, so a board can always be rebuilt from whatever is on disk.
// Strictness lives in rules.mjs and is enforced at append time.
import { formatStamp, parseClauseSubject, parseEntryNumber, parseSeriesId, parseTaskId, taskAttemptId } from "./ids.mjs";

export function createBoard() {
  return {
    tasks: {},
    questions: {},
    decisions: {},
    plans: {},
    releases: {},
    collisions: [],
    corrections: [],
    budgetWarnings: [],
    control: { paused: false, pausedAt: null, pausedBy: null },
    sequence: { P: 0, T: 0, Q: 0, D: 0, R: 0 },
    entryCount: 0,
    lastEntry: null,
    lastHash: null,
  };
}

export function replay(entries) {
  const board = createBoard();
  for (const entry of entries ?? []) applyEntry(board, entry);
  return board;
}

const dataOf = (entry) => (entry && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {});
const list = (value) => (Array.isArray(value) ? value : []);
const firstMatching = (values, parse) => list(values).find((value) => parse(value)) ?? null;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function bumpSequence(board, id) {
  const parsed = parseSeriesId(id);
  if (parsed && board.sequence[parsed.series] < parsed.number) board.sequence[parsed.series] = parsed.number;
}

function noteSequences(board, entry) {
  const task = parseTaskId(entry.subject);
  if (task) bumpSequence(board, task.id);
  else bumpSequence(board, entry.subject);
  const clause = parseClauseSubject(entry.subject);
  if (clause) bumpSequence(board, clause.plan);
}

function newTask(id, entry) {
  return {
    id,
    state: "created",
    attempt: 1,
    attemptId: id,
    title: dataOf(entry).title ?? entry.summary,
    createdAt: entry.at,
    createdEntry: entry.n,
    claimedBy: null,
    claimedAt: null,
    test: {
      command: null,
      approved: false,
      lastResult: null,
      definedEntry: null,
      approvedEntry: null,
      lastResultEntry: null,
      lastResultAt: null,
      lastRunWhere: null,
    },
    worktree: null,
    commits: [],
    lastCommitAt: null,
    lastCommitEntry: null,
    lastProgressAt: null,
    lastProgress: null,
    blockedReason: null,
    proofs: [],
    reviews: [],
    merged: null,
    doneAt: null,
    doneEntry: null,
    reopenedEntry: null,
    refs: [],
  };
}

function addRefs(target, refs) {
  for (const ref of list(refs)) if (!target.includes(ref)) target.push(ref);
}

function previousPlanId(board, number) {
  let best = null;
  for (const plan of Object.values(board.plans)) {
    const parsed = parseSeriesId(plan.id);
    if (parsed && parsed.number < number && (!best || parsed.number > best.number)) best = parsed;
  }
  return best ? best.id : null;
}

function ensurePlan(board, planId, entry, state) {
  if (board.plans[planId]) return board.plans[planId];
  const parsed = parseSeriesId(planId);
  const data = dataOf(entry);
  const basedOn = data.basedOn === null ? null : data.basedOn ?? previousPlanId(board, parsed ? parsed.number : 0);
  const inherited = basedOn && board.plans[basedOn] ? clone(board.plans[basedOn].clauses) : {};
  for (const clause of Object.values(inherited)) {
    clause.ref = `${planId} ${clause.clause}`;
    clause.inheritedFrom = clause.inheritedFrom ?? basedOn;
  }
  const plan = { id: planId, state, title: null, basedOn, approvedAt: null, approvedEntry: null, clauses: inherited };
  board.plans[planId] = plan;
  return plan;
}

function applyTaskEntry(board, entry, data) {
  const parsed = parseTaskId(entry.subject);
  if (!parsed) return;
  const id = parsed.id;
  if (entry.type === "task.created") {
    if (!board.tasks[id]) board.tasks[id] = newTask(id, entry);
    addRefs(board.tasks[id].refs, entry.refs);
    return;
  }
  const task = board.tasks[id];
  if (!task) return;
  addRefs(task.refs, entry.refs);
  switch (entry.type) {
    case "task.claimed":
      task.state = "claimed";
      task.claimedBy = entry.actor?.id ?? null;
      task.claimedAt = entry.at;
      task.blockedReason = null;
      break;
    case "task.progress":
      if (task.state !== "done") task.state = "in-progress";
      task.lastProgressAt = entry.at;
      task.lastProgress = entry.summary;
      task.blockedReason = null;
      if (data.released) task.claimedBy = null;
      break;
    case "task.blocked":
      task.state = "blocked";
      task.blockedReason = entry.reason ?? null;
      task.lastProgressAt = entry.at;
      if (data.released) task.claimedBy = null;
      break;
    case "task.proof":
      task.state = "proof";
      task.lastProgressAt = entry.at;
      task.proofs.push({ entry: entry.n, at: entry.at, kind: data.kind ?? null, link: data.link ?? list(entry.evidence)[0] ?? null });
      break;
    case "task.done":
      task.state = "done";
      task.doneAt = entry.at;
      task.doneEntry = entry.n;
      break;
    case "task.reopened":
      task.attempt += 1;
      task.attemptId = taskAttemptId(id, task.attempt);
      task.state = "reopened";
      task.claimedBy = null;
      task.reopenedEntry = entry.n;
      task.doneAt = null;
      task.doneEntry = null;
      task.merged = null;
      task.test.lastResult = null;
      break;
    case "test.defined":
      task.test.command = data.command ?? entry.summary;
      task.test.approved = false;
      task.test.approvedEntry = null;
      task.test.lastResult = null;
      task.test.definedEntry = entry.n;
      break;
    case "test.approved":
      task.test.approved = true;
      task.test.approvedEntry = entry.n;
      break;
    case "test.passed":
    case "test.failed":
      task.test.lastResult = entry.type === "test.passed" ? "passed" : "failed";
      task.test.lastResultEntry = entry.n;
      task.test.lastResultAt = entry.at;
      task.test.lastRunWhere = data.where ?? null;
      break;
    case "review.verdict":
      task.reviews.push({
        entry: entry.n,
        at: entry.at,
        kind: data.kind ?? null,
        verdict: data.verdict ?? null,
        model: data.model ?? entry.actor?.model ?? null,
        provider: data.provider ?? null,
        cost: data.cost ?? null,
        confidence: data.confidence ?? null,
        reason: entry.reason ?? null,
      });
      break;
    case "worktree.created":
      task.worktree = {
        path: data.path ?? list(entry.evidence)[0] ?? null,
        branch: data.branch ?? null,
        port: data.port ?? null,
        createdAt: entry.at,
        entry: entry.n,
      };
      break;
    case "worktree.removed":
      task.worktree = null;
      break;
    case "commit.observed": {
      const sha = data.sha ?? data.commit ?? list(entry.evidence)[0] ?? null;
      if (sha && task.commits.some((commit) => commit.sha === sha)) break;
      task.commits.push({ sha, files: list(data.files).slice(), message: data.message ?? entry.summary, at: entry.at, entry: entry.n });
      task.lastCommitAt = entry.at;
      task.lastCommitEntry = entry.n;
      break;
    }
    case "merge.done":
      task.merged = { entry: entry.n, at: entry.at, commit: data.commit ?? list(entry.evidence)[0] ?? null, into: data.into ?? null };
      break;
    default:
      break;
  }
}

function collisionTasks(entry, data) {
  if (Array.isArray(data.tasks)) return data.tasks.slice();
  const tasks = [];
  for (const value of [entry.subject, ...list(entry.evidence)]) {
    const parsed = parseTaskId(value);
    if (parsed && !tasks.includes(parsed.id)) tasks.push(parsed.id);
  }
  return tasks;
}

export function applyEntry(board, entry) {
  if (!entry || typeof entry !== "object") return board;
  const data = dataOf(entry);
  noteSequences(board, entry);
  board.entryCount += 1;
  board.lastEntry = entry.n ?? board.lastEntry;
  board.lastHash = entry.hash ?? board.lastHash;
  const type = entry.type;

  if (/^(task|test|worktree)\./.test(type) || type === "review.verdict" || type === "commit.observed" || type === "merge.done") {
    applyTaskEntry(board, entry, data);
    return board;
  }

  switch (type) {
    case "plan.approved": {
      const plan = ensurePlan(board, entry.subject, entry, "approved");
      plan.state = "approved";
      plan.title = data.title ?? entry.summary;
      plan.approvedAt = entry.at;
      plan.approvedEntry = entry.n;
      break;
    }
    case "clause.added":
    case "clause.changed":
    case "clause.withdrawn": {
      const subject = parseClauseSubject(entry.subject);
      if (!subject) break;
      const plan = ensurePlan(board, subject.plan, entry, "draft");
      const existing = plan.clauses[subject.clause];
      if (type === "clause.added") {
        if (existing) break;
        plan.clauses[subject.clause] = {
          ref: entry.subject,
          clause: subject.clause,
          text: data.text ?? entry.summary,
          heading: data.heading ?? null,
          state: "active",
          addedEntry: entry.n,
          history: [entry.n],
        };
      } else if (existing) {
        if (type === "clause.changed") existing.text = data.text ?? entry.summary;
        else existing.state = "withdrawn";
        existing.history.push(entry.n);
      }
      break;
    }
    case "question.asked": {
      if (board.questions[entry.subject]) break;
      board.questions[entry.subject] = {
        id: entry.subject,
        task: data.task ?? firstMatching([...list(entry.evidence), ...list(entry.refs)], parseTaskId),
        text: data.question ?? data.text ?? entry.summary,
        options: list(data.options).slice(),
        blocking: Boolean(data.blocking),
        state: "open",
        askedBy: entry.actor?.id ?? null,
        askedAt: entry.at,
        entry: entry.n,
        answer: null,
        answeredAt: null,
        decision: null,
        reusedDecision: data.reusedDecision ?? null,
      };
      break;
    }
    case "question.answered": {
      const question = board.questions[entry.subject];
      if (!question) break;
      question.state = "answered";
      question.answer = data.answer ?? data.text ?? entry.summary;
      question.answeredAt = entry.at;
      question.answeredBy = entry.actor?.id ?? null;
      if (data.decision) question.decision = data.decision;
      break;
    }
    case "decision.made": {
      const questionId = data.question ?? firstMatching(list(entry.evidence), (value) => parseSeriesId(value)?.series === "Q");
      board.decisions[entry.subject] = {
        id: entry.subject,
        text: data.text ?? entry.summary,
        reason: entry.reason ?? null,
        question: questionId,
        refs: list(entry.refs).slice(),
        by: entry.actor?.id ?? null,
        at: entry.at,
        entry: entry.n,
      };
      if (questionId && board.questions[questionId]) board.questions[questionId].decision = entry.subject;
      break;
    }
    case "collision.detected":
      board.collisions.push({
        id: entry.n,
        subject: entry.subject,
        files: list(data.files).slice(),
        tasks: collisionTasks(entry, data),
        state: "open",
        detectedAt: entry.at,
        resolvedAt: null,
        resolvedEntry: null,
      });
      break;
    case "collision.resolved": {
      const targetId = data.collision ?? null;
      let target = targetId ? board.collisions.find((collision) => collision.id === targetId) : null;
      if (!target) {
        for (let index = board.collisions.length - 1; index >= 0; index -= 1) {
          const candidate = board.collisions[index];
          if (candidate.state === "open" && candidate.subject === entry.subject) { target = candidate; break; }
        }
      }
      if (target) {
        target.state = "resolved";
        target.resolvedAt = entry.at;
        target.resolvedEntry = entry.n;
      }
      break;
    }
    case "release.cut": {
      const version = data.version ?? null;
      const plan = data.plan ?? null;
      const commit = data.commit ?? null;
      board.releases[entry.subject] = {
        id: entry.subject,
        version,
        plan,
        commit,
        state: "cut",
        at: entry.at,
        entry: entry.n,
        stamp: formatStamp({ release: entry.subject, version, plan, entry: entry.n, commit }),
        rolledBackAt: null,
        rollbackEntry: null,
      };
      break;
    }
    case "release.rollback": {
      const release = board.releases[entry.subject];
      if (!release) break;
      release.state = "rolled-back";
      release.rolledBackAt = entry.at;
      release.rollbackEntry = entry.n;
      break;
    }
    case "correction":
      board.corrections.push({
        entry: entry.n,
        at: entry.at,
        corrects: entry.corrects ?? null,
        summary: entry.summary,
        reason: entry.reason ?? null,
        acknowledgedBreaks: Array.isArray(data.acknowledgedBreaks) ? clone(data.acknowledgedBreaks) : null,
      });
      break;
    case "budget.warning":
      board.budgetWarnings.push({ entry: entry.n, at: entry.at, subject: entry.subject, summary: entry.summary, percent: data.percent ?? null });
      break;
    default:
      break;
  }
  // Pause-all / resume-all control (Core Spec §4) is recorded as a decision.made
  // (or any non-task entry) carrying data.control.
  if (data.control === "pause-all" || data.control === "resume-all") {
    board.control.paused = data.control === "pause-all";
    board.control.pausedAt = board.control.paused ? entry.at : null;
    board.control.pausedBy = board.control.paused ? entry.actor?.id ?? null : null;
  }
  return board;
}

export function entryNumberOf(entry) {
  return parseEntryNumber(entry?.n);
}
