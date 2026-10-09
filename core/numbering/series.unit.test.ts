import { describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore } from "../ledger/index";
import {
  baseNumber,
  currentAttempt,
  formatNumber,
  highestNumber,
  nextNumber,
  parseNumber,
  taskLabel,
  type Series,
} from "./series";

const owner = { kind: "person" as const, id: "owner" };
const gate = { kind: "system" as const, id: "gate" };

function fresh(): Ledger {
  return Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T00:00:00Z") });
}

describe("parseNumber / formatNumber", () => {
  const series: Series[] = ["L", "P", "T", "Q", "D", "R"];
  const samples = [1, 7, 42, 1234];

  it.each(series)("round-trips every %s number", (s) => {
    for (const n of samples) {
      const text = formatNumber(s, n);
      const parsed = parseNumber(text);
      expect(parsed).toBeDefined();
      expect(parsed!.series).toBe(s);
      expect(parsed!.n).toBe(n);
      expect(formatNumber(parsed!.series, parsed!.n, parsed!.attempt)).toBe(text);
    }
  });

  it("formats L numbers with six digits minimum", () => {
    expect(formatNumber("L", 1)).toBe("L-000001");
    expect(formatNumber("L", 231)).toBe("L-000231");
    expect(formatNumber("L", 1234567)).toBe("L-1234567");
  });

  it("parses L numbers only with six or more digits", () => {
    expect(parseNumber("L-000012")).toEqual({ series: "L", n: 12 });
    expect(parseNumber("L-1234567")).toEqual({ series: "L", n: 1234567 });
    expect(parseNumber("L-12")).toBeUndefined();
    expect(parseNumber("L-00012")).toBeUndefined();
  });

  it("formats and parses task attempts", () => {
    expect(formatNumber("T", 14)).toBe("T-14");
    expect(formatNumber("T", 14, 1)).toBe("T-14");
    expect(formatNumber("T", 14, 2)).toBe("T-14.a2");
    expect(parseNumber("T-14.a2")).toEqual({ series: "T", n: 14, attempt: 2 });
    expect(parseNumber("T-14")).toEqual({ series: "T", n: 14, attempt: 1 });
  });

  it("refuses attempt suffixes on anything but tasks", () => {
    expect(parseNumber("P-1.a2")).toBeUndefined();
    expect(parseNumber("D-3.a2")).toBeUndefined();
    expect(formatNumber("P", 1, 2)).toBe("P-1");
  });

  it("rejects invalid numbers", () => {
    expect(parseNumber("T-0")).toBeUndefined();
    expect(parseNumber("X-1")).toBeUndefined();
    expect(parseNumber("hello")).toBeUndefined();
    expect(parseNumber("")).toBeUndefined();
    expect(parseNumber("T-14.a0")).toBeUndefined();
    expect(() => formatNumber("T", 0)).toThrow(RangeError);
    expect(() => formatNumber("P", -1)).toThrow(RangeError);
    expect(() => formatNumber("P", 1.5)).toThrow(RangeError);
  });

  it("tolerates surrounding whitespace on parse", () => {
    expect(parseNumber("  P-2 ")).toEqual({ series: "P", n: 2 });
  });
});

describe("baseNumber", () => {
  it("strips the attempt suffix only", () => {
    expect(baseNumber("T-14.a2")).toBe("T-14");
    expect(baseNumber("T-14")).toBe("T-14");
    expect(baseNumber("P-2")).toBe("P-2");
  });
});

