import { createHash } from "node:crypto";
import { isAuthoritative } from "../ledger/index";
import { GATE_ACTOR, type LedgerEntry, type LedgerPort } from "../worktrees/ports";

export interface CheckRequest {
  requestId: string;
  attempt: string;
  expected: { definitionEntry: string; approvalEntry: string; pin: string; commit: string };
}
export interface CheckResult {
  ok: boolean; reason?: string; commit?: string; entry?: LedgerEntry;
  run?: { passed: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; outputTail: string };
  output?: string;
}
export interface CheckExecution {
  version: 1; requestId: string; requestDigest: string; attempt: string;
  phase: "reserved" | "admitted" | "launch-intent" | "terminal" | "refused-beforelaunch" | "unknown";
  expected: CheckRequest["expected"];
  binding?: Record<string, unknown>; bindingDigest?: string;
  reservedEntry?: string; admittedEntry?: string; launchIntentEntry?: string;
  result?: Omit<CheckResult, "entry">;
  validation?: Record<string, unknown>;
  settlement?: "not-launched" | "process-exit-observed" | "unknown";
  descendantSettlement?: "not-established";
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function checkRequest(value: unknown): CheckRequest {
  const v = value as CheckRequest;
  if (!v || typeof v !== "object" || Object.keys(v).sort().join() !== "attempt,expected,requestId"
    || typeof v.requestId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,99}$/.test(v.requestId)
    || !/^T-\d+(?:\.a\d+)?$/.test(v.attempt) || !v.expected
    || Object.keys(v.expected).sort().join() !== "approvalEntry,commit,definitionEntry,pin"
    || ![v.expected.definitionEntry, v.expected.approvalEntry].every(s => typeof s === "string" && /^L-\d+$/.test(s))
    || !/^[a-f0-9]{64}$/.test(v.expected.pin) || !/^[a-f0-9]{40,64}$/.test(v.expected.commit)) throw new Error("Supply the saved check request and exact expected inputs.");
  return { requestId: v.requestId, attempt: v.attempt, expected: {
    definitionEntry: v.expected.definitionEntry, approvalEntry: v.expected.approvalEntry, pin: v.expected.pin, commit: v.expected.commit,
  } };
}
export class CheckJournal {
  private active = new Map<string, Promise<CheckResult>>();
  private closing = false;
  constructor(private ledger: LedgerPort) {}
  private records() {
    return this.ledger.entries().filter(e => e.actor.kind === "system" && e.actor.id === GATE_ACTOR.id && isAuthoritative(e)
      && ["check.execution", "test.passed", "test.failed"].includes(e.type) && (e.data?.execution as CheckExecution)?.version === 1);
  }
  private record(e: LedgerEntry) { return e.data!.execution as unknown as CheckExecution; }
  lookup(requestId: string) { return this.records().filter(e => this.record(e).requestId === requestId).at(-1); }
  private replay(e: LedgerEntry): CheckResult {
    const r = this.record(e);
    return r.result ? { ...r.result, entry: e } : { ok: false, reason: `Check ${r.requestId} is ${r.phase}; its outcome is not settled. Recover this request; do not launch another.`, entry: e };
  }
  private append(receipt: CheckExecution, reason?: string) {
    return this.ledger.append({ actor: GATE_ACTOR, type: "check.execution", subject: receipt.attempt,
      summary: `Check ${receipt.requestId}: ${receipt.phase}`, ...(reason ? { reason } : {}), evidence: [], refs: [], data: { execution: receipt } });
  }
  status(requestId: string) { const entry = this.lookup(requestId); return entry ? { execution: this.record(entry), result: this.replay(entry) } : null; }
  beginClose() { this.closing = true; }
  async drain() { this.beginClose(); await Promise.allSettled([...this.active.values()]); }
  run(request: CheckRequest, scope: string, work: (context: CheckContext) => Promise<CheckResult>): Promise<CheckResult> {
    const requestDigest = hash({ scope, ...request });
    const previous = this.lookup(request.requestId);
    if (previous) {
      if (this.record(previous).requestDigest !== requestDigest) return Promise.resolve({ ok: false, reason: "This request ID belongs to different check inputs." });
      return this.active.get(request.requestId) ?? Promise.resolve(this.replay(previous));
    }
    if (this.closing) return Promise.resolve({ ok: false, reason: "The project is closing; no new checks can start." });
    const latest = new Map<string, CheckExecution>();
    for (const e of this.records()) { const r = this.record(e); if (r.attempt === request.attempt) latest.set(r.requestId, r); }
    const blocking = [...latest.values()].find(r => !["terminal", "refused-beforelaunch"].includes(r.phase));
    if (blocking) return Promise.resolve({ ok: false, reason: "An earlier check is unresolved. Recover its original request before starting another.", entry: this.lookup(blocking.requestId) });
    let receipt: CheckExecution = { version: 1, ...request, requestDigest, phase: "reserved" };
    const reserved = this.append(receipt);
    receipt = { ...receipt, reservedEntry: reserved.n };
    let launched = false;
    let publicationFailed = false;
    let terminalPrepared = false;
    const publish = (value: CheckExecution, reason?: string) => {
      try { return this.append(value, reason); }
      catch (error) { publicationFailed = true; throw error; }
    };
    const context: CheckContext = {
      request,
      admitted: binding => { receipt = { ...receipt, phase: "admitted", binding, bindingDigest: hash(binding) }; const e = publish(receipt); receipt = { ...receipt, admittedEntry: e.n }; },
      launch: () => { receipt = { ...receipt, phase: "launch-intent" }; const e = publish(receipt); receipt = { ...receipt, launchIntentEntry: e.n }; launched = true; },
      terminal: (result, validation) => { terminalPrepared = true; return { ...receipt, phase: "terminal", result, validation, settlement: "process-exit-observed", descendantSettlement: "not-established" }; },
      unknown: (reason, run) => { receipt = { ...receipt, phase: "unknown", settlement: "unknown", descendantSettlement: "not-established", result: { ok: false, reason, ...(run ? { run } : {}) } }; return { ok: false, reason, entry: publish(receipt, reason), ...(run ? { run } : {}) }; },
    };
    // Reservation is durable and the promise is registered before work can await or spawn.
    const promise = Promise.resolve().then(() => work(context)).then(result => {
      if ((result.entry?.data?.execution as CheckExecution)?.requestId === request.requestId) return result;
      if (launched) return context.unknown("The launched check returned without a durable terminal result.", result.run);
      receipt = { ...receipt, phase: "refused-beforelaunch", settlement: "not-launched", result: { ok: false, reason: result.reason ?? "Check refused before launch.", ...(result.commit ? { commit: result.commit } : {}) } };
      return { ...receipt.result!, entry: publish(receipt) };
    }).catch(error => {
      // Append failure may already be on disk. Never attempt a second terminal write or unlock it.
      if (publicationFailed || terminalPrepared || (error as { code?: string }).code === "CHAIN_BROKEN") throw error;
      if (launched) return context.unknown(`Check outcome unknown: ${(error as Error).message}`);
      receipt = { ...receipt, phase: "refused-beforelaunch", settlement: "not-launched", result: { ok: false, reason: (error as Error).message } };
      return { ...receipt.result!, entry: publish(receipt) };
    }).finally(() => this.active.delete(request.requestId));
    this.active.set(request.requestId, promise);
    return promise;
  }
}
export interface CheckContext {
  request: CheckRequest;
  admitted(binding: Record<string, unknown>): void;
  launch(): void;
  terminal(result: Omit<CheckResult, "entry">, validation: Record<string, unknown>): CheckExecution;
  unknown(reason: string, run?: CheckResult["run"]): CheckResult;
}
