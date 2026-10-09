// Agent check-in relay (Core Specs §4): token-scoped write tools over the strict ledger.
//
// The relay never keeps authoritative state of its own: every task, question, decision, pause
// and stop it reasons about is re-derived from `ledger.entries()` on each call, so a restarted
// relay sees exactly what the ledger says. Live session tokens are held in memory; a session
// store keeps only a sha256 hash of each token so an agent can prove who it is after a restart
// (`hello({ agent, resume: <old token> })`). Tokens themselves are never written anywhere.
//
// Ledger encoding (structured details go in `data`, which the ledger's replay() reads; the
// evidence ids are kept for humans and for older readers):
//   question.asked     subject Q-n, summary = question, data {task, options, blocking[, reusedDecision]}
//   decision.made      subject D-n, summary = answer,   data {question, task}, reason required (written first)
//   question.answered  subject Q-n, summary = answer,   data {decision[, reusedDecision]}
//   task.blocked       written by release_task / stop_worker with data {released: true}
//   decision.made / question.answered are written as actor {kind: 'system', id: 'relay'} with data.by =
//   the main chat's agent id, because the ledger accepts those types only from a person or system.
//   pause/resume-all   decision.made with data {control: 'pause-all' | 'resume-all'}
//   stop_worker        decision.made with data {control: 'stop-worker', agent}
// Every task entry uses the current attempt id (T-1, or T-1.a2 after a reopen).
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
const TASK_ATTEMPT_ID = /^T-\d+(\.a\d+)?$/;
const QUESTION_ID = /^Q-\d+$/;
const DECISION_ID = /^D-\d+$/;
const AGENT_NAME = /^[A-Za-z0-9._ -]{1,80}$/;
const MAX_TEXT = 2000;
const CLAIMABLE_STATES = Object.freeze(['created', 'reopened', 'blocked', 'released']);
// The ledger lets only a person or Perfect Planner itself (system) write decisions and answers.
// The relay is part of Perfect Planner, so it records the main chat's decisions as the system
// actor and names the main chat in data.by (and data.model).
const RELAY_ACTOR = Object.freeze({ kind: 'system', id: 'relay' });
const ID_RETRIES = 5;

