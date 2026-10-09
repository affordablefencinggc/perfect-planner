import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { Ledger, MemoryStore, type Actor } from "../ledger/index";
import { Relay } from "../relay/index";
import { JevReviewer, MemoryKeyProvider, independenceProblem, SecretKey, checkDiff, createJevTransport, parseDiff, validateKey, type JevCallResult, type JevRequest } from "./index";

const KEY = "ts_live_FAKE0123456789abcdef";

function newLedger(now = "2026-10-09T05:00:00Z") {
  return Ledger.openSync(new MemoryStore(), { now: () => new Date(now) });
}

function reply(answers: Record<string, { choice: string; confidence: number; reason?: string }>, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ answers, model: "jev-2026-09", ...extra }), { status: 200, headers: { "content-type": "application/json" } });
}

/** A transport that answers every question with the given choices. */
function fakeTransport(choices: Record<string, string>, confidence = 0.95, cost: number | null = 0.03) {
  const calls: JevRequest[] = [];
  const transport = vi.fn(async (request: JevRequest): Promise<JevCallResult> => {
    calls.push(request);
    const answers = Object.fromEntries(Object.keys(request.questions).map((q) => [q, { choice: choices[q] ?? "none", confidence }]));
    return { ok: true, answers, model: "jev-2026-09", cost, status: 200 };
  });
  return { transport, calls };
}

const TEST_INPUT = {
  task: "T-1",
  title: "Invoice id survives reload",
  clauses: [{ ref: "P-1 §2.1", text: "A new invoice keeps its id after a reload." }],
  test: { command: "npm test -- invoice-id", source: "it('keeps id', () => { expect(reload(make()).id).toBe(id) })" },
  failsFirst: true,
  author: { kind: "agent", id: "worker-1", model: "claude-builder-1" } as Actor,
};

const GOOD = { covers_clauses: "all", trivially_passing: "no", weakest_clause: "none", weakens_tests: "no", stays_in_scope: "yes" };

describe("SecretKey", () => {
  it("never prints its value", () => {
    const key = new SecretKey(KEY);
    expect(String(key)).toBe("[redacted]");
    expect(`${key}`).toBe("[redacted]");
    expect(JSON.stringify({ key })).toBe('{"key":"[redacted]"}');
    expect(inspect(key)).not.toContain(KEY);
    expect(key.reveal()).toBe(KEY);
    expect(key.scrub(`failed with ${KEY} inside`)).toBe("failed with [redacted] inside");
  });

  it("validates like the Settings field", () => {
    expect(validateKey(`  ${KEY}\n`)).toBe(KEY);
    expect(() => validateKey("   ")).toThrow(/Enter a key/);
    expect(() => validateKey("a\u0007b")).toThrow(/control/);
    expect(() => validateKey("x".repeat(513))).toThrow(/512/);
  });
});

