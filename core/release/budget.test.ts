import { describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import {
  budgetStatus,
  checkBudget,
  costOf,
  currentBudget,
  formatCents,
  installBudgetRule,
  monthSpend,
  recordSpend,
  setBudget,
} from "./budget";

const owner = { kind: "person" as const, id: "owner" };
const agent = { kind: "agent" as const, id: "claude-code", model: "m1" };
const system = { kind: "system" as const, id: "gate" };
const jev = { kind: "jev" as const, id: "jev", model: "m1" };

function setup(start = "2026-10-09T00:00:00Z") {
  const clock = { t: new Date(start) };
  const now = () => clock.t;
  const ledger = Ledger.openSync(new MemoryStore(), { now });
  installNumberingRules(ledger);
  for (const summary of ["first task", "second task"]) appendNumbered(ledger, { actor: system, type: "task.created", summary, evidence: [], refs: [] });
  installBudgetRule(ledger, { now });
  return { ledger, clock, now };
}

const spend = (l: Ledger, cents: number, kind: "ci" | "model" = "model") =>
  recordSpend(l, agent, { cents, kind, subject: "T-1", summary: `spent ${cents}` });

const claim = (l: Ledger) =>
  l.append({ actor: agent, type: "task.claimed", subject: "T-2", summary: "claimed", evidence: [], refs: [] });

describe("formatCents", () => {
  it("formats dollars and cents", () => {
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(100000)).toBe("$1000.00");
    expect(formatCents(12.6)).toBe("$0.13");
    expect(formatCents(-250)).toBe("-$2.50");
  });
});

describe("spend", () => {
  it("costOf reads well-formed costs only", () => {
    const { ledger } = setup();
    const e = recordSpend(ledger, agent, { cents: 42, kind: "ci", subject: "T-1", summary: "ci run", detail: "build" });
    expect(costOf(e)).toEqual({ cents: 42, kind: "ci", detail: "build" });
    const plain = ledger.append({ actor: agent, type: "task.progress", subject: "T-1", summary: "x", evidence: [], refs: [] });
    expect(costOf(plain)).toBeUndefined();
    const bad = ledger.append({ actor: agent, type: "task.progress", subject: "T-1", summary: "x", evidence: [], refs: [], data: { cost: { cents: "9", kind: "ci" } } });
    expect(costOf(bad)).toBeUndefined();
    const badKind = ledger.append({ actor: agent, type: "task.progress", subject: "T-1", summary: "x", evidence: [], refs: [], data: { cost: { cents: 9, kind: "gpu" } } });
    expect(costOf(badKind)).toBeUndefined();
  });

  it("sums by kind, and any entry type can carry a cost", () => {
    const { ledger } = setup();
    spend(ledger, 100, "ci");
    spend(ledger, 250, "model");
    recordSpend(ledger, agent, { cents: 50, kind: "model", subject: "T-1", summary: "proof run", type: "task.proof" });
    expect(monthSpend(ledger.entries(), "2026-10")).toEqual({ totalCents: 400, ciCents: 100, modelCents: 300 });
  });

  it("rounds fractional cents and rejects negatives", () => {
    const { ledger } = setup();
    const e = spend(ledger, 10.6);
    expect(costOf(e)?.cents).toBe(11);
    expect(() => spend(ledger, -1)).toThrow(LedgerError);
  });

  it("spend in a prior month does not count", () => {
    const { ledger, clock } = setup("2026-09-30T23:59:59Z");
    spend(ledger, 5000);
    clock.t = new Date("2026-10-01T00:00:00Z");
    spend(ledger, 100);
    expect(monthSpend(ledger.entries(), "2026-09").totalCents).toBe(5000);
    expect(monthSpend(ledger.entries(), "2026-10").totalCents).toBe(100);
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "cap" });
    const s = budgetStatus(ledger.entries(), clock.t);
    expect(s.month).toBe("2026-10");
    expect(s.spentCents).toBe(100);
    expect(s.state).toBe("ok");
  });
});

