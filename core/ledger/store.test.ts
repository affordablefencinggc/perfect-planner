import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore, Ledger, LedgerError, verifyChain, type EntryDraft, type LedgerEntry } from "./index";

const person = { kind: "person" as const, id: "owner" };
const times = [
  "2026-09-30T23:58:00Z",
  "2026-09-30T23:59:30Z",
  "2026-10-01T00:00:30Z",
  "2026-10-01T00:01:00Z",
];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-ledger-"));
  roots.push(root);
  return root;
}

function ledgerDir(root: string): string {
  return path.join(root, ".perfect-planner", "ledger");
}

function lockPath(root: string): string {
  return path.join(ledgerDir(root), ".writer.lock");
}

/** A clock that returns the given instants in order, then keeps returning the last one. */
function clockFrom(instants: string[]): () => Date {
  let i = 0;
  return () => new Date(instants[Math.min(i++, instants.length - 1)]);
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

function readLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
}

function writeFour(root: string): LedgerEntry[] {
  const ledger = Ledger.openSync(new FileStore(root), { now: clockFrom(times) });
  for (const summary of ["one", "two", "three", "four"]) ledger.append(draft({ summary }));
  const written = ledger.entries().map((entry) => ({ ...entry }));
  ledger.close();
  return written;
}

describe("FileStore layout", () => {
  it("writes each entry as one line in the file for the month of its at", () => {
    const root = tempRoot();
    writeFour(root);

    const files = fs.readdirSync(ledgerDir(root)).filter((name) => name.endsWith(".jsonl")).sort();
    expect(files).toEqual(["2026-09.jsonl", "2026-10.jsonl"]);

    const september = readLines(path.join(ledgerDir(root), "2026-09.jsonl")).map((line) => JSON.parse(line) as LedgerEntry);
    const october = readLines(path.join(ledgerDir(root), "2026-10.jsonl")).map((line) => JSON.parse(line) as LedgerEntry);
    expect(september.map((e) => [e.n, e.summary])).toEqual([
      ["L-000001", "one"],
      ["L-000002", "two"],
    ]);
    expect(october.map((e) => [e.n, e.summary])).toEqual([
      ["L-000003", "three"],
      ["L-000004", "four"],
    ]);
    expect(fs.readFileSync(path.join(ledgerDir(root), "2026-10.jsonl"), "utf8").endsWith("\n")).toBe(true);
  });

  it("writes the HEAD file with the last entry's number and hash", () => {
    const root = tempRoot();
    const written = writeFour(root);
    const head = JSON.parse(fs.readFileSync(path.join(ledgerDir(root), "HEAD"), "utf8"));
    expect(head).toEqual({ n: written[3].n, hash: written[3].hash });
  });

  it("removes the writer lock on close", () => {
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root), { now: clockFrom(times) });
    ledger.append(draft());
    expect(fs.existsSync(lockPath(root))).toBe(true);
    ledger.close();
    expect(fs.existsSync(lockPath(root))).toBe(false);
  });

  it("opens an empty project with no entries and a writer", () => {
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root));
    expect(ledger.status).toMatchObject({ ok: true, writable: true, entries: 0 });
    ledger.close();
  });
});

describe("FileStore reopening", () => {
  it("reads the entries back in order, and the chain verifies", () => {
    const root = tempRoot();
    const written = writeFour(root);

    const reopened = Ledger.openSync(new FileStore(root));
    expect(reopened.status).toMatchObject({ ok: true, writable: true, entries: 4, head: "L-000004" });
    expect(reopened.entries()).toEqual(written);
    expect(verifyChain(reopened.entries())).toEqual({ ok: true });
    reopened.close();
  });

  it("appends to the existing month file when a later session writes to it", () => {
    const root = tempRoot();
    writeFour(root);

    const ledger = Ledger.openSync(new FileStore(root), { now: clockFrom(["2026-10-01T00:05:00Z"]) });
    const entry = ledger.append(draft({ summary: "five" }));
    ledger.close();

    expect(entry.n).toBe("L-000005");
    expect(readLines(path.join(ledgerDir(root), "2026-10.jsonl"))).toHaveLength(3);
    expect(Ledger.openSync(new FileStore(root)).status).toMatchObject({ ok: true, entries: 5 });
  });
});

