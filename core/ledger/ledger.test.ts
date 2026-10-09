import { describe, expect, it } from "vitest";
import {
  ALLOCATING_TYPES,
  DEFAULT_PERMISSIONS,
  ENTRY_TYPES,
  Ledger,
  LedgerError,
  MemoryStore,
  REASON_REQUIRED_TYPES,
  type Actor,
  type EntryDraft,
  type EntryType,
  type LedgerEntry,
  MemoryKeyProvider,
} from "./index";

const person = { kind: "person" as const, id: "owner" };
const agent = { kind: "agent" as const, id: "claude-code", model: "claude-x" };

/** A clock that starts at `start` and moves forward `stepMs` on every call. */
function clock(start = "2026-10-09T02:00:00Z", stepMs = 1000): () => Date {
  let t = Date.parse(start);
  return () => {
    const at = new Date(t);
    t += stepMs;
    return at;
  };
}

function open(store: MemoryStore = new MemoryStore(), now: () => Date = clock()): Ledger {
  return Ledger.openSync(store, { now });
}

/** Allocating types must take the next number in their series. */
function nextSubject(ledger: Ledger, type: EntryDraft["type"]): string {
  const seriesOf = (t: string) => Object.entries(ALLOCATING_TYPES).find(([, types]) => (types as readonly string[]).includes(t))?.[0];
  const series = seriesOf(type);
  if (!series) return "T-1";
  return `${series}-${ledger.entries().filter((e) => seriesOf(e.type) === series).length + 1}`;
}

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return { actor: person, type: "task.progress", subject: "T-1", summary: "Did a thing", ...overrides };
}

/** The LedgerError that fn throws; fails the test if fn succeeds or throws anything else. */
function thrown(fn: () => unknown): LedgerError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerError) return error;
    throw error;
  }
  throw new Error("expected a LedgerError, but the call succeeded");
}

function defineAndApprove(ledger: Ledger, test = "npm test -- login.spec", subject = "T-1"): void {
  ledger.append(draft({ type: "test.defined", subject, summary: "Test defined", data: { test } }));
  ledger.append(draft({ type: "test.approved", subject, summary: "Test approved", data: { test } }));
}

function commit(ledger: Ledger, sha = "9f3c2e1", subject = "T-1"): LedgerEntry {
  return ledger.append(draft({ type: "commit.observed", subject, summary: `Commit ${sha}`, evidence: [`commit:${sha}`], data: { sha } }));
}

function passed(ledger: Ledger, test = "npm test -- login.spec", subject = "T-1"): LedgerEntry {
  return ledger.append(draft({ type: "test.passed", subject, summary: "Tests passed", data: { test } }));
}

function done(ledger: Ledger, subject = "T-1"): LedgerEntry {
  return ledger.append(draft({ type: "task.done", subject, summary: "Task finished" }));
}

describe("Ledger smoke", () => {
  it("numbers and chains entries", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T02:14:05.123Z") });
    const a = ledger.append(draft());
    const b = ledger.append(draft());
    expect(a.n).toBe("L-000001");
    expect(a.at).toBe("2026-10-09T02:14:05Z");
    expect(b.prev).toBe(a.hash);
    expect(() => ledger.append(draft({ summary: "TBD" }))).toThrow(LedgerError);
  });
});

describe("EMPTY_FIELD", () => {
  it.each(["", "   ", "\t\n", "TBD", "tbd", " Tbd "])("refuses summary %j", (summary) => {
    const ledger = open();
    expect(thrown(() => ledger.append(draft({ summary }))).code).toBe("EMPTY_FIELD");
    expect(ledger.entries()).toHaveLength(0);
  });

  it.each(["", "  "])("refuses subject %j", (subject) => {
    expect(thrown(() => open().append(draft({ subject }))).code).toBe("EMPTY_FIELD");
  });

  it.each(["", "TBD"])("refuses an empty reason %j on a type that does not need one", (reason) => {
    expect(thrown(() => open().append(draft({ reason }))).code).toBe("EMPTY_FIELD");
  });

  it("refuses an empty reason on a type that needs one, as EMPTY_FIELD rather than REASON_REQUIRED", () => {
    expect(thrown(() => open().append(draft({ type: "decision.made", reason: "" }))).code).toBe("EMPTY_FIELD");
  });

  it.each([
    ["refs", { refs: ["P-2 §3.1", ""] }],
    ["refs", { refs: [" "] }],
    ["evidence", { evidence: ["commit:9f3c2e1", ""] }],
    ["evidence", { evidence: ["TBD"] }],
  ])("refuses an empty string in %s: %j", (_field, overrides) => {
    expect(thrown(() => open().append(draft(overrides))).code).toBe("EMPTY_FIELD");
  });

  it("stores the summary and reason trimmed", () => {
    const ledger = open();
    const entry = ledger.append(draft({ summary: "  Did it  ", type: "decision.made", subject: "D-1", reason: "  because  " }));
    expect(entry.summary).toBe("Did it");
    expect(entry.reason).toBe("because");
  });
});

