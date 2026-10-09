import { describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore, hashEntry, type EntryDraft, type LedgerEntry } from "./index";

const person = { kind: "person" as const, id: "owner" };
const agent = { kind: "agent" as const, id: "claude-code", model: "claude-x" };

function clock(start = "2026-10-09T02:00:00Z"): () => Date {
  let t = Date.parse(start);
  return () => {
    const at = new Date(t);
    t += 1000;
    return at;
  };
}

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return { actor: person, type: "task.progress", subject: "T-1", summary: "Did a thing", ...overrides };
}

function thrown(fn: () => unknown): LedgerError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerError) return error;
    throw error;
  }
  throw new Error("expected a LedgerError, but the call succeeded");
}

/** Writes five entries to the store and releases the writer lock. */
function writeFive(store: MemoryStore): void {
  const ledger = Ledger.openSync(store, { now: clock() });
  for (let i = 1; i <= 5; i += 1) ledger.append(draft({ summary: `Step ${i}` }));
  ledger.close();
}

/** Edits one stored line the way a person with a text editor would. */
function tamper(store: MemoryStore, index: number, change: (entry: LedgerEntry) => void, rehash = false): void {
  const entry = JSON.parse(store.lines[index]) as LedgerEntry;
  change(entry);
  if (rehash) entry.hash = hashEntry(entry);
  store.lines[index] = JSON.stringify(entry);
}

describe("tamper flow", () => {
  it("detects an edited entry, refuses writes, and lets a person acknowledge the break", () => {
    const store = new MemoryStore();
    writeFive(store);
    tamper(store, 2, (e) => {
      e.summary = "Step three, rewritten";
    });

    const ledger = Ledger.openSync(store, { now: clock("2026-10-09T03:00:00Z") });
    expect(ledger.status).toMatchObject({ ok: false, writable: true, brokenAt: "L-000003", problem: "hash", acknowledged: [] });
    expect(thrown(() => ledger.append(draft())).code).toBe("CHAIN_BROKEN");

    expect(thrown(() => ledger.acknowledgeBreak(agent, "I will clear this myself")).code).toBe("BAD_ACTOR");
    expect(ledger.status.ok).toBe(false);

    const ack = ledger.acknowledgeBreak(person, "Owner compared the line with git history");
    expect(ack.type).toBe("chain.acknowledged");
    expect(ack.subject).toBe("L-000003");
    expect(ack.reason).toBe("Owner compared the line with git history");
    expect(ack.data).toMatchObject({ firstBad: "L-000003", problem: "hash" });
    expect(ledger.status).toMatchObject({ ok: true, acknowledged: ["L-000003"] });

    const after = ledger.append(draft({ summary: "Work resumes" }));
    expect(after.n).toBe("L-000007");
    ledger.close();

    const reopened = Ledger.openSync(store);
    expect(reopened.status).toMatchObject({ ok: true, writable: true, acknowledged: ["L-000003"], entries: 7 });
    reopened.close();

    tamper(store, 4, (e) => {
      e.summary = "Step five, rewritten too";
    });
    const again = Ledger.openSync(store);
    expect(again.status).toMatchObject({ ok: false, brokenAt: "L-000005", problem: "hash", acknowledged: ["L-000003"] });
    expect(thrown(() => again.append(draft())).code).toBe("CHAIN_BROKEN");
  });

  it("detects an edit made with a recomputed hash, at the next entry", () => {
    const store = new MemoryStore();
    writeFive(store);
    tamper(
      store,
      2,
      (e) => {
        e.summary = "Step three, re-hashed";
      },
      true,
    );
    const ledger = Ledger.openSync(store);
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000004", problem: "prev" });
  });

  it("detects an edit to the last entry even when its hash is recomputed, via the stored head", () => {
    const store = new MemoryStore();
    writeFive(store);
    tamper(
      store,
      4,
      (e) => {
        e.summary = "Last step, re-hashed";
      },
      true,
    );
    const ledger = Ledger.openSync(store);
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000005", problem: "hash" });
    expect(ledger.status.detail).toContain("rewritten after it was recorded");
  });

  it("detects a truncated tail, refuses acknowledgement, and clears once the lines are restored", () => {
    const store = new MemoryStore();
    writeFive(store);
    const lastLine = store.lines.pop() as string;

    const ledger = Ledger.openSync(store);
    expect(ledger.status).toMatchObject({ ok: false, writable: true, brokenAt: "L-000005", problem: "truncated", entries: 4 });
    expect(thrown(() => ledger.append(draft())).code).toBe("CHAIN_BROKEN");
    const refusal = thrown(() => ledger.acknowledgeBreak(person, "the tail is gone, accept it"));
    expect(refusal.code).toBe("RULE");
    expect(refusal.message).toContain("restore");
    ledger.close();

    store.lines.push(lastLine);
    expect(Ledger.openSync(store).status).toMatchObject({ ok: true, entries: 5 });
  });

  it.each([
    ["not JSON at all", "{not json"],
    ["a bare number", "42"],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
  ])("reports an unreadable line (%s) as a parse break", (_label, garbage) => {
    const store = new MemoryStore();
    writeFive(store);
    store.lines[3] = garbage;

    const ledger = Ledger.openSync(store);
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000004", problem: "parse" });
    expect(ledger.entries()).toHaveLength(3);
    expect(thrown(() => ledger.acknowledgeBreak(person, "unreadable line")).code).toBe("RULE");
    expect(thrown(() => ledger.append(draft())).code).toBe("CHAIN_BROKEN");
  });

  it("detects a deleted line in the middle as a number break", () => {
    const store = new MemoryStore();
    writeFive(store);
    store.lines.splice(1, 1);
    const ledger = Ledger.openSync(store);
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000003", problem: "number" });
  });
});

describe("acknowledgement rules", () => {
  it("needs a reason to acknowledge a break", () => {
    const store = new MemoryStore();
    writeFive(store);
    tamper(store, 2, (entry) => {
      entry.summary = "Edited";
    });
    const ledger = Ledger.openSync(store, { now: clock("2026-10-09T03:00:00Z") });
    expect(thrown(() => ledger.acknowledgeBreak(person, "  ")).code).toBe("EMPTY_FIELD");
    expect(ledger.status.ok).toBe(false);
  });

  it("ignores a chain.acknowledged written by anyone but a person", () => {
    const store = new MemoryStore();
    writeFive(store);
    // Forge an agent acknowledgement on disk for a break that does not exist yet.
    const ledger = Ledger.openSync(store, { now: clock("2026-10-09T03:00:00Z") });
    ledger.close();
    const last = JSON.parse(store.lines[4]) as LedgerEntry;
    const forged = { n: "L-000006", at: "2026-10-09T03:00:00Z", actor: agent, type: "chain.acknowledged", subject: "L-000003", summary: "Pre-acknowledged", reason: "pre", evidence: [], refs: [], data: { firstBad: "L-000003" }, prev: last.hash } as Omit<LedgerEntry, "hash">;
    const signed = { ...forged, hash: hashEntry(forged) } as LedgerEntry;
    store.lines.push(JSON.stringify(signed));
    store.head = { n: signed.n, hash: signed.hash };
    tamper(store, 2, (entry) => {
      entry.summary = "Edited";
    });
    const reopened = Ledger.openSync(store);
    expect(reopened.status).toMatchObject({ ok: false, brokenAt: "L-000003", acknowledged: [] });
  });
});