describe("FileStore writer lock", () => {
  it("a second open while the first holds the lock is not writable", () => {
    const root = tempRoot();
    const first = Ledger.openSync(new FileStore(root), { now: clockFrom(times) });
    first.append(draft({ summary: "from first" }));

    const second = Ledger.openSync(new FileStore(root));
    expect(second.status.writable).toBe(false);
    expect(second.entries().map((e) => e.summary)).toEqual(["from first"]);
    expect(thrown(() => second.append(draft())).code).toBe("READ_ONLY");

    second.close();
    expect(fs.existsSync(lockPath(root))).toBe(true);
    first.close();
  });

  it("after close() the lock is free and a new open is writable", () => {
    const root = tempRoot();
    const first = Ledger.openSync(new FileStore(root), { now: clockFrom(times) });
    first.append(draft());
    first.close();
    expect(first.status.writable).toBe(false);

    const next = Ledger.openSync(new FileStore(root), { now: clockFrom(["2026-10-01T00:09:00Z"]) });
    expect(next.status.writable).toBe(true);
    expect(next.append(draft({ summary: "later" })).n).toBe("L-000002");
    next.close();
  });

  it("takes over a lock left by a process on this host that no longer exists", () => {
    const root = tempRoot();
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    fs.writeFileSync(
      lockPath(root),
      JSON.stringify({ pid: 2147483646, host: os.hostname(), since: "2026-10-01T00:00:00Z" }),
    );

    const ledger = Ledger.openSync(new FileStore(root), { now: clockFrom(times) });
    expect(ledger.status.writable).toBe(true);
    ledger.append(draft());
    const lock = JSON.parse(fs.readFileSync(lockPath(root), "utf8"));
    expect(lock).toMatchObject({ pid: process.pid, host: os.hostname() });
    ledger.close();
    expect(fs.existsSync(lockPath(root))).toBe(false);
  });

  it("respects a lock held by a live process on this host", () => {
    const root = tempRoot();
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    fs.writeFileSync(lockPath(root), JSON.stringify({ pid: process.ppid, host: os.hostname(), since: "2026-10-01T00:00:00Z" }));

    const ledger = Ledger.openSync(new FileStore(root));
    expect(ledger.status.writable).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath(root), "utf8")).pid).toBe(process.ppid);
  });

  it("does not take over a lock from another host, even with a dead pid", () => {
    const root = tempRoot();
    fs.mkdirSync(ledgerDir(root), { recursive: true });
    fs.writeFileSync(
      lockPath(root),
      JSON.stringify({ pid: 2147483646, host: `${os.hostname()}-elsewhere`, since: "2026-10-01T00:00:00Z" }),
    );

    expect(Ledger.openSync(new FileStore(root)).status.writable).toBe(false);
  });
});

describe("FileStore tamper detection", () => {
  it("detects an edited line on disk when the ledger is reopened", () => {
    const root = tempRoot();
    writeFour(root);

    const file = path.join(ledgerDir(root), "2026-09.jsonl");
    const lines = readLines(file);
    const entry = JSON.parse(lines[1]) as LedgerEntry;
    entry.summary = "two, edited on disk";
    lines[1] = JSON.stringify(entry);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);

    const reopened = Ledger.openSync(new FileStore(root));
    expect(reopened.status).toMatchObject({ ok: false, brokenAt: "L-000002", problem: "hash", writable: true });
    expect(thrown(() => reopened.append(draft())).code).toBe("CHAIN_BROKEN");
  });
});

describe("fixed source bug", () => {
  it("a second Ledger on the same FileStore instance is not writable while the first holds the lock", () => {
    const root = tempRoot();
    const store = new FileStore(root);
    const first = Ledger.openSync(store, { now: clockFrom(times) });
    const second = Ledger.openSync(store);
    expect(second.status.writable).toBe(false);
    first.close();
    second.close();
  });
});
