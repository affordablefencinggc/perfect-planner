import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createRelay, defaultResolver, normalizeQuestionText, questionKey, relayView } from '../src/core/relay/index.mjs';
import { RELAY_TOOL_NAMES, relayToolError } from '../mcp/perfectPlannerRelayTools.mjs';
import { resolveRelayWriteConfig } from '../mcp/perfectPlannerMcpCore.mjs';

// Small in-memory fake of the shared Ledger interface (src/core/ledger/index.mjs).
const REASON_TYPES = /^(decision\.made|correction)$|\.(blocked|reopened|rejected)$/;
function fakeLedger() {
  const list = [];
  const subscribers = new Set();
  let clock = Date.parse('2026-10-09T00:00:00.000Z');
  return {
    async append({ actor, type, subject, summary, reason = null, evidence = [], refs = [], corrects = null }) {
      const refuse = (message) => { const e = new Error(message); e.code = 'LEDGER_RULE'; throw e; };
      if (!actor?.kind || !actor?.id) refuse('actor required');
      if (typeof summary !== 'string' || !summary.trim() || /\n/.test(summary) || summary.trim() === 'TBD') refuse('summary invalid');
      if (REASON_TYPES.test(type) && !(typeof reason === 'string' && reason.trim())) refuse(`${type} needs a reason`);
      clock += 1000;
      const entry = Object.freeze({
        n: `L-${String(list.length + 1).padStart(6, '0')}`, at: new Date(clock).toISOString(), actor, type, subject, summary, reason,
        evidence: Object.freeze([...evidence]), refs: Object.freeze([...refs]), corrects, prev: null, hash: 'fake',
      });
      list.push(entry);
      for (const fn of subscribers) fn(entry);
      return entry;
    },
    entries: () => [...list],
    nextId(series) {
      let max = 0;
      for (const e of list) { const m = new RegExp(`^${series}-(\\d+)`).exec(e.subject ?? ''); if (m) max = Math.max(max, Number(m[1])); }
      return `${series}-${max + 1}`;
    },
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
  await relay.releaseTask(w.token, t, 'handing back', { blocked: false });
  assert.equal(ledger.entries().at(-1).type, 'task.progress');
  await ledger.append({ actor: system, type: 'task.done', subject: t, summary: 'done' });
  await rejects(relay.claimTask(w.token, t), 'RELAY_CONFLICT');
  await ledger.append({ actor: system, type: 'task.reopened', subject: t, summary: 'reopen', reason: 'regression' });
  const claim = await relay.claimTask(w.token, t);
  assert.equal(claim.attempt, 2);
  assert.equal(ledger.entries().at(-1).subject, `${t}.a2`);
  await relay.reportProgress(w.token, t, 'second attempt underway');
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

  const types = ledger.entries().filter((e) => e.actor.kind !== 'system' && e.actor.kind !== 'person').map((e) => `${e.type}:${e.subject}`);
  assert.deepEqual(types, [
    'task.claimed:T-1', 'task.claimed:T-2', 'task.progress:T-1', 'question.asked:Q-1', 'question.asked:Q-2', 'task.progress:T-2',
    'question.answered:Q-1', 'decision.made:D-1', 'question.answered:Q-2', 'decision.made:D-2', 'task.proof:T-1', 'task.proof:T-2',
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
