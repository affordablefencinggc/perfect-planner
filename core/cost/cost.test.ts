import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore, type Actor } from "../ledger/index";
import { installNumberingRules } from "../numbering/index";
import { AgentService, TokenStore, foldBoard } from "../mcp/index";
import { costView, parsePrices, parseUsage, type Prices } from "./index";

const owner: Actor = { kind: "person", id: "owner" };
const none: Prices = new Map();

function setup() {
  const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-23T05:00:00Z") });
  installNumberingRules(ledger);
  ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "API", data: { title: "API" } });
  ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "Web", data: { title: "Web", repo: "web" } });
  const tokens = new TokenStore();
  const service = new AgentService({ ledger, tokens });
  return { ledger, service, w1: tokens.issue({ role: "worker", person: "owner", task: "T-1" }), w2: tokens.issue({ role: "worker", person: "owner", task: "T-2" }) };
}

async function worker(service: AgentService, token: string, task: string, model: string) {
  const hello = (await service.call({ token }, "hello", { name: `w-${task}`, model })) as { agent: string };
  const who = { token, agent: hello.agent };
  await service.call(who, "claim_task", { task });
  return who;
}

describe("parseUsage", () => {
  it("accepts whole tokens and dollars, and nothing else", () => {
    expect(parseUsage({ inputTokens: 1200, outputTokens: 300 })).toEqual({ ok: true, usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0 } });
    expect(parseUsage({ costUsd: 0.1234567 })).toMatchObject({ ok: true, usage: { costUsd: 0.123457 } });
    for (const bad of [null, "12", [], {}, { inputTokens: -1 }, { inputTokens: 1.5 }, { inputTokens: "12" }, { inputTokens: NaN }, { outputTokens: Infinity }, { inputTokens: 1e300 }, { inputTokens: 2e9 }, { costUsd: -0.01 }, { costUsd: 1e300 }, { costUsd: NaN }, { costUsd: "3" }, { inputTokens: { a: 1 } }]) {
      expect(parseUsage(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("parsePrices", () => {
  it("takes dollars per million for plain model names, and a model called constructor is only a name", () => {
    const ok = parsePrices({ "claude-x": { inputPerMillion: 3, outputPerMillion: 15 }, constructor: { inputPerMillion: 1, outputPerMillion: 2 } });
    expect(ok.ok && [...ok.prices.keys()]).toEqual(["claude-x", "constructor"]);
    expect(parsePrices(JSON.parse('{"__proto__":{"inputPerMillion":1,"outputPerMillion":2}}'))).toMatchObject({ ok: false });
    for (const bad of [[], null, { "bad name": { inputPerMillion: 1, outputPerMillion: 1 } }, { m: { inputPerMillion: -1, outputPerMillion: 1 } }, { m: { inputPerMillion: "1", outputPerMillion: 1 } }, { m: { inputPerMillion: 1 } }, { m: { inputPerMillion: 1e9, outputPerMillion: 1 } }]) {
      expect(parsePrices(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("the agent writes usage with its progress line", () => {
  it("keeps good usage, and drops a bad figure without losing the line", async () => {
    const { service, ledger, w1 } = setup();
    const a = await worker(service, w1, "T-1", "claude-x");
    const good = (await service.call(a, "report_progress", { task: "T-1", text: "Wrote it", usage: { inputTokens: 100, outputTokens: 20 } })) as Record<string, unknown>;
    expect(good.usageIgnored).toBeUndefined();
    const bad = (await service.call(a, "report_progress", { task: "T-1", text: "More", usage: { inputTokens: -5 } })) as Record<string, unknown>;
    expect(String(bad.usageIgnored)).toContain("whole numbers");
    const lines = ledger.bySubject("T-1").filter((e) => e.type === "task.progress");
    expect(lines.map((e) => e.summary)).toEqual(["Wrote it", "More"]);
    expect(lines[0]!.data).toEqual({ usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } });
    expect(lines[1]!.data).toBeUndefined();
  });

  it("will not take usage on a task the worker does not hold", async () => {
    const { service, w1 } = setup();
    const a = await worker(service, w1, "T-1", "claude-x");
    await expect(service.call(a, "report_progress", { task: "T-2", text: "x", usage: { inputTokens: 1 } })).rejects.toThrow();
  });
});

describe("costView", () => {
  it("labels reported, estimated and unpriced work apart, and adds up by task, repo and model", async () => {
    const { service, ledger, w1, w2 } = setup();
    const a = await worker(service, w1, "T-1", "claude-x");
    const b = await worker(service, w2, "T-2", "claude-y");
    await service.call(a, "report_progress", { task: "T-1", text: "a", usage: { inputTokens: 1_000_000, outputTokens: 100_000 } });
    await service.call(a, "report_progress", { task: "T-1", text: "b", usage: { inputTokens: 500, outputTokens: 500, costUsd: 0.25 } });
    await service.call(b, "report_progress", { task: "T-2", text: "c", usage: { inputTokens: 2000, outputTokens: 1000 } });
    const prices: Prices = new Map([["claude-x", { inputPerMillion: 3, outputPerMillion: 15 }]]);
    const view = costView(ledger.entries(), foldBoard(ledger.entries()), prices);
    // claude-x: 1M in * $3 + 100k out * $15/M = $4.50 estimated, plus $0.25 reported.
    expect(view.project).toMatchObject({ estimatedUsd: 4.5, reportedUsd: 0.25, measuredUsd: 0, usd: 4.75, unpricedTokens: 3000, calls: 3, inputTokens: 1_002_500 });
    expect(view.byTask.map((t) => [t.key, t.repo, t.usd, t.unpricedTokens])).toEqual([["T-1", "main", 4.75, 0], ["T-2", "web", 0, 3000]]);
    expect(view.byRepo.map((r) => [r.key, r.usd])).toEqual([["main", 4.75], ["web", 0]]);
    expect(view.byModel.map((m) => m.key)).toEqual(["claude-x", "claude-y"]);
    expect(view.byTask[0]!.runs.map((r) => [r.model, r.calls])).toEqual([["claude-x", 2]]);
    expect(view.ignored).toBe(0);
  });

  it("shows nothing for work that reported nothing: no usage is not zero dollars", () => {
    const { ledger } = setup();
    const view = costView(ledger.entries(), foldBoard(ledger.entries()), none);
    expect(view.byTask).toEqual([]);
    expect(view.project).toMatchObject({ calls: 0, usd: 0 });
  });

  it("counts Jev's signed review cost as measured, or estimated when Jev did not say", () => {
    const { ledger } = setup();
    const jev = (cost: number, costEstimated: boolean) => ledger.append({ actor: owner, type: "review.verdict", subject: "T-1.a2", summary: "Jev read it", data: { cost, costEstimated, jevModel: "jev-1", review: "diff", verdict: "approve" } });
    jev(0.03, false);
    jev(0.02, true);
    ledger.append({ actor: owner, type: "review.verdict", subject: "T-1", summary: "No call", data: { cost: 0, costEstimated: false, jevModel: null, review: "test", verdict: "escalate" } });
    const view = costView(ledger.entries(), foldBoard(ledger.entries()), none);
    expect(view.project).toMatchObject({ measuredUsd: 0.03, estimatedUsd: 0.02, usd: 0.05, calls: 2 });
    expect(view.byTask[0]!.runs[0]).toMatchObject({ worker: "jev", model: "jev-1", task: "T-1.a2" });
  });

  it("skips impossible numbers already in the ledger and counts them; a model named __proto__ is just a name", async () => {
    const { service, ledger, w1 } = setup();
    const a = await worker(service, w1, "T-1", "__proto__");
    await service.call(a, "report_progress", { task: "T-1", text: "ok", usage: { inputTokens: 10, outputTokens: 10 } });
    // Written straight into the ledger by something that did not go through the tool.
    const agent = ledger.entries().at(-1)!.actor;
    for (const usage of [{ inputTokens: NaN }, { inputTokens: -1 }, "lots", { costUsd: 1e300 }]) ledger.append({ actor: agent, type: "task.progress", subject: "T-1", summary: "odd", data: { usage } });
    ledger.append({ actor: owner, type: "review.verdict", subject: "T-1", summary: "odd", data: { cost: 1e300, jevModel: "jev-1" } });
    const view = costView(ledger.entries(), foldBoard(ledger.entries()), none);
    expect(view.ignored).toBe(5);
    expect(view.project).toMatchObject({ inputTokens: 10, calls: 1 });
    expect(view.byModel.map((m) => m.key)).toEqual(["__proto__"]);
    expect(Object.keys({})).toEqual([]);
  });

  it("folds twenty thousand entries quickly", () => {
    const { ledger } = setup();
    const agent: Actor = { kind: "agent", id: "a-1", model: "claude-x" };
    const entries = [...ledger.entries()];
    for (let i = 0; i < 20_000; i += 1) {
      entries.push({ n: `L-${i + 10}`, at: "2026-10-23T05:00:00Z", actor: agent, type: "task.progress", subject: "T-1", summary: `step ${i}`, evidence: [], refs: [], data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }, prev: "", hash: "" });
    }
    const started = performance.now();
    const view = costView(entries, foldBoard(entries), none);
    expect(performance.now() - started).toBeLessThan(500);
    expect(view.project.calls).toBe(20_000);
    expect(view.byTask[0]!.runs).toHaveLength(1);
  });
});
