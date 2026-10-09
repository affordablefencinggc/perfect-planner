import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  createFileSessionStore, createMemorySessionStore, createRelay, defaultResolver, hashToken, normalizeQuestionText, questionKey, relayView,
} from '../src/core/relay/index.mjs';
import { RELAY_TOOL_NAMES, relayToolError } from '../mcp/perfectPlannerRelayTools.mjs';
import { resolveRelayWriteConfig } from '../mcp/perfectPlannerMcpCore.mjs';

// Small in-memory fake of the shared Ledger interface (src/core/ledger/index.mjs). It mirrors the real
// ledger's refusals that matter to the relay: task state transitions (ALLOWED_FROM), attempt ids,
// never-skipped numbers (rule number-sequence), the claim test gate, and it keeps `data`.
const REASON_TYPES = /^(decision\.made|correction)$|\.(blocked|reopened|rejected)$/;
const ALLOWED_FROM = {
  'task.claimed': ['created', 'reopened', 'blocked', 'released'],
  'task.progress': ['claimed', 'in-progress', 'blocked', 'proof'],
  'task.blocked': ['created', 'claimed', 'in-progress', 'proof', 'reopened', 'released'],
  'task.proof': ['claimed', 'in-progress', 'proof'],
  'task.done': ['claimed', 'in-progress', 'proof', 'blocked'],
  'task.reopened': ['claimed', 'in-progress', 'blocked', 'proof', 'done', 'released'],
};
// Like the real ledger, only a person or the system may answer questions and record decisions.
const PERSON_OR_SYSTEM = new Set(['question.answered', 'decision.made', 'test.approved', 'task.done', 'task.reopened', 'correction']);
function fakeLedger() {
  const list = [];
  const subscribers = new Set();
  const tasks = {};
  const questions = {};
  const sequence = { T: 0, Q: 0, D: 0 };
  let clock = Date.parse('2026-10-09T00:00:00.000Z');
  const refuse = (rule, message) => { const e = new Error(message); e.code = 'LEDGER_RULE'; e.rule = rule; throw e; };
  const requireNew = (series, subject) => { if (subject !== `${series}-${sequence[series] + 1}`) refuse('number-sequence', `${subject} skips or reuses a number`); };
  function validate({ type, subject, data }) {
    const m = /^(T-\d+)(?:\.a(\d+))?$/.exec(subject ?? '');
    if (type === 'task.created') { requireNew('T', subject); return; }
    if (type.startsWith('task.') || type.startsWith('test.')) {
      if (!m) refuse('subject-task', `${type} needs a task subject`);
      const t = tasks[m[1]];
      if (!t) refuse('task-unknown', `${m[1]} does not exist`);
      if (m[2] && Number(m[2]) !== t.attempt) refuse('task-attempt', `${subject} is not the current attempt`);
      if (ALLOWED_FROM[type] && !ALLOWED_FROM[type].includes(t.state)) refuse('task-state', `${type} is not allowed while ${m[1]} is ${t.state}`);
      if (type === 'task.claimed' && !t.approved) refuse('task-test-not-approved', 'test not approved');
      return;
    }
    if (type === 'question.asked') requireNew('Q', subject);
    if (type === 'question.answered' && questions[subject] !== 'open') refuse('question-answered', `${subject} is not open`);
    if (type === 'decision.made') {
      requireNew('D', subject);
      if (data?.question && !questions[data.question]) refuse('question-unknown', `unknown question ${data.question}`);
    }
  }
  function apply({ type, subject, actor, data }) {
    const m = /^(T-\d+)/.exec(subject ?? '');
    const t = m ? tasks[m[1]] : null;
    const series = /^([TQD])-(\d+)$/.exec(subject ?? '');
    if (['task.created', 'question.asked', 'decision.made'].includes(type) && series) sequence[series[1]] = Math.max(sequence[series[1]], Number(series[2]));
    if (type === 'task.created') tasks[subject] = { state: 'created', attempt: 1, approved: false, claimedBy: null };
    else if (type === 'test.defined') t.approved = false;
    else if (type === 'test.approved') t.approved = true;
    else if (type === 'task.claimed') { t.state = 'claimed'; t.claimedBy = actor.id; }
    else if (type === 'task.progress') { if (data?.released) { t.state = 'released'; t.claimedBy = null; } else if (t.state !== 'done') t.state = 'in-progress'; }
    else if (type === 'task.blocked') { t.state = 'blocked'; if (data?.released) t.claimedBy = null; }
    else if (type === 'task.proof') t.state = 'proof';
    else if (type === 'task.done') t.state = 'done';
    else if (type === 'task.reopened') { t.state = 'reopened'; t.attempt += 1; t.claimedBy = null; }
    else if (type === 'question.asked') questions[subject] = 'open';
    else if (type === 'question.answered') questions[subject] = 'answered';
  }
  return {
    async append({ actor, type, subject, summary, reason = null, evidence = [], refs = [], corrects = null, data }) {
      if (!actor?.kind || !actor?.id) refuse('actor-required', 'actor required');
      if (typeof summary !== 'string' || !summary.trim() || /\n/.test(summary) || summary.trim() === 'TBD') refuse('summary-required', 'summary invalid');
      if (REASON_TYPES.test(type) && !(typeof reason === 'string' && reason.trim())) refuse('reason-required', `${type} needs a reason`);
      if (data !== undefined && (data === null || typeof data !== 'object' || Array.isArray(data))) refuse('data-shape', 'data must be an object');
      if (PERSON_OR_SYSTEM.has(type) && !['person', 'system'].includes(actor.kind)) refuse('actor-not-permitted', `${type} may only be written by person or system`);
      validate({ type, subject, data });
      clock += 1000;
      const entry = Object.freeze({
        n: `L-${String(list.length + 1).padStart(6, '0')}`, at: new Date(clock).toISOString(), actor, type, subject, summary, reason,
        evidence: Object.freeze([...evidence]), refs: Object.freeze([...refs]), corrects, prev: null, hash: 'fake',
        ...(data !== undefined ? { data: Object.freeze(JSON.parse(JSON.stringify(data))) } : {}),
      });
      apply(entry);
      list.push(entry);
      for (const fn of subscribers) fn(entry);
      return entry;
    },
    entries: () => [...list],
    nextId(series) { return `${series}-${sequence[series] + 1}`; },
    claimedBy: (id) => tasks[id]?.claimedBy ?? null,
    stateOf: (id) => tasks[id]?.state ?? null,
    verify: () => ({ ok: true }),
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    close() {},
  };
}

