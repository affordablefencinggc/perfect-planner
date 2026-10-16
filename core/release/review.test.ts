import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import { setBudget, recordSpend } from "./budget";
import { installReleaseRules, runCheapFirst, recordPipeline } from "./pipeline";
import { DEFAULT_PRESET, PRESETS, currentPreset, installSettingsRule, needsDeepReview, setPreset } from "./presets";
import { areasOf, heuristicRisk, triageRisk } from "./risk";
import type { ChangeSet } from "./types";
import { approveSecretFinding, approvedFingerprints } from "./allowlist";
import { scanChange } from "./secrets";

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

const builder = { kind: "agent" as const, id: "worker-2", model: "builder-model" };
const reviewer = { kind: "jev" as const, id: "jev", model: "reviewer-model" };
const approve = async () => ({ verdict: "approve" as const, notes: [], reviewer });

describe("cheap-first pipeline", () => {
  it("passes a small safe change without a deep review", async () => {
    const result = await runCheapFirst(small, { ledger: open(), author: builder, now: NOW });
    expect(result.verdict).toBe("ready");
    expect(result.deep).toBe(false);
    expect(result.checks.map((c) => c.check)).toEqual(["budget", "size-cap", "secret-scan", "risk-triage", "deep-review", "local-tests"]);
    expect(result.checks.find((c) => c.check === "local-tests")).toMatchObject({ status: "skipped", summary: "Not run: no test runner configured" });
  });

  it("fails closed without a ledger instead of skipping the budget and preset", async () => {
    await expect(runCheapFirst(small, {} as never)).rejects.toThrow(/needs the project ledger/);
    await expect(runCheapFirst(small, { ledger: open() } as never)).rejects.toThrow(/needs the builder/);
  });

  it("holds an oversize change before spending anything else", async () => {
    let rated = false;
    const result = await runCheapFirst(
      { plannedLines: 50, files: [{ path: "src/a.ts", added: 400, removed: 0 }] },
      { ledger: open(), author: builder, now: NOW, rater: async () => ((rated = true), { level: "low", reason: "" }) },
    );
    expect(result.verdict).toBe("held");
    expect(result.summary).toMatch(/size-cap/);
    expect(rated).toBe(false);
  });

  it("blocks a change with a secret and never shows the secret", async () => {
    const token = "ghp_" + "A1b2C3d4".repeat(5).slice(0, 36);
    const change: ChangeSet = { plannedLines: 100, files: [{ path: "src/a.ts", added: 1, removed: 0, addedText: `const t = "${token}";\n` }] };
    const result = await runCheapFirst(change, { ledger: open(), author: builder, now: NOW });
    expect(result.verdict).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("runs only the tests for the changed files and blocks on failure", async () => {
    let ran: string[] = [];
    const result = await runCheapFirst(small, {
      ledger: open(),
      author: builder,
      now: NOW,
      allTests: ["src/ui/Button.test.tsx", "src/other/Other.test.tsx"],
      runTests: async (tests) => ((ran = tests), { ok: false, summary: "1 failed" }),
    });
    expect(ran).toEqual(["src/ui/Button.test.tsx"]);
    expect(result.verdict).toBe("blocked");
  });

  it("holds a risky change when no deep reviewer is configured, approves with one", async () => {
    const held = await runCheapFirst(authChange, { ledger: open(), author: builder, now: NOW });
    expect(held.verdict).toBe("held");
    expect(held.deep).toBe(true);
    const approved = await runCheapFirst(authChange, { ledger: open(), author: builder, now: NOW, deepReview: approve });
    expect(approved.verdict).toBe("ready");
    const rejected = await runCheapFirst(authChange, { ledger: open(), author: builder, now: NOW, deepReview: async () => ({ verdict: "reject", notes: ["checks no expiry"], reviewer }) });
    expect(rejected.verdict).toBe("blocked");
    expect(rejected.summary).toMatch(/checks no expiry/);
  });

  it("never lets the builder review its own change", async () => {
    const self = await runCheapFirst(authChange, { ledger: open(), author: builder, now: NOW, deepReview: async () => ({ verdict: "approve", notes: [], reviewer: builder }) });
    expect(self.verdict).toBe("held");
    expect(self.summary).toMatch(/different reviewer/);
    const sameModel = await runCheapFirst(authChange, {
      ledger: open(),
      author: builder,
      now: NOW,
      deepReview: async () => ({ verdict: "approve", notes: [], reviewer: { kind: "jev", id: "jev", model: "builder-model" } }),
    });
    expect(sameModel.verdict).toBe("held");
    const anonymous = await runCheapFirst(authChange, { ledger: open(), author: builder, now: NOW, deepReview: async () => ({ verdict: "approve", notes: [] }) as never });
    expect(anonymous.verdict).toBe("held");
  });

  it("sends a change that deletes tests to the deep review even under Cheap", async () => {
    const ledger = open();
    setPreset(ledger, owner, "cheap", "solo prototype");
    const change: ChangeSet = { plannedLines: 100, files: [{ path: "src/ui/Button.test.tsx", added: 0, removed: 40, deleted: true }] };
    const held = await runCheapFirst(change, { ledger, author: builder, now: NOW });
    expect(held.preset).toBe("cheap");
    expect(held.verdict).toBe("held");
    expect(held.deep).toBe(true);
    expect(needsDeepReview("cheap", heuristicRisk(change)).deep).toBe(true);
  });

  it("stops at the budget before anything else when the month is spent", async () => {
    const ledger = open();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "monthly cap" });
    recordSpend(ledger, agent, { cents: 1000, kind: "model", subject: "T-1", summary: "review spend" });
    const result = await runCheapFirst(small, { ledger, author: builder, now: NOW });
    expect(result.verdict).toBe("held");
    expect(result.checks[0]).toMatchObject({ check: "budget", status: "hold" });
  });

  it("wires the budget stop and the person-only settings into the ledger it gates", async () => {
    const ledger = open();
    setBudget(ledger, owner, { monthlyCents: 1000, reason: "monthly cap" });
    recordSpend(ledger, agent, { cents: 1000, kind: "model", subject: "T-1", summary: "review spend" });
    await runCheapFirst(small, { ledger, author: builder, now: NOW });
    expect(() => ledger.append({ actor: agent, type: "task.claimed", subject: "T-1", summary: "claim", evidence: [], refs: [] })).toThrow(/budget reached/);
    expect(() =>
      appendNumbered(ledger, { actor: system, type: "decision.made", summary: "raise", reason: "x", evidence: [], refs: [], data: { topic: "budget", budget: { monthlyCents: 999999 } } }),
    ).toThrow(/Only a person/);
    installReleaseRules(ledger); // idempotent: a second install adds no second rule
    setBudget(ledger, owner, { monthlyCents: 5000, reason: "raised" });
    expect(() => ledger.append({ actor: agent, type: "task.claimed", subject: "T-1", summary: "claim", evidence: [], refs: [] })).not.toThrow();
  });

  it("records its outcome as a review.verdict entry", async () => {
    const ledger = open();
    const result = await runCheapFirst(small, { ledger, author: builder, now: NOW });
    const entry = recordPipeline(ledger, system, "T-1", result);
    expect(entry.type).toBe("review.verdict");
    expect(entry.data).toMatchObject({ stage: "cheap-first", preset: "balanced", verdict: "ready", deep: false, risk: "low" });
  });
});

