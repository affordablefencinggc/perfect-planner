// Agent check-in relay (Core Specs §4): token-scoped write tools over the strict ledger.
//
// The relay never keeps authoritative state of its own: every task, question and decision it
// reasons about is re-derived from `ledger.entries()` on each call, so a restarted relay sees
// exactly what the ledger says. Only session tokens (who is connected right now) live in memory.
//
// Ledger encoding conventions used by the relay (all within the shared Entry fields):
//   question.asked     subject Q-n, summary = question text, evidence = [T-n, 'option:<text>'..., 'blocking'|'non-blocking']
//   question.answered  subject Q-n, summary = answer text,   evidence = [D-n]
//   decision.made      subject D-n, summary = answer text,   evidence = [Q-n, T-n], reason required
//   task.blocked / task.progress written by release_task or stop_worker carry evidence 'relay:released'
//   pause/resume-all   decision.made subject D-n with evidence ['relay:pause-all'] / ['relay:resume-all']
import { randomBytes } from 'node:crypto';

export const RELAY_ERROR_CODES = Object.freeze({
  FORBIDDEN: 'RELAY_FORBIDDEN',
  PAUSED: 'RELAY_PAUSED',
  STOPPED: 'RELAY_STOPPED',
  INVALID: 'RELAY_INVALID',
  NOT_FOUND: 'RELAY_NOT_FOUND',
  CONFLICT: 'RELAY_CONFLICT',
  TEST_NOT_APPROVED: 'RELAY_TEST_NOT_APPROVED',
});

const RELEASED = 'relay:released';
const PAUSE_ALL = 'relay:pause-all';
const RESUME_ALL = 'relay:resume-all';
const OPTION_PREFIX = 'option:';
const TASK_ID = /^T-\d+$/;
const QUESTION_ID = /^Q-\d+$/;
const MAX_TEXT = 2000;

export function relayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const baseTaskId = (subject) => String(subject ?? '').replace(/\.a\d+$/, '');

/** One-line, bounded text suitable for an entry summary. */
function oneLine(value, field) {
  if (typeof value !== 'string') throw relayError(RELAY_ERROR_CODES.INVALID, `${field} must be a string.`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw relayError(RELAY_ERROR_CODES.INVALID, `${field} must not be empty.`);
  if (text.toUpperCase() === 'TBD') throw relayError(RELAY_ERROR_CODES.INVALID, `${field} must not be "TBD".`);
  if (text.length > MAX_TEXT) throw relayError(RELAY_ERROR_CODES.INVALID, `${field} is longer than ${MAX_TEXT} characters.`);
  return text;
}

/** Normalised comparison key for relay dedupe: case, whitespace and trailing punctuation ignored. */
export function normalizeQuestionText(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s?.!:;]+$/, '');
}

export function questionKey(text, options = []) {
  const normalizedOptions = [...new Set(options.map(normalizeQuestionText))].sort();
  return JSON.stringify([normalizeQuestionText(text), normalizedOptions]);
}

/**
 * Pure relay view over ledger entries: tasks (claim/test state), questions, decisions, pause flag.
 * Deliberately limited to what the relay enforces; the ledger module's replay() owns the full board.
 */