describe("REASON_REQUIRED", () => {
  it("lists the types the README names", () => {
    expect([...REASON_REQUIRED_TYPES].sort()).toEqual(
      [
        "chain.acknowledged",
        "clause.changed",
        "clause.withdrawn",
        "correction",
        "decision.made",
        "release.rollback",
        "task.reopened",
        "key.trusted",
        "key.retired",
      ].sort(),
    );
  });

  // chain.acknowledged is written only by acknowledgeBreak; its reason check is covered in tamper.test.ts.
  it.each([...REASON_REQUIRED_TYPES].filter((type) => type !== "chain.acknowledged"))("refuses %s without a reason", (type) => {
    const ledger = open();
    ledger.append(draft({ summary: "seed" }));
    // corrects is supplied so that a correction is refused for its reason, not its target.
    const error = thrown(() => ledger.append(draft({ type, corrects: "L-000001", reason: undefined })));
    expect(error.code).toBe("REASON_REQUIRED");
  });

  it("accepts every reason-required type once a reason is given", () => {
    const ledger = open();
    ledger.append(draft({ summary: "seed" }));
    for (const type of REASON_REQUIRED_TYPES) {
      if (type === "chain.acknowledged") continue;
      expect(() => ledger.append(draft({ type, subject: nextSubject(ledger, type), reason: "Because the owner said so", corrects: "L-000001", ...keyPayload(type, ledger) }))).not.toThrow();
    }
  });
});

/** key.trusted names a real key and key.retired a key the ledger knows; other types need nothing extra. */
function keyPayload(type: string, ledger: Ledger): Partial<EntryDraft> {
  if (type === "key.retired") {
    const key = ledger.entries().find((e) => e.sig)!.sig!.key;
    return { subject: key, data: { keyId: key } };
  }
  if (type !== "key.trusted") return {};
  // A second key of the writer's own: that needs no owner.
  const key = new MemoryKeyProvider().createKey("person:owner");
  return { subject: key.keyId, data: { ...key } };
}

describe("UNKNOWN_TYPE", () => {
  it.each(["task.nope", "constructor", ""])("refuses type %j", (type) => {
    const error = thrown(() => open().append(draft({ type: type as EntryDraft["type"] })));
    expect(error.code).toBe("UNKNOWN_TYPE");
  });

  it("accepts every documented entry type except task.done, which has its own rule", () => {
    const ledger = open();
    ledger.append(draft({ summary: "seed" }));
    for (const type of ENTRY_TYPES) {
      if (type === "task.done" || type === "chain.acknowledged") continue;
      expect(() => ledger.append(draft({ type, subject: nextSubject(ledger, type), reason: "reason", corrects: "L-000001", data: { test: "npm test" }, ...keyPayload(type, ledger) }))).not.toThrow();
    }
  });
});

describe("BAD_ACTOR", () => {
  it("refuses an agent without a model", () => {
    expect(thrown(() => open().append(draft({ actor: { kind: "agent", id: "claude-code" } }))).code).toBe("BAD_ACTOR");
  });

  it("refuses a jev without a model", () => {
    expect(thrown(() => open().append(draft({ actor: { kind: "jev", id: "jev" } }))).code).toBe("BAD_ACTOR");
  });

  it("refuses an agent whose model is blank", () => {
    expect(thrown(() => open().append(draft({ actor: { kind: "agent", id: "claude-code", model: "  " } }))).code).toBe("BAD_ACTOR");
  });

  it("refuses an unknown actor kind", () => {
    const actor = { kind: "robot", id: "x" } as unknown as Actor;
    expect(thrown(() => open().append(draft({ actor }))).code).toBe("BAD_ACTOR");
  });

  it("refuses a missing actor", () => {
    expect(thrown(() => open().append(draft({ actor: undefined as unknown as Actor }))).code).toBe("BAD_ACTOR");
  });

  it("refuses an actor with an empty id", () => {
    expect(thrown(() => open().append(draft({ actor: { kind: "person", id: "" } }))).code).toBe("BAD_ACTOR");
  });

  it("accepts a person or system actor without a model, and an agent with one", () => {
    const ledger = open();
    expect(() => ledger.append(draft({ actor: { kind: "person", id: "owner" } }))).not.toThrow();
    expect(() => ledger.append(draft({ actor: { kind: "system", id: "watcher" } }))).not.toThrow();
    expect(() => ledger.append(draft({ actor: agent }))).not.toThrow();
  });

  it("does not store an undefined model on a person", () => {
    const entry = open().append(draft({ actor: { kind: "person", id: "owner" } }));
    expect("model" in entry.actor).toBe(false);
  });
});

