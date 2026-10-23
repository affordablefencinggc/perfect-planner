// The agent check-in service behind every transport (spec §4.1).
//
// Each call carries a token. A worker's token covers only its own task; the
// main chat (the first agent a person connects) answers the relay. The
// service checks who may call what and then writes through the ledger, which
// owns the entry rules and the gate rules other modules register; when the
// ledger refuses, the agent gets the ledger's reason back.
import { LedgerError, type Actor, type EntryDraft, type Ledger, type LedgerEntry } from "../ledger/index";
import { Relay, trustedEntry } from "../relay/relay";
import { attemptLabel, foldBoard, type TaskView } from "./board";
import { lookup } from "../lookup/index";
import { TestGate } from "../gate/index";
import { TokenStore, tokenId, type Grant } from "./tokens";
import { TOOL_INFO, TOOL_INPUTS, type ToolInput, type ToolName } from "./tools";
import { looksSecret, redactSecrets } from "../jev/redact";

export type AgentRole = "main" | "worker" | "observer";

export interface AgentRecord {
  id: string;
  name: string;
  model?: string;
  person: string;
  role: AgentRole;
  task?: string;
}

export type ToolErrorCode = "UNAUTHORIZED" | "FORBIDDEN" | "INVALID" | "NOT_FOUND" | "CONFLICT" | "PAUSED" | "REFUSED";

export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface Caller {
  token: string;
  /** Returned by hello; required for every other tool. */
  agent?: string;
}

export interface AgentServiceOptions {
  ledger: Ledger;
  tokens?: TokenStore;
  relay?: Relay;
  /** The test gate propose_test defines tests through (default: one over the same ledger). */
  gate?: TestGate;
  /** Milliseconds now; tests pass a fake clock. */
  now?: () => number;
}

/** An agent not heard from for this long no longer counts as checked in, and no longer holds the main chat. */
export const AGENT_QUIET_MS = 10 * 60 * 1000;

