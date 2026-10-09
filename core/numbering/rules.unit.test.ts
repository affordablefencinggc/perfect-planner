import { describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore, type EntryDraft } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "./rules";

const owner = { kind: "person" as const, id: "owner" };
const agent = { kind: "agent" as const, id: "claude-code", model: "m1" };
const gate = { kind: "system" as const, id: "gate" };

function open(): Ledger {
  return Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T00:00:00Z") });
}

function refusalCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return undefined;
}

function taskCreated(subject: string, extra: Partial<EntryDraft> = {}): EntryDraft {
  return { actor: gate, type: "task.created", subject, summary: `task ${subject}`, evidence: [], refs: [], ...extra };
}

describe("installNumberingRules: task numbers", () => {
  it("refuses a task.created that skips a number", () => {
    const ledger = open();
    installNumberingRules(ledger);
    expect(refusalCode(() => ledger.append(taskCreated("T-2")))).toBe("RULE");
    expect(ledger.entries()).toHaveLength(0);
  });

  it("refuses a task.created that reuses a number", () => {
    const ledger = open();
    installNumberingRules(ledger);
    ledger.append(taskCreated("T-1"));
    expect(refusalCode(() => ledger.append(taskCreated("T-1")))).toBe("RULE");
    expect(() => ledger.append(taskCreated("T-1"))).toThrow(/must take the next T number, T-2/);
    expect(ledger.entries()).toHaveLength(1);
  });

  it("accepts the next task number", () => {
    const ledger = open();
    installNumberingRules(ledger);
    ledger.append(taskCreated("T-1"));
    expect(ledger.append(taskCreated("T-2")).subject).toBe("T-2");
  });

  it("fills in subjects with appendNumbered: T-1, then T-2", () => {
    const ledger = open();
    installNumberingRules(ledger);
    const first = appendNumbered(ledger, { actor: gate, type: "task.created", summary: "first", evidence: [], refs: [] });
    const second = appendNumbered(ledger, { actor: gate, type: "task.created", summary: "second", evidence: [], refs: [] });
    expect(first.subject).toBe("T-1");
    expect(second.subject).toBe("T-2");
  });

  it("refuses task.claimed for a task that was never created", () => {
    const ledger = open();
    installNumberingRules(ledger);
    const code = refusalCode(() =>
      ledger.append({ actor: agent, type: "task.claimed", subject: "T-99", summary: "claimed", evidence: [], refs: [] }),
    );
    expect(code).toBe("RULE");
    expect(() =>
      ledger.append({ actor: agent, type: "task.claimed", subject: "T-99", summary: "claimed", evidence: [], refs: [] }),
    ).toThrow(/T-99 was never created/);
  });

  it("accepts task.claimed for a created task on attempt 1", () => {
    const ledger = open();
    installNumberingRules(ledger);
    ledger.append(taskCreated("T-1"));
    expect(
      ledger.append({ actor: agent, type: "task.claimed", subject: "T-1", summary: "claimed", evidence: [], refs: [] }).subject,
    ).toBe("T-1");
  });

  it("refuses a wrong attempt suffix and accepts the right one after a reopen", () => {
    const ledger = open();
    installNumberingRules(ledger);
    ledger.append(taskCreated("T-1"));
    expect(
      refusalCode(() =>
        ledger.append({ actor: agent, type: "task.claimed", subject: "T-1.a2", summary: "claimed", evidence: [], refs: [] }),
      ),
    ).toBe("RULE");
    expect(() =>
      ledger.append({ actor: agent, type: "task.claimed", subject: "T-1.a2", summary: "claimed", evidence: [], refs: [] }),
    ).toThrow(/T-1 is on attempt 1, not 2/);

    ledger.append({ actor: owner, type: "task.reopened", subject: "T-1", summary: "retry", reason: "tests failed", evidence: [], refs: [] });
    expect(
      ledger.append({ actor: agent, type: "task.claimed", subject: "T-1.a2", summary: "claimed", evidence: [], refs: [] }).subject,
    ).toBe("T-1.a2");
    expect(
      refusalCode(() =>
        ledger.append({ actor: agent, type: "task.claimed", subject: "T-1.a3", summary: "claimed", evidence: [], refs: [] }),
      ),
    ).toBe("RULE");
  });
});