describe("Jev transport", () => {
  it("sends the Looplet request shape with the key only in the Authorization header", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply({ q: { choice: "yes", confidence: 0.9, reason: "because" } }, { usage: { cost_usd: 0.012 } }));
    const transport = createJevTransport({ keys: new MemoryKeyProvider(KEY), fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await transport({ model: "jev-latest", state: { a: 1 }, questions: { q: { type: "choice", instructions: "?", criteria: { yes: "y", no: "n" } } } });
    expect(result).toEqual({ ok: true, answers: { q: { choice: "yes", confidence: 0.9, reason: "because" } }, model: "jev-2026-09", cost: 0.012, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(String(init!.body)).not.toContain(KEY);
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: "jev-latest", state: { a: 1 }, questions: { q: { type: "choice" } } });
  });

  it("fails closed: no key, HTTP errors, malformed replies and network errors never look like answers", async () => {
    const q = { model: "jev-latest", state: {}, questions: { q: { type: "choice" as const, instructions: "?", criteria: { a: "a" } } } };
    const never = vi.fn();
    expect(await createJevTransport({ keys: new MemoryKeyProvider(), fetchImpl: never as unknown as typeof fetch })(q)).toMatchObject({ ok: false, problem: "no_key" });
    expect(never).not.toHaveBeenCalled();

    const status = (code: number) => (async () => new Response("busy", { status: code })) as unknown as typeof fetch;
    expect(await createJevTransport({ keys: new MemoryKeyProvider(KEY), fetchImpl: status(500) })(q)).toMatchObject({ ok: false, problem: "request_failed", status: 500 });
    const busy = vi.fn(status(429));
    expect(await createJevTransport({ keys: new MemoryKeyProvider(KEY), fetchImpl: busy as unknown as typeof fetch, sleep: async () => {} })(q)).toMatchObject({ ok: false, problem: "request_failed", status: 429 });
    expect(busy).toHaveBeenCalledTimes(2);

    const malformed = (async () => reply({ other: { choice: "a", confidence: 1 } })) as unknown as typeof fetch;
    expect(await createJevTransport({ keys: new MemoryKeyProvider(KEY), fetchImpl: malformed })(q)).toMatchObject({ ok: false, problem: "malformed" });

    const leaky = (async () => {
      throw new Error(`socket closed while sending ${KEY}`);
    }) as unknown as typeof fetch;
    const failed = await createJevTransport({ keys: new MemoryKeyProvider(KEY), fetchImpl: leaky })(q);
    expect(failed).toMatchObject({ ok: false, problem: "request_failed" });
    expect(JSON.stringify(failed)).not.toContain(KEY);
  });

  it("retries once on 429 and then succeeds", async () => {
    let n = 0;
    const fetchImpl = (async () => (n++ === 0 ? new Response("", { status: 429 }) : reply({ q: { choice: "a", confidence: 1 } }))) as unknown as typeof fetch;
    const result = await createJevTransport({ keys: new MemoryKeyProvider(KEY), fetchImpl, sleep: async () => {} })({ model: "m", state: {}, questions: { q: { type: "choice", instructions: "", criteria: { a: "" } } } });
    expect(result.ok).toBe(true);
  });
});