export class AgentService {
  readonly ledger: Ledger;
  readonly tokens: TokenStore;
  readonly relay: Relay;
  readonly gate: TestGate;
  private readonly agents = new Map<string, AgentRecord & { grant: Grant; token: string }>();
  /** person -> agent id of their main chat */
  private readonly mains = new Map<string, string>();
  /** agent id -> when it last called any tool (ms) */
  private readonly lastSeen = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: AgentServiceOptions) {
    this.now = options.now ?? Date.now;
    this.ledger = options.ledger;
    this.tokens = options.tokens ?? new TokenStore();
    this.relay = options.relay ?? new Relay({ ledger: options.ledger });
    this.gate = options.gate ?? new TestGate({ ledger: options.ledger });
  }

  /** Validate and run one tool call. Every transport goes through here. */
  async call(caller: Caller, tool: string, rawArgs: unknown): Promise<unknown> {
    if (!Object.prototype.hasOwnProperty.call(TOOL_INPUTS, tool)) throw new ToolError("NOT_FOUND", `There is no tool called ${tool}.`);
    const name = tool as ToolName;
    const parsed = TOOL_INPUTS[name].safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw new ToolError("INVALID", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    }
    const grant = this.tokens.resolve(caller.token);
    if (!grant) throw new ToolError("UNAUTHORIZED", "This token is not valid for this project, or it was revoked.");
    if (name === "hello") return this.hello(caller.token, grant, parsed.data as ToolInput<"hello">);

    const agent = caller.agent ? this.agents.get(caller.agent) : undefined;
    if (!agent || agent.token !== caller.token) throw new ToolError("UNAUTHORIZED", "Call hello first; this agent has not checked in with this token.");
    this.lastSeen.set(agent.id, this.now());
    const need = TOOL_INFO[name].caller;
    if (need === "worker" && agent.role !== "worker") throw new ToolError("FORBIDDEN", `${name} is for workers launched on a task.`);
    if (need === "main" && agent.role !== "main") throw new ToolError("FORBIDDEN", `${name} is for ${agent.person}'s main chat only.`);

    try {
      return await this.dispatch(agent, name, parsed.data);
    } catch (error) {
      if (error instanceof LedgerError) throw new ToolError("REFUSED", `${error.message} (${error.code})`);
      throw error;
    }
  }

  private dispatch(agent: AgentRecord, name: ToolName, args: unknown): unknown {
    switch (name) {
      case "list_tasks":
        return { tasks: [...this.board().values()] };
      case "claim_task":
        return this.claim(agent, args as ToolInput<"claim_task">);
      case "report_progress":
        return this.progress(agent, args as ToolInput<"report_progress">);
      case "attach_proof":
        return this.proof(agent, args as ToolInput<"attach_proof">);
      case "ask_main":
        return this.ask(agent, args as ToolInput<"ask_main">);
      case "check_inbox":
        return this.inbox(agent);
      case "answer":
        return this.answer(agent, args as ToolInput<"answer">);
      case "lookup":
        // Forged person or system entries (plan text, decisions) are left out of what agents read.
        return lookup(this.ledger.entries().filter(trustedEntry), (args as ToolInput<"lookup">).ref);
      case "release_task":
        return this.release(agent, args as ToolInput<"release_task">);
      case "propose_test":
        return this.proposeTest(agent, args as ToolInput<"propose_test">);
      default:
        throw new ToolError("NOT_FOUND", `There is no tool called ${name}.`);
    }
  }

  private hello(token: string, grant: Grant, input: ToolInput<"hello">): { agent: string; role: AgentRole; task?: string; person: string; instructions: string } {
    // A worker token checks in once; reconnecting returns the same agent.
    for (const existing of this.agents.values()) {
      if (existing.token === token && existing.role === "worker") return this.welcome(existing);
    }
    // Ids are derived from the token, not random, so a reconnect (or a restart with
    // the same token) keeps the agent's id and the tasks it holds.
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent";
    const id = `${slug}-${tokenId(token)}`;
    const known = this.agents.get(id);
    if (known && known.token === token) {
      this.lastSeen.set(id, this.now());
      return this.welcome(known);
    }
    let role: AgentRole;
    if (grant.role === "worker") role = "worker";
    else if (!this.mains.has(grant.person) || this.mainIsGone(grant.person)) role = "main";
    else role = "observer";
    // A main chat that went quiet hands the role over; the old one stays on the roster as read-only.
    if (role === "main" && grant.role !== "worker") {
      const old = this.agents.get(this.mains.get(grant.person) ?? "");
      if (old && old.role === "main") old.role = "observer";
    }
    // The person-set model wins; a self-declared one is kept but marked unverified.
    const model = grant.model ?? (input.model ? `unverified:${input.model}` : undefined);
    const record = { id, name: input.name, person: grant.person, role, grant, token, ...(model ? { model } : {}), ...(grant.task ? { task: grant.task } : {}) };
    this.agents.set(id, record);
    this.lastSeen.set(id, this.now());
    if (role === "main") this.mains.set(grant.person, id);
    return this.welcome(record);
  }

  private welcome(agent: AgentRecord): { agent: string; role: AgentRole; task?: string; person: string; instructions: string } {
    const instructions =
      agent.role === "main"
        ? "You are the main chat. Call check_inbox between steps; answer worker questions with answer(Q, text), or ask the person here when you cannot. check_inbox also lists what Perfect Planner itself saw the workers do (two tasks changing one file, a task gone quiet, new commits) in notices; tell the person about anything that needs them."
        : agent.role === "worker"
          ? `You work on ${agent.task} only. claim_task, then report_progress as you go, attach_proof for evidence, and ask_main for anything you need decided. Perfect Planner runs the approved test itself.`
          : "You are connected read-only: list_tasks, lookup and check_inbox. The main chat for this person is another agent.";
    return { agent: agent.id, role: agent.role, person: agent.person, instructions, ...(agent.task ? { task: agent.task } : {}) };
  }

  private actor(agent: AgentRecord): Actor {
    // The ledger requires a model for AI actors; an agent that did not name one is recorded honestly as unknown.
    return { kind: "agent", id: agent.id, model: agent.model ?? "unknown" };
  }

  board(): Map<string, TaskView> {
    return foldBoard(this.ledger.entries());
  }

  private ownTask(agent: AgentRecord, task: string, mustHold: boolean): TaskView {
    if (agent.task !== task) throw new ToolError("FORBIDDEN", `Your token covers ${agent.task} only, not ${task}.`);
    const view = this.board().get(task);
    if (!view) throw new ToolError("NOT_FOUND", `${task} is not on the board.`);
    if (mustHold && view.owner !== agent.id) throw new ToolError("CONFLICT", `Claim ${task} first.`);
    return view;
  }

  private notPaused(agent: AgentRecord): void {
    const all = this.relay.isPausedAll();
    if (all) throw new ToolError("PAUSED", `All work is paused: ${all.reason}. Call check_inbox later.`);
    const waiting = this.relay.blockingFor(agent.id);
    if (waiting) throw new ToolError("PAUSED", `You are paused until ${waiting} is answered. Call check_inbox for the answer.`);
  }

  private write(draft: EntryDraft): LedgerEntry {
    return this.ledger.append(draft);
  }

  private claim(agent: AgentRecord, { task }: ToolInput<"claim_task">) {
    this.notPaused(agent);
    const view = this.ownTask(agent, task, false);
    if (view.owner === agent.id) return { task: attemptLabel(view), status: view.status, entry: view.lastEntry };
    if (view.status === "done") throw new ToolError("CONFLICT", `${task} is already done.`);
    if (view.owner) throw new ToolError("CONFLICT", `${task} is held by ${view.owner}.`);
    // A retry is claimed as its attempt ("T-14.a2"): the gate's claim rule judges that attempt, which
    // keeps the approved test, not the reopened attempt it replaced (that one refuses every claim).
    const entry = this.write({ actor: this.actor(agent), type: "task.claimed", subject: attemptLabel(view), summary: `Claimed ${attemptLabel(view)} by ${agent.name}`, refs: view.clauses });
    return { task: attemptLabel(view), status: "claimed", entry: entry.n };
  }

  private progress(agent: AgentRecord, { task, text }: ToolInput<"report_progress">) {
    this.notPaused(agent);
    this.ownTask(agent, task, true);
    return { entry: this.write({ actor: this.actor(agent), type: "task.progress", subject: task, summary: redactSecrets(text) }).n };
  }

  private proof(agent: AgentRecord, { task, kind, link }: ToolInput<"attach_proof">) {
    this.notPaused(agent);
    this.ownTask(agent, task, true);
    if (looksSecret(link)) throw new ToolError("INVALID", "That proof looks like it contains a secret; attach a link to the evidence instead.");
    const entry = this.write({ actor: this.actor(agent), type: "task.proof", subject: task, summary: `${kind}: ${link}`.slice(0, 200), evidence: [`${kind}:${link}`], data: { kind, link } });
    return { entry: entry.n, note: "Recorded as evidence. Done still needs the approved test to pass when Perfect Planner runs it." };
  }

  private async ask(agent: AgentRecord, input: ToolInput<"ask_main">) {
    this.ownTask(agent, input.task, false);
    const result = await this.relay.ask(this.actor(agent), agent.person, {
      task: input.task,
      question: input.question,
      ...(input.options ? { options: input.options } : {}),
      blocking: input.blocking ?? false,
    });
    if (result.status === "open" && input.blocking && input.wait_seconds) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.wait_seconds * 1000);
      try {
        const answered = await this.relay.waitFor(result.q, controller.signal);
        this.relay.answersFor(agent.id);
        return { q: result.q, status: "answered", answer: answered.answer, decision: answered.decision, paused: false };
      } catch {
        return { ...result, note: `No answer yet; you stay paused until ${result.q} is answered. Call check_inbox.` };
      } finally {
        clearTimeout(timer);
      }
    }
    return result;
  }

  private inbox(agent: AgentRecord) {
    if (agent.role === "main") return this.relay.digest(agent.person);
    if (agent.role === "observer") return { note: "Only the main chat receives the digest.", open: 0 };
    const answers = this.relay.answersFor(agent.id).map((q) => ({ q: q.q, question: q.question, answer: q.answer, decision: q.decision, via: q.answeredVia }));
    const all = this.relay.isPausedAll();
    const waiting = this.relay.blockingFor(agent.id);
    return { answers, paused: Boolean(all || waiting), ...(all ? { pausedReason: all.reason } : {}), ...(waiting ? { waitingOn: waiting } : {}) };
  }

  private answer(agent: AgentRecord, { question, text }: ToolInput<"answer">) {
    try {
      return this.relay.answer(this.actor(agent), agent.person, question, text);
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      throw new ToolError("CONFLICT", (error as Error).message);
    }
  }

  /**
   * Test first (spec 5.1): the worker proposes the test before claiming. It is only a proposal: the
   * gate runs nothing an agent wrote until a person approves it, and the claim stays refused until
   * the approved test has failed on the current code.
   */
  private proposeTest(agent: AgentRecord, { task, command, files }: ToolInput<"propose_test">) {
    this.notPaused(agent);
    const view = this.ownTask(agent, task, false);
    if (view.status === "done") throw new ToolError("CONFLICT", `${task} is already done.`);
    if (view.owner && view.owner !== agent.id) throw new ToolError("CONFLICT", `${task} is held by ${view.owner}.`);
    let defined;
    try {
      defined = this.gate.define(attemptLabel(view), command, this.actor(agent), view.clauses, { files });
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      throw new ToolError("INVALID", (error as Error).message);
    }
    if (!defined.ok) throw new ToolError("CONFLICT", defined.reason);
    return {
      task: attemptLabel(view),
      entry: defined.entry.n,
      status: "waiting for approval",
      note: `${agent.person} approves the test in Perfect Planner; it is then run to confirm it fails. Call list_tasks (testApproved) or try claim_task after that.`,
    };
  }

  private release(agent: AgentRecord, { task, reason, blocked }: ToolInput<"release_task">) {
    const view = this.ownTask(agent, task, true);
    if (view.status === "done" && blocked) throw new ToolError("CONFLICT", `${task} is already done, so it cannot be released as blocked.`);
    const entry = this.write({
      actor: this.actor(agent),
      type: blocked ? "task.blocked" : "task.progress",
      subject: task,
      summary: blocked ? `Released blocked by ${agent.name}` : `Released by ${agent.name}`,
      reason: redactSecrets(reason),
      data: { released: true },
    });
    this.tokens.revokeTask(task);
    return { entry: entry.n, status: view.status === "done" ? "done" : blocked ? "blocked" : "open" };
  }

  /**
   * After a restart, tasks may still be held by agents that never checked in
   * again. Releases every claimed task whose holder is not connected now.
   */
  releaseOrphanedHolds(by: Actor, reason: string): string[] {
    const released: string[] = [];
    for (const task of this.board().values()) {
      if (!task.owner || this.agents.has(task.owner)) continue;
      // A blocked task stays blocked, but loses its dead owner so anyone can pick it up later.
      if (task.status === "claimed" || task.status === "blocked") {
        this.write({ actor: by, type: task.status === "blocked" ? "task.blocked" : "task.progress", subject: task.id, summary: `Released from ${task.owner}, which is not connected`, reason, data: { released: true } });
        released.push(task.id);
      }
    }
    return released;
  }

  /**
   * The person answers a question in Perfect Planner itself. Unlike the main
   * chat's answer, this is a decision: it gets a D number and answers the same
   * question from any of this person's workers later.
   */
  decide(person: Actor, q: string, text: string): { q: string; decision: string | null; worker: string } {
    if (person.kind !== "person") throw new ToolError("FORBIDDEN", "Only a person makes decisions.");
    return this.relay.answer(person, person.id, q, text);
  }

  /** Owner control (spec §4.5): stop every worker at once. */
  pauseAll(by: Actor, reason: string): void {
    const active = this.activeTasks();
    // With nothing in progress, pause the open tasks so no new claim starts.
    const tasks = active.length ? active : [...this.board().values()].filter((t) => t.status !== "done").map((t) => t.id);
    this.relay.pauseAll(by, reason, tasks);
  }

  resumeAll(by: Actor): void {
    this.relay.resumeAll(by);
  }

  private activeTasks(): string[] {
    return [...this.board().values()].filter((t) => t.status === "claimed" || (t.status === "blocked" && t.owner)).map((t) => t.id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].map(({ grant: _grant, token: _token, ...rest }) => rest);
  }

  /** When the agent last called a tool, as an ISO time, or undefined if it never has. */
  seenAt(id: string): string | undefined {
    const at = this.lastSeen.get(id);
    return at === undefined ? undefined : new Date(at).toISOString();
  }

  /** Agents heard from within `quietMs` whose token still works: what the header counts as checked in. */
  liveAgents(quietMs: number = AGENT_QUIET_MS): AgentRecord[] {
    const cutoff = this.now() - quietMs;
    return [...this.agents.values()]
      .filter((a) => (this.lastSeen.get(a.id) ?? 0) >= cutoff && this.tokens.resolve(a.token))
      .map(({ grant: _grant, token: _token, ...rest }) => rest);
  }

  private mainIsGone(person: string): boolean {
    const id = this.mains.get(person);
    const seen = id ? this.lastSeen.get(id) : undefined;
    const grant = id ? this.agents.get(id) : undefined;
    return !id || seen === undefined || this.now() - seen >= AGENT_QUIET_MS || !grant || !this.tokens.resolve(grant.token);
  }
}

// The proof guard and the redaction share one set of patterns with Jev's diff check.
export { looksSecret } from "../jev/redact";