describe("settings an agent cannot change", () => {
  it("leaves the agent no way to write the decision at all", () => {
    const ledger = open();
    expect(() =>
      appendNumbered(ledger, { actor: agent, type: "decision.made", summary: "cheaper", reason: "save money", evidence: [], refs: [], data: { topic: "review-preset", preset: "cheap" } }),
    ).toThrow(/may not write decision.made/);
  });

  it("ignores a review-preset decision written by anyone but a person", () => {
    const ledger = open();
    setPreset(ledger, owner, "thorough", "we take payments now");
    appendNumbered(ledger, { actor: system, type: "decision.made", summary: "cheaper", reason: "save money", evidence: [], refs: [], data: { topic: "review-preset", preset: "cheap" } });
    expect(currentPreset(ledger.entries())).toBe("thorough");
  });

  it("refuses a system write outright once the settings rule is installed", () => {
    const ledger = open();
    installSettingsRule(ledger);
    expect(() =>
      appendNumbered(ledger, { actor: system, type: "decision.made", summary: "cheaper", reason: "save money", evidence: [], refs: [], data: { topic: "review-preset", preset: "cheap" } }),
    ).toThrow(/Only a person/);
    expect(() =>
      appendNumbered(ledger, { actor: system, type: "decision.made", summary: "more money", reason: "x", evidence: [], refs: [], data: { topic: "budget", budget: { monthlyCents: 999999 } } }),
    ).toThrow(/Only a person/);
    expect(() => setPreset(ledger, owner, "cheap", "solo prototype")).not.toThrow();
  });

  it("runs the gate on the ledger's preset, not on what a caller passes", async () => {
    const ledger = open();
    setPreset(ledger, owner, "thorough", "production app");
    const result = await runCheapFirst(small, { ledger, author: builder, now: NOW, preset: "cheap" } as never);
    expect(result.preset).toBe("thorough");
    expect(result.deep).toBe(true);
  });
});

