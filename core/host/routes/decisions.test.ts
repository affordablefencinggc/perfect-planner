import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryKeyProvider, type JevRequest } from "../../jev/index";
import { addClause } from "../../lookup/index";
import { forgeEntry, hostCall, startTestHost } from "../testing";
import { entryCents, setDecisionJev, settleDecisionJev, spendThisMonth } from "./decisions";

let t: Awaited<ReturnType<typeof startTestHost>>;
let n = 0;
const key = () => `dec${++n}`;

beforeAll(async () => {
  t = await startTestHost();
});
afterAll(async () => {
  setDecisionJev(null);
  await t.stop();
});
afterEach(() => setDecisionJev({ keys: new MemoryKeyProvider() }));

/** The fingerprint of an open card, as the screen would have received it. */
async function fp(project: string, q: string): Promise<string> {
  const view = (await hostCall(t.base, "GET", `/decisions?project=${project}`)).body.result;
  return view.open.find((c: { id: string }) => c.id === q).fingerprint;
}

describe("decisions routes", () => {
  it("is empty on a new project and says honestly that Jev is not connected", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const res = await hostCall(t.base, "GET", `/decisions?project=${key()}`);
    expect(res.status).toBe(200);
    expect(res.body.result.open).toEqual([]);
    expect(res.body.result.decided).toEqual([]);
    expect(res.body.result.jev.connected).toBe(false);
    expect(res.body.result.jev.model).toBeNull();
    expect(res.body.result.jev.note).toMatch(/offline reviewer/);
    expect(res.body.result.summary).toMatchObject({ open: 0, decided: 0, spend: { cents: 0, label: "$0.00" } });
  });

  it("asks through the relay, then overriding writes D-1 with the reason and answers the question", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const p = key();
    const asked = await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Which database should invoices use?", options: ["Postgres", "SQLite"] });
    expect(asked.body.result).toMatchObject({ q: "Q-1", status: "open" });

    let view = (await hostCall(t.base, "GET", `/decisions?project=${p}`)).body.result;
    expect(view.open).toHaveLength(1);
    const card = view.open[0];
    expect(card).toMatchObject({ id: "Q-1", title: "Which database should invoices use?", status: "open", recommendation: null });
    expect(card.options.map((o: { label: string }) => o.label)).toEqual(["Postgres", "SQLite"]);
    expect(card.noRecommendation).toMatch(/yours/);
    expect(card.entries[0].n).toBe("L-000001");
    expect(card.entries[0].hash).toHaveLength(12);

    const noRec = await hostCall(t.base, "POST", `/decisions/accept?project=${p}`, { q: "Q-1", fingerprint: card.fingerprint });
    expect(noRec.status).toBe(409);

    const missingReason = await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-1", choice: "SQLite", fingerprint: card.fingerprint });
    expect(missingReason.status).toBe(400);
    expect(missingReason.body.code).toBe("REASON_REQUIRED");
    const badChoice = await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-1", choice: "Mongo", reason: "x", fingerprint: card.fingerprint });
    expect(badChoice.body.code).toBe("BAD_CHOICE");

    const done = await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-1", choice: "SQLite", reason: "One file is easier to back up", fingerprint: card.fingerprint });
    expect(done.body.result).toMatchObject({ q: "Q-1", decision: "D-1", answer: "SQLite", status: "overridden" });

    const project = t.host.project(p);
    const d = project.ledger.bySubject("D-1")[0]!;
    expect(d.type).toBe("decision.made");
    expect(d.reason).toBe("One file is easier to back up");
    expect(project.service.relay.get("Q-1")).toMatchObject({ status: "answered", answer: "SQLite", decision: "D-1" });

    view = (await hostCall(t.base, "GET", `/decisions?project=${p}`)).body.result;
    expect(view.open).toHaveLength(0);
    expect(view.decided[0]).toMatchObject({ id: "Q-1", d: "D-1", status: "overridden", outcome: { answer: "SQLite", reason: "One file is easier to back up" } });
    expect(view.decided[0].outcome.by.kind).toBe("person");

    const again = await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-1", choice: "Postgres", reason: "x", fingerprint: card.fingerprint });
    expect(again.status).toBe(409);
  });

  it("the offline reviewer recommends from a similar earlier decision, and accepting records it", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const p = key();
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Which database should invoices use?", options: ["Postgres", "SQLite"] });
    await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-1", choice: "SQLite", reason: "Simple backups", fingerprint: await fp(p, "Q-1") });
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Which database should the invoice archive use?", options: ["SQLite", "Postgres"] });
    const view = (await hostCall(t.base, "GET", `/decisions?project=${p}`)).body.result;
    const card = view.open[0];
    expect(card.id).toBe("Q-2");
    expect(card.recommendation).toMatchObject({ option: "SQLite", source: "offline", producedBy: "Offline reviewer", model: null });
    expect(card.recommendation.reasons[0]).toMatch(/D-1/);
    expect(card.recommendation.confidence).toBeGreaterThan(0.4);

    const accepted = await hostCall(t.base, "POST", `/decisions/accept?project=${p}`, { q: "Q-2", fingerprint: card.fingerprint });
    expect(accepted.body.result).toMatchObject({ decision: "D-2", answer: "SQLite", status: "accepted" });
    const after = (await hostCall(t.base, "GET", `/decisions?project=${p}`)).body.result;
    expect(after.decided.find((c: { id: string }) => c.id === "Q-2")).toMatchObject({ status: "accepted", recommendation: { option: "SQLite", source: "offline" } });
    expect(after.summary).toMatchObject({ open: 0, decided: 2 });
  });

  it("accept and override are bound to the card the person saw", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const p = key();
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Which database should invoices use?", options: ["Postgres", "SQLite"] });
    await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-1", choice: "SQLite", reason: "Simple backups", fingerprint: await fp(p, "Q-1") });
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Which database should the invoice archive use?", options: ["SQLite", "Postgres"] });
    const seen = await fp(p, "Q-2");
    expect(seen).toMatch(/^[0-9a-f]{64}$/);

    const missing = await hostCall(t.base, "POST", `/decisions/accept?project=${p}`, { q: "Q-2" });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("FINGERPRINT_REQUIRED");
    const missingOverride = await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-2", choice: "Postgres", reason: "x" });
    expect(missingOverride.status).toBe(400);
    expect(missingOverride.body.code).toBe("FINGERPRINT_REQUIRED");

    // Something changes after the person looked: a new plan clause that names the other option changes what the offline reviewer says.
    const stale = await hostCall(t.base, "POST", `/decisions/accept?project=${p}`, { q: "Q-2", fingerprint: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("STALE");
    expect(stale.body.message).toMatch(/changed since you looked/);
    const staleOverride = await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-2", choice: "Postgres", reason: "x", fingerprint: "0".repeat(64) });
    expect(staleOverride.status).toBe(409);
    expect((await hostCall(t.base, "GET", `/decisions?project=${p}`)).body.result.open).toHaveLength(1);

    const real = await hostCall(t.base, "POST", `/decisions/accept?project=${p}`, { q: "Q-2", fingerprint: seen });
    expect(real.status).toBe(200);
    expect(real.body.result).toMatchObject({ answer: "SQLite", status: "accepted" });
  });

  it("a changed recommendation makes the old fingerprint stale", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const p = key();
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Where do invoices live?", options: ["Postgres", "SQLite"] });
    const seen = await fp(p, "Q-1");
    addClause(t.host.project(p).ledger, { kind: "person", id: "owner" }, { text: "Invoices are stored in SQLite." });
    const now = await fp(p, "Q-1");
    expect(now).not.toBe(seen);
    const res = await hostCall(t.base, "POST", `/decisions/accept?project=${p}`, { q: "Q-1", fingerprint: seen });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STALE");
    expect((await hostCall(t.base, "POST", `/decisions/accept?project=${p}`, { q: "Q-1", fingerprint: now })).status).toBe(200);
  });

  it("an identical question is answered at once by the relay from the earlier decision", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const p = key();
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Ship on Fridays?", options: ["Yes", "No"] });
    await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-1", choice: "No", reason: "Weekend support is thin", fingerprint: await fp(p, "Q-1") });
    const again = await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "ship on fridays", options: ["No", "Yes"] });
    expect(again.body.result).toMatchObject({ status: "answered", decision: "D-1", via: "decision" });
    const view = (await hostCall(t.base, "GET", `/decisions?project=${p}`)).body.result;
    expect(view.decided.find((c: { id: string }) => c.id === "Q-2")).toMatchObject({ status: "decided", outcome: { answer: "No" } });
  });

  it("refuses an empty question and free-text overrides need words", async () => {
    const p = key();
    expect((await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "  " })).status).toBe(400);
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "What should the app be called?" });
    expect((await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-1", reason: "x", fingerprint: await fp(p, "Q-1") })).status).toBe(400);
    const named = await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-1", text: "Ledgerly", reason: "Short and clear", fingerprint: await fp(p, "Q-1") });
    expect(named.body.result).toMatchObject({ decision: "D-1", answer: "Ledgerly" });
    expect((await hostCall(t.base, "POST", `/decisions/override?project=${p}`, { q: "Q-9", text: "x", reason: "x" })).status).toBe(404);
  });

  it("shows settings decisions and review verdicts with model and cost", async () => {
    const p = key();
    const project = t.host.project(p);
    project.ledger.append({ actor: { kind: "person", id: "owner" }, type: "decision.made", subject: "D-1", summary: "Monthly budget set to $20.00", reason: "Keep costs small", evidence: [], refs: [], data: { topic: "budget", budget: { monthlyCents: 2000 } } });
    // Jev's verdicts are written and signed by Perfect Planner, naming Jev as the reviewer (core/jev/reviewer).
    project.ledger.append({ actor: { kind: "system", id: "jev-reviewer" }, type: "review.verdict", subject: "T-1", summary: "Jev rejects the diff for T-1", reason: "A test is weakened", evidence: [], refs: [], data: { reviewer: { kind: "jev", id: "jev", model: "jev-latest" }, review: "diff", verdict: "reject", jevModel: "jev-latest", cost: 0.03, confidence: 0.9, notes: ["A test is weakened."] } });
    const view = (await hostCall(t.base, "GET", `/decisions?project=${p}`)).body.result;
    const budget = view.decided.find((c: { kind: string }) => c.kind === "decision");
    expect(budget).toMatchObject({ d: "D-1", topic: "budget", title: "Monthly budget set to $20.00", outcome: { reason: "Keep costs small" } });
    const review = view.decided.find((c: { kind: string }) => c.kind === "review");
    expect(review.recommendation).toMatchObject({ option: "Reject", source: "jev", producedBy: "Jev", model: "jev-latest", confidence: 0.9, reasons: ["A test is weakened."], cost: { cents: 3, label: "$0.03" } });
    expect(view.summary.spend).toEqual({ cents: 3, label: "$0.03" });
  });

  it("with a key saved, asks Jev and shows its recommendation with the model it reports", async () => {
    const requests: JevRequest[] = [];
    setDecisionJev({
      keys: new MemoryKeyProvider("ts_test_key_123456789"),
      transport: async (request) => {
        requests.push(request);
        return { ok: true, status: 200, model: "jev-2026-09", cost: 0.02, answers: { settled: { choice: "option_2", confidence: 0.7, reason: "§1 says invoices are stored in SQLite." } } };
      },
    });
    const p = key();
    const project = t.host.project(p);
    addClause(project.ledger, { kind: "person", id: "owner" }, { text: "Invoices are stored in SQLite." });
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Where do invoices live?", options: ["Postgres", "SQLite"] });
    await settleDecisionJev(project);
    const view = (await hostCall(t.base, "GET", `/decisions?project=${p}`)).body.result;
    expect(view.jev).toMatchObject({ connected: true, model: "jev-latest" });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain("ts_test_key");
    expect(view.open[0].recommendation).toMatchObject({ option: "SQLite", source: "jev", model: "jev-2026-09", confidence: 0.7, cost: { cents: 2 } });
    expect(view.open[0].status).toBe("open");
    expect(JSON.stringify(view)).not.toContain("ts_test_key");
  });

  it("reads both cost shapes", () => {
    const base = { n: "L-000001", at: "2026-10-01T00:00:00Z", actor: { kind: "system" as const, id: "x" }, type: "review.verdict" as const, subject: "T-1", summary: "s", evidence: [], refs: [], prev: "", hash: "" };
    expect(entryCents({ ...base, data: { cost: { cents: 12, kind: "model" } } })).toBe(12);
    expect(entryCents({ ...base, data: { cost: 0.05 } })).toBe(5);
    expect(entryCents(base)).toBeNull();
    // Hand-built entries were never verified by a ledger, so they are not spend (signed spend is covered above).
    expect(spendThisMonth([{ ...base, data: { cost: { cents: 12, kind: "model" } } }, { ...base, data: { cost: 0.05 } }], "2026-10")).toBe(0);
  });
});