describe("BAD_CORRECTS", () => {
  it("refuses a correction that names no entry", () => {
    const ledger = open();
    ledger.append(draft());
    expect(thrown(() => ledger.append(draft({ type: "correction", reason: "wrong number" }))).code).toBe("BAD_CORRECTS");
  });

  it("refuses to correct an entry that does not exist", () => {
    const ledger = open();
    ledger.append(draft());
    expect(thrown(() => ledger.append(draft({ corrects: "L-000999" }))).code).toBe("BAD_CORRECTS");
  });

  it("refuses an empty corrects reference", () => {
    const ledger = open();
    ledger.append(draft());
    expect(thrown(() => ledger.append(draft({ corrects: "" }))).code).toBe("BAD_CORRECTS");
  });

  it("refuses to correct the entry it is about to become", () => {
    const ledger = open();
    ledger.append(draft());
    expect(thrown(() => ledger.append(draft({ corrects: "L-000002" }))).code).toBe("BAD_CORRECTS");
  });

  it("accepts a correction of an earlier entry and keeps the reference", () => {
    const ledger = open();
    const wrong = ledger.append(draft({ summary: "Wrong count" }));
    const fixed = ledger.append(draft({ type: "correction", reason: "Miscounted", corrects: wrong.n, summary: "Right count" }));
    expect(fixed.corrects).toBe("L-000001");
    expect(ledger.get(fixed.corrects!)).toBe(wrong);
  });
});

