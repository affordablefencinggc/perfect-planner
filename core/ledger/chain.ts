import { createHash } from "node:crypto";
import { GENESIS_PREV, type ChainResult, type LedgerEntry } from "./types";

/** JSON with sorted object keys, undefined dropped and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("canonicalJson: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Fingerprint of an entry: every field except hash, prev included. */
export function hashEntry(entry: Omit<LedgerEntry, "hash"> | LedgerEntry): string {
  const { hash: _ignored, ...rest } = entry as LedgerEntry;
  return sha256(canonicalJson(rest));
}

export function ledgerNumber(index: number): string {
  return `L-${String(index).padStart(6, "0")}`;
}

/**
 * Checks numbering, prev links and hashes from the first entry. Stops at the
 * first problem, because everything after a break is unanchored.
 */
export function verifyChain(entries: readonly LedgerEntry[]): ChainResult {
  return verifyFrom(entries, 0, GENESIS_PREV, 1);
}

/**
 * Like verifyChain, but a break named by a later chain.acknowledged entry is
 * accepted when the bad entry still has the hash the person acknowledged,
 * and checking re-anchors on that entry from there.
 */
export function verifyWithAcknowledgements(entries: readonly LedgerEntry[]): {
  result: ChainResult;
  acknowledged: string[];
} {
  const acknowledged: string[] = [];
  let start = 0;
  let prev = GENESIS_PREV;
  let number = 1;
  for (;;) {
    const result = verifyFrom(entries, start, prev, number);
    if (result.ok) return { result, acknowledged };
    const index = entries.findIndex((e, i) => i >= start && e.n === result.firstBad);
    // Only a person's acknowledgement counts, and only for the bytes they saw:
    // it records the bad entry's stored hash, so a later edit is a new break.
    const ackIndex = entries.findIndex(
      (e) =>
        e.type === "chain.acknowledged" &&
        e.actor?.kind === "person" &&
        e.data?.firstBad === result.firstBad &&
        index >= 0 &&
        acknowledgesExactly(e, entries[index], entries),
    );
    if (index < 0 || ackIndex <= index) return { result, acknowledged };
    acknowledged.push(result.firstBad);
    start = index + 1;
    prev = entries[index].hash;
    number = (parseLedgerNumber(entries[index].n) ?? number) + 1;
  }
}

/**
 * An acknowledgement pins both the bad entry's stored hash and the
 * fingerprint of its content as the person saw it, so any further edit to
 * that entry, of any field, is a new break.
 */
export function acknowledgesExactly(ack: LedgerEntry, bad: LedgerEntry, entries?: readonly LedgerEntry[]): boolean {
  if (ack.data?.hash !== bad.hash || ack.data?.content !== hashEntry(bad)) return false;
  // A "prev" break also pins the entry before it, which is the one that was rewritten.
  const pins = Array.isArray(ack.data?.pins) ? (ack.data.pins as { n?: unknown; hash?: unknown; content?: unknown }[]) : [];
  for (const pin of pins) {
    const pinned = entries?.find((e) => e.n === pin.n);
    if (!pinned || pinned.hash !== pin.hash || hashEntry(pinned) !== pin.content) return false;
  }
  return true;
}

export function parseLedgerNumber(n: string): number | undefined {
  const match = /^L-(\d{6,})$/.exec(n);
  if (match && match[1].length > 6 && match[1].startsWith("0")) return undefined;
  return match ? Number(match[1]) : undefined;
}

function verifyFrom(entries: readonly LedgerEntry[], start: number, startPrev: string, startNumber: number): ChainResult {
  let prev = startPrev;
  for (let i = start; i < entries.length; i += 1) {
    const entry = entries[i];
    const expected = ledgerNumber(startNumber + (i - start));
    if (entry.n !== expected) {
      return { ok: false, firstBad: entry.n || expected, problem: "number", detail: `expected ${expected}, found ${entry.n}` };
    }
    if (entry.prev !== prev) {
      return { ok: false, firstBad: entry.n, problem: "prev", detail: `prev does not match the fingerprint of ${i === 0 ? "the start" : entries[i - 1].n}` };
    }
    const actual = hashEntry(entry);
    if (entry.hash !== actual) {
      return { ok: false, firstBad: entry.n, problem: "hash", detail: `content changed since it was written (stored ${short(entry.hash)}, now ${short(actual)})` };
    }
    prev = entry.hash;
  }
  return { ok: true };
}

function short(hash: string): string {
  return String(hash).slice(0, 12);
}