describe("installNumberingRules: decisions and questions", () => {
  it("refuses decision.made that answers a question nobody asked", () => {
    const ledger = open();
    installNumberingRules(ledger);
    const draft = {
      actor: owner,
      type: "decision.made" as const,
      subject: "D-1",
      summary: "Use SQLite",
      reason: "simplest",
      evidence: [],
      refs: [],
      data: { question: "Q-9" },
    };
    expect(refusalCode(() => ledger.append(draft))).toBe("RULE");
    expect(() => ledger.append(draft)).toThrow(/Q-9, which was never asked/);
  });

  it("accepts decision.made that answers an asked question", () => {
    const ledger = open();
    installNumberingRules(ledger);
    appendNumbered(ledger, { actor: agent, type: "question.asked", summary: "Which database?", evidence: [], refs: [] });
    const decision = appendNumbered(ledger, {
      actor: owner,
      type: "decision.made",
      summary: "Use SQLite",
      reason: "simplest",
      evidence: [],
      refs: [],
      data: { question: "Q-1" },
    });
    expect(decision.subject).toBe("D-1");
  });
});

describe("installNumberingRules: releases", () => {
  const cut = (version: string, extra: Partial<EntryDraft> = {}): EntryDraft => ({
    actor: owner,
    type: "release.cut",
    subject: "R-1",
    summary: "release",
    evidence: [],
    refs: [],
    data: { version, commit: "abc1234" },
    ...extra,
  });

  it("refuses a release whose version is not above the previous one", () => {
    const ledger = open();
    installNumberingRules(ledger);
    ledger.append(cut("v1.0.0"));
    const second = cut("v1.0.0", { subject: "R-2" });
    expect(refusalCode(() => ledger.append(second))).toBe("RULE");
    expect(() => ledger.append({ ...second, data: { version: "v0.9.0", commit: "abc1234" } })).toThrow(/must be above v1\.0\.0/);
    expect(ledger.entries()).toHaveLength(1);
  });

  it("refuses a rollback that does not name the release it restores", () => {
    const ledger = open();
    installNumberingRules(ledger);
    ledger.append(cut("v1.0.0"));
    const rollback: EntryDraft = {
      actor: owner,
      type: "release.rollback",
      subject: "R-2",
      summary: "rollback",
      reason: "bad deploy",
      evidence: [],
      refs: [],
      data: { version: "v1.0.1", commit: "abc1234" },
    };
    expect(refusalCode(() => ledger.append(rollback))).toBe("RULE");
    expect(() => ledger.append(rollback)).toThrow(/must name the release it restores/);
    expect(() => ledger.append({ ...rollback, data: { version: "v1.0.1", commit: "abc1234", restores: "R-9" } })).toThrow(
      /must name the release it restores/,
    );
  });

  it("accepts a rollback that names an existing release", () => {
    const ledger = open();
    installNumberingRules(ledger);
    ledger.append(cut("v1.0.0"));
    const entry = ledger.append({
      actor: owner,
      type: "release.rollback",
      subject: "R-2",
      summary: "rollback",
      reason: "bad deploy",
      evidence: [],
      refs: [],
      data: { version: "v1.0.1", commit: "abc1234", restores: "R-1" },
    });
    expect(entry.subject).toBe("R-2");
  });

  it("requires a commit on a release", () => {
    const ledger = open();
    installNumberingRules(ledger);
    expect(() => ledger.append(cut("v1.0.0", { data: { version: "v1.0.0" } }))).toThrow(/needs the commit/);
  });
});

describe("installNumberingRules: removal", () => {
  it("lifts the rules when the returned function is called", () => {
    const ledger = open();
    const remove = installNumberingRules(ledger);
    expect(refusalCode(() => ledger.append(taskCreated("T-5")))).toBe("RULE");
    remove();
    expect(ledger.append(taskCreated("T-5")).subject).toBe("T-5");
  });
});
