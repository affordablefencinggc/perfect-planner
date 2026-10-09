import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import { setBudget, recordSpend } from "./budget";
import { runCheapFirst, recordPipeline } from "./pipeline";
import { DEFAULT_PRESET, PRESETS, currentPreset, installSettingsRule, needsDeepReview, setPreset } from "./presets";
import { areasOf, heuristicRisk, triageRisk } from "./risk";
import type { ChangeSet } from "./types";

const owner = { kind: "person" as const, id: "owner" };
const agent = { kind: "agent" as const, id: "claude-code", model: "m1" };
const system = { kind: "system" as const, id: "gate" };
const NOW = new Date("2026-10-09T00:00:00Z");

function open(): Ledger {
  const ledger = Ledger.openSync(new MemoryStore(), { now: () => NOW });
  installNumberingRules(ledger);
  appendNumbered(ledger, { actor: system, type: "task.created", summary: "first task", evidence: [], refs: [] });
  return ledger;
}

const small: ChangeSet = { task: "T-1", plannedLines: 100, files: [{ path: "src/ui/Button.tsx", added: 20, removed: 5, addedText: "export const x = 1;\n" }] };
const authChange: ChangeSet = { task: "T-2", plannedLines: 100, files: [{ path: "src/auth/login.ts", added: 10, removed: 2, addedText: "const ok = true;\n" }] };

describe("risk triage", () => {
  it("finds sensitive areas from paths", () => {
    expect(areasOf("src/auth/login.ts")).toContain("auth");
    expect(areasOf("server/billing/invoice.ts")).toContain("payments");
    expect(areasOf("db/migrations/0003_add.sql")).toContain("migrations");
    expect(areasOf("core/jev/secret.ts")).toContain("secrets");
    expect(areasOf(".github/workflows/ci.yml")).toContain("ci");
    expect(areasOf("src\\auth\\session.ts")).toContain("auth");
    expect(areasOf("src/ui/Author.tsx")).toEqual([]);
    expect(areasOf("src/ui/Button.tsx")).toEqual([]);
  });

  it("rates plain small changes low and sensitive ones high", () => {
    expect(heuristicRisk(small).level).toBe("low");
    const auth = heuristicRisk(authChange);
    expect(auth.level).toBe("high");
    expect(auth.areas).toEqual(["auth"]);
  });

  it("marks oversize against the plan as high and big unplanned changes medium", () => {
    const over = heuristicRisk({ plannedLines: 10, files: [{ path: "src/a.ts", added: 30, removed: 0 }] });
    expect(over.level).toBe("high");
    expect(over.areas).toContain("oversize");
    expect(heuristicRisk({ files: [{ path: "src/a.ts", added: 500, removed: 0 }] }).level).toBe("medium");
  });

  it("treats removed test lines as medium risk", () => {
    const t = heuristicRisk({ files: [{ path: "src/a.test.ts", added: 1, removed: 40 }] });
    expect(t.level).toBe("medium");
    expect(t.reasons.join(" ")).toMatch(/removes test lines/);
  });

  it("lets the small model raise but never lower the level, and sends it no file contents", async () => {
    let seen: unknown;
    const raised = await triageRisk(small, async (input) => {
      seen = input;
      return { level: "high", reason: "touches shared state" };
    });
    expect(raised.level).toBe("high");
    expect(raised.rater).toBe("heuristic+model");
    expect(JSON.stringify(seen)).not.toContain("export const x");
    const notLowered = await triageRisk(authChange, async () => ({ level: "low", reason: "looks fine" }));
    expect(notLowered.level).toBe("high");
  });

  it("falls back to path rules when the small model fails", async () => {
    const t = await triageRisk(small, async () => {
      throw new Error("offline");
    });
    expect(t.level).toBe("low");
    expect(t.reasons.join(" ")).toMatch(/small-model rating unavailable \(offline\)/);
  });
});

describe("presets", () => {
  it("defaults to Balanced and matches the plan table", () => {
    expect(DEFAULT_PRESET).toBe("balanced");
    expect(PRESETS.cheap.deepReview).toBe("sensitive-only");
    expect(PRESETS.balanced.deepReview).toBe("risky");
    expect(PRESETS.thorough.deepReview).toBe("always");
    expect(PRESETS.thorough.fullTestsEveryMerge).toBe(true);
  });

  it("decides deep review per preset", () => {
    const low = heuristicRisk(small);
    const medium = heuristicRisk({ files: [{ path: "src/a.ts", added: 500, removed: 0 }] });
    const auth = heuristicRisk(authChange);
    expect(needsDeepReview("cheap", low).deep).toBe(false);
    expect(needsDeepReview("cheap", medium).deep).toBe(false);
    expect(needsDeepReview("cheap", auth).deep).toBe(true);
    expect(needsDeepReview("balanced", low).deep).toBe(false);
    expect(needsDeepReview("balanced", medium).deep).toBe(true);
    expect(needsDeepReview("thorough", low).deep).toBe(true);
  });

  it("records the preset in the ledger, person only", () => {
    const ledger = open();
    expect(currentPreset(ledger.entries())).toBe("balanced");
    setPreset(ledger, owner, "thorough", "we take payments now");
    expect(currentPreset(ledger.entries())).toBe("thorough");
    expect(() => setPreset(ledger, agent, "cheap", "save money")).toThrow(/Only a person/);
    expect(currentPreset(ledger.entries())).toBe("thorough");
  });
});