export function relayView(entries) {
  const tasks = {};
  const questions = {};
  const decisions = {};
  let pausedAll = false;
  const task = (id) => (tasks[id] ??= { id, title: null, state: 'created', attempt: 1, claimedBy: null, test: { defined: false, approved: false }, lastProgressAt: null, exists: false });
  for (const entry of entries) {
    const subject = entry.subject;
    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    switch (entry.type) {
      case 'task.created': { const t = task(baseTaskId(subject)); t.exists = true; t.title = entry.summary; t.refs = entry.refs ?? []; break; }
      case 'test.defined': { const t = task(baseTaskId(subject)); t.test = { defined: true, approved: false }; break; }
      case 'test.approved': { const t = task(baseTaskId(subject)); t.test = { defined: true, approved: true }; break; }
      case 'task.claimed': { const t = task(baseTaskId(subject)); t.state = 'claimed'; t.claimedBy = entry.actor?.id ?? null; break; }
      case 'task.progress': {
        const t = task(baseTaskId(subject)); t.state = 'in-progress'; t.lastProgressAt = entry.at;
        if (evidence.includes(RELEASED)) { t.claimedBy = null; t.state = 'created'; }
        break;
      }
      case 'task.blocked': { const t = task(baseTaskId(subject)); t.state = 'blocked'; if (evidence.includes(RELEASED)) t.claimedBy = null; break; }
      case 'task.proof': { task(baseTaskId(subject)).state = 'proof'; break; }
      case 'task.done': { const t = task(baseTaskId(subject)); t.state = 'done'; break; }
      case 'task.reopened': { const t = task(baseTaskId(subject)); t.state = 'reopened'; t.attempt += 1; t.claimedBy = null; break; }
      case 'question.asked': {
        const options = evidence.filter((e) => typeof e === 'string' && e.startsWith(OPTION_PREFIX)).map((e) => e.slice(OPTION_PREFIX.length));
        questions[subject] = {
          id: subject, task: evidence.find((e) => TASK_ID.test(e)) ?? null, text: entry.summary, options,
          blocking: evidence.includes('blocking'), state: 'open', answer: null, decision: null, askedBy: entry.actor?.id ?? null, askedAt: entry.n,
        };
        break;
      }
      case 'question.answered': {
        const q = questions[subject];
        if (q) { q.state = 'answered'; q.answer = entry.summary; q.decision = evidence.find((e) => /^D-\d+$/.test(e)) ?? null; }
        break;
      }
      case 'decision.made': {
        decisions[subject] = { id: subject, text: entry.summary, reason: entry.reason ?? null, question: evidence.find((e) => QUESTION_ID.test(e)) ?? null };
        if (evidence.includes(PAUSE_ALL)) pausedAll = true;
        if (evidence.includes(RESUME_ALL)) pausedAll = false;
        break;
      }
      default: break;
    }
  }
  return { tasks, questions, decisions, pausedAll };
}

const citesRef = (entry, ref) => entry.corrects === ref
  || (entry.evidence ?? []).includes(ref)
  || (entry.refs ?? []).some((r) => r === ref || r.endsWith(` ${ref}`) || r.startsWith(`${ref} `));

/** Default lookup: plain ledger search by id. A clauses module can replace it via `resolver`. */
export function defaultResolver(ref, { entries }) {
  const id = String(ref ?? '').trim();
  if (!id) throw relayError(RELAY_ERROR_CODES.INVALID, 'ref must not be empty.');
  let history;
  if (/^L-\d+$/.test(id)) history = entries.filter((e) => e.n === id);
  else if (/^[PTQDR]-\d+(\.a\d+)?$/.test(id)) history = entries.filter((e) => e.subject === id || baseTaskId(e.subject) === id);
  else history = [];
  const historyNs = new Set(history.map((e) => e.n));
  const citedBy = entries.filter((e) => !historyNs.has(e.n) && citesRef(e, id));
  if (!history.length && !citedBy.length) throw relayError(RELAY_ERROR_CODES.NOT_FOUND, `Nothing in the ledger matches ${id}.`);
  const creating = history[0];
  return { ref: id, text: creating?.summary ?? null, history, citedBy };
}

function newToken() { return `pp_${randomBytes(24).toString('hex')}`; }

/**
 * createRelay({ ledger, now, resolver }) — ledger implements the shared Ledger interface
 * (append/entries/nextId/subscribe). All writes are serialized through one queue.
 */