describe("DONE_WITHOUT_PASS", () => {
  it("refuses task.done when the task has no approved test", () => {
    const ledger = open();
    ledger.append(draft({ type: "test.defined", summary: "Test defined", data: { test: "npm test" } }));
    commit(ledger);
    const error = thrown(() => done(ledger));
    expect(error.code).toBe("DONE_WITHOUT_PASS");
    expect(error.message).toContain("no approved test");
  });

  it("refuses task.done on a task with no history at all", () => {
    expect(thrown(() => done(open(), "T-9")).code).toBe("DONE_WITHOUT_PASS");
  });

  it("refuses task.done when the approved test never passed", () => {
    const ledger = open();
    defineAndApprove(ledger);
    commit(ledger);
    const error = thrown(() => done(ledger));
    expect(error.code).toBe("DONE_WITHOUT_PASS");
    expect(error.message).toContain("no passing run");
  });

  it("refuses task.done when the pass came before the last commit", () => {
    const ledger = open();
    defineAndApprove(ledger);
    passed(ledger);
    commit(ledger);
    expect(thrown(() => done(ledger)).code).toBe("DONE_WITHOUT_PASS");
  });

  it("refuses task.done when the pass was for a different test command", () => {
    const ledger = open();
    defineAndApprove(ledger, "npm test -- login.spec");
    commit(ledger);
    passed(ledger, "npm test -- signup.spec");
    expect(thrown(() => done(ledger)).code).toBe("DONE_WITHOUT_PASS");
  });

  it("refuses task.done when the pass came before a reopen", () => {
    const ledger = open();
    defineAndApprove(ledger);
    commit(ledger);
    passed(ledger);
    ledger.append(draft({ type: "task.reopened", reason: "Reviewer found a gap", summary: "Reopened" }));
    expect(thrown(() => done(ledger)).code).toBe("DONE_WITHOUT_PASS");
  });

  it("accepts task.done when the pass comes after a reopen", () => {
    const ledger = open();
    defineAndApprove(ledger);
    commit(ledger);
    ledger.append(draft({ type: "task.reopened", reason: "Reviewer found a gap", summary: "Reopened" }));
    commit(ledger, "a1b2c3d");
    passed(ledger);
    expect(done(ledger).type).toBe("task.done");
  });

  it("refuses task.done after a new approval for a different test, until that test passes", () => {
    const ledger = open();
    defineAndApprove(ledger, "npm test -- a.spec");
    commit(ledger);
    passed(ledger, "npm test -- a.spec");
    defineAndApprove(ledger, "npm test -- b.spec");
    expect(thrown(() => done(ledger)).code).toBe("DONE_WITHOUT_PASS");
    passed(ledger, "npm test -- b.spec");
    expect(done(ledger).type).toBe("task.done");
  });

  it("accepts the spec success path: defined, approved, commit, passed, done", () => {
    const ledger = open();
    ledger.append(draft({ type: "test.defined", subject: "T-14", summary: "Login test defined", data: { test: "npm test -- login.spec" } }));
    ledger.append(draft({ type: "test.approved", subject: "T-14", summary: "Login test approved", data: { test: "npm test -- login.spec" } }));
    commit(ledger, "9f3c2e1", "T-14");
    ledger.append(draft({ type: "test.passed", subject: "T-14", summary: "Login test passed", data: { test: "npm test -- login.spec" } }));
    const entry = ledger.append(draft({ type: "task.done", subject: "T-14", summary: "Login done" }));
    expect(entry.type).toBe("task.done");
    expect(ledger.status).toMatchObject({ ok: true, entries: 5, head: entry.n });
  });

  it("treats an attempt suffix as the same task: T-1.a2 counts as T-1", () => {
    const ledger = open();
    defineAndApprove(ledger, "npm test -- login.spec", "T-1");
    commit(ledger, "9f3c2e1", "T-1.a2");
    passed(ledger, "npm test -- login.spec", "T-1.a2");
    expect(done(ledger, "T-1.a2").subject).toBe("T-1.a2");
  });

  it("treats a bare task id as the same task as its attempts", () => {
    const ledger = open();
    defineAndApprove(ledger, "npm test -- login.spec", "T-1.a2");
    commit(ledger, "9f3c2e1", "T-1");
    passed(ledger, "npm test -- login.spec", "T-1");
    expect(done(ledger, "T-1").subject).toBe("T-1");
  });

  it("does not treat T-10 as T-1", () => {
    const ledger = open();
    defineAndApprove(ledger, "npm test -- login.spec", "T-1");
    commit(ledger, "9f3c2e1", "T-1");
    passed(ledger, "npm test -- login.spec", "T-1");
    expect(thrown(() => done(ledger, "T-10")).message).toContain("no approved test");
  });
});

describe("RULE", () => {
  it("refuses an entry a registered rule rejects, with the rule's message", () => {
    const ledger = open();
    ledger.addRule((d) => (d.summary.includes("forbidden") ? "no forbidden words" : null));
    const error = thrown(() => ledger.append(draft({ summary: "a forbidden thing" })));
    expect(error.code).toBe("RULE");
    expect(error.message).toBe("no forbidden words");
    expect(ledger.entries()).toHaveLength(0);
  });

  it("gives the rule the draft and the ledger, so gate rules can read history", () => {
    const ledger = open();
    ledger.addRule((d, l) =>
      d.type === "task.claimed" && l.bySubject(d.subject).every((e) => e.type !== "test.approved")
        ? "task.claimed needs test.approved"
        : null,
    );
    expect(thrown(() => ledger.append(draft({ type: "task.claimed", subject: "T-3", summary: "Claimed" }))).message).toBe(
      "task.claimed needs test.approved",
    );
    ledger.append(draft({ type: "test.defined", subject: "T-3", summary: "Defined", data: { test: "npm test" } }));
    ledger.append(draft({ type: "test.approved", subject: "T-3", summary: "Approved", data: { test: "npm test" } }));
    expect(() => ledger.append(draft({ type: "task.claimed", subject: "T-3", summary: "Claimed" }))).not.toThrow();
  });

  it("stops refusing once the returned unsubscribe function is called", () => {
    const ledger = open();
    const unsubscribe = ledger.addRule((d) => (d.summary.includes("forbidden") ? "no forbidden words" : null));
    expect(thrown(() => ledger.append(draft({ summary: "forbidden" }))).code).toBe("RULE");
    unsubscribe();
    expect(() => ledger.append(draft({ summary: "forbidden" }))).not.toThrow();
  });

  it("refuses when any one of several rules refuses", () => {
    const ledger = open();
    ledger.addRule(() => null);
    ledger.addRule(() => "second rule says no");
    expect(thrown(() => ledger.append(draft())).message).toBe("second rule says no");
  });

  it("runs after the built-in checks, so built-in errors still win", () => {
    const ledger = open();
    ledger.addRule(() => "always refuses");
    expect(thrown(() => ledger.append(draft({ summary: "" }))).code).toBe("EMPTY_FIELD");
  });
});

