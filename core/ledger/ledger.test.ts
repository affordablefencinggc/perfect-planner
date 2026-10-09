import { describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore, type EntryDraft } from "./index";

const person = { kind: "person" as const, id: "owner" };

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return { actor: person, type: "task.progress", subject: "T-1", summary: "Did a thing", ...overrides };
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