export function createRelay({ ledger, now = () => new Date(), resolver = defaultResolver, tokenFactory = newToken } = {}) {
  if (!ledger || typeof ledger.append !== 'function' || typeof ledger.entries !== 'function' || typeof ledger.nextId !== 'function') {
    throw relayError(RELAY_ERROR_CODES.INVALID, 'createRelay requires a ledger with append, entries and nextId.');
  }
  const sessions = new Map(); // token -> session
  let mainToken = null;
  let queue = Promise.resolve();

  const serialize = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const view = () => relayView(ledger.entries());
  const actorOf = (session) => ({ kind: 'agent', id: session.agentId, ...(session.model ? { model: session.model } : {}) });
  const publicSession = (s) => ({ agent: s.agentId, model: s.model, role: s.role, task: s.task, waitingOn: s.waitingOn, stopped: s.stopped });

  function session(token, { role, allowPaused = false } = {}) {
    const s = typeof token === 'string' ? sessions.get(token) : undefined;
    if (!s) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, 'Unknown or missing session token. Call hello first.');
    if (role && s.role !== role) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, `This tool needs a ${role} token; yours is a ${s.role} token.`);
    if (s.stopped) throw relayError(RELAY_ERROR_CODES.STOPPED, 'This worker was stopped by the main chat.');
    if (s.role === 'worker' && !allowPaused) {
      if (s.waitingOn) throw relayError(RELAY_ERROR_CODES.PAUSED, `Paused until ${s.waitingOn} is answered; call check_answer.`);
      if (view().pausedAll) throw relayError(RELAY_ERROR_CODES.PAUSED, 'All workers are paused by the main chat.');
    }
    s.lastSeenAt = now().toISOString();
    return s;
  }

  function workerForTask(token, taskId) {
    const s = session(token, { role: 'worker' });
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw relayError(RELAY_ERROR_CODES.INVALID, 'task must look like T-14.');
    if (s.task !== taskId) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, s.task ? `Your token covers ${s.task} only.` : 'Your token covers no task yet; claim_task first.');
    const t = view().tasks[taskId];
    if (!t || t.claimedBy !== s.agentId) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, `${taskId} is no longer claimed by you.`);
    return s;
  }

  function hello({ agent, model, role } = {}) {
    const name = oneLine(agent, 'agent');
    if (!/^[A-Za-z0-9._ -]{1,80}$/.test(name)) throw relayError(RELAY_ERROR_CODES.INVALID, 'agent must be 1-80 letters, digits, space, dot, dash or underscore.');
    if (role !== undefined && role !== 'main' && role !== 'worker') throw relayError(RELAY_ERROR_CODES.INVALID, 'role must be "main" or "worker".');
    if (role === 'main' && mainToken) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, 'A main chat is already registered.');
    const taken = new Set([...sessions.values()].map((s) => s.agentId));
    let agentId = name;
    for (let i = 2; taken.has(agentId); i += 1) agentId = `${name}#${i}`;
    const token = tokenFactory();
    const assigned = !mainToken && role !== 'worker' ? 'main' : 'worker';
    const s = { token, agentId, model: typeof model === 'string' && model.trim() ? model.trim() : null, role: assigned, task: null, waitingOn: null, stopped: false, answers: new Map(), registeredAt: now().toISOString(), lastSeenAt: now().toISOString() };
    sessions.set(token, s);
    if (assigned === 'main') mainToken = token;
    return { token, agent: agentId, role: assigned };
  }

  function listTasks(token) {
    session(token, { allowPaused: true });
    const { tasks } = view();
    return Object.values(tasks).filter((t) => t.exists).map((t) => ({
      id: t.id, title: t.title, state: t.state, attempt: t.attempt, claimedBy: t.claimedBy, testApproved: t.test.approved,
      claimable: !t.claimedBy && ['created', 'reopened', 'blocked'].includes(t.state) && t.test.approved,
    }));
  }

  const claimTask = (token, taskId) => serialize(async () => {
    const s = session(token, { role: 'worker' });
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw relayError(RELAY_ERROR_CODES.INVALID, 'task must look like T-14.');
    if (s.task && s.task !== taskId) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, `Your token already covers ${s.task}; release it first.`);
    const t = view().tasks[taskId];
    if (!t || !t.exists) throw relayError(RELAY_ERROR_CODES.NOT_FOUND, `${taskId} does not exist.`);
    if (t.claimedBy === s.agentId) return { task: taskId, alreadyClaimed: true };
    if (t.claimedBy) throw relayError(RELAY_ERROR_CODES.CONFLICT, `${taskId} is claimed by ${t.claimedBy}.`);
    if (!['created', 'reopened', 'blocked'].includes(t.state)) throw relayError(RELAY_ERROR_CODES.CONFLICT, `${taskId} is ${t.state} and cannot be claimed.`);
    if (!t.test.approved) throw relayError(RELAY_ERROR_CODES.TEST_NOT_APPROVED, `${taskId} cannot start until its acceptance test is defined and approved.`);
    const subject = t.attempt > 1 ? `${taskId}.a${t.attempt}` : taskId;
    const entry = await ledger.append({ actor: actorOf(s), type: 'task.claimed', subject, summary: `${s.agentId} claimed ${subject}` });
    s.task = taskId;
    return { task: taskId, attempt: t.attempt, entry: entry.n };
  });

  const reportProgress = (token, taskId, text) => serialize(async () => {
    const s = workerForTask(token, taskId);
    const entry = await ledger.append({ actor: actorOf(s), type: 'task.progress', subject: taskId, summary: oneLine(text, 'text') });
    return { task: taskId, entry: entry.n };
  });

  const attachProof = (token, taskId, kind, link) => serialize(async () => {
    const s = workerForTask(token, taskId);
    const k = oneLine(kind, 'kind');
    const l = oneLine(link, 'link');
    const entry = await ledger.append({ actor: actorOf(s), type: 'task.proof', subject: taskId, summary: `Proof (${k}) attached for ${taskId}`, evidence: [l] });
    return { task: taskId, kind: k, entry: entry.n };
  });

  const askMain = (token, taskId, question, options = [], blocking = false) => serialize(async () => {
    const s = workerForTask(token, taskId);
    const text = oneLine(question, 'question');
    if (!Array.isArray(options) || options.length > 20) throw relayError(RELAY_ERROR_CODES.INVALID, 'options must be an array of at most 20 strings.');
    const opts = options.map((o, i) => oneLine(o, `options[${i}]`));
    const key = questionKey(text, opts);
    const current = view();
    const prior = Object.values(current.questions).find((q) => q.state === 'answered' && q.decision && questionKey(q.text, q.options) === key);
    const q = ledger.nextId('Q');
    const evidence = [taskId, ...opts.map((o) => OPTION_PREFIX + o), blocking ? 'blocking' : 'non-blocking'];
    const asked = await ledger.append({ actor: actorOf(s), type: 'question.asked', subject: q, summary: text, evidence });
    if (prior) {
      const answered = await ledger.append({
        actor: { kind: 'system', id: 'relay' }, type: 'question.answered', subject: q, summary: prior.answer,
        evidence: [prior.decision, prior.id],
      });
      s.answers.set(q, { answer: prior.answer, decision: prior.decision });
      return { question: q, state: 'answered', answer: prior.answer, decision: prior.decision, dedupedFrom: prior.id, entries: [asked.n, answered.n] };
    }
    s.answers.set(q, null);
    if (blocking) s.waitingOn = q;
    return { question: q, state: 'open', blocking: Boolean(blocking), entries: [asked.n] };
  });

  function checkAnswer(token, q) {
    const s = session(token, { role: 'worker', allowPaused: true });
    const question = view().questions[q];
    if (!question || (!s.answers.has(q) && question.task !== s.task)) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, `${q} is not one of your questions.`);
    if (question.state !== 'answered') return { question: q, state: 'open' };
    if (s.waitingOn === q) s.waitingOn = null;
    return { question: q, state: 'answered', answer: question.answer, decision: question.decision };
  }

  function checkInbox(token) {
    session(token, { role: 'main' });
    const current = view();
    const open = Object.values(current.questions).filter((q) => q.state === 'open').map((q) => ({
      question: q.id, task: q.task, askedBy: q.askedBy, text: q.text, options: q.options, blocking: q.blocking,
    }));
    open.sort((a, b) => Number(b.blocking) - Number(a.blocking));
    const workers = [...sessions.values()].filter((w) => w.role === 'worker').map(publicSession);
    return { open, blockingCount: open.filter((q) => q.blocking).length, pausedAll: current.pausedAll, workers };
  }

  const answer = (token, q, text, reason) => serialize(async () => {
    const s = session(token, { role: 'main' });
    if (typeof q !== 'string' || !QUESTION_ID.test(q)) throw relayError(RELAY_ERROR_CODES.INVALID, 'question must look like Q-2.');
    const current = view();
    const question = current.questions[q];
    if (!question) throw relayError(RELAY_ERROR_CODES.NOT_FOUND, `${q} does not exist.`);
    if (question.state !== 'open') throw relayError(RELAY_ERROR_CODES.CONFLICT, `${q} is already answered.`);
    const answerText = oneLine(text, 'text');
    const why = oneLine(reason, 'reason');
    const d = ledger.nextId('D');
    const answered = await ledger.append({ actor: actorOf(s), type: 'question.answered', subject: q, summary: answerText, evidence: [d] });
    const decided = await ledger.append({
      actor: actorOf(s), type: 'decision.made', subject: d, summary: answerText, reason: why,
      evidence: [q, ...(question.task ? [question.task] : [])],
    });
    let routedTo = null;
    for (const w of sessions.values()) {
      if (w.answers.has(q) || (w.role === 'worker' && question.task && w.task === question.task && w.agentId === question.askedBy)) {
        w.answers.set(q, { answer: answerText, decision: d });
        routedTo = w.agentId;
      }
    }
    return { question: q, decision: d, answer: answerText, routedTo, entries: [answered.n, decided.n] };
  });

  function lookup(token, ref) {
    session(token, { allowPaused: true });
    const entries = ledger.entries();
    return resolver(ref, { entries, view: relayView(entries) });
  }

  const releaseTask = (token, taskId, reason, { blocked = true } = {}) => serialize(async () => {
    const s = workerForTask(token, taskId);
    const why = oneLine(reason, 'reason');
    const type = blocked ? 'task.blocked' : 'task.progress';
    const entry = await ledger.append(blocked
      ? { actor: actorOf(s), type, subject: taskId, summary: `${s.agentId} released ${taskId} as blocked`, reason: why, evidence: [RELEASED] }
      : { actor: actorOf(s), type, subject: taskId, summary: `${s.agentId} released ${taskId}: ${why}`, reason: why, evidence: [RELEASED] });
    s.task = null;
    return { task: taskId, type, entry: entry.n };
  });

  const setPauseAll = (token, paused, reason) => serialize(async () => {
    const s = session(token, { role: 'main' });
    const why = oneLine(reason, 'reason');
    if (view().pausedAll === paused) return { pausedAll: paused, changed: false };
    const d = ledger.nextId('D');
    const entry = await ledger.append({
      actor: actorOf(s), type: 'decision.made', subject: d, summary: paused ? 'Pause all workers' : 'Resume all workers', reason: why,
      evidence: [paused ? PAUSE_ALL : RESUME_ALL],
    });
    return { pausedAll: paused, changed: true, decision: d, entry: entry.n };
  });

  const stopWorker = (token, agentId, reason) => serialize(async () => {
    const s = session(token, { role: 'main' });
    const why = oneLine(reason, 'reason');
    const target = [...sessions.values()].find((w) => w.role === 'worker' && w.agentId === agentId);
    if (!target) throw relayError(RELAY_ERROR_CODES.NOT_FOUND, `No worker named ${agentId} is connected.`);
    if (target.stopped) return { agent: agentId, stopped: true, changed: false };
    target.stopped = true;
    let entry = null;
    if (target.task) {
      entry = await ledger.append({
        actor: actorOf(s), type: 'task.blocked', subject: target.task, summary: `Main chat stopped ${agentId} on ${target.task}`, reason: why,
        evidence: [RELEASED],
      });
    }
    const task = target.task;
    target.task = null;
    return { agent: agentId, stopped: true, changed: true, task, entry: entry?.n ?? null };
  });

  return Object.freeze({
    hello, listTasks, claimTask, reportProgress, attachProof, askMain, checkAnswer, checkInbox, answer, lookup, releaseTask,
    pauseAll: (token, reason) => setPauseAll(token, true, reason),
    resumeAll: (token, reason) => setPauseAll(token, false, reason),
    stopWorker,
    sessions: () => [...sessions.values()].map(publicSession),
  });
}
