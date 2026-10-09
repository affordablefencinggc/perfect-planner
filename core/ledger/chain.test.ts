import { describe, expect, it } from "vitest";
import {
  Ledger,
  MemoryStore,
  canonicalJson,
  hashEntry,
  verifyChain,
  verifyWithAcknowledgements,
  type ChainResult,
  type LedgerEntry,
} from "./index";

const person = { kind: "person" as const, id: "owner" };

/** Builds a real, intact chain of `count` entries and returns detached copies of them. */
function buildChain(count: number): LedgerEntry[] {
  let t = Date.parse("2026-10-09T02:00:00Z");
  const ledger = Ledger.openSync(new MemoryStore(), {
    now: () => {
      const at = new Date(t);
      t += 60_000;
      return at;
    },
  });
  for (let i = 1; i <= count; i += 1) {
    ledger.append({
      actor: person,
      type: "task.progress",
      subject: "T-1",
      summary: `Step ${i}`,
      evidence: [`file:step-${i}.ts`],
      refs: ["P-2 §3.1"],
    });
  }
  const copies = ledger.entries().map((entry) => JSON.parse(JSON.stringify(entry)) as LedgerEntry);
  ledger.close();
  return copies;
}

function breakOf(result: ChainResult): Extract<ChainResult, { ok: false }> {
  if (result.ok) throw new Error("expected the chain to break, but verifyChain passed");
  return result;
}

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    const value = { b: 1, a: { d: [{ z: 1, y: { q: 2, p: 3 } }], c: 4 } };
    expect(canonicalJson(value)).toBe('{"a":{"c":4,"d":[{"y":{"p":3,"q":2},"z":1}]},"b":1}');
  });

  it("drops undefined object properties and writes no whitespace", () => {
    expect(canonicalJson({ a: undefined, b: "x y", c: null, d: [1, 2] })).toBe('{"b":"x y","c":null,"d":[1,2]}');
  });

  it("gives the same text whatever order the keys were inserted in", () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("writes undefined array items as null, as JSON does", () => {
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("escapes strings exactly as JSON.stringify does", () => {
    expect(canonicalJson({ 'k"': "a\nb" })).toBe('{"k\\"":"a\\nb"}');
  });

  it("refuses non-finite numbers rather than hashing them", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });
});

describe("hashEntry", () => {
  it("ignores the hash field", () => {
    const [entry] = buildChain(1);
    expect(hashEntry({ ...entry, hash: "f".repeat(64) })).toBe(hashEntry(entry));
    expect(hashEntry(entry)).toBe(entry.hash);
  });

  it("is independent of the key order of data", () => {
    const [entry] = buildChain(1);
    expect(hashEntry({ ...entry, data: { b: 1, a: 2 } })).toBe(hashEntry({ ...entry, data: { a: 2, b: 1 } }));
  });

  it("changes when any other field changes", () => {
    const [entry] = buildChain(1);
    expect(hashEntry({ ...entry, summary: "other" })).not.toBe(hashEntry(entry));
  });
});

describe("verifyChain", () => {
  it("accepts an empty ledger and an intact chain", () => {
    expect(verifyChain([])).toEqual({ ok: true });
    expect(verifyChain(buildChain(5))).toEqual({ ok: true });
    expect(verifyWithAcknowledgements(buildChain(5))).toEqual({ result: { ok: true }, acknowledged: [] });
  });

  it("requires the first entry to chain from the genesis hash", () => {
    const entries = buildChain(3);
    entries[0].prev = "1".repeat(64);
    expect(breakOf(verifyChain(entries))).toMatchObject({ firstBad: "L-000001", problem: "prev" });
  });

  it("detects an edited summary as a hash problem on the edited entry", () => {
    const entries = buildChain(5);
    entries[1].summary = "Step two, quietly edited";
    const result = breakOf(verifyChain(entries));
    expect(result).toMatchObject({ firstBad: "L-000002", problem: "hash" });
    expect(result.detail).toContain("content changed");
  });

  it.each([
    ["actor", (e: LedgerEntry) => { e.actor.id = "someone-else"; }],
    ["evidence", (e: LedgerEntry) => { e.evidence.push("file:extra.ts"); }],
    ["refs", (e: LedgerEntry) => { e.refs = ["P-9"]; }],
    ["subject", (e: LedgerEntry) => { e.subject = "T-2"; }],
    ["at", (e: LedgerEntry) => { e.at = "2026-10-09T03:00:00Z"; }],
    ["reason", (e: LedgerEntry) => { e.reason = "added after the fact"; }],
    ["data", (e: LedgerEntry) => { e.data = { test: "npm test" }; }],
  ])("detects an edit to %s, which is covered by the hash", (_field, mutate) => {
    const entries = buildChain(4);
    mutate(entries[1]);
    expect(breakOf(verifyChain(entries))).toMatchObject({ firstBad: "L-000002", problem: "hash" });
  });

  it("detects an edit with a recomputed hash as a prev problem on the next entry", () => {
    const entries = buildChain(5);
    entries[1].summary = "Step two, edited and re-hashed";
    entries[1].hash = hashEntry(entries[1]);
    expect(breakOf(verifyChain(entries))).toMatchObject({ firstBad: "L-000003", problem: "prev" });
    expect(breakOf(verifyWithAcknowledgements(entries).result)).toMatchObject({ firstBad: "L-000003", problem: "prev" });
  });

  it("detects a deleted middle entry as a number problem at the first entry after the gap", () => {
    const entries = buildChain(5);
    entries.splice(2, 1);
    expect(breakOf(verifyChain(entries))).toMatchObject({ firstBad: "L-000004", problem: "number" });
  });

  it("detects reordered entries as a number problem", () => {
    const [a, b, c, d, e] = buildChain(5);
    const reordered = [a, c, b, d, e];
    expect(breakOf(verifyChain(reordered))).toMatchObject({ firstBad: "L-000003", problem: "number" });
  });

  it("detects an edit to the last entry", () => {
    const entries = buildChain(3);
    entries[2].summary = "Final step, edited";
    expect(breakOf(verifyChain(entries))).toMatchObject({ firstBad: "L-000003", problem: "hash" });
  });
});
