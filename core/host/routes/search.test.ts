import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor, Ledger } from "../../ledger/index";
import { addPlanText, changeClause } from "../../lookup/index";
import { appendNumbered, cutRelease } from "../../numbering/index";
import { hostCall, startTestHost } from "../testing";
import { normalizeRef } from "./search";

const owner: Actor = { kind: "person", id: "sam" };
const watcher: Actor = { kind: "system", id: "watcher" };

const PLAN = `# Invoices

## 1. Scope

Finish invoice sending.

## 2. Behaviour

- A new invoice keeps its identity after a reload.
- An accepted email is recovered without resending.
`;

function seed(ledger: Ledger) {
  addPlanText(ledger, owner, PLAN);
  appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Invoice plan approved" });
  appendNumbered(ledger, { actor: owner, type: "task.created", summary: "Invoice identity survives reload", refs: ["P-1 §2.1"], evidence: ["https://example.test/issue/1"] });
  appendNumbered(ledger, { actor: owner, type: "question.asked", summary: "Keep the draft id?", data: { task: "T-1" } });
  appendNumbered(ledger, { actor: owner, type: "decision.made", summary: "Keep the draft id", reason: "Identity must survive a reload", refs: ["P-1 §2.1"], data: { question: "Q-1" } });
  ledger.append({ actor: watcher, type: "commit.observed", subject: "T-1", summary: "Commit 9f3c2e1", evidence: ["commit:9f3c2e1"], data: { sha: "9f3c2e1" } });
  cutRelease(ledger, owner, { commit: "9f3c2e1", change: "feature" });
  changeClause(ledger, owner, "§2.1", "A new invoice keeps its identity after a reload, even offline.", "Offline support is in scope");
}