describe("READ_ONLY", () => {
  it("a readOnly open never takes the writer lock and refuses writes", () => {
    const store = new MemoryStore();
    const writer = open(store);
    writer.append(draft({ summary: "written by the writer" }));
    writer.close();
    const reader = Ledger.openSync(store, { readOnly: true });
    expect(reader.status).toMatchObject({ ok: true, writable: false, entries: 1 });
    expect(thrown(() => reader.append(draft())).code).toBe("READ_ONLY");
    expect(thrown(() => reader.acknowledgeBreak(person, "why")).code).toBe("READ_ONLY");
    reader.close();
    // The reader did not hold the lock, so a writer can still take it.
    expect(open(store).status.writable).toBe(true);
  });

  it("a second writer on the same store is read-only while the first holds the lock", () => {
    const store = new MemoryStore();
    const first = open(store);
    first.append(draft({ summary: "from first" }));

    const second = open(store);
    expect(second.status.writable).toBe(false);
    expect(second.entries().map((e) => e.summary)).toEqual(["from first"]);
    expect(thrown(() => second.append(draft())).code).toBe("READ_ONLY");

    first.close();
    expect(first.status.writable).toBe(false);
    expect(thrown(() => first.append(draft())).code).toBe("READ_ONLY");

    const third = open(store);
    expect(third.status.writable).toBe(true);
    expect(third.append(draft({ summary: "from third" })).n).toBe("L-000002");
  });
});

describe("subscribe", () => {
  it("calls the listener after each append, and stops after unsubscribe", () => {
    const ledger = open();
    const seen: string[] = [];
    const unsubscribe = ledger.subscribe((entry) => seen.push(entry.n));
    ledger.append(draft());
    ledger.append(draft());
    expect(seen).toEqual(["L-000001", "L-000002"]);
    unsubscribe();
    ledger.append(draft());
    expect(seen).toEqual(["L-000001", "L-000002"]);
  });

  it("is not called for a refused entry", () => {
    const ledger = open();
    let calls = 0;
    ledger.subscribe(() => {
      calls += 1;
    });
    expect(() => ledger.append(draft({ summary: "TBD" }))).toThrow(LedgerError);
    expect(calls).toBe(0);
  });
});

describe("entries", () => {
  it("are frozen once written", () => {
    const ledger = open();
    const entry = ledger.append(draft({ summary: "original" }));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Reflect.set(entry, "summary", "changed")).toBe(false);
    expect(Reflect.set(entry, "hash", "0".repeat(64))).toBe(false);
    expect(ledger.get(entry.n)?.summary).toBe("original");
  });

  it("do not share arrays or data with the caller's draft", () => {
    const ledger = open();
    const input = draft({ evidence: ["file:a.ts"], refs: ["P-2 §3.1"], data: { test: "npm test" } });
    const entry = ledger.append(input);
    input.evidence!.push("file:b.ts");
    (input.data as { test: string }).test = "changed";
    expect(entry.evidence).toEqual(["file:a.ts"]);
    expect(entry.data).toEqual({ test: "npm test" });
  });

  it("never go backwards in time when the clock does", () => {
    const times = ["2026-10-09T10:00:00.500Z", "2026-10-09T09:00:00Z", "2026-10-09T10:00:01Z"];
    let i = 0;
    const ledger = open(new MemoryStore(), () => new Date(times[i++]));
    const a = ledger.append(draft());
    const b = ledger.append(draft());
    const c = ledger.append(draft());
    expect(a.at).toBe("2026-10-09T10:00:00Z");
    expect(b.at).toBe("2026-10-09T10:00:00Z");
    expect(c.at).toBe("2026-10-09T10:00:01Z");
  });

  it("are numbered contiguously and chained by hash", () => {
    const ledger = open();
    for (let i = 0; i < 3; i += 1) ledger.append(draft({ summary: `step ${i}` }));
    const all = ledger.entries();
    expect(all.map((e) => e.n)).toEqual(["L-000001", "L-000002", "L-000003"]);
    expect(all[0].prev).toBe("0".repeat(64));
    expect(all[1].prev).toBe(all[0].hash);
    expect(all[2].prev).toBe(all[1].hash);
  });

  it("are reported by status with the head and count", () => {
    const ledger = open();
    expect(ledger.status).toEqual({ ok: true, writable: true, entries: 0, head: undefined, acknowledged: [] });
    const last = ledger.append(draft());
    expect(ledger.status).toMatchObject({ ok: true, writable: true, entries: 1, head: last.n });
  });

  it("can be read back through the async open", async () => {
    const store = new MemoryStore();
    open(store).append(draft({ summary: "earlier" }));
    const ledger = await Ledger.open(store);
    expect(ledger.entries().map((e) => e.summary)).toEqual(["earlier"]);
    expect(ledger.status.writable).toBe(false);
  });
});