describe("test review (§6.2)", () => {
  it("approves a covering, failing-first test and writes one review.verdict entry", async () => {
    const ledger = newLedger();
    const { transport, calls } = fakeTransport(GOOD);
    const result = await new JevReviewer({ ledger, transport }).reviewTest(TEST_INPUT);
    expect(result.verdict).toBe("approve");
    expect(calls[0]!.questions.weakest_clause!.criteria).toHaveProperty("P-1 §2.1");
    const entry = ledger.get(result.entry!)!;
    expect(entry).toMatchObject({ type: "review.verdict", subject: "T-1", actor: { kind: "jev", id: "jev", model: "jev-2026-09" }, refs: ["P-1 §2.1"] });
    expect(entry.data).toMatchObject({ review: "test", verdict: "approve", policy: "pp-review-v1", model: "jev-latest", cost: 0.03, confidence: 0.95 });
  });

  it("rejects with gaps when a clause is missed or the test can pass trivially", async () => {
    const { transport } = fakeTransport({ ...GOOD, covers_clauses: "some", trivially_passing: "yes", weakest_clause: "P-1 §2.1" });
    const result = await new JevReviewer({ ledger: newLedger(), transport }).reviewTest(TEST_INPUT);
    expect(result.verdict).toBe("reject");
    expect(result.notes).toEqual(["Not every cited clause is checked; weakest: P-1 §2.1.", "The test could pass without the work being done."]);
  });

  it("rejects a test that already passes without asking Jev", async () => {
    const { transport } = fakeTransport(GOOD);
    const result = await new JevReviewer({ ledger: newLedger(), transport }).reviewTest({ ...TEST_INPUT, failsFirst: false });
    expect(result.verdict).toBe("reject");
    expect(transport).not.toHaveBeenCalled();
  });

  it("sends low-confidence verdicts to the main chat instead of deciding", async () => {
    expect((await new JevReviewer({ ledger: newLedger(), transport: fakeTransport(GOOD, 0.4).transport }).reviewTest(TEST_INPUT)).verdict).toBe("escalate");
    expect((await new JevReviewer({ ledger: newLedger(), transport: fakeTransport(GOOD, 0.7).transport }).reviewTest(TEST_INPUT)).verdict).toBe("escalate");
  });

  it("never approves its own output", async () => {
    const { transport } = fakeTransport(GOOD);
    const jev: Actor = { kind: "jev", id: "jev", model: "jev-latest" };
    const result = await new JevReviewer({ ledger: newLedger(), transport }).reviewTest({ ...TEST_INPUT, author: jev });
    expect(result.verdict).toBe("escalate");
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses to approve work built by the reviewing model, or by a builder whose model is unknown", async () => {
    for (const model of ["jev-latest", "JEV-LATEST", "jev-2026-09", "unknown", "unverified:claude-builder-1", undefined]) {
      const { transport } = fakeTransport(GOOD);
      const ledger = newLedger();
      const author: Actor = { kind: "agent", id: "worker-1", ...(model ? { model } : {}) };
      const result = await new JevReviewer({ ledger, transport }).reviewDiff({ task: "T-1", clauses: TEST_INPUT.clauses, diff: IN_SCOPE_DIFF, testOutput: "ok", allowedFiles: [], author });
      expect(result.verdict, String(model)).toBe("escalate");
      expect(result.reason).toMatch(/^Not independent/);
      expect(transport).not.toHaveBeenCalled();
      expect(ledger.get(result.entry!)!.data).toMatchObject({ verdict: "escalate", builtBy: author });
    }
  });

  it("downgrades an approval when Jev reports it ran the builder's model", async () => {
    const transport = async (r: JevRequest): Promise<JevCallResult> => ({
      ok: true,
      model: "claude-builder-1",
      cost: 0.01,
      status: 200,
      answers: Object.fromEntries(Object.keys(r.questions).map((q) => [q, { choice: (GOOD as Record<string, string>)[q]!, confidence: 0.99 }])),
    });
    const result = await new JevReviewer({ ledger: newLedger(), transport }).reviewTest(TEST_INPUT);
    expect(result).toMatchObject({ verdict: "escalate", reason: expect.stringContaining("same model") });
  });

  it("approves when the builder is a different, named model", () => {
    expect(independenceProblem({ kind: "agent", id: "w", model: "claude-builder-1" }, "jev-latest")).toBeNull();
    expect(independenceProblem({ kind: "person", id: "owner", model: "human" }, "jev-latest")).toBeNull();
  });

  it("records an unavailable verdict, never an approval, when Jev cannot be reached", async () => {
    const ledger = newLedger();
    const transport = async (): Promise<JevCallResult> => ({ ok: false, problem: "no_key", detail: "No Jev key is saved." });
    const result = await new JevReviewer({ ledger, transport }).reviewTest(TEST_INPUT);
    expect(result.verdict).toBe("unavailable");
    expect(ledger.get(result.entry!)!.data).toMatchObject({ verdict: "unavailable", problem: "no_key", cost: 0 });
  });
});

const IN_SCOPE_DIFF = `diff --git a/src/invoice/id.ts b/src/invoice/id.ts
--- a/src/invoice/id.ts
+++ b/src/invoice/id.ts
@@ -1,3 +1,4 @@
 export function newId() {
-  return Math.random();
+  const id = crypto.randomUUID();
+  return id;
 }
`;