describe("budget config", () => {
  it("is uncapped with no config", () => {
    const { ledger, now } = setup();
    spend(ledger, 999999);
    expect(currentBudget(ledger.entries())).toBeUndefined();
    const s = checkBudget(ledger, system, now());
    expect(s.state).toBe("uncapped");
    expect(s.budgetCents).toBeUndefined();
    expect(s.remainingCents).toBeUndefined();
    expect(ledger.entries().some((e) => e.type === "budget.warning")).toBe(false);
    expect(() => claim(ledger)).not.toThrow();
  });

  it("latest decision wins and defaults warnAt to 0.8", () => {
    const { ledger } = setup();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "first" });
    expect(currentBudget(ledger.entries())).toEqual({ monthlyCents: 1000, warnAt: 0.8 });
    setBudget(ledger, owner, { monthlyCents: 2000, warnAt: 0.5, reason: "more" });
    expect(currentBudget(ledger.entries())).toEqual({ monthlyCents: 2000, warnAt: 0.5 });
    const e = ledger.last()!;
    expect(e.type).toBe("decision.made");
    expect(e.subject).toBe("D-2");
    expect(e.data?.topic).toBe("budget");
    expect(e.reason).toBe("more");
  });

  it("an agent, Jev or system cannot set the budget", () => {
    const { ledger } = setup();
    for (const actor of [agent, jev, { kind: "system" as const, id: "watcher" }]) {
      expect(() => setBudget(ledger, actor, { monthlyCents: 1000, reason: "r" })).toThrow(LedgerError);
    }
    expect(currentBudget(ledger.entries())).toBeUndefined();
  });

  it("rejects nonsense values and blank reasons", () => {
    const { ledger } = setup();
    expect(() => setBudget(ledger, owner, { monthlyCents: 0, reason: "r" })).toThrow();
    expect(() => setBudget(ledger, owner, { monthlyCents: 100, warnAt: 1.5, reason: "r" })).toThrow();
    expect(() => setBudget(ledger, owner, { monthlyCents: 100, reason: " " })).toThrow(LedgerError);
  });
});

describe("thresholds", () => {
  it("ok below 80%, warning at 80%, stopped at 100%", () => {
    const { ledger, now } = setup();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "cap" });
    spend(ledger, 799);
    let s = budgetStatus(ledger.entries(), now());
    expect(s.state).toBe("ok");
    expect(s.remainingCents).toBe(201);
    spend(ledger, 1);
    s = budgetStatus(ledger.entries(), now());
    expect(s.state).toBe("warning");
    expect(s.ratio).toBeCloseTo(0.8);
    spend(ledger, 199);
    expect(budgetStatus(ledger.entries(), now()).state).toBe("warning");
    spend(ledger, 1);
    s = budgetStatus(ledger.entries(), now());
    expect(s.state).toBe("stopped");
    expect(s.remainingCents).toBe(0);
  });

  it("honours a custom warnAt and overspend", () => {
    const { ledger, now } = setup();
    setBudget(ledger, owner, { monthlyCents: 1000, warnAt: 0.5, reason: "cap" });
    spend(ledger, 500);
    expect(budgetStatus(ledger.entries(), now()).state).toBe("warning");
    spend(ledger, 900);
    const s = budgetStatus(ledger.entries(), now());
    expect(s.state).toBe("stopped");
    expect(s.ratio).toBeCloseTo(1.4);
    expect(s.remainingCents).toBe(0);
  });

  it("is exact for awkward budgets (no float drift at the warning line)", () => {
    const { ledger, now } = setup();
    setBudget(ledger, owner, { monthlyCents: 1070, reason: "cap" }); // 80% = 856
    spend(ledger, 855);
    expect(budgetStatus(ledger.entries(), now()).state).toBe("ok");
    spend(ledger, 1);
    expect(budgetStatus(ledger.entries(), now()).state).toBe("warning");
  });
});