describe("queries", () => {
  function fixture(): Ledger {
    const ledger = open();
    ledger.append(draft({ subject: "T-1", summary: "one" }));
    ledger.append(draft({ subject: "T-2", summary: "two" }));
    ledger.append(draft({ subject: "T-1", summary: "three" }));
    ledger.append(draft({ subject: "T-1", summary: "four" }));
    ledger.append(draft({ subject: "P-2", summary: "five" }));
    return ledger;
  }

  it("get returns the entry by number, or undefined", () => {
    const ledger = fixture();
    expect(ledger.get("L-000002")?.summary).toBe("two");
    expect(ledger.get("L-000099")).toBeUndefined();
  });

  it("last returns the newest entry, or undefined when empty", () => {
    expect(open().last()).toBeUndefined();
    expect(fixture().last()?.summary).toBe("five");
  });

  it("bySubject returns every entry about the subject, in order", () => {
    expect(fixture().bySubject("T-1").map((e) => e.summary)).toEqual(["one", "three", "four"]);
    expect(fixture().bySubject("T-99")).toEqual([]);
  });

  it("since returns entries strictly after the given number", () => {
    const ledger = fixture();
    expect(ledger.since("L-000002").map((e) => e.n)).toEqual(["L-000003", "L-000004", "L-000005"]);
    expect(ledger.since("L-000005")).toEqual([]);
    expect(ledger.since("L-000099")).toEqual([]);
  });

  it("range returns the inclusive span, and nothing for a bad span", () => {
    const ledger = fixture();
    expect(ledger.range("L-000002", "L-000004").map((e) => e.n)).toEqual(["L-000002", "L-000003", "L-000004"]);
    expect(ledger.range("L-000004", "L-000002")).toEqual([]);
    expect(ledger.range("L-000002", "L-000099")).toEqual([]);
    expect(ledger.range("L-000099", "L-000002")).toEqual([]);
  });
});

describe("fixed source bugs", () => {
  it("refuses chain.acknowledged written through append, even by an agent", () => {
    const ledger = open();
    ledger.append(draft({ summary: "seed" }));
    expect(() =>
      ledger.append(
        draft({
          actor: agent,
          type: "chain.acknowledged",
          subject: "L-000001",
          summary: "Pre-acknowledged",
          reason: "pre-approved",
          data: { firstBad: "L-000001", problem: "hash" },
        }),
      ),
    ).toThrow();
  });

  it("refuses test.approved for a test that was never defined", () => {
    const ledger = open();
    expect(() =>
      ledger.append(draft({ type: "test.approved", subject: "T-1", summary: "Approved", data: { test: "npm test -- ghost.spec" } })),
    ).toThrow();
  });
});

describe("latest run decides", () => {
  it("refuses task.done when the approved test failed after it passed", () => {
    const ledger = open();
    defineAndApprove(ledger);
    commit(ledger);
    passed(ledger);
    ledger.append(draft({ type: "test.failed", subject: "T-1", summary: "Login test failed", data: { test: "npm test -- login.spec" } }));
    expect(thrown(() => done(ledger)).code).toBe("DONE_WITHOUT_PASS");
    passed(ledger);
    expect(done(ledger).type).toBe("task.done");
  });

  it("deep-freezes stored entries", () => {
    const ledger = open();
    const entry = ledger.append(draft({ refs: ["P-1 §1"], data: { nested: { a: 1 } } }));
    expect(Object.isFrozen(entry.actor)).toBe(true);
    expect(Object.isFrozen(entry.refs)).toBe(true);
    expect(Object.isFrozen((entry.data as { nested: object }).nested)).toBe(true);
  });
});

