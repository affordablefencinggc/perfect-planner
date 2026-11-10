import { describe, expect, it, vi } from "vitest";
import { memoryLedger } from "../worktrees/testing";
import { GATE_ACTOR, type LedgerPort } from "../worktrees/ports";
import { CheckJournal, checkRequest, type CheckContext, type CheckRequest } from "./execution";

const request = (id = "request-000000001"): CheckRequest => ({ requestId: id, attempt: "T-1", expected: {
  definitionEntry: "L-1", approvalEntry: "L-2", pin: "a".repeat(64), commit: "b".repeat(40),
} });
function complete(ledger: LedgerPort, context: CheckContext) {
  context.admitted({ worktree: "fixture", commit: context.request.expected.commit });
  context.launch();
  const result = { ok: true, commit: context.request.expected.commit };
  const entry = ledger.append({ actor: GATE_ACTOR, type: "test.passed", subject: "T-1", summary: "Fixture terminal",
    data: { execution: context.terminal(result, { valid: true }) } });
  return { ...result, entry };
}

describe("durable check execution journal", () => {
  it("reserves before async work, coalesces exact retry, excludes a second ID and drains admission", async () => {
    const ledger = await memoryLedger();
    const journal = new CheckJournal(ledger);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const work = vi.fn(async (context: CheckContext) => { await held; return complete(ledger, context); });
    const first = journal.run(request(), "scope", work);
    expect(journal.status(request().requestId)?.execution.phase).toBe("reserved");
    expect(journal.run(request(), "scope", work)).toBe(first);
    expect(await journal.run(request("request-000000002"), "scope", work)).toMatchObject({ ok: false, reason: expect.stringContaining("unresolved"), entry: { data: { execution: { requestId: request().requestId } } } });
    let drained = false;
    const draining = journal.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    expect((await first).ok).toBe(true);
    await draining;
    expect(work).toHaveBeenCalledTimes(1);
    expect(await journal.run(request("request-000000003"), "scope", work)).toMatchObject({ ok: false, reason: expect.stringContaining("closing") });
  });

  it("replays the original sole terminal before mutable preflight and rejects altered binding", async () => {
    const ledger = await memoryLedger();
    const first = new CheckJournal(ledger);
    const original = await first.run(request(), "scope", async context => complete(ledger, context));
    const reopened = new CheckJournal(ledger);
    const mustNotReadCurrentHead = vi.fn(async () => { throw new Error("HEAD has since changed"); });
    expect(await reopened.run(request(), "scope", mustNotReadCurrentHead)).toEqual(original);
    expect(mustNotReadCurrentHead).not.toHaveBeenCalled();
    expect(await reopened.run({ ...request(), expected: { ...request().expected, commit: "c".repeat(40) } }, "scope", mustNotReadCurrentHead)).toMatchObject({ ok: false, reason: expect.stringContaining("different") });
    expect(await reopened.run(request(), "another-ledger", mustNotReadCurrentHead)).toMatchObject({ ok: false });
    const receipts = ledger.entries().filter(e => e.data?.execution);
    expect(receipts.map(e => e.type)).toEqual(["check.execution", "check.execution", "check.execution", "test.passed"]);
  });

  it("known prelaunch refusal releases the slot while launched uncertainty survives reopening", async () => {
    const ledger = await memoryLedger();
    const first = new CheckJournal(ledger);
    await first.run(request(), "scope", async () => ({ ok: false, reason: "No worktree" }));
    expect(first.status(request().requestId)?.execution.phase).toBe("refused-beforelaunch");
    await first.run(request("request-000000002"), "scope", async context => { context.admitted({}); context.launch(); throw new Error("lost process result"); });
    const reopened = new CheckJournal(ledger);
    expect(reopened.status("request-000000002")?.execution).toMatchObject({ phase: "unknown", settlement: "unknown", descendantSettlement: "not-established" });
    const never = vi.fn(async () => ({ ok: true }));
    expect(await reopened.run(request("request-000000003"), "scope", never)).toMatchObject({ ok: false, reason: expect.stringContaining("unresolved") });
    expect(never).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4])("retains an ambiguous durable append at boundary %i without a second publication or relaunch", async boundary => {
    const ledger = await memoryLedger();
    let count = 0;
    const faulty: LedgerPort = { entries: () => ledger.entries(), bySubject: subject => ledger.bySubject(subject), append: draft => {
      const entry = ledger.append(draft);
      if (++count === boundary) throw new Error("Injected lost append acknowledgment");
      return entry;
    } };
    const journal = new CheckJournal(faulty);
    let launches = 0;
    await expect(Promise.resolve().then(() => journal.run(request(), "scope", async context => {
      context.admitted({}); context.launch(); launches++;
      const result = { ok: true };
      return { ...result, entry: faulty.append({ actor: GATE_ACTOR, type: "test.passed", subject: "T-1", summary: "Terminal",
        data: { execution: context.terminal(result, { valid: true }) } }) };
    }))).rejects.toThrow("lost append acknowledgment");
    expect(count).toBe(boundary);
    expect(launches).toBe(boundary === 4 ? 1 : 0);
    const reopened = new CheckJournal(ledger);
    const never = vi.fn(async () => ({ ok: true }));
    const replay = await reopened.run(request(), "scope", never);
    expect(replay.ok).toBe(boundary === 4);
    expect(never).not.toHaveBeenCalled();
    if (boundary < 4) expect(await reopened.run(request("request-000000002"), "scope", never)).toMatchObject({ ok: false });
  });

  it.each([2, 3, 4])("a failed publication before append %i retains exclusion and does not synthesize another receipt", async boundary => {
    const ledger = await memoryLedger();
    let count = 0;
    const faulty: LedgerPort = { entries: () => ledger.entries(), bySubject: subject => ledger.bySubject(subject), append: draft => {
      if (++count === boundary) throw new Error("Injected write unavailable");
      return ledger.append(draft);
    } };
    const journal = new CheckJournal(faulty);
    await expect(journal.run(request(), "scope", async context => complete(faulty, context))).rejects.toThrow("write unavailable");
    expect(count).toBe(boundary);
    const reopened = new CheckJournal(ledger);
    const never = vi.fn(async () => ({ ok: true }));
    expect(await reopened.run(request("request-000000002"), "scope", never)).toMatchObject({ ok: false, reason: expect.stringContaining("unresolved") });
    expect(never).not.toHaveBeenCalled();
  });

  it("parses exact requests and refuses caller-supplied command/path or incomplete bindings", () => {
    expect(checkRequest(request())).toEqual(request());
    expect(() => checkRequest({ ...request(), command: "evil" })).toThrow();
    expect(() => checkRequest({ ...request(), expected: { commit: "b".repeat(40) } })).toThrow();
  });
});