describe("diff review (§6.3)", () => {
  const input = { task: "T-1", clauses: TEST_INPUT.clauses, diff: IN_SCOPE_DIFF, testOutput: "1 passed", allowedFiles: ["src/invoice/"], author: TEST_INPUT.author };

  it("approves a clean in-scope diff when Jev agrees", async () => {
    const { transport, calls } = fakeTransport(GOOD);
    const result = await new JevReviewer({ ledger: newLedger(), transport }).reviewDiff({ ...input, attempt: 1 });
    expect(result.verdict).toBe("approve");
    expect(calls[0]!.state).toMatchObject({ files: ["src/invoice/id.ts"], allowed_files: ["src/invoice/"] });
  });

  it("rejects with Jev's notes, which sends the task back for attempt 2", async () => {
    const ledger = newLedger();
    const transport = async (r: JevRequest): Promise<JevCallResult> => ({
      ok: true,
      model: "jev-2026-09",
      cost: 0.05,
      status: 200,
      answers: Object.fromEntries(Object.keys(r.questions).map((q) => [q, q === "weakens_tests" ? { choice: "yes", confidence: 0.9, reason: "tolerance widened in id.test.ts" } : { choice: (GOOD as Record<string, string>)[q]!, confidence: 0.9 }])),
    });
    const result = await new JevReviewer({ ledger, transport }).reviewDiff({ ...input, attempt: 1 });
    expect(result).toMatchObject({ verdict: "reject", notes: ["A test or check is weakened: tolerance widened in id.test.ts"] });
    expect(ledger.get(result.entry!)!.data).toMatchObject({ review: "diff", verdict: "reject", attempt: 1 });
  });

  it("rejects out-of-scope files, weakened tests and secrets with line notes, without calling Jev", async () => {
    const diff = `diff --git a/src/billing/other.ts b/src/billing/other.ts
--- a/src/billing/other.ts
+++ b/src/billing/other.ts
@@ -1 +1 @@
-x
+const stripe = "sk_live_${"a".repeat(24)}";
diff --git a/src/invoice/id.test.ts b/src/invoice/id.test.ts
--- a/src/invoice/id.test.ts
+++ b/src/invoice/id.test.ts
@@ -10,4 +10,3 @@
 describe("id", () => {
-  it("keeps id", () => { expect(a).toBe(b) });
+  it.skip("keeps id", () => {});
-  expect(c).toBe(d);
 });
`;
    const { transport } = fakeTransport(GOOD);
    const result = await new JevReviewer({ ledger: newLedger(), transport }).reviewDiff({ ...input, diff, allowedFiles: ["src/invoice/"] });
    expect(transport).not.toHaveBeenCalled();
    expect(result.verdict).toBe("reject");
    expect(result.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/billing/other.ts", rule: "scope" }),
        expect.objectContaining({ file: "src/billing/other.ts", rule: "secret", line: 1 }),
        expect.objectContaining({ file: "src/invoice/id.test.ts", rule: "tests", line: 11 }),
        expect.objectContaining({ file: "src/invoice/id.test.ts", rule: "tests", note: expect.stringContaining("skipped") }),
      ]),
    );
  });

  it("parses deletions and renames", () => {
    const files = parseDiff(`diff --git a/tests/a.test.ts b/tests/a.test.ts
deleted file mode 100644
--- a/tests/a.test.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-it("a", () => {});
-expect(1).toBe(1);
`);
    expect(files).toMatchObject([{ path: "tests/a.test.ts", deleted: true, removed: [{ line: 1 }, { line: 2 }] }]);
    expect(checkDiff(files, ["tests/"])).toEqual([expect.objectContaining({ rule: "tests", note: "A test file is deleted." })]);
  });
});

describe("nothing secret reaches TypeSafe", () => {
  it("redacts secrets in removed and context lines, test output and test source before sending", async () => {
    const stripe = `sk_live_${"b".repeat(24)}`;
    const diff = `diff --git a/src/invoice/id.ts b/src/invoice/id.ts
--- a/src/invoice/id.ts
+++ b/src/invoice/id.ts
@@ -1,3 +1,3 @@
 const old = "${stripe}";
-const key = "${stripe}";
+const key = process.env.KEY;
`;
    const { transport, calls } = fakeTransport(GOOD);
    const reviewer = new JevReviewer({ ledger: newLedger(), transport });
    await reviewer.reviewDiff({ task: "T-1", clauses: TEST_INPUT.clauses, diff, testOutput: `token=${stripe}`, allowedFiles: [], author: TEST_INPUT.author });
    await reviewer.reviewTest({ ...TEST_INPUT, test: { command: "npm test", source: `const k = "${stripe}"` } });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(JSON.stringify(call)).not.toContain(stripe);
      expect(JSON.stringify(call)).toContain("[redacted-secret]");
    }
  });
});