describe("NOT_PERMITTED: who may write which entry types", () => {
  const jev = { kind: "jev" as const, id: "jev", model: "jev-latest" };
  const gate = { kind: "system" as const, id: "gate" };
  const agentOnly = new Set(DEFAULT_PERMISSIONS.agent === "any" ? [] : DEFAULT_PERMISSIONS.agent);
  const refusedToAgents = ENTRY_TYPES.filter((type) => !agentOnly.has(type) && type !== "chain.acknowledged");

  it.each(refusedToAgents)("refuses %s from an agent", (type) => {
    const error = thrown(() => open().append(draft({ actor: agent, type, reason: "because", data: { test: "npm test" } })));
    expect(error.code).toBe("NOT_PERMITTED");
    expect(error.message).toContain(`may not write ${type}`);
  });

  it("refuses approvals, test results and done from an agent even when they would otherwise pass", () => {
    const ledger = open();
    ledger.append(draft({ actor: agent, type: "test.defined", subject: "T-1", summary: "Proposed test", data: { test: "npm test" } }));
    expect(thrown(() => ledger.append(draft({ actor: agent, type: "test.approved", subject: "T-1", summary: "Approved", data: { test: "npm test" } }))).code).toBe("NOT_PERMITTED");
    ledger.append(draft({ type: "test.approved", subject: "T-1", summary: "Approved", data: { test: "npm test" } }));
    expect(thrown(() => ledger.append(draft({ actor: agent, type: "test.passed", subject: "T-1", summary: "Passed", data: { test: "npm test" } }))).code).toBe("NOT_PERMITTED");
    ledger.append(draft({ actor: gate, type: "test.passed", subject: "T-1", summary: "Passed", data: { test: "npm test" } }));
    expect(thrown(() => ledger.append(draft({ actor: agent, type: "task.done", subject: "T-1", summary: "Done" }))).code).toBe("NOT_PERMITTED");
    expect(ledger.append(draft({ actor: gate, type: "task.done", subject: "T-1", summary: "Done" })).type).toBe("task.done");
  });

  it("lets an agent claim, report, attach proof and ask or answer through the relay, but not decide", () => {
    const ledger = open();
    for (const type of ["task.claimed", "task.progress", "task.blocked", "task.proof", "question.asked", "question.answered"] as const) {
      expect(ledger.append(draft({ actor: agent, type, subject: type.startsWith("question.") ? "Q-1" : "T-1" })).type).toBe(type);
    }
    expect(thrown(() => ledger.append(draft({ actor: agent, type: "decision.made", subject: "D-1", reason: "Earlier decision D-1 answers it" }))).code).toBe("NOT_PERMITTED");
  });

  it("lets Jev record verdicts only", () => {
    const ledger = open();
    expect(ledger.append(draft({ actor: jev, type: "review.verdict", summary: "Approve" })).type).toBe("review.verdict");
    for (const type of ["test.approved", "test.passed", "task.done", "release.cut"] as const) {
      expect(thrown(() => ledger.append(draft({ actor: jev, type, data: { test: "npm test" } }))).code).toBe("NOT_PERMITTED");
    }
  });

  it("lets a person and the gate write anything the other rules allow", () => {
    const ledger = open();
    ledger.append(draft({ actor: gate, type: "test.defined", subject: "T-1", summary: "Defined", data: { test: "npm test" } }));
    expect(ledger.append(draft({ type: "test.approved", subject: "T-1", summary: "Approved", data: { test: "npm test" } })).actor.kind).toBe("person");
  });

  it("takes a custom permission table, e.g. to let an agent create tasks", () => {
    const ledger = Ledger.openSync(new MemoryStore(), {
      now: clock(),
      permissions: { ...DEFAULT_PERMISSIONS, agent: [...(DEFAULT_PERMISSIONS.agent as readonly EntryType[]), "task.created"] },
    });
    expect(ledger.append(draft({ actor: agent, type: "task.created" })).type).toBe("task.created");
    expect(thrown(() => ledger.append(draft({ actor: agent, type: "task.done" }))).code).toBe("NOT_PERMITTED");
  });
});