export function relayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const baseTaskId = (subject) => String(subject ?? '').replace(/\.a\d+$/, '');
// A done task keeps its last claimer for the record, but that is no longer a live claim.
const holdsClaim = (t) => Boolean(t.claimedBy) && t.state !== 'done';
const claimOf = (current, agentId) => Object.values(current.tasks).find((t) => t.claimedBy === agentId && holdsClaim(t)) ?? null;
const attemptId = (t) => (t.attempt > 1 ? `${t.id}.a${t.attempt}` : t.id);
const dataOf = (entry) => (entry?.data && typeof entry.data === 'object' && !Array.isArray(entry.data) ? entry.data : {});
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

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
 * Pure relay view over ledger entries: tasks (claim/test state), questions, decisions, pause flag,
 * stopped agents. Reads `data` first (the ledger's replay() contract) and falls back to the
 * evidence markers older relay entries used. The ledger module's replay() owns the full board.
 */
export function relayView(entries) {
  const tasks = {};
  const questions = {};
  const decisions = {};
  const stopped = new Set();
  const correctedEntries = new Set();
  const correctedIds = new Set();
  let pausedAll = false;
  const task = (id) => (tasks[id] ??= { id, title: null, state: 'created', attempt: 1, claimedBy: null, test: { defined: false, approved: false }, lastProgressAt: null, exists: false });
  for (const entry of entries) {
    const subject = entry.subject;
    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    const data = dataOf(entry);
    const released = data.released === true || evidence.includes(RELEASED);
    switch (entry.type) {
      case 'task.created': { const t = task(baseTaskId(subject)); t.exists = true; t.title = data.title ?? entry.summary; t.refs = entry.refs ?? []; break; }
      case 'test.defined': { const t = task(baseTaskId(subject)); t.test = { defined: true, approved: false }; break; }
      case 'test.approved': { const t = task(baseTaskId(subject)); t.test = { defined: true, approved: true }; break; }
      case 'task.claimed': { const t = task(baseTaskId(subject)); t.state = 'claimed'; t.claimedBy = entry.actor?.id ?? null; break; }
      case 'task.progress': {
        const t = task(baseTaskId(subject));
        t.lastProgressAt = entry.at;
        if (released) { t.claimedBy = null; t.state = 'released'; } else if (t.state !== 'done') t.state = 'in-progress';
        break;
      }
      case 'task.blocked': { const t = task(baseTaskId(subject)); t.state = 'blocked'; if (released) t.claimedBy = null; break; }
      case 'task.proof': { task(baseTaskId(subject)).state = 'proof'; break; }
      case 'task.done': { const t = task(baseTaskId(subject)); t.state = 'done'; break; }
      case 'task.reopened': { const t = task(baseTaskId(subject)); t.state = 'reopened'; t.attempt += 1; t.claimedBy = null; break; }
      case 'question.asked': {
        if (questions[subject]) break;
        const options = Array.isArray(data.options)
          ? data.options.map(String)
          : evidence.filter((e) => typeof e === 'string' && e.startsWith(OPTION_PREFIX)).map((e) => e.slice(OPTION_PREFIX.length));
        const rawTask = data.task ?? evidence.find((e) => TASK_ATTEMPT_ID.test(e)) ?? null;
        questions[subject] = {
          id: subject, task: rawTask ? baseTaskId(rawTask) : null, text: data.question ?? entry.summary, options,
          blocking: typeof data.blocking === 'boolean' ? data.blocking : evidence.includes('blocking'),
          state: 'open', answer: null, decision: null, decisionCorrected: false, askedBy: entry.actor?.id ?? null, askedAt: entry.n,
          reusedDecision: data.reusedDecision ?? null,
        };
        break;
      }
      case 'question.answered': {
        const q = questions[subject];
        if (q) {
          q.state = 'answered';
          q.answer = data.answer ?? entry.summary;
          q.decision = data.decision ?? evidence.find((e) => DECISION_ID.test(e)) ?? q.decision;
        }
        break;
      }
      case 'decision.made': {
        const question = data.question ?? evidence.find((e) => QUESTION_ID.test(e)) ?? null;
        decisions[subject] = { id: subject, text: data.text ?? entry.summary, reason: entry.reason ?? null, question, entry: entry.n, corrected: false };
        if (question && questions[question] && !questions[question].decision) questions[question].decision = subject;
        const control = data.control ?? (evidence.includes(PAUSE_ALL) ? 'pause-all' : evidence.includes(RESUME_ALL) ? 'resume-all' : null);
        if (control === 'pause-all') pausedAll = true;
        if (control === 'resume-all') pausedAll = false;
        if (control === 'stop-worker' && typeof data.agent === 'string') stopped.add(data.agent);
        break;
      }
      case 'correction': {
        if (entry.corrects) correctedEntries.add(entry.corrects);
        for (const e of evidence) if (DECISION_ID.test(e)) correctedIds.add(e);
        if (typeof data.decision === 'string') correctedIds.add(data.decision);
        break;
      }
      default: break;
    }
  }
  for (const d of Object.values(decisions)) d.corrected = correctedEntries.has(d.entry) || correctedIds.has(d.id);
  for (const q of Object.values(questions)) q.decisionCorrected = Boolean(q.decision && decisions[q.decision]?.corrected);
  return { tasks, questions, decisions, pausedAll, stopped };
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

/** In-memory session store: agent name -> { hash, role }. Only token hashes are kept. */
export function createMemorySessionStore() {
  const records = new Map();
  return {
    get: (agentId) => records.get(agentId) ?? null,
    set: (agentId, record) => { records.set(agentId, { hash: record.hash, role: record.role }); },
    all: () => [...records.entries()].map(([agent, r]) => ({ agent, ...r })),
  };
}

/**
 * File-backed session store (JSON of token hashes, never tokens). Written atomically
 * (temp file + rename) so a crash leaves either the old or the new file.
 */
export function createFileSessionStore(file) {
  const target = path.resolve(file);
  let records = Object.create(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    for (const [agent, r] of Object.entries(parsed?.agents ?? {})) {
      if (AGENT_NAME.test(agent.replace(/#\d+$/, '')) && typeof r?.hash === 'string' && /^[0-9a-f]{64}$/.test(r.hash) && (r.role === 'main' || r.role === 'worker')) {
        records[agent] = { hash: r.hash, role: r.role };
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const save = () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, agents: records }, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, target);
  };
  return {
    get: (agentId) => records[agentId] ?? null,
    set: (agentId, record) => { records[agentId] = { hash: record.hash, role: record.role }; save(); },
    all: () => Object.entries(records).map(([agent, r]) => ({ agent, ...r })),
  };
}

/**
 * createRelay({ ledger, now, resolver, tokenFactory, sessionStore, mainAgent }) — ledger implements
 * the shared Ledger interface (append/entries/nextId/subscribe). All relay writes are serialized
 * through one queue. `mainAgent` (e.g. from PP_MAIN_AGENT) names the only agent that may hold the
 * main-chat seat; without it the first agent to connect becomes main, and once a main chat is
 * recorded in the session store only that agent (proving its old token) can take the seat again.
 */
export function createRelay({
  ledger, now = () => new Date(), resolver = defaultResolver, tokenFactory = newToken,
  sessionStore = createMemorySessionStore(), mainAgent = null,
} = {}) {
  if (!ledger || typeof ledger.append !== 'function' || typeof ledger.entries !== 'function' || typeof ledger.nextId !== 'function') {
    throw relayError(RELAY_ERROR_CODES.INVALID, 'createRelay requires a ledger with append, entries and nextId.');
  }
  if (!sessionStore || typeof sessionStore.get !== 'function' || typeof sessionStore.set !== 'function') {
    throw relayError(RELAY_ERROR_CODES.INVALID, 'sessionStore must provide get and set.');
  }
  const ownerMain = mainAgent === null || mainAgent === undefined || mainAgent === '' ? null : String(mainAgent).trim();
  if (ownerMain !== null && !AGENT_NAME.test(ownerMain)) throw relayError(RELAY_ERROR_CODES.INVALID, 'mainAgent must be a valid agent name.');
  const sessions = new Map(); // token -> session
  let mainToken = null;
  let queue = Promise.resolve();

  const serialize = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const view = () => relayView(ledger.entries());
  const byOf = (session) => ({ by: session.agentId, ...(session.model ? { model: session.model } : {}) });
  const actorOf = (session) => ({ kind: 'agent', id: session.agentId, ...(session.model ? { model: session.model } : {}) });
  const publicSession = (s) => ({ agent: s.agentId, model: s.model, role: s.role, task: s.task, waitingOn: s.waitingOn, stopped: s.stopped });
  const storedMain = () => (typeof sessionStore.all === 'function' ? sessionStore.all().find((r) => r.role === 'main')?.agent ?? null : null);

  /**
   * Appends an entry that creates the next id in `series`. If another writer sharing the ledger
   * took that id between nextId() and append(), the ledger refuses with rule number-sequence and
   * nothing is written; the relay then retries with a fresh id.
   */
  async function appendNew(series, build) {
    for (let i = 0; ; i += 1) {
      const id = ledger.nextId(series);
      try {
        return { id, entry: await ledger.append(build(id)) };
      } catch (error) {
        if (i + 1 < ID_RETRIES && error?.code === 'LEDGER_RULE' && error?.rule === 'number-sequence') continue;
        throw error;
      }
    }
  }

  function openBlockingQuestion(current, agentId) {
    return Object.values(current.questions).find((q) => q.state === 'open' && q.blocking && q.askedBy === agentId) ?? null;
  }

  function session(token, { role, allowPaused = false } = {}) {
    const s = typeof token === 'string' ? sessions.get(token) : undefined;
    if (!s) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, 'Unknown or missing session token. Call hello first.');
    if (role && s.role !== role) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, `This tool needs a ${role} token; yours is a ${s.role} token.`);
    const current = view();
    if (s.stopped || current.stopped.has(s.agentId)) { s.stopped = true; throw relayError(RELAY_ERROR_CODES.STOPPED, 'This worker was stopped by the main chat.'); }
    if (s.role === 'worker' && !allowPaused) {
      if (s.waitingOn) throw relayError(RELAY_ERROR_CODES.PAUSED, `Paused until ${s.waitingOn} is answered; call check_answer.`);
      const blocking = openBlockingQuestion(current, s.agentId);
      if (blocking) { s.waitingOn = blocking.id; throw relayError(RELAY_ERROR_CODES.PAUSED, `Paused until ${blocking.id} is answered; call check_answer.`); }
      if (current.pausedAll) throw relayError(RELAY_ERROR_CODES.PAUSED, 'All workers are paused by the main chat.');
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
    return { s, t, subject: attemptId(t) };
  }

  function hello({ agent, model, role, resume } = {}) {
    const name = oneLine(agent, 'agent');
    if (!AGENT_NAME.test(name)) throw relayError(RELAY_ERROR_CODES.INVALID, 'agent must be 1-80 letters, digits, space, dot, dash or underscore.');
    if (role !== undefined && role !== 'main' && role !== 'worker') throw relayError(RELAY_ERROR_CODES.INVALID, 'role must be "main" or "worker".');
    const current = view();
    if (current.stopped.has(name)) throw relayError(RELAY_ERROR_CODES.STOPPED, `${name} was stopped by the main chat and cannot reconnect under that name.`);
    const cleanModel = typeof model === 'string' && model.trim() ? model.trim() : null;
    const register = (token, agentId, assigned) => {
      for (const [t, live] of sessions) if (live.agentId === agentId) { sessions.delete(t); if (t === mainToken) mainToken = null; }
      const claimed = claimOf(current, agentId);
      const blocking = openBlockingQuestion(current, agentId);
      const s = {
        token, agentId, model: cleanModel, role: assigned, task: assigned === 'worker' ? claimed?.id ?? null : null, waitingOn: blocking?.id ?? null,
        stopped: false, answers: new Map(), registeredAt: now().toISOString(), lastSeenAt: now().toISOString(),
      };
      sessions.set(token, s);
      if (assigned === 'main') mainToken = token;
      sessionStore.set(agentId, { hash: hashToken(token), role: assigned });
      return { token, agent: agentId, role: assigned, task: s.task, resumed: false };
    };

    // Resume: the agent proves its identity with the token it was given before (e.g. before a restart).
    if (resume !== undefined && resume !== null) {
      const record = typeof resume === 'string' ? sessionStore.get(name) : null;
      if (!record || record.hash !== hashToken(resume)) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, `The resume token does not match ${name}.`);
      if (record.role === 'main' && ownerMain !== null && ownerMain !== name) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, `The main chat seat is reserved for ${ownerMain}.`);
      if (record.role === 'main' && mainToken && sessions.get(mainToken)?.agentId !== name) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, 'A main chat is already registered.');
      return { ...register(resume, name, record.role), resumed: true };
    }

    // Owner-named main chat: only that name gets the seat, and it does not need a resume token.
    if (ownerMain !== null && name === ownerMain && role !== 'worker') {
      if (mainToken) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, 'A main chat is already registered.');
      return register(tokenFactory(), name, 'main');
    }
    const mainReserved = ownerMain !== null || storedMain() !== null;
    if (role === 'main' && (mainToken || mainReserved)) {
      throw relayError(RELAY_ERROR_CODES.FORBIDDEN, mainToken ? 'A main chat is already registered.' : 'The main chat seat is reserved; reconnect it with its resume token.');
    }
    // Names that are connected, hold a ledger claim, or are recorded in the session store are taken:
    // a new caller gets a fresh suffixed name and can never pick up someone else's claim.
    const taken = new Set([...sessions.values()].map((s) => s.agentId));
    for (const t of Object.values(current.tasks)) if (holdsClaim(t)) taken.add(t.claimedBy);
    for (const stoppedName of current.stopped) taken.add(stoppedName);
    let agentId = name;
    for (let i = 2; taken.has(agentId) || sessionStore.get(agentId); i += 1) agentId = `${name}#${i}`;
    const assigned = !mainToken && !mainReserved && role !== 'worker' ? 'main' : 'worker';
    return register(tokenFactory(), agentId, assigned);
  }

  function listTasks(token) {
    session(token, { allowPaused: true });
    const { tasks } = view();
    return Object.values(tasks).filter((t) => t.exists).map((t) => ({
      id: t.id, title: t.title, state: t.state, attempt: t.attempt, claimedBy: t.claimedBy, testApproved: t.test.approved,
      claimable: !t.claimedBy && CLAIMABLE_STATES.includes(t.state) && t.test.approved,
    }));
  }

  const claimTask = (token, taskId) => serialize(async () => {
    const s = session(token, { role: 'worker' });
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw relayError(RELAY_ERROR_CODES.INVALID, 'task must look like T-14.');
    const current = view();
    if (s.task && s.task !== taskId) {
      // The token only stays bound while the ledger still shows this agent holding the claim.
      // Once that task is done, reopened or released, the worker may claim the next one.
      const held = current.tasks[s.task];
      if (held && held.claimedBy === s.agentId && holdsClaim(held)) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, `Your token already covers ${s.task}; release it first.`);
      s.task = null;
    }
    const t = current.tasks[taskId];
    if (!t || !t.exists) throw relayError(RELAY_ERROR_CODES.NOT_FOUND, `${taskId} does not exist.`);
    if (t.claimedBy === s.agentId && holdsClaim(t)) { s.task = taskId; return { task: taskId, attempt: t.attempt, alreadyClaimed: true }; }
    if (t.claimedBy) throw relayError(RELAY_ERROR_CODES.CONFLICT, `${taskId} is claimed by ${t.claimedBy}.`);
    if (!CLAIMABLE_STATES.includes(t.state)) throw relayError(RELAY_ERROR_CODES.CONFLICT, `${taskId} is ${t.state} and cannot be claimed.`);
    if (!t.test.approved) throw relayError(RELAY_ERROR_CODES.TEST_NOT_APPROVED, `${taskId} cannot start until its acceptance test is defined and approved.`);
    const subject = attemptId(t);
    const entry = await ledger.append({ actor: actorOf(s), type: 'task.claimed', subject, summary: `${s.agentId} claimed ${subject}` });
    s.task = taskId;
    return { task: taskId, attempt: t.attempt, entry: entry.n };
  });

  const reportProgress = (token, taskId, text) => serialize(async () => {
    const { s, subject } = workerForTask(token, taskId);
    const entry = await ledger.append({ actor: actorOf(s), type: 'task.progress', subject, summary: oneLine(text, 'text') });
    return { task: taskId, entry: entry.n };
  });

  const attachProof = (token, taskId, kind, link) => serialize(async () => {
    const { s, subject } = workerForTask(token, taskId);
    const k = oneLine(kind, 'kind');
    const l = oneLine(link, 'link');
    const entry = await ledger.append({ actor: actorOf(s), type: 'task.proof', subject, summary: `Proof (${k}) attached for ${subject}`, evidence: [l], data: { kind: k, link: l } });
    return { task: taskId, kind: k, entry: entry.n };
  });

  const askMain = (token, taskId, question, options = [], blocking = false) => serialize(async () => {
    const { s, subject } = workerForTask(token, taskId);
    const text = oneLine(question, 'question');
    if (!Array.isArray(options) || options.length > 20) throw relayError(RELAY_ERROR_CODES.INVALID, 'options must be an array of at most 20 strings.');
    const opts = options.map((o, i) => oneLine(o, `options[${i}]`));
    const isBlocking = Boolean(blocking);
    const key = questionKey(text, opts);
    const current = view();
    // Reuse only a still-valid decision: one a later correction entry names is skipped.
    const prior = Object.values(current.questions)
      .filter((q) => q.state === 'answered' && q.decision && !q.decisionCorrected && questionKey(q.text, q.options) === key)
      .at(-1);
    const evidence = [subject, ...opts.map((o) => OPTION_PREFIX + o), isBlocking ? 'blocking' : 'non-blocking'];
    const data = { task: subject, options: opts, blocking: isBlocking, ...(prior ? { reusedDecision: prior.decision } : {}) };
    const { id: q, entry: asked } = await appendNew('Q', (id) => ({ actor: actorOf(s), type: 'question.asked', subject: id, summary: text, evidence, data }));
    if (prior) {
      const answered = await ledger.append({
        actor: RELAY_ACTOR, type: 'question.answered', subject: q, summary: prior.answer,
        evidence: [prior.decision, prior.id], data: { decision: prior.decision, reusedDecision: prior.decision, reusedFrom: prior.id },
      });
      s.answers.set(q, { answer: prior.answer, decision: prior.decision });
      return { question: q, state: 'answered', answer: prior.answer, decision: prior.decision, dedupedFrom: prior.id, entries: [asked.n, answered.n] };
    }
    s.answers.set(q, null);
    if (isBlocking) s.waitingOn = q;
    return { question: q, state: 'open', blocking: isBlocking, entries: [asked.n] };
  });

  function checkAnswer(token, q) {
    const s = session(token, { role: 'worker', allowPaused: true });
    const question = view().questions[q];
    if (!question || (!s.answers.has(q) && question.askedBy !== s.agentId && question.task !== s.task)) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, `${q} is not one of your questions.`);
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
    const question = view().questions[q];
    if (!question) throw relayError(RELAY_ERROR_CODES.NOT_FOUND, `${q} does not exist.`);
    if (question.state !== 'open') throw relayError(RELAY_ERROR_CODES.CONFLICT, `${q} is already answered.`);
    const answerText = oneLine(text, 'text');
    const why = oneLine(reason, 'reason');
    // decision.made first: if its id is taken by another writer, nothing has been written yet.
    const { id: d, entry: decided } = await appendNew('D', (id) => ({
      actor: RELAY_ACTOR, type: 'decision.made', subject: id, summary: answerText, reason: why,
      evidence: [q, ...(question.task ? [question.task] : [])], data: { question: q, ...(question.task ? { task: question.task } : {}), ...byOf(s) },
    }));
    const answered = await ledger.append({ actor: RELAY_ACTOR, type: 'question.answered', subject: q, summary: answerText, evidence: [d], data: { decision: d, ...byOf(s) } });
    let routedTo = null;
    for (const w of sessions.values()) {
      if (w.answers.has(q) || (w.role === 'worker' && w.agentId === question.askedBy)) {
        w.answers.set(q, { answer: answerText, decision: d });
        routedTo = w.agentId;
      }
    }
    return { question: q, decision: d, answer: answerText, routedTo, entries: [decided.n, answered.n] };
  });

  function lookup(token, ref) {
    session(token, { allowPaused: true });
    const entries = ledger.entries();
    // The strict ledger's board carries the plans (board.plans[P].clauses), which a
    // clause-aware resolver such as core/clauses lookup() needs to return clause text.
    const board = typeof ledger.board === 'function' ? ledger.board() : null;
    return resolver(ref, { entries, view: relayView(entries), board, plans: board?.plans ?? {} });
  }

  // A release always records task.blocked: the ledger only allows a new claim from created,
  // reopened or blocked, so a release recorded as progress would leave the task unclaimable.
  const releaseTask = (token, taskId, reason) => serialize(async () => {
    const { s, subject } = workerForTask(token, taskId);
    const why = oneLine(reason, 'reason');
    const entry = await ledger.append({
      actor: actorOf(s), type: 'task.blocked', subject, summary: `${s.agentId} released ${subject}`, reason: why,
      evidence: [RELEASED], data: { released: true },
    });
    s.task = null;
    return { task: taskId, type: 'task.blocked', entry: entry.n };
  });

  const setPauseAll = (token, paused, reason) => serialize(async () => {
    const s = session(token, { role: 'main' });
    const why = oneLine(reason, 'reason');
    if (view().pausedAll === paused) return { pausedAll: paused, changed: false };
    const { id: d, entry } = await appendNew('D', (id) => ({
      actor: RELAY_ACTOR, type: 'decision.made', subject: id, summary: paused ? 'Pause all workers' : 'Resume all workers', reason: why,
      evidence: [paused ? PAUSE_ALL : RESUME_ALL], data: { control: paused ? 'pause-all' : 'resume-all', ...byOf(s) },
    }));
    return { pausedAll: paused, changed: true, decision: d, entry: entry.n };
  });

  // Stops a worker by name, connected or not (e.g. one holding a claim after a restart). The stop is
  // a ledger decision, so it survives restarts and blocks hello under that name.
  const stopWorker = (token, agentId, reason) => serialize(async () => {
    const s = session(token, { role: 'main' });
    const why = oneLine(reason, 'reason');
    if (typeof agentId !== 'string' || !agentId.trim()) throw relayError(RELAY_ERROR_CODES.INVALID, 'agent must be a worker name.');
    if (agentId === s.agentId) throw relayError(RELAY_ERROR_CODES.FORBIDDEN, 'The main chat cannot stop itself.');
    const current = view();
    const live = [...sessions.values()].filter((w) => w.agentId === agentId);
    const claimed = claimOf(current, agentId);
    const stored = sessionStore.get(agentId);
    if (live.some((w) => w.role === 'main') || stored?.role === 'main') throw relayError(RELAY_ERROR_CODES.FORBIDDEN, `${agentId} is the main chat, not a worker.`);
    if (!live.length && !claimed && !stored && !current.stopped.has(agentId)) throw relayError(RELAY_ERROR_CODES.NOT_FOUND, `No worker named ${agentId} is known.`);
    for (const w of live) { w.stopped = true; w.task = null; }
    if (current.stopped.has(agentId)) return { agent: agentId, stopped: true, changed: false };
    const { id: d, entry: decided } = await appendNew('D', (id) => ({
      actor: RELAY_ACTOR, type: 'decision.made', subject: id, summary: `Stop worker ${agentId}`, reason: why, data: { control: 'stop-worker', agent: agentId, ...byOf(s) },
    }));
    let entry = null;
    if (claimed) {
      const subject = attemptId(claimed);
      entry = await ledger.append({
        actor: actorOf(s), type: 'task.blocked', subject, summary: `Main chat stopped ${agentId} on ${subject}`, reason: why,
        evidence: [RELEASED], data: { released: true, stoppedAgent: agentId },
      });
    }
    return { agent: agentId, stopped: true, changed: true, task: claimed?.id ?? null, decision: d, entries: [decided.n, ...(entry ? [entry.n] : [])], entry: entry?.n ?? decided.n };
  });

  return Object.freeze({
    hello, listTasks, claimTask, reportProgress, attachProof, askMain, checkAnswer, checkInbox, answer, lookup, releaseTask,
    pauseAll: (token, reason) => setPauseAll(token, true, reason),
    resumeAll: (token, reason) => setPauseAll(token, false, reason),
    stopWorker,
    sessions: () => [...sessions.values()].map(publicSession),
  });
}