describe("checkBudget", () => {
  it("writes one warning at 80% and one stop at 100%, then nothing more", () => {
    const { ledger, now } = setup();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "cap" });
    spend(ledger, 500);
    checkBudget(ledger, system, now());
    expect(ledger.entries().filter((e) => e.type === "budget.warning")).toHaveLength(0);

    spend(ledger, 300);
    const s1 = checkBudget(ledger, system, now());
    expect(s1.state).toBe("warning");
    checkBudget(ledger, system, now());
    checkBudget(ledger, system, now());
    let warnings = ledger.entries().filter((e) => e.type === "budget.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.subject).toBe("budget");
    expect(warnings[0]!.data).toEqual({ month: "2026-10", threshold: "warn", spentCents: 800, budgetCents: 1000 });

    spend(ledger, 200);
    expect(checkBudget(ledger, system, now()).state).toBe("stopped");
    checkBudget(ledger, system, now());
    warnings = ledger.entries().filter((e) => e.type === "budget.warning");
    expect(warnings).toHaveLength(2);
    expect(warnings[1]!.data?.threshold).toBe("stop");
    expect(warnings[1]!.summary).toContain("$10.00 of $10.00");
  });

  it("warns again next month, and again after a raise is crossed", () => {
    const { ledger, clock } = setup();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "cap" });
    spend(ledger, 900);
    checkBudget(ledger, system, clock.t);
    clock.t = new Date("2026-11-02T00:00:00Z");
    expect(budgetStatus(ledger.entries(), clock.t).state).toBe("ok");
    spend(ledger, 850);
    checkBudget(ledger, system, clock.t);
    expect(ledger.entries().filter((e) => e.type === "budget.warning")).toHaveLength(2);

    setBudget(ledger, owner, { monthlyCents: 1000 + 100, reason: "bump" });
    spend(ledger, 100);
    checkBudget(ledger, system, clock.t); // 950 of 1100 -> warn at new amount
    expect(ledger.entries().filter((e) => e.type === "budget.warning")).toHaveLength(3);
  });

  it("works when a single charge jumps straight past 100%", () => {
    const { ledger, now } = setup();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "cap" });
    spend(ledger, 5000);
    expect(checkBudget(ledger, system, now()).state).toBe("stopped");
    const w = ledger.entries().filter((e) => e.type === "budget.warning");
    expect(w).toHaveLength(1);
    expect(w[0]!.data?.threshold).toBe("stop");
  });
});

describe("installBudgetRule", () => {
  it("refuses claims and worktrees at 100%, allows everything else", () => {
    const { ledger } = setup();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "cap" });
    spend(ledger, 900);
    expect(() => claim(ledger)).not.toThrow(); // warning still allows work
    spend(ledger, 100);

    let err: unknown;
    try {
      claim(ledger);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe("RULE");
    expect((err as LedgerError).message).toBe(
      "Monthly budget reached ($10.00 of $10.00); raise it in Settings to start new runs",
    );
    expect(() =>
      ledger.append({ actor: system, type: "worktree.created", subject: "T-2", summary: "wt", evidence: [], refs: [] }),
    ).toThrow(/Monthly budget reached/);

    // in-flight work finishes
    expect(() => spend(ledger, 10)).not.toThrow();
    expect(() => ledger.append({ actor: agent, type: "task.proof", subject: "T-1", summary: "proof", evidence: [], refs: [] })).not.toThrow();
    expect(() => ledger.append({ actor: system, type: "commit.observed", subject: "T-1", summary: "commit", evidence: [], refs: [] })).not.toThrow();
    expect(() => checkBudget(ledger, system, new Date("2026-10-09T00:00:00Z"))).not.toThrow();
  });

  it("allows new runs after the budget is raised", () => {
    const { ledger } = setup();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "cap" });
    spend(ledger, 1000);
    expect(() => claim(ledger)).toThrow(LedgerError);
    setBudget(ledger, owner, { monthlyCents: 5000, reason: "raise for launch" });
    expect(() => claim(ledger)).not.toThrow();
  });

  it("an agent cannot lift the stop by setting the budget", () => {
    const { ledger } = setup();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "cap" });
    spend(ledger, 1000);
    expect(() => setBudget(ledger, agent, { monthlyCents: 99999, reason: "sneaky" })).toThrow(LedgerError);
    expect(() => claim(ledger)).toThrow(LedgerError);
  });

  it("a new month lifts the stop", () => {
    const { ledger, clock } = setup();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "cap" });
    spend(ledger, 1000);
    expect(() => claim(ledger)).toThrow(LedgerError);
    clock.t = new Date("2026-11-01T00:00:00Z");
    expect(() => claim(ledger)).not.toThrow();
  });

  it("does nothing when uncapped", () => {
    const { ledger } = setup();
    spend(ledger, 10_000_000);
    expect(() => claim(ledger)).not.toThrow();
  });
});