describe("forged ledger entries never reach the Decisions screen", () => {
  const jev = { kind: "jev" as const, id: "jev", model: "jev-latest" };
  const system = { kind: "system" as const, id: "jev-reviewer" };
  const owner = { kind: "person" as const, id: "owner" };
  const view = async (p: string) => (await hostCall(t.base, "GET", `/decisions?project=${p}`)).body.result;

  it("ignores a forged Jev verdict on a task (decided cards and spend)", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const p = key();
    const project = t.host.project(p);
    forgeEntry(project, { actor: system, type: "review.verdict", subject: "T-1", summary: "Jev approves the diff for T-1", data: { reviewer: jev, review: "diff", verdict: "approve", cost: 5, confidence: 1 } });
    // Appended through the ledger, but as Jev itself (unsigned): information, never a counted verdict.
    project.ledger.append({ actor: jev, type: "review.verdict", subject: "T-2", summary: "Jev approves the diff for T-2", evidence: [], refs: [], data: { review: "diff", verdict: "approve", cost: 7 } });
    const v = await view(p);
    expect(v.decided).toEqual([]);
    expect(v.summary).toMatchObject({ decided: 0, spend: { cents: 0 } });
  });

  it("ignores a forged Jev verdict on a question (no Jev recommendation)", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const p = key();
    const project = t.host.project(p);
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Where do invoices live?", options: ["Postgres", "SQLite"] });
    forgeEntry(project, { actor: system, type: "review.verdict", subject: "Q-1", summary: "Jev settles Q-1", refs: ["Q-1"], data: { reviewer: jev, review: "question", verdict: "approve", answers: { settled: { choice: "option_1", confidence: 0.99, reason: "forged" } } } });
    const card = (await view(p)).open[0];
    expect(card.recommendation).toBeNull();
    expect(card.entries).toHaveLength(1);
  });

  it("ignores a forged decision: no decided card and no offline recommendation from it", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const p = key();
    const project = t.host.project(p);
    forgeEntry(project, { actor: owner, type: "decision.made", subject: "D-1", summary: "Monthly budget set to $9999", data: { topic: "budget" } });
    forgeEntry(project, { actor: owner, type: "decision.made", subject: "D-2", summary: "Postgres", data: { questionText: "Which database should invoices use?", answer: "Postgres" } });
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Which database should the invoice archive use?", options: ["SQLite", "Postgres"] });
    const v = await view(p);
    expect(v.decided).toEqual([]);
    expect(v.open[0].recommendation).toBeNull();
    expect(v.open[0].noRecommendation).toMatch(/yours/);
  });

  it("ignores a forged plan clause when the offline reviewer looks for a named option", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const p = key();
    const project = t.host.project(p);
    forgeEntry(project, { actor: owner, type: "clause.added", subject: "§1", summary: "Invoices are stored in SQLite.", data: { clause: "1", kind: "paragraph", text: "Invoices are stored in SQLite." } });
    await hostCall(t.base, "POST", `/decisions/ask?project=${p}`, { question: "Where do invoices live?", options: ["Postgres", "SQLite"] });
    expect((await view(p)).open[0].recommendation).toBeNull();
  });
});