const system = { kind: 'system', id: 'perfect-planner' };
async function seedTask(ledger, title, { approved = true } = {}) {
  const id = ledger.nextId('T');
  await ledger.append({ actor: system, type: 'task.created', subject: id, summary: title, refs: ['P-1 §3.1'] });
  await ledger.append({ actor: system, type: 'test.defined', subject: id, summary: `node --test tests/${id}.test.mjs` });
  if (approved) await ledger.append({ actor: { kind: 'person', id: 'owner' }, type: 'test.approved', subject: id, summary: 'Approved acceptance test' });
  return id;
}

async function rejects(promiseOrFn, code) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${code}, call succeeded`);
}

async function setup() {
  const ledger = fakeLedger();
  const relay = createRelay({ ledger });
  const t1 = await seedTask(ledger, 'Build login form');
  const t2 = await seedTask(ledger, 'Build signup form');
  const main = relay.hello({ agent: 'lead', model: 'claude-opus' });
  const w1 = relay.hello({ agent: 'worker', model: 'claude-sonnet' });
  const w2 = relay.hello({ agent: 'worker', model: 'gpt' });
  return { ledger, relay, t1, t2, main, w1, w2 };
}

test('hello: first agent is main chat, later agents are workers with unique ids', async () => {
  const { relay, main, w1, w2 } = await setup();
  assert.equal(main.role, 'main');
  assert.equal(w1.role, 'worker');
  assert.equal(w2.role, 'worker');
  assert.equal(w1.agent, 'worker');
  assert.equal(w2.agent, 'worker#2');
  assert.notEqual(w1.token, w2.token);
  assert.match(main.token, /^pp_[a-f0-9]{48}$/);
  await rejects(() => relay.hello({ agent: 'another-lead', role: 'main' }), 'RELAY_FORBIDDEN');
  await rejects(() => relay.hello({ agent: '' }), 'RELAY_INVALID');
  await rejects(() => relay.hello({ agent: 'x', role: 'admin' }), 'RELAY_INVALID');
  const ledger = fakeLedger();
  const fresh = createRelay({ ledger });
  assert.equal(fresh.hello({ agent: 'early-worker', role: 'worker' }).role, 'worker', 'an explicit worker does not take the main seat');
  assert.equal(fresh.hello({ agent: 'lead' }).role, 'main');
  assert.equal(ledger.entries().length, 0, 'hello writes nothing');
});

test('token scoping: every call is checked against token role and task binding', async () => {
  const { relay, ledger, t1, t2, main, w1, w2 } = await setup();
  await rejects(() => relay.listTasks('pp_nope'), 'RELAY_FORBIDDEN');
  await rejects(relay.claimTask(undefined, t1), 'RELAY_FORBIDDEN');
  await rejects(relay.claimTask(main.token, t1), 'RELAY_FORBIDDEN');
  await rejects(() => relay.checkInbox(w1.token), 'RELAY_FORBIDDEN');
  await rejects(relay.answer(w1.token, 'Q-1', 'yes', 'because'), 'RELAY_FORBIDDEN');
  await rejects(relay.pauseAll(w1.token, 'nope'), 'RELAY_FORBIDDEN');
  await rejects(relay.stopWorker(w1.token, 'worker#2', 'nope'), 'RELAY_FORBIDDEN');
  await rejects(relay.reportProgress(w1.token, t1, 'started'), 'RELAY_FORBIDDEN');

  const claim = await relay.claimTask(w1.token, t1);
  assert.equal(claim.task, t1);
  assert.equal((await relay.claimTask(w1.token, t1)).alreadyClaimed, true);
  await rejects(relay.claimTask(w1.token, t2), 'RELAY_FORBIDDEN');
  await rejects(relay.reportProgress(w1.token, t2, 'sneaky'), 'RELAY_FORBIDDEN');
  await rejects(relay.attachProof(w1.token, t2, 'log', 'file://x'), 'RELAY_FORBIDDEN');
  await rejects(relay.askMain(w1.token, t2, 'q?'), 'RELAY_FORBIDDEN');
  await rejects(relay.releaseTask(w1.token, t2, 'nope'), 'RELAY_FORBIDDEN');
  await rejects(relay.claimTask(w2.token, t1), 'RELAY_CONFLICT');
  await rejects(relay.reportProgress(w2.token, t1, 'not mine'), 'RELAY_FORBIDDEN');
  await rejects(relay.claimTask(w2.token, 'T-99'), 'RELAY_NOT_FOUND');
  await rejects(relay.claimTask(w2.token, 'bogus'), 'RELAY_INVALID');
  await rejects(relay.reportProgress(w1.token, t1, '   '), 'RELAY_INVALID');
  await rejects(relay.reportProgress(w1.token, t1, 'TBD'), 'RELAY_INVALID');

  const progress = await relay.reportProgress(w1.token, t1, 'Form\nrendered');
  const entry = ledger.entries().find((e) => e.n === progress.entry);
  assert.equal(entry.type, 'task.progress');
  assert.equal(entry.summary, 'Form rendered', 'multi-line text collapses to one line');
  assert.deepEqual(entry.actor, { kind: 'agent', id: 'worker', model: 'claude-sonnet' });

  await relay.attachProof(w1.token, t1, 'test-run', 'artifact://run/42');
  assert.equal(ledger.entries().at(-1).type, 'task.proof');
  assert.deepEqual(ledger.entries().at(-1).evidence, ['artifact://run/42']);

  // Releasing frees the token to claim another task, and frees the task for others.
  await relay.releaseTask(w1.token, t1, 'Needs design input');
  const released = ledger.entries().at(-1);
  assert.equal(released.type, 'task.blocked');
  assert.equal(released.reason, 'Needs design input');
  await rejects(relay.reportProgress(w1.token, t1, 'after release'), 'RELAY_FORBIDDEN');
  await relay.claimTask(w1.token, t2);
  await relay.claimTask(w2.token, t1);
  assert.deepEqual(relay.listTasks(main.token).map((t) => [t.id, t.claimedBy]), [[t1, 'worker#2'], [t2, 'worker']]);
});

test('claim is refused until the acceptance test is approved; reopened tasks claim with attempt suffix', async () => {
  const ledger = fakeLedger();
  const relay = createRelay({ ledger });
  relay.hello({ agent: 'lead' });
  const w = relay.hello({ agent: 'w' });
  const t = await seedTask(ledger, 'Unapproved', { approved: false });
  await rejects(relay.claimTask(w.token, t), 'RELAY_TEST_NOT_APPROVED');
  assert.equal(relay.listTasks(w.token)[0].claimable, false);
  await ledger.append({ actor: { kind: 'person', id: 'owner' }, type: 'test.approved', subject: t, summary: 'ok' });
  await relay.claimTask(w.token, t);
  await relay.releaseTask(w.token, t, 'handing back');
  assert.equal(ledger.entries().at(-1).type, 'task.blocked', 'a release is always task.blocked, which the ledger lets anyone re-claim');
  await relay.claimTask(w.token, t);
  await ledger.append({ actor: system, type: 'task.done', subject: t, summary: 'done' });
  await rejects(relay.claimTask(w.token, t), 'RELAY_CONFLICT');
  await ledger.append({ actor: system, type: 'task.reopened', subject: t, summary: 'reopen', reason: 'regression' });
  const claim = await relay.claimTask(w.token, t);
  assert.equal(claim.attempt, 2);
  assert.equal(ledger.entries().at(-1).subject, `${t}.a2`);
  await relay.reportProgress(w.token, t, 'second attempt underway');
  await relay.attachProof(w.token, t, 'log', 'log://a2');
  await relay.askMain(w.token, t, 'Keep the old fixture?');
  await relay.releaseTask(w.token, t, 'handing back attempt two');
  const second = ledger.entries().filter((e) => e.actor.kind === 'agent').slice(-5);
  assert.deepEqual(second.map((e) => [e.type, e.subject]), [
    ['task.claimed', `${t}.a2`], ['task.progress', `${t}.a2`], ['task.proof', `${t}.a2`], ['question.asked', 'Q-1'], ['task.blocked', `${t}.a2`],
  ], 'every entry about a reopened task uses the current attempt id');
  assert.equal(second[3].data.task, `${t}.a2`);
  assert.equal(relayView(ledger.entries()).questions['Q-1'].task, t, 'questions still group under the base task');
});

test('relay dedupe: an identical answered question returns the earlier decision at once and is logged', async () => {
  const { relay, ledger, t1, t2, main, w1, w2 } = await setup();
  await relay.claimTask(w1.token, t1);
  await relay.claimTask(w2.token, t2);
  const asked = await relay.askMain(w1.token, t1, 'Should forms use the shared Button component?', ['yes', 'no']);
  assert.deepEqual([asked.question, asked.state], ['Q-1', 'open']);
  const inbox = relay.checkInbox(main.token);
  assert.equal(inbox.open.length, 1);
  assert.deepEqual(inbox.open[0], { question: 'Q-1', task: t1, askedBy: 'worker', text: 'Should forms use the shared Button component?', options: ['yes', 'no'], blocking: false });
  await rejects(relay.answer(main.token, 'Q-1', 'yes', ''), 'RELAY_INVALID');
  const answered = await relay.answer(main.token, 'Q-1', 'yes', 'Keeps styling consistent');
  assert.deepEqual([answered.decision, answered.routedTo], ['D-1', 'worker']);
  await rejects(relay.answer(main.token, 'Q-1', 'no', 'again'), 'RELAY_CONFLICT');
  await rejects(relay.answer(main.token, 'Q-7', 'no', 'why'), 'RELAY_NOT_FOUND');

  const before = ledger.entries().length;
  const dup = await relay.askMain(w2.token, t2, '  should FORMS use the shared   button component ', ['No', 'Yes']);
  assert.equal(dup.state, 'answered');
  assert.equal(dup.answer, 'yes');
  assert.equal(dup.decision, 'D-1');
  assert.equal(dup.dedupedFrom, 'Q-1');
  assert.equal(dup.question, 'Q-2');
  const added = ledger.entries().slice(before);
  assert.deepEqual(added.map((e) => [e.type, e.subject]), [['question.asked', 'Q-2'], ['question.answered', 'Q-2']]);
  assert.ok(added[1].evidence.includes('D-1'));
  assert.equal(ledger.entries().filter((e) => e.type === 'decision.made').length, 1, 'no new decision for a dedupe');
  assert.equal(relay.checkInbox(main.token).open.length, 0);
  assert.equal(relay.checkAnswer(w2.token, 'Q-2').decision, 'D-1');

  // Different options are a different question.
  const different = await relay.askMain(w2.token, t2, 'Should forms use the shared Button component?', ['yes', 'no', 'later']);
  assert.equal(different.state, 'open');
  assert.equal(different.question, 'Q-3');
  assert.equal(normalizeQuestionText(' Hello   World?? '), 'hello world');
  assert.equal(questionKey('A?', ['x', 'Y']), questionKey('a', ['y', 'X']));
});

test('blocking question pauses only the asking worker until answered', async () => {
  const { relay, t1, t2, main, w1, w2 } = await setup();
  await relay.claimTask(w1.token, t1);
  await relay.claimTask(w2.token, t2);
  const q = await relay.askMain(w1.token, t1, 'Which auth provider?', ['local', 'oauth'], true);
  assert.equal(q.blocking, true);
  await rejects(relay.reportProgress(w1.token, t1, 'still going'), 'RELAY_PAUSED');
  await rejects(relay.askMain(w1.token, t1, 'another?'), 'RELAY_PAUSED');
  assert.deepEqual(relay.checkAnswer(w1.token, q.question), { question: q.question, state: 'open' });
  await relay.reportProgress(w2.token, t2, 'unaffected by the other worker'); // other worker keeps working
  await rejects(() => relay.checkAnswer(w2.token, q.question), 'RELAY_FORBIDDEN');
  assert.equal(relay.checkInbox(main.token).blockingCount, 1);
  assert.equal(relay.sessions().find((s) => s.agent === 'worker').waitingOn, q.question);
  await relay.answer(main.token, q.question, 'local', 'Offline-first requirement');
  await rejects(relay.reportProgress(w1.token, t1, 'still paused until checked'), 'RELAY_PAUSED');
  const got = relay.checkAnswer(w1.token, q.question);
  assert.deepEqual([got.state, got.answer, got.decision], ['answered', 'local', 'D-1']);
  await relay.reportProgress(w1.token, t1, 'resumed after answer');
});

test('pause-all writes ledger decisions and stops every worker; stop_worker halts one worker alone', async () => {
  const { relay, ledger, t1, t2, main, w1, w2 } = await setup();
  await relay.claimTask(w1.token, t1);
  await relay.claimTask(w2.token, t2);
  const paused = await relay.pauseAll(main.token, 'Owner reviewing the plan');
  assert.equal(paused.changed, true);
  const pauseEntry = ledger.entries().at(-1);
  assert.deepEqual([pauseEntry.type, pauseEntry.subject, pauseEntry.reason], ['decision.made', 'D-1', 'Owner reviewing the plan']);
  assert.equal((await relay.pauseAll(main.token, 'again')).changed, false);
  await rejects(relay.reportProgress(w1.token, t1, 'x'), 'RELAY_PAUSED');
  await rejects(relay.reportProgress(w2.token, t2, 'x'), 'RELAY_PAUSED');
  assert.equal(relay.listTasks(w1.token).length, 2, 'reads still work while paused');
  assert.equal(relay.checkInbox(main.token).pausedAll, true);
  await relay.resumeAll(main.token, 'Plan confirmed');
  await relay.reportProgress(w1.token, t1, 'back to work');

  const stopped = await relay.stopWorker(main.token, 'worker#2', 'Looping on the same error');
  assert.deepEqual([stopped.task, stopped.changed], [t2, true]);
  const stopEntry = ledger.entries().at(-1);
  assert.deepEqual([stopEntry.type, stopEntry.subject, stopEntry.reason], ['task.blocked', t2, 'Looping on the same error']);
  await rejects(relay.reportProgress(w2.token, t2, 'x'), 'RELAY_STOPPED');
  await rejects(() => relay.listTasks(w2.token), 'RELAY_STOPPED');
  await relay.reportProgress(w1.token, t1, 'other worker unaffected');
  await rejects(relay.stopWorker(main.token, 'ghost', 'x'), 'RELAY_NOT_FOUND');
  const w3 = relay.hello({ agent: 'fresh' });
  await relay.claimTask(w3.token, t2); // the stopped worker's task is claimable again
});

test('lookup: default ledger search and injectable resolver', async () => {
  const { relay, ledger, t1, main, w1 } = await setup();
  await relay.claimTask(w1.token, t1);
  await relay.askMain(w1.token, t1, 'Use tabs?');
  await relay.answer(main.token, 'Q-1', 'no', 'House style');
  const task = relay.lookup(w1.token, t1);
  assert.equal(task.text, 'Build login form');
  assert.deepEqual(task.history.map((e) => e.type), ['task.created', 'test.defined', 'test.approved', 'task.claimed']);
  assert.ok(task.citedBy.some((e) => e.type === 'question.asked'), 'question citing the task is listed');
  const q = relay.lookup(main.token, 'Q-1');
  assert.equal(q.text, 'Use tabs?');
  assert.ok(q.citedBy.some((e) => e.subject === 'D-1'));
  const d = relay.lookup(main.token, 'D-1');
  assert.equal(d.text, 'no');
  const first = ledger.entries()[0].n;
  assert.equal(relay.lookup(main.token, first).history[0].n, first);
  assert.ok(relay.lookup(main.token, '§3.1').citedBy.length >= 2, 'clause refs are found through citations');
  await rejects(() => relay.lookup(main.token, 'R-9'), 'RELAY_NOT_FOUND');
  assert.throws(() => defaultResolver('', { entries: [] }), { code: 'RELAY_INVALID' });

  const calls = [];
  const custom = createRelay({ ledger, resolver: (ref, ctx) => { calls.push([ref, ctx.entries.length]); return { ref, text: 'clause text', history: [], citedBy: [] }; } });
  const tok = custom.hello({ agent: 'x' }).token;
  assert.equal(custom.lookup(tok, 'P-2 §3.1').text, 'clause text');
  assert.deepEqual(calls, [['P-2 §3.1', ledger.entries().length]]);
});

test('end to end: main chat plus two workers through the relay core', async () => {
  const ledger = fakeLedger();
  const seen = [];
  ledger.subscribe((e) => seen.push(e.type));
  const relay = createRelay({ ledger });
  const t1 = await seedTask(ledger, 'API endpoint');
  const t2 = await seedTask(ledger, 'UI page');
  const main = relay.hello({ agent: 'main-chat', model: 'opus' });
  const a = relay.hello({ agent: 'alpha', model: 'sonnet' });
  const b = relay.hello({ agent: 'beta', model: 'haiku' });
  assert.deepEqual(relay.listTasks(a.token).map((t) => t.claimable), [true, true]);
  await Promise.all([relay.claimTask(a.token, t1), relay.claimTask(b.token, t2)]);
  await relay.reportProgress(a.token, t1, 'Route skeleton in place');
  const qa = await relay.askMain(a.token, t1, 'Return 404 or 410 for deleted items?', ['404', '410'], true);
  const qb = await relay.askMain(b.token, t2, 'Show deleted items greyed out?', ['yes', 'no']);
  const inbox = relay.checkInbox(main.token);
  assert.deepEqual(inbox.open.map((q) => q.question), [qa.question, qb.question], 'blocking question first');
  await rejects(relay.reportProgress(a.token, t1, 'paused'), 'RELAY_PAUSED');
  await relay.reportProgress(b.token, t2, 'Layout done');
  const ra = await relay.answer(main.token, qa.question, '410', 'Clients must distinguish deleted from missing');
  const rb = await relay.answer(main.token, qb.question, 'no', 'Keep the list clean');
  assert.deepEqual([ra.routedTo, rb.routedTo], ['alpha', 'beta']);
  assert.deepEqual([ra.decision, rb.decision], ['D-1', 'D-2']);
  assert.equal(relay.checkAnswer(a.token, qa.question).answer, '410');
  await relay.attachProof(a.token, t1, 'test-run', 'log://T-1/run-1');
  await relay.attachProof(b.token, t2, 'screenshot', 'file://shots/ui.png');
  assert.equal(relay.checkInbox(main.token).open.length, 0);

  const types = ledger.entries().filter((e) => e.actor.kind === 'agent' || e.data?.by).map((e) => `${e.type}:${e.subject}`);
  const decisions = ledger.entries().filter((e) => e.type === 'decision.made');
  assert.ok(decisions.every((e) => e.actor.kind === 'system' && e.actor.id === 'relay' && e.data.by === 'main-chat' && e.data.model === 'opus'), 'decisions are recorded by the relay on behalf of the named main chat');
  assert.deepEqual(types, [
    'task.claimed:T-1', 'task.claimed:T-2', 'task.progress:T-1', 'question.asked:Q-1', 'question.asked:Q-2', 'task.progress:T-2',
    'decision.made:D-1', 'question.answered:Q-1', 'decision.made:D-2', 'question.answered:Q-2', 'task.proof:T-1', 'task.proof:T-2',
  ]);
  assert.equal(seen.length, ledger.entries().length);
  assert.ok(!ledger.entries().some((e) => e.type === 'task.done'), 'workers can never mark done through the relay');

  // Durable state: a fresh relay (e.g. after restart) derives questions and claims from the ledger alone.
  const view = relayView(ledger.entries());
  assert.equal(view.tasks[t1].claimedBy, 'alpha');
  assert.equal(view.questions[qa.question].decision, 'D-1');
  const restarted = createRelay({ ledger });
  const m2 = restarted.hello({ agent: 'main-chat' });
  assert.equal(restarted.checkInbox(m2.token).open.length, 0);
  const dup = await (async () => {
    const w = restarted.hello({ agent: 'gamma' });
    const t3 = await seedTask(ledger, 'Docs');
    await restarted.claimTask(w.token, t3);
    return restarted.askMain(w.token, t3, 'return 404 or 410 for deleted items', ['410', '404']);
  })();
  assert.equal(dup.decision, 'D-1');
});

test('release (review 1): a released task is task.blocked with data.released and another worker can claim it', async () => {
  const { relay, ledger, t1, main, w1, w2 } = await setup();
  await relay.claimTask(w1.token, t1);
  await relay.reportProgress(w1.token, t1, 'halfway');
  const released = await relay.releaseTask(w1.token, t1, 'Out of my depth');
  assert.equal(released.type, 'task.blocked');
  const entry = ledger.entries().at(-1);
  assert.deepEqual([entry.type, entry.data], ['task.blocked', { released: true }]);
  assert.equal(ledger.claimedBy(t1), null, 'the ledger itself no longer shows the old claimer');
  assert.equal(relay.listTasks(main.token).find((t) => t.id === t1).claimable, true);
  const claim = await relay.claimTask(w2.token, t1);
  assert.equal(claim.task, t1);
  assert.equal(ledger.claimedBy(t1), 'worker#2');
  await relay.reportProgress(w2.token, t1, 'picked up');
  // The relay API no longer offers a release that the ledger would leave unclaimable.
  await relay.releaseTask(w2.token, t1, 'done for now', { blocked: false });
  assert.equal(ledger.entries().at(-1).type, 'task.blocked');
  await relay.claimTask(w1.token, t1);
});

test('ledger data (review 2): question, answer, decision, dedupe and pause details are written in data', async () => {
  const { relay, ledger, t1, t2, main, w1, w2 } = await setup();
  await relay.claimTask(w1.token, t1);
  await relay.claimTask(w2.token, t2);
  await relay.askMain(w1.token, t1, 'Tabs or spaces?', ['tabs', 'spaces'], true);
  const asked = ledger.entries().at(-1);
  assert.deepEqual(asked.data, { task: t1, options: ['tabs', 'spaces'], blocking: true });
  await relay.answer(main.token, 'Q-1', 'spaces', 'House style');
  const [decided, answered] = ledger.entries().slice(-2);
  assert.deepEqual([decided.type, decided.subject, decided.data], ['decision.made', 'D-1', { question: 'Q-1', task: t1, by: 'lead', model: 'claude-opus' }]);
  assert.deepEqual([answered.type, answered.subject, answered.data], ['question.answered', 'Q-1', { decision: 'D-1', by: 'lead', model: 'claude-opus' }]);
  await relay.askMain(w2.token, t2, 'tabs or spaces', ['spaces', 'tabs']);
  const [dupAsked, dupAnswered] = ledger.entries().slice(-2);
  assert.equal(dupAsked.data.reusedDecision, 'D-1');
  assert.deepEqual(dupAnswered.data, { decision: 'D-1', reusedDecision: 'D-1', reusedFrom: 'Q-1' });
  await relay.pauseAll(main.token, 'Review');
  assert.deepEqual(ledger.entries().at(-1).data, { control: 'pause-all', by: 'lead', model: 'claude-opus' });
  await relay.resumeAll(main.token, 'Reviewed');
  assert.deepEqual(ledger.entries().at(-1).data, { control: 'resume-all', by: 'lead', model: 'claude-opus' });

  // relayView reads data first, so entries written only with data (e.g. by other modules) are understood.
  const view = relayView([
    { n: 'L-000001', type: 'question.asked', subject: 'Q-9', summary: 'Ship it?', actor: { kind: 'agent', id: 'x' }, evidence: [], data: { task: 'T-4.a2', options: ['yes', 'no'], blocking: true } },
    { n: 'L-000002', type: 'decision.made', subject: 'D-9', summary: 'yes', actor: { kind: 'agent', id: 'm' }, evidence: [], data: { question: 'Q-9', control: 'pause-all' } },
    { n: 'L-000003', type: 'question.answered', subject: 'Q-9', summary: 'yes', actor: { kind: 'agent', id: 'm' }, evidence: [], data: { decision: 'D-9' } },
  ]);
  assert.deepEqual([view.questions['Q-9'].task, view.questions['Q-9'].options, view.questions['Q-9'].blocking, view.questions['Q-9'].decision], ['T-4', ['yes', 'no'], true, 'D-9']);
  assert.equal(view.pausedAll, true);
});

test('restart (review 3, 4): a worker resumes its own claim with its old token; nobody else can take it', async () => {
  const ledger = fakeLedger();
  const store = createMemorySessionStore();
  const before = createRelay({ ledger, sessionStore: store });
  const t1 = await seedTask(ledger, 'Persisted task');
  const main = before.hello({ agent: 'lead' });
  const w1 = before.hello({ agent: 'w1' });
  await before.claimTask(w1.token, t1);
  await before.reportProgress(w1.token, t1, 'before restart');
  assert.ok(store.all().every((r) => /^[0-9a-f]{64}$/.test(r.hash) && r.hash !== w1.token), 'only token hashes are stored');

  const after = createRelay({ ledger, sessionStore: store });
  // Someone connecting first after the restart is not handed the main seat or w1's claim.
  const intruder = after.hello({ agent: 'w1' });
  assert.deepEqual([intruder.agent, intruder.role], ['w1#2', 'worker']);
  await rejects(after.claimTask(intruder.token, t1), 'RELAY_CONFLICT');
  await rejects(after.reportProgress(intruder.token, t1, 'hijack'), 'RELAY_FORBIDDEN');
  await rejects(() => after.hello({ agent: 'w1', resume: intruder.token }), 'RELAY_FORBIDDEN');
  await rejects(() => after.hello({ agent: 'w1', resume: 'pp_wrong_token_value' }), 'RELAY_FORBIDDEN');
  const early = after.hello({ agent: 'eager' });
  assert.equal(early.role, 'worker', 'the main seat stays reserved for the recorded main chat');
  await rejects(() => after.hello({ agent: 'eager2', role: 'main' }), 'RELAY_FORBIDDEN');

  const lead = after.hello({ agent: 'lead', resume: main.token });
  assert.deepEqual([lead.role, lead.resumed], ['main', true]);
  const back = after.hello({ agent: 'w1', resume: w1.token });
  assert.deepEqual([back.agent, back.role, back.task, back.resumed], ['w1', 'worker', t1, true]);
  // Re-claiming the task it already holds binds the token, then work continues.
  const reclaim = await after.claimTask(back.token, t1);
  assert.equal(reclaim.alreadyClaimed, true);
  await after.reportProgress(back.token, t1, 'after restart');
  assert.equal(ledger.entries().at(-1).actor.id, 'w1');

  // Same flow when the worker only re-claims (no resume-restored task binding needed).
  const again = createRelay({ ledger, sessionStore: store });
  const w1b = again.hello({ agent: 'w1', resume: w1.token });
  await again.claimTask(w1b.token, t1);
  await again.reportProgress(w1b.token, t1, 'third process');
});

test('restart (review 4): PP_MAIN_AGENT names the only agent that can hold the main seat', async () => {
  const ledger = fakeLedger();
  const relay = createRelay({ ledger, mainAgent: 'owner-lead' });
  const first = relay.hello({ agent: 'worker-a' });
  assert.equal(first.role, 'worker', 'first to connect is not main when the owner named one');
  await rejects(() => relay.hello({ agent: 'worker-b', role: 'main' }), 'RELAY_FORBIDDEN');
  const lead = relay.hello({ agent: 'owner-lead' });
  assert.equal(lead.role, 'main');
  await rejects(() => relay.hello({ agent: 'owner-lead', role: 'main' }), 'RELAY_FORBIDDEN');
  assert.throws(() => createRelay({ ledger, mainAgent: 'bad/name' }), { code: 'RELAY_INVALID' });
});

test('restart (review 5): an open blocking question still pauses its asker after a restart', async () => {
  const ledger = fakeLedger();
  const store = createMemorySessionStore();
  const before = createRelay({ ledger, sessionStore: store });
  const t1 = await seedTask(ledger, 'Blocking');
  const main = before.hello({ agent: 'lead' });
  const w = before.hello({ agent: 'w' });
  await before.claimTask(w.token, t1);
  const q = await before.askMain(w.token, t1, 'Which DB?', ['sqlite', 'pg'], true);

  const after = createRelay({ ledger, sessionStore: store });
  const lead = after.hello({ agent: 'lead', resume: main.token });
  const back = after.hello({ agent: 'w', resume: w.token });
  await rejects(after.reportProgress(back.token, t1, 'sneak past the pause'), 'RELAY_PAUSED');
  assert.equal(after.sessions().find((s) => s.agent === 'w').waitingOn, q.question);
  assert.deepEqual(after.checkAnswer(back.token, q.question), { question: q.question, state: 'open' });
  await after.answer(lead.token, q.question, 'sqlite', 'Local first');
  assert.equal(after.checkAnswer(back.token, q.question).answer, 'sqlite');
  await after.reportProgress(back.token, t1, 'unpaused');
});

test('stop (review 5): stopping is a ledger decision that survives restarts, even without a task', async () => {
  const ledger = fakeLedger();
  const store = createMemorySessionStore();
  const before = createRelay({ ledger, sessionStore: store });
  const t1 = await seedTask(ledger, 'Held');
  const main = before.hello({ agent: 'lead' });
  const idle = before.hello({ agent: 'idle' });
  const holder = before.hello({ agent: 'holder' });
  await before.claimTask(holder.token, t1);

  const stopIdle = await before.stopWorker(main.token, 'idle', 'Not needed');
  assert.equal(stopIdle.task, null);
  const stopEntry = ledger.entries().at(-1);
  assert.deepEqual([stopEntry.type, stopEntry.reason, stopEntry.data], ['decision.made', 'Not needed', { control: 'stop-worker', agent: 'idle', by: 'lead' }]);
  await rejects(() => before.listTasks(idle.token), 'RELAY_STOPPED');
  await rejects(() => before.hello({ agent: 'idle' }), 'RELAY_STOPPED');
  await rejects(before.stopWorker(main.token, 'lead', 'self'), 'RELAY_FORBIDDEN');

  const after = createRelay({ ledger, sessionStore: store });
  const lead = after.hello({ agent: 'lead', resume: main.token });
  await rejects(() => after.hello({ agent: 'idle' }), 'RELAY_STOPPED');
  await rejects(() => after.hello({ agent: 'idle', resume: idle.token }), 'RELAY_STOPPED');
  // A worker holding a claim but not reconnected can still be stopped, which frees its task.
  const stopHolder = await after.stopWorker(lead.token, 'holder', 'Lost its session');
  assert.equal(stopHolder.task, t1);
  assert.deepEqual(ledger.entries().slice(-2).map((e) => e.type), ['decision.made', 'task.blocked']);
  assert.equal(ledger.claimedBy(t1), null);
  const fresh = after.hello({ agent: 'fresh' });
  await after.claimTask(fresh.token, t1);
  assert.equal((await after.stopWorker(lead.token, 'holder', 'again')).changed, false);
});

test('ids (review 6): a decision id taken by another writer is retried and nothing is half-written', async () => {
  const { relay, ledger, t1, main, w1 } = await setup();
  await relay.claimTask(w1.token, t1);
  await relay.askMain(w1.token, t1, 'Use the shared modal?');
  const original = ledger.nextId.bind(ledger);
  let raced = false;
  ledger.nextId = (series) => {
    const id = original(series);
    if (series === 'D' && !raced) {
      raced = true;
      // Another module in the same process (watcher, test gate) writes between nextId and append.
      ledger.append({ actor: { kind: 'system', id: 'watcher' }, type: 'decision.made', subject: id, summary: 'Watcher decision', reason: 'stall' });
    }
    return id;
  };
  const answered = await relay.answer(main.token, 'Q-1', 'yes', 'Consistency');
  assert.equal(answered.decision, 'D-2');
  const tail = ledger.entries().slice(-3);
  assert.deepEqual(tail.map((e) => [e.type, e.subject, e.data?.by ?? e.actor.id]), [
    ['decision.made', 'D-1', 'watcher'], ['decision.made', 'D-2', 'lead'], ['question.answered', 'Q-1', 'lead'],
  ]);
  assert.equal(tail[2].data.decision, 'D-2');
  assert.equal(relayView(ledger.entries()).questions['Q-1'].decision, 'D-2');
});

test('dedupe (review 9): a decision named by a later correction is not reused', async () => {
  const { relay, ledger, t1, t2, main, w1, w2 } = await setup();
  await relay.claimTask(w1.token, t1);
  await relay.claimTask(w2.token, t2);
  await relay.askMain(w1.token, t1, 'Dark mode default?', ['yes', 'no']);
  await relay.answer(main.token, 'Q-1', 'yes', 'Popular');
  await ledger.append({ actor: { kind: 'person', id: 'owner' }, type: 'correction', subject: 'D-1', summary: 'D-1 was wrong', reason: 'Accessibility review', evidence: ['D-1'] });
  const fresh = await relay.askMain(w2.token, t2, 'dark mode default', ['no', 'yes']);
  assert.equal(fresh.state, 'open', 'the corrected decision is not handed out again');
  await relay.answer(main.token, fresh.question, 'no', 'Accessibility review');
  // A correction that names the decision entry by L-number works the same way.
  const decisionEntry = ledger.entries().filter((e) => e.type === 'decision.made').at(-1);
  await ledger.append({ actor: { kind: 'person', id: 'owner' }, type: 'correction', subject: decisionEntry.subject, summary: 'reverted', reason: 'Changed again', corrects: decisionEntry.n });
  const third = await relay.askMain(w1.token, t1, 'Dark mode default?', ['yes', 'no']);
  assert.equal(third.state, 'open');
  // An uncorrected decision is still reused.
  await relay.answer(main.token, third.question, 'yes', 'Final');
  assert.equal((await relay.askMain(w2.token, t2, 'Dark mode default?', ['yes', 'no'])).decision, 'D-3');
});

test('file session store keeps only token hashes and survives a reload', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pp-relay-store-'));
  try {
    const file = path.join(base, '.perfect-planner', 'relay', 'sessions.json');
    const ledger = fakeLedger();
    const relay = createRelay({ ledger, sessionStore: createFileSessionStore(file) });
    const main = relay.hello({ agent: 'lead' });
    const w = relay.hello({ agent: 'w' });
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes(main.token) && !text.includes(w.token), 'tokens are never written');
    assert.ok(text.includes(hashToken(w.token)));
    const reloaded = createRelay({ ledger, sessionStore: createFileSessionStore(file) });
    assert.equal(reloaded.hello({ agent: 'lead', resume: main.token }).role, 'main');
    assert.equal(reloaded.hello({ agent: 'w', resume: w.token }).agent, 'w');
    await writeFile(file, '{not json', 'utf8');
    assert.deepEqual(createFileSessionStore(file).all(), [], 'a corrupt store starts empty instead of crashing the server');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Runs once src/core/ledger lands on this branch; until then it is reported as skipped.
const realLedgerUrl = new URL('../src/core/ledger/index.mjs', import.meta.url);
test('real ledger (review 8): relay writes agree with ledger.board()', { skip: !existsSync(realLedgerUrl) && 'src/core/ledger is not on this branch yet' }, async () => {
  const { openLedger } = await import(realLedgerUrl.href);
  const root = await mkdtemp(path.join(tmpdir(), 'pp-relay-real-'));
  const ledger = await openLedger(root);
  try {
    const owner = { kind: 'person', id: 'owner' };
    const seed = async (title) => {
      const id = ledger.nextId('T');
      await ledger.append({ actor: system, type: 'task.created', subject: id, summary: title });
      await ledger.append({ actor: system, type: 'test.defined', subject: id, summary: `node --test tests/${id}.test.mjs` });
      await ledger.append({ actor: owner, type: 'test.approved', subject: id, summary: 'Approved' });
      return id;
    };
    const t1 = await seed('One');
    const t2 = await seed('Two');
    const store = createMemorySessionStore();
    const relay = createRelay({ ledger, sessionStore: store });
    const main = relay.hello({ agent: 'lead' });
    const a = relay.hello({ agent: 'a' });
    const b = relay.hello({ agent: 'b' });
    await relay.claimTask(a.token, t1);
    await relay.claimTask(b.token, t2);
    await relay.releaseTask(a.token, t1, 'Handing over');
    assert.equal(ledger.board().tasks[t1].claimedBy, null);
    await relay.releaseTask(b.token, t2, 'Swap');
    await relay.claimTask(b.token, t1);
    await relay.claimTask(a.token, t2);
    assert.equal(ledger.board().tasks[t1].claimedBy, 'b');
    const q = await relay.askMain(b.token, t1, 'Which icon set?', ['lucide', 'heroicons'], true);
    let board = ledger.board();
    assert.deepEqual([board.questions[q.question].blocking, board.questions[q.question].options, board.questions[q.question].task], [true, ['lucide', 'heroicons'], t1]);
    const ans = await relay.answer(main.token, q.question, 'lucide', 'Already bundled');
    const dup = await relay.askMain(a.token, t2, 'which icon set', ['heroicons', 'lucide']);
    board = ledger.board();
    assert.equal(board.questions[q.question].decision, ans.decision);
    assert.equal(board.questions[dup.question].decision, ans.decision);
    assert.equal(board.questions[dup.question].reusedDecision, ans.decision);
    await relay.pauseAll(main.token, 'Hold');
    assert.equal(ledger.board().control.paused, true);
    await relay.resumeAll(main.token, 'Go');
    assert.equal(ledger.board().control.paused, false);
    await ledger.append({ actor: system, type: 'task.reopened', subject: t2, summary: 'reopen', reason: 'regression' });
    const c = relay.hello({ agent: 'c' });
    assert.equal((await relay.claimTask(c.token, t2)).attempt, 2);
    await relay.reportProgress(c.token, t2, 'second attempt');
    assert.equal(ledger.entries().at(-1).subject, `${t2}.a2`);
    const view = relayView(ledger.entries());
    board = ledger.board();
    for (const id of [t1, t2]) assert.deepEqual([view.tasks[id].claimedBy, view.tasks[id].state, view.tasks[id].attempt], [board.tasks[id].claimedBy, board.tasks[id].state, board.tasks[id].attempt], `${id} agrees`);
    const restarted = createRelay({ ledger, sessionStore: store });
    const bBack = restarted.hello({ agent: 'b', resume: b.token });
    assert.equal(bBack.task, t1);
    assert.equal(restarted.checkAnswer(bBack.token, q.question).answer, 'lucide');
    await restarted.reportProgress(bBack.token, t1, 'resumed after restart');
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ledger refusals propagate with their code', async () => {
  const ledger = fakeLedger();
  const relay = createRelay({ ledger });
  const t = await seedTask(ledger, 'x');
  relay.hello({ agent: 'lead' });
  const w = relay.hello({ agent: 'w' });
  await relay.claimTask(w.token, t);
  ledger.append = async () => { const e = new Error('chain broken'); e.code = 'LEDGER_CHAIN_BROKEN'; throw e; };
  await rejects(relay.reportProgress(w.token, t, 'x'), 'LEDGER_CHAIN_BROKEN');
  assert.throws(() => createRelay({}), { code: 'RELAY_INVALID' });
});

test('MCP error mapping keeps relay codes and hides unexpected failures', () => {
  const forbidden = relayToolError(Object.assign(new Error('nope'), { code: 'RELAY_FORBIDDEN' }));
  assert.equal(forbidden.isError, true);
  assert.equal(forbidden.structuredContent.code, 'RELAY_FORBIDDEN');
  const hidden = relayToolError(Object.assign(new Error('ENOENT C:\\secret\\path'), { code: 'ENOENT' }));
  assert.equal(hidden.structuredContent.code, 'RELAY_UNAVAILABLE');
  assert.doesNotMatch(hidden.content[0].text, /secret/);
});

test('write mode is opt-in and needs a ledger root', () => {
  assert.deepEqual(resolveRelayWriteConfig({}, []), { write: false, ledgerRoot: null });
  assert.deepEqual(resolveRelayWriteConfig({ PP_MCP_WRITE: 'true', PP_LEDGER_ROOT: 'x' }, []), { write: false, ledgerRoot: null });
  assert.throws(() => resolveRelayWriteConfig({ PP_MCP_WRITE: '1' }, []), { code: 'MCP_WRITE_LEDGER_ROOT_REQUIRED' });
  const root = path.join(tmpdir(), 'repo');
  assert.equal(resolveRelayWriteConfig({ PP_MCP_WRITE: '1' }, ['--ledger-root', root]).ledgerRoot, path.resolve(root));
  assert.equal(resolveRelayWriteConfig({ PP_MCP_WRITE: '1' }, [`--ledger-root=${root}`]).ledgerRoot, path.resolve(root));
  assert.equal(resolveRelayWriteConfig({ PP_MCP_WRITE: '1', PP_LEDGER_ROOT: root }, []).ledgerRoot, path.resolve(root));
});

test('stdio smoke: relay tools are listed only when write mode is enabled', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pp-core-mcp-'));
  const server = fileURLToPath(new URL('../mcp/perfectPlannerMcpServer.mjs', import.meta.url));
  const list = async (env, args = []) => {
    const client = new Client({ name: 'core-mcp-smoke', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, ...args], env, stderr: 'pipe' }));
    try {
      const { tools } = await client.listTools();
      return { names: tools.map((t) => t.name), instructions: client.getInstructions() ?? '' };
    } finally { await client.close(); }
  };
  try {
    const env = { ...process.env, PERFECT_PLANNER_REGISTRY_ROOT: path.join(base, 'registry') };
    delete env.PP_MCP_WRITE;
    delete env.PP_LEDGER_ROOT;
    const readOnly = await list(env);
    assert.ok(readOnly.names.includes('planner_list_registered_apps'));
    assert.ok(RELAY_TOOL_NAMES.every((n) => !readOnly.names.includes(n)), 'no write tools by default');
    assert.match(readOnly.instructions, /read-only/);

    const writable = await list({ ...env, PP_MCP_WRITE: '1' }, ['--ledger-root', path.join(base, 'repo')]);
    for (const name of RELAY_TOOL_NAMES) assert.ok(writable.names.includes(name), `${name} listed`);
    assert.ok(writable.names.includes('planner_list_registered_apps'), 'read-only tools stay available');
    assert.match(writable.instructions, /call hello first/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
