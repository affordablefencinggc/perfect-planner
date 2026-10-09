// Thin MCP wrappers over src/core/relay (Core Specs §4). Registered only when write mode is enabled.
// Every tool takes the session token returned by `hello`; scope is enforced inside the relay.

export const RELAY_TOOL_NAMES = Object.freeze([
  'hello', 'list_tasks', 'claim_task', 'report_progress', 'attach_proof', 'ask_main', 'check_answer',
  'check_inbox', 'answer', 'lookup', 'release_task', 'pause_all', 'resume_all', 'stop_worker',
]);

const SAFE_CODES = /^(RELAY|LEDGER)_[A-Z_]+$/;

export function relayToolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

/** Map a relay/ledger refusal onto an MCP error result without forwarding stack traces or paths. */
export function relayToolError(error) {
  const code = typeof error?.code === 'string' && SAFE_CODES.test(error.code) ? error.code : 'RELAY_UNAVAILABLE';
  const message = code === 'RELAY_UNAVAILABLE' ? 'The relay could not complete this call. Nothing was written.' : String(error.message ?? code);
  return { isError: true, ...relayToolResult({ code, message }) };
}

export function registerRelayTools(server, getRelay, z) {
  const token = z.string().min(8).max(200).describe('Session token returned by hello');
  const task = z.string().regex(/^T-\d+$/).describe('Task id such as T-14');
  const question = z.string().regex(/^Q-\d+$/).describe('Question id such as Q-2');
  const writes = { title: 'Perfect Planner relay', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const reads = { title: 'Perfect Planner relay', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const wrap = (fn) => async (args) => {
    try { return relayToolResult(await fn(await getRelay(), args)); } catch (error) { return relayToolError(error); }
  };
  const tool = (name, description, inputSchema, annotations, fn) => server.registerTool(name, { title: name, description, inputSchema, annotations }, wrap(fn));

  tool('hello', 'Register this agent and receive a session token. The first agent becomes the main chat; others are workers.',
    { agent: z.string().min(1).max(80), model: z.string().max(120).optional(), role: z.enum(['main', 'worker']).optional() }, writes,
    (r, { agent, model, role }) => r.hello({ agent, model, role }));
  tool('list_tasks', 'List ledger tasks with state and whether they can be claimed.', { token }, reads,
    (r, a) => ({ tasks: r.listTasks(a.token) }));
  tool('claim_task', 'Claim one task (worker). Binds your token to exactly that task. Refused until its acceptance test is approved.', { token, task }, writes,
    (r, a) => r.claimTask(a.token, a.task));
  tool('report_progress', 'Record a one-line progress note for your task.', { token, task, text: z.string().min(1).max(2000) }, writes,
    (r, a) => r.reportProgress(a.token, a.task, a.text));
  tool('attach_proof', 'Attach a proof link (test run, log, commit, screenshot) to your task.', { token, task, kind: z.string().min(1).max(60), link: z.string().min(1).max(2000) }, writes,
    (r, a) => r.attachProof(a.token, a.task, a.kind, a.link));
  tool('ask_main', 'Ask the main chat a question about your task. An identical answered question returns its decision at once. blocking pauses only you until answered.',
    { token, task, question: z.string().min(1).max(2000), options: z.array(z.string().min(1).max(500)).max(20).default([]), blocking: z.boolean().default(false) }, writes,
    (r, a) => r.askMain(a.token, a.task, a.question, a.options, a.blocking));
  tool('check_answer', 'Check whether one of your questions has been answered. Works while paused.', { token, question }, reads,
    (r, a) => r.checkAnswer(a.token, a.question));
  tool('check_inbox', 'Main chat only: digest of open worker questions, blocking first.', { token }, reads,
    (r, a) => r.checkInbox(a.token));
  tool('answer', 'Main chat only: answer a question; records question.answered and decision.made and routes the answer back.', { token, question, text: z.string().min(1).max(2000), reason: z.string().min(1).max(2000) }, writes,
    (r, a) => r.answer(a.token, a.question, a.text, a.reason));
  tool('lookup', 'Look up a reference (§3.1, P-2 §3.1, T-14, D-3, R-1, L-000231, Q-2): text, history and everything citing it.', { token, ref: z.string().min(1).max(200) }, reads,
    (r, a) => r.lookup(a.token, a.ref));
  tool('release_task', 'Give your task back with a reason. blocked=true (default) records task.blocked; false records task.progress.', { token, task, reason: z.string().min(1).max(2000), blocked: z.boolean().default(true) }, writes,
    (r, a) => r.releaseTask(a.token, a.task, a.reason, { blocked: a.blocked }));
  tool('pause_all', 'Main chat only: pause every worker (recorded in the ledger).', { token, reason: z.string().min(1).max(2000) }, writes,
    (r, a) => r.pauseAll(a.token, a.reason));
  tool('resume_all', 'Main chat only: resume all workers (recorded in the ledger).', { token, reason: z.string().min(1).max(2000) }, writes,
    (r, a) => r.resumeAll(a.token, a.reason));
  tool('stop_worker', 'Main chat only: stop one worker; its task is recorded as blocked and released.', { token, agent: z.string().min(1).max(90), reason: z.string().min(1).max(2000) }, writes,
    (r, a) => r.stopWorker(a.token, a.agent, a.reason));
}