describe("highestNumber / nextNumber", () => {
  it("starts at zero and hands out the first number", () => {
    const ledger = fresh();
    expect(highestNumber(ledger.entries(), "P")).toBe(0);
    expect(nextNumber(ledger.entries(), "P")).toBe("P-1");
    expect(nextNumber(ledger.entries(), "L")).toBe("L-000001");
  });

  it("counts entries for L and the highest subject for other series", () => {
    const ledger = fresh();
    ledger.append({ actor: owner, type: "plan.approved", subject: "P-1", summary: "plan one", evidence: [], refs: [] });
    ledger.append({ actor: owner, type: "plan.approved", subject: "P-2", summary: "plan two", evidence: [], refs: [] });
    ledger.append({ actor: gate, type: "task.created", subject: "T-1", summary: "first task", evidence: [], refs: [] });
    expect(highestNumber(ledger.entries(), "L")).toBe(3);
    expect(nextNumber(ledger.entries(), "L")).toBe("L-000004");
    expect(highestNumber(ledger.entries(), "P")).toBe(2);
    expect(nextNumber(ledger.entries(), "P")).toBe("P-3");
    expect(nextNumber(ledger.entries(), "T")).toBe("T-2");
    expect(nextNumber(ledger.entries(), "D")).toBe("D-1");
  });

  it("does not reuse a number after a correction of the entry that allocated it", () => {
    const ledger = fresh();
    const plan = ledger.append({ actor: owner, type: "plan.approved", subject: "P-1", summary: "plan one", evidence: [], refs: [] });
    ledger.append({ actor: owner, type: "plan.approved", subject: "P-2", summary: "plan two", evidence: [], refs: [] });
    ledger.append({
      actor: owner,
      type: "correction",
      subject: "P-2",
      summary: "P-2 was approved in error",
      reason: "wrong draft",
      evidence: [],
      refs: [],
      corrects: plan.n,
    });
    expect(highestNumber(ledger.entries(), "P")).toBe(2);
    expect(nextNumber(ledger.entries(), "P")).toBe("P-3");
  });

  it("ignores entries whose subject is not an allocated number of that series", () => {
    const ledger = fresh();
    ledger.append({ actor: owner, type: "test.defined", subject: "T-50", summary: "defined", data: { test: "npm test" }, evidence: [], refs: [] });
    ledger.append({ actor: owner, type: "question.asked", subject: "Q-3", summary: "a question", evidence: [], refs: [] });
    expect(highestNumber(ledger.entries(), "T")).toBe(0);
    expect(nextNumber(ledger.entries(), "Q")).toBe("Q-4");
  });
});

describe("task attempts", () => {
  function withTask(): Ledger {
    const ledger = fresh();
    ledger.append({ actor: gate, type: "task.created", subject: "T-14", summary: "login page", evidence: [], refs: [] });
    return ledger;
  }

  it("is attempt 1 until a task is reopened, then one more per reopen", () => {
    const ledger = withTask();
    expect(currentAttempt(ledger.entries(), "T-14")).toBe(1);
    expect(taskLabel(ledger.entries(), "T-14")).toBe("T-14");
    ledger.append({ actor: owner, type: "task.reopened", subject: "T-14", summary: "tests failed", reason: "login regressed", evidence: [], refs: [] });
    expect(currentAttempt(ledger.entries(), "T-14")).toBe(2);
    expect(taskLabel(ledger.entries(), "T-14")).toBe("T-14.a2");
    ledger.append({ actor: owner, type: "task.reopened", subject: "T-14", summary: "again", reason: "still broken", evidence: [], refs: [] });
    expect(taskLabel(ledger.entries(), "T-14")).toBe("T-14.a3");
  });

  it("accepts an attempt-suffixed task as input", () => {
    const ledger = withTask();
    ledger.append({ actor: owner, type: "task.reopened", subject: "T-14", summary: "retry", reason: "retry", evidence: [], refs: [] });
    expect(currentAttempt(ledger.entries(), "T-14.a2")).toBe(2);
    expect(taskLabel(ledger.entries(), "T-14.a2")).toBe("T-14.a2");
  });

  it("does not count reopens of other tasks", () => {
    const ledger = withTask();
    ledger.append({ actor: owner, type: "task.reopened", subject: "T-15", summary: "other task", reason: "other", evidence: [], refs: [] });
    expect(currentAttempt(ledger.entries(), "T-14")).toBe(1);
  });

  it("requires a reason to reopen a task", () => {
    const ledger = withTask();
    let caught: unknown;
    try {
      ledger.append({ actor: owner, type: "task.reopened", subject: "T-14", summary: "retry", evidence: [], refs: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerError);
    expect((caught as LedgerError).code).toBe("REASON_REQUIRED");
    expect(currentAttempt(ledger.entries(), "T-14")).toBe(1);
  });

  it("refuses taskLabel for a non-task number", () => {
    const ledger = fresh();
    expect(() => taskLabel(ledger.entries(), "P-1")).toThrow(RangeError);
    expect(() => taskLabel(ledger.entries(), "nonsense")).toThrow(RangeError);
  });
});