describe("search routes", () => {
  let ctx: Awaited<ReturnType<typeof startTestHost>>;
  beforeEach(async () => {
    ctx = await startTestHost({ owned: false }); // seeds write as sam; an owner pin would make person:owner the only first writer
    ctx.host.ensureKey("system");
    ctx.host.ensurePersonKey(owner.id); // seeds write as sam, signed like the person's own window would
  });
  afterEach(async () => {
    await ctx.stop();
  });

  it("normalizes what people type into references", () => {
    expect(normalizeRef("P-12 3.2")).toBe("P-12 §3.2");
    expect(normalizeRef("P-12 §3.2")).toBe("P-12 §3.2");
    expect(normalizeRef("p-12 s3.2")).toBe("P-12 §3.2");
    expect(normalizeRef("sec 3.2")).toBe("§3.2");
    expect(normalizeRef("3.2")).toBe("§3.2");
    expect(normalizeRef("r5")).toBe("R-5");
    expect(normalizeRef("L-231")).toBe("L-000231");
    expect(normalizeRef("T-14.A2")).toBe("T-14.a2");
    expect(normalizeRef("invoice reload")).toBeUndefined();
  });

  it("is empty and intact on a fresh ledger", async () => {
    const recent = await hostCall(ctx.base, "GET", "/recent?project=s1");
    expect(recent.body.result).toMatchObject({ total: 0, entries: [], examples: [] });
    const verify = await hostCall(ctx.base, "GET", "/verify?project=s1");
    expect(verify.body.result).toMatchObject({ ok: true, entries: 0, brokenAt: null });
  });

  it("looks up clauses with version history, releases with ranges, and entries", async () => {
    seed(ctx.host.project("s2").ledger);

    const clause = await hostCall(ctx.base, "GET", `/lookup?project=s2&ref=${encodeURIComponent("P-1 2.1")}`);
    expect(clause.status).toBe(200);
    const c = clause.body.result;
    expect(c).toMatchObject({ found: true, kind: "clause", ref: "P-1 §2.1", text: "A new invoice keeps its identity after a reload." });
    expect(c.clause.current.text).toMatch(/even offline/);
    expect(c.clause.versions.map((v: { type: string }) => v.type)).toEqual(["clause.added", "clause.changed"]);
    expect(c.why).toBe("Offline support is in scope");
    expect(c.tasks).toEqual(["T-1"]);
    expect(c.commits).toEqual(["9f3c2e1"]);
    expect(c.citedBy.map((e: { subject: string }) => e.subject)).toEqual(expect.arrayContaining(["T-1", "D-1"]));

    const release = (await hostCall(ctx.base, "GET", "/lookup?project=s2&ref=R-1")).body.result;
    expect(release).toMatchObject({ found: true, kind: "release", who: { id: "sam" } });
    expect(release.release).toMatchObject({ version: "v1.0.0", from: "L-000001", commit: "9f3c2e1" });
    expect(release.release.count).toBe(release.release.entries.length);
    expect(release.release.count).toBeGreaterThan(5);

    const task = (await hostCall(ctx.base, "GET", "/lookup?project=s2&ref=t-1")).body.result;
    expect(task).toMatchObject({ found: true, kind: "task", what: "Invoice identity survives reload", evidence: ["https://example.test/issue/1"], refs: ["P-1 §2.1"] });

    const decision = (await hostCall(ctx.base, "GET", "/lookup?project=s2&ref=D-1")).body.result;
    expect(decision).toMatchObject({ found: true, kind: "decision", why: "Identity must survive a reload" });
    expect((await hostCall(ctx.base, "GET", "/lookup?project=s2&ref=Q-1")).body.result).toMatchObject({ found: true, status: "answered" });

    const entry = (await hostCall(ctx.base, "GET", "/lookup?project=s2&ref=L-1")).body.result;
    expect(entry).toMatchObject({ found: true, kind: "entry", ref: "L-000001" });
    expect(entry.entry.shortHash).toHaveLength(12);

    const missing = (await hostCall(ctx.base, "GET", "/lookup?project=s2&ref=R-9")).body.result;
    expect(missing).toMatchObject({ found: false, problem: "R-9 was never released" });

    const bad = await hostCall(ctx.base, "GET", "/lookup?project=s2&ref=");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("NO_REF");
  });

  it("searches free text, ranks, pages and caps", async () => {
    seed(ctx.host.project("s3").ledger);
    const res = (await hostCall(ctx.base, "GET", "/search?project=s3&q=reload")).body.result;
    expect(res.total).toBeGreaterThan(0);
    expect(res.hits[0].ref).toBe("§2.1");
    expect(res.hits.some((h: { kind: string }) => h.kind === "entry")).toBe(true);

    const paged = (await hostCall(ctx.base, "GET", "/search?project=s3&q=invoice&pageSize=2&page=2")).body.result;
    expect(paged).toMatchObject({ page: 2, pageSize: 2 });
    expect(paged.hits.length).toBeLessThanOrEqual(2);
    expect(paged.pages).toBe(Math.ceil(paged.total / 2));

    const exact = (await hostCall(ctx.base, "GET", `/search?project=s3&q=${encodeURIComponent("P-1 2.1")}`)).body.result;
    expect(exact.hits[0]).toMatchObject({ ref: "P-1 §2.1", exact: true });

    expect((await hostCall(ctx.base, "GET", "/search?project=s3&q=")).status).toBe(400);
  });

  it("lists recent entries newest first with examples, and verifies the chain", async () => {
    seed(ctx.host.project("s4").ledger);
    const recent = (await hostCall(ctx.base, "GET", "/recent?project=s4&limit=3")).body.result;
    expect(recent.entries).toHaveLength(3);
    expect(recent.entries[0].n).toBe(`L-${String(recent.total).padStart(6, "0")}`);
    expect(recent.examples).toEqual(expect.arrayContaining(["R-1", "T-1", "D-1", "Q-1"]));
    expect(recent.examples[0]).toMatch(/^P-1 §/);
    const verify = (await hostCall(ctx.base, "GET", "/verify?project=s4")).body.result;
    expect(verify).toMatchObject({ ok: true, entries: recent.total, head: recent.entries[0].n });
    expect(verify.headHash).toHaveLength(12);
  });
});