describe("cost cap (§6.7)", () => {
  it("warns at 80%, queues at 100% without approving, and runs the queue when the cap is raised", async () => {
    const ledger = newLedger();
    const { transport } = fakeTransport(GOOD, 0.95, 0.04);
    const reviewer = new JevReviewer({ ledger, transport, settings: { monthlyLimit: 0.1 } });
    await reviewer.reviewTest(TEST_INPUT); // 0.04
    await reviewer.reviewTest(TEST_INPUT); // 0.08 -> 80% warning
    const warnings = () => ledger.entries().filter((e) => e.type === "budget.warning").map((e) => e.data?.level);
    expect(warnings()).toEqual([80]);
    await reviewer.reviewTest(TEST_INPUT); // 0.12 -> 100% warning
    expect(warnings()).toEqual([80, 100]);
    const queued = await reviewer.reviewTest(TEST_INPUT);
    expect(queued.verdict).toBe("queued");
    expect(transport).toHaveBeenCalledTimes(3);
    expect(reviewer.queued()).toEqual(["Test review for T-1"]);

    reviewer.settings.monthlyLimit = 1;
    const results = await reviewer.retryQueued();
    expect(results.map((r) => r.verdict)).toEqual(["approve"]);
    expect(reviewer.spentThisMonth()).toBeCloseTo(0.16);
  });

  it("counts an estimated cost when Jev does not report one", async () => {
    const ledger = newLedger();
    const reviewer = new JevReviewer({ ledger, transport: fakeTransport(GOOD, 0.95, null).transport, settings: { estimatedCostPerCall: 0.02 } });
    const result = await reviewer.reviewTest(TEST_INPUT);
    expect(ledger.get(result.entry!)!.data).toMatchObject({ cost: 0.02, costEstimated: true });
  });
});

describe("questions the plan already settles", () => {
  it("answers a multiple-choice question when Jev is confident the plan decides it, and logs the call", async () => {
    const ledger = newLedger();
    const transport = async (r: JevRequest): Promise<JevCallResult> => {
      expect(r.state).toMatchObject({ plan: [{ ref: "P-1 §4.2", text: "Dates are ISO 8601." }] });
      return { ok: true, model: "jev-2026-09", cost: 0.01, status: 200, answers: { settled: { choice: "option_2", confidence: 0.92 } } };
    };
    const reviewer = new JevReviewer({ ledger, transport });
    reviewer.planClauses = () => [{ ref: "P-1 §4.2", text: "Dates are ISO 8601." }];
    const relay = new Relay({ ledger, settled: reviewer });
    const result = await relay.ask({ kind: "agent", id: "w1", model: "m" }, "owner", { task: "T-1", question: "Date format?", options: ["Locale", "ISO"] });
    expect(result).toMatchObject({ status: "answered", answer: "ISO", via: "settled" });
    expect(ledger.entries().map((e) => e.type)).toEqual(["question.asked", "review.verdict", "question.answered"]);
    expect(ledger.entries()[2]).toMatchObject({ actor: { kind: "system" }, refs: [ledger.entries()[1]!.n, "T-1"], data: { via: "settled", source: { kind: "jev", model: "jev-2026-09" } } });
    expect(relay.digest("owner").autoAnswered[0]).toContain("from the plan");
  });

  it("leaves the question for the main chat when Jev is unsure or the plan is silent", async () => {
    const ledger = newLedger();
    const transport = async (): Promise<JevCallResult> => ({ ok: true, model: "j", cost: 0.01, status: 200, answers: { settled: { choice: "option_1", confidence: 0.5 } } });
    const reviewer = new JevReviewer({ ledger, transport });
    reviewer.planClauses = () => [{ ref: "P-1 §1", text: "x" }];
    const relay = new Relay({ ledger, settled: reviewer });
    expect(await relay.ask({ kind: "agent", id: "w1", model: "m" }, "owner", { task: "T-1", question: "A or B?", options: ["A", "B"] })).toMatchObject({ status: "open" });
    expect(relay.digest("owner").open).toBe(1);
  });
});