describe("third review round", () => {
  const token = "ghp_" + "Q7w8E9r0".repeat(5).slice(0, 36);
  const secretChange: ChangeSet = { plannedLines: 100, files: [{ path: "src/a.ts", added: 1, removed: 0, addedText: `const t = "${token}";\n` }] };

  it("lets a secret-looking value through only with a person's signed approval in the ledger", async () => {
    const ledger = open();
    const first = await runCheapFirst(secretChange, { ledger, author: builder, now: NOW });
    expect(first.verdict).toBe("blocked");
    const fingerprint = scanChange(secretChange.files)[0].fingerprint!;
    approveSecretFinding(ledger, owner, { fingerprint, reason: "test fixture, not a real token" });
    const second = await runCheapFirst(secretChange, { ledger, author: builder, now: NOW });
    expect(second.checks.find((c) => c.check === "secret-scan")?.status).toBe("pass");
    approveSecretFinding(ledger, owner, { fingerprint, reason: "fixture removed", revoke: true });
    expect((await runCheapFirst(secretChange, { ledger, author: builder, now: NOW })).verdict).toBe("blocked");
  });

  it("ignores an approval written by anyone but a person, and refuses it once the gate has run", async () => {
    const ledger = open();
    const fingerprint = scanChange(secretChange.files)[0].fingerprint!;
    appendNumbered(ledger, { actor: system, type: "decision.made", summary: "allow", reason: "x", evidence: [], refs: [], data: { topic: "secret-allowlist", fingerprint } });
    expect(approvedFingerprints(ledger.entries()).size).toBe(0);
    expect((await runCheapFirst(secretChange, { ledger, author: builder, now: NOW })).verdict).toBe("blocked");
    expect(() =>
      appendNumbered(ledger, { actor: system, type: "decision.made", summary: "allow", reason: "x", evidence: [], refs: [], data: { topic: "secret-allowlist", fingerprint } }),
    ).toThrow(/Only a person/);
    expect(() => approveSecretFinding(ledger, agent, { fingerprint, reason: "x" })).toThrow(/Only a person/);
  });

  it("catches test deletions in __tests__ folders, Python tests and edits that remove assertions", () => {
    for (const file of [
      { path: "src/__tests__/login.js", added: 0, removed: 30, deleted: true },
      { path: "tests/test_login.py", added: 0, removed: 12, deleted: true },
      { path: "pkg/login_test.go", added: 0, removed: 9, deleted: true },
      { path: "src/login.test.ts", added: 3, removed: 3 }, // asserts swapped for comments: same size
    ]) {
      expect(heuristicRisk({ files: [file] }).areas).toContain("tests");
    }
    expect(heuristicRisk({ files: [{ path: "src/login.test.ts", added: 5, removed: 0 }] }).areas).not.toContain("tests");
  });

  it("compares reviewer and builder without regard to case", async () => {
    const result = await runCheapFirst(authChange, {
      ledger: open(),
      author: builder,
      now: NOW,
      deepReview: async () => ({ verdict: "approve", notes: [], reviewer: { kind: "agent", id: "Worker-2", model: "other" } }),
    });
    expect(result.verdict).toBe("held");
    const sameModel = await runCheapFirst(authChange, {
      ledger: open(),
      author: builder,
      now: NOW,
      deepReview: async () => ({ verdict: "approve", notes: [], reviewer: { kind: "jev", id: "jev", model: "Builder-Model" } }),
    });
    expect(sameModel.verdict).toBe("held");
  });
});