describe("cheap-first pipeline", () => {
  it("passes a small safe change without a deep review", async () => {
    const result = await runCheapFirst(small, {});
    expect(result.verdict).toBe("ready");
    expect(result.deep).toBe(false);
    expect(result.checks.map((c) => c.check)).toEqual(["size-cap", "secret-scan", "risk-triage", "deep-review", "budget", "local-tests"]);
    expect(result.checks.find((c) => c.check === "local-tests")?.status).toBe("skipped");
  });

  it("holds an oversize change before spending anything else", async () => {
    let rated = false;
    const result = await runCheapFirst(
      { plannedLines: 50, files: [{ path: "src/a.ts", added: 400, removed: 0 }] },
      { rater: async () => ((rated = true), { level: "low", reason: "" }) },
    );
    expect(result.verdict).toBe("held");
    expect(result.summary).toMatch(/size-cap/);
    expect(rated).toBe(false);
  });

  it("blocks a change with a secret and never shows the secret", async () => {
    const token = "ghp_" + "A1b2C3d4".repeat(5).slice(0, 36);
    const change: ChangeSet = { plannedLines: 100, files: [{ path: "src/a.ts", added: 1, removed: 0, addedText: `const t = "${token}";\n` }] };
    const result = await runCheapFirst(change, {});
    expect(result.verdict).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("runs only the tests for the changed files and blocks on failure", async () => {
    let ran: string[] = [];
    const result = await runCheapFirst(small, {
      allTests: ["src/ui/Button.test.tsx", "src/other/Other.test.tsx"],
      runTests: async (tests) => ((ran = tests), { ok: false, summary: "1 failed" }),
    });
    expect(ran).toEqual(["src/ui/Button.test.tsx"]);
    expect(result.verdict).toBe("blocked");
  });

  it("holds a risky change when no deep reviewer is configured, approves with one", async () => {
    const held = await runCheapFirst(authChange, {});
    expect(held.verdict).toBe("held");
    expect(held.deep).toBe(true);
    const approved = await runCheapFirst(authChange, { deepReview: async () => ({ verdict: "approve", notes: [] }) });
    expect(approved.verdict).toBe("ready");
    const rejected = await runCheapFirst(authChange, { deepReview: async () => ({ verdict: "reject", notes: ["checks no expiry"] }) });
    expect(rejected.verdict).toBe("blocked");
    expect(rejected.summary).toMatch(/checks no expiry/);
  });

  it("stops at the budget before anything else when the month is spent", async () => {
    const ledger = open();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "monthly cap" });
    recordSpend(ledger, agent, { cents: 1000, kind: "model", subject: "T-1", summary: "review spend" });
    const result = await runCheapFirst(small, { entries: ledger.entries(), now: NOW });
    expect(result.verdict).toBe("held");
    expect(result.checks[0]).toMatchObject({ check: "budget", status: "hold" });
  });

  it("records its outcome as a review.verdict entry", async () => {
    const ledger = open();
    const result = await runCheapFirst(small, {});
    const entry = recordPipeline(ledger, system, "T-1", result);
    expect(entry.type).toBe("review.verdict");
    expect(entry.data).toMatchObject({ stage: "cheap-first", preset: "balanced", verdict: "ready", deep: false, risk: "low" });
  });
});

describe("settings an agent cannot change", () => {
  it("ignores a review-preset decision written straight to the ledger by an agent", () => {
    const ledger = open();
    setPreset(ledger, owner, "thorough", "we take payments now");
    appendNumbered(ledger, { actor: agent, type: "decision.made", summary: "cheaper", reason: "save money", evidence: [], refs: [], data: { topic: "review-preset", preset: "cheap" } });
    expect(currentPreset(ledger.entries())).toBe("thorough");
  });

  it("refuses the agent's write outright once the settings rule is installed", () => {
    const ledger = open();
    installSettingsRule(ledger);
    expect(() =>
      appendNumbered(ledger, { actor: agent, type: "decision.made", summary: "cheaper", reason: "save money", evidence: [], refs: [], data: { topic: "review-preset", preset: "cheap" } }),
    ).toThrow(/Only a person/);
    expect(() =>
      appendNumbered(ledger, { actor: agent, type: "decision.made", summary: "more money", reason: "x", evidence: [], refs: [], data: { topic: "budget", budget: { monthlyCents: 999999 } } }),
    ).toThrow(/Only a person/);
    expect(() => setPreset(ledger, owner, "cheap", "solo prototype")).not.toThrow();
  });

  it("runs the gate on the ledger's preset, not on what a caller passes", async () => {
    const ledger = open();
    setPreset(ledger, owner, "thorough", "production app");
    const result = await runCheapFirst(small, { entries: ledger.entries(), now: NOW, preset: "cheap" } as never);
    expect(result.preset).toBe("thorough");
    expect(result.deep).toBe(true);
  });
});
