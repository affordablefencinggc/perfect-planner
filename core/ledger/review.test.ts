import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileStore,
  Ledger,
  LedgerError,
  MemoryStore,
  authorKind,
  hashEntry,
  isAuthoritative,
  verifyChain,
  type EntryDraft,
  type LedgerEntry, MemoryKeyProvider } from "./index";

/** One device's keys, shared by every open in this file. */
const keys = new MemoryKeyProvider();

// Regression tests for the independent review of PR #4 (2026-10-09).

const person = { kind: "person" as const, id: "owner" };
const agent = { kind: "agent" as const, id: "claude-code", model: "worker-model" };
const gate = { kind: "system" as const, id: "gate" };

function clock(start = "2026-10-09T02:00:00Z"): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
}

function draft(overrides: Partial<EntryDraft> = {}): EntryDraft {
  return { actor: person, type: "task.progress", subject: "T-1", summary: "Did a thing", ...overrides };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return "no error";
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-review-"));
  dirs.push(dir);
  return dir;
}

describe("decisions and approvals come only from a person or the system", () => {
  it("refuses decision.made from an agent", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { keys, now: clock() });
    expect(code(() => ledger.append(draft({ actor: agent, type: "decision.made", subject: "D-1", reason: "I decided" })))).toBe("NOT_PERMITTED");
  });

  it("refuses decision.made from Jev", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { keys, now: clock() });
    const jev = { kind: "jev" as const, id: "jev", model: "jev-latest" };
    expect(code(() => ledger.append(draft({ actor: jev, type: "decision.made", subject: "D-1", reason: "Jev decided" })))).toBe("NOT_PERMITTED");
  });

  it("does not let a rule swap the actor after the permission check", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { keys, now: clock() });
    const sneaky = draft({ actor: { ...person }, type: "decision.made", subject: "D-1", reason: "ok" });
    ledger.addRule((d) => {
      (d as { actor: unknown }).actor = { ...agent };
      return null;
    });
    // The draft a rule sees is frozen, so the swap throws and nothing is stored.
    expect(() => ledger.append(sneaky)).toThrow(TypeError);
    expect(ledger.entries()).toHaveLength(0);
  });

  it("exposes a verified author: authorKind and isAuthoritative read the checked actor, not data", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { keys, now: clock() });
    const byAgent = ledger.append(draft({ actor: agent, type: "question.answered", subject: "Q-1", data: { by: "person", confirmedBy: "owner" } }));
    const byPerson = ledger.append(draft({ type: "decision.made", subject: "D-1", reason: "Owner chose" }));
    const byGate = ledger.append(draft({ actor: gate, type: "task.progress" }));
    expect(authorKind(byAgent)).toBe("agent");
    expect(isAuthoritative(byAgent)).toBe(false);
    expect(isAuthoritative(byPerson)).toBe(true);
    expect(isAuthoritative(byGate)).toBe(true);
    expect(isAuthoritative(byPerson, { personOnly: true })).toBe(true);
    expect(isAuthoritative(byGate, { personOnly: true })).toBe(false);
  });

  it("flags a stored decision written by an agent as a broken ledger on open", () => {
    const store = new MemoryStore();
    const ledger = Ledger.openSync(store, { keys,
      now: clock(),
      permissions: { person: "any", system: "any", agent: ["decision.made"], jev: [] },
    });
    ledger.append(draft({ actor: agent, type: "decision.made", subject: "D-1", reason: "forged" }));
    ledger.close();
    const reopened = Ledger.openSync(store, { keys });
    expect(reopened.status).toMatchObject({ ok: false, brokenAt: "L-000001", problem: "permission" });
  });
});

describe("the chain cannot corrupt itself or reuse a number", () => {
  it("does not reuse an L-number after a deleted entry is acknowledged", () => {
    const store = new MemoryStore();
    const first = Ledger.openSync(store, { keys, now: clock() });
    for (let i = 0; i < 5; i += 1) first.append(draft({ summary: `Step ${i + 1}` }));
    first.close();
    store.lines.splice(2, 1); // delete L-000003
    const ledger = Ledger.openSync(store, { keys, now: clock("2026-10-09T03:00:00Z") });
    expect(ledger.status.ok).toBe(false);
    const ack = ledger.acknowledgeBreak(person, "Deleted by mistake, accepted");
    expect(ack.n).toBe("L-000006");
    const next = ledger.append(draft({ summary: "After" }));
    expect(next.n).toBe("L-000007");
    const numbers = ledger.entries().map((e) => e.n);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("stores exactly what it hashed, even for non-JSON values in data", () => {
    const store = new MemoryStore();
    const ledger = Ledger.openSync(store, { keys, now: clock() });
    ledger.append(
      draft({
        data: {
          when: new Date("2026-10-09T00:00:00Z") as unknown as string,
          set: new Set([1, 2]) as unknown as string,
          nested: { skip: undefined, list: [1, undefined, 3] },
        },
      }),
    );
    ledger.append(draft({ summary: "next" }));
    ledger.close();
    const reopened = Ledger.openSync(store, { keys });
    expect(verifyChain(reopened.entries())).toEqual({ ok: true });
    expect(reopened.status.ok).toBe(true);
  });

  it("stops writing after a failed store write instead of reusing the number", () => {
    const store = new MemoryStore();
    const ledger = Ledger.openSync(store, { keys, now: clock() });
    ledger.append(draft());
    const realAppend = store.append.bind(store);
    store.append = (entry: LedgerEntry) => {
      realAppend(entry); // the line reaches disk...
      throw new Error("disk full while writing HEAD"); // ...but the write reports failure
    };
    expect(() => ledger.append(draft({ summary: "half written" }))).toThrow(/disk full.*reopen/);
    store.append = realAppend;
    expect(code(() => ledger.append(draft({ summary: "would reuse L-000002" })))).toBe("CHAIN_BROKEN");
    // a failed save is not tampering: the words must not say so (F5)
    expect(() => ledger.append(draft({ summary: "again" }))).toThrow(/disk full.*reopen/);
    expect(() => ledger.append(draft({ summary: "again" }))).not.toThrow(/fingerprint|acknowledge|tamper/);
    ledger.close();
    const reopened = Ledger.openSync(store, { keys });
    const numbers = reopened.entries().map((e) => e.n);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(reopened.status.ok).toBe(true);
  });

  it("keeps the entry when a subscriber throws", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { keys, now: clock() });
    ledger.subscribe(() => {
      throw new Error("view crashed");
    });
    const entry = ledger.append(draft());
    expect(entry.n).toBe("L-000001");
    expect(ledger.append(draft()).n).toBe("L-000002");
  });

  it("refuses to reuse a series number even without installNumberingRules", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { keys, now: clock() });
    ledger.append(draft({ type: "task.created", subject: "T-1" }));
    expect(code(() => ledger.append(draft({ type: "task.created", subject: "T-1" })))).toBe("RULE");
    expect(code(() => ledger.append(draft({ type: "task.created", subject: "T-01" })))).toBe("RULE");
    expect(code(() => ledger.append(draft({ type: "task.created", subject: "T-3" })))).toBe("RULE");
    expect(ledger.append(draft({ type: "task.created", subject: "T-2" })).subject).toBe("T-2");
    ledger.append(draft({ type: "decision.made", subject: "D-1", reason: "x" }));
    expect(code(() => ledger.append(draft({ type: "decision.made", subject: "D-1", reason: "again" })))).toBe("RULE");
  });

  it("stops a live writer whose files were changed underneath it", () => {
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root), { keys, now: clock() });
    ledger.append(draft());
    ledger.append(draft());
    // Another process (or a git pull) rewrites the ledger directory while this writer is open.
    const dir = path.join(root, ".perfect-planner", "ledger");
    const file = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
    const lines = fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n");
    fs.writeFileSync(path.join(dir, file), `${lines[0]}\n`);
    fs.writeFileSync(path.join(dir, "HEAD"), JSON.stringify({ n: "L-000001", hash: JSON.parse(lines[0]).hash }));
    expect(code(() => ledger.append(draft({ summary: "would fork the chain" })))).toBe("CHAIN_BROKEN");
    ledger.close();
  });
});

describe("second round: locking, acknowledgements and torn writes", () => {
  it("loads only after taking the lock, so a writer never appends from a stale list", () => {
    const root = tempRoot();
    const a = Ledger.openSync(new FileStore(root), { keys, now: clock() });
    a.append(draft());
    // B opens while A holds the lock: read-only, so it cannot append from what it loaded.
    const b = Ledger.openSync(new FileStore(root), { keys, now: clock() });
    expect(b.status.writable).toBe(false);
    a.append(draft());
    a.close();
    // A fresh writer after A closes sees both entries.
    const c = Ledger.openSync(new FileStore(root), { keys, now: clock("2026-10-09T05:00:00Z") });
    expect(c.entries()).toHaveLength(2);
    expect(c.append(draft()).n).toBe("L-000003");
    c.close();
    b.close();
  });

  it("treats a second edit of an acknowledged entry as a new break", () => {
    const store = new MemoryStore();
    const first = Ledger.openSync(store, { keys, now: clock() });
    for (let i = 0; i < 3; i += 1) first.append(draft({ summary: `Step ${i + 1}` }));
    first.close();
    const edit = (summary: string) => {
      const entry = JSON.parse(store.lines[1]);
      entry.summary = summary;
      store.lines[1] = JSON.stringify(entry);
    };
    edit("First edit");
    const second = Ledger.openSync(store, { keys, now: clock("2026-10-09T03:00:00Z") });
    second.acknowledgeBreak(person, "Seen and accepted");
    second.close();
    expect(Ledger.openSync(store, { keys }).status).toMatchObject({ ok: true, acknowledged: ["L-000002"] });
    edit("Second edit, changing what was acknowledged");
    expect(Ledger.openSync(store, { keys }).status).toMatchObject({ ok: false, brokenAt: "L-000002", problem: "hash" });
  });

  it("re-checks the rest of the chain after an acknowledgement", () => {
    const store = new MemoryStore();
    const first = Ledger.openSync(store, { keys, now: clock() });
    for (let i = 0; i < 5; i += 1) first.append(draft({ summary: `Step ${i + 1}` }));
    first.close();
    for (const index of [1, 3]) {
      const entry = JSON.parse(store.lines[index]);
      entry.summary = "edited";
      store.lines[index] = JSON.stringify(entry);
    }
    const ledger = Ledger.openSync(store, { keys, now: clock("2026-10-09T03:00:00Z") });
    expect(ledger.status.brokenAt).toBe("L-000002");
    ledger.acknowledgeBreak(person, "First one seen");
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000004" });
    expect(code(() => ledger.append(draft()))).toBe("CHAIN_BROKEN");
  });

  it("repairs a final line torn by a crash mid-write instead of staying read-only", () => {
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root), { keys, now: clock() });
    ledger.append(draft());
    ledger.append(draft());
    ledger.close();
    const dir = path.join(root, ".perfect-planner", "ledger");
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"))!);
    fs.appendFileSync(file, '{"n":"L-000003","at":"2026-10-09T02:0');
    const reopened = Ledger.openSync(new FileStore(root), { keys, now: clock("2026-10-09T04:00:00Z") });
    expect(reopened.status.ok).toBe(true);
    expect(reopened.status.repaired).toMatch(/dropped an incomplete final line/);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("torn-"))).toBe(true);
    // L-000003 is the system correction recording the repair.
    expect(reopened.append(draft()).n).toBe("L-000004");
    reopened.close();
    expect(Ledger.openSync(new FileStore(root), { keys, readOnly: true }).status.ok).toBe(true);
  });

  it("completes a final line that only lost its newline", () => {
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root), { keys, now: clock() });
    ledger.append(draft());
    ledger.close();
    const dir = path.join(root, ".perfect-planner", "ledger");
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"))!);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").trimEnd());
    const reopened = Ledger.openSync(new FileStore(root), { keys, now: clock("2026-10-09T04:00:00Z") });
    expect(reopened.status).toMatchObject({ ok: true, entries: 2 });
    expect(reopened.status.repaired).toMatch(/completed L-000001/);
    expect(reopened.append(draft()).n).toBe("L-000003");
    reopened.close();
  });

  it("does not let a stale-lock takeover remove a fresh lock", () => {
    const root = tempRoot();
    const dir = path.join(root, ".perfect-planner", "ledger");
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, ".writer.lock");
    // A lock from a dead process on this host.
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, host: os.hostname(), since: "2026-10-09T00:00:00Z" }));
    const store = new FileStore(root);
    const judged = fs.readFileSync(lock, "utf8");
    // Another process replaces the stale lock with its own fresh one before we move it aside.
    const fresh = JSON.stringify({ pid: process.ppid, host: os.hostname(), since: "2026-10-09T01:00:00Z" });
    fs.writeFileSync(lock, fresh);
    (store as unknown as { takeOverStaleLock(stale: string): void }).takeOverStaleLock(judged);
    expect(fs.readFileSync(lock, "utf8")).toBe(fresh);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".stale."))).toEqual([]);
  });

  it("only accepts canonical ledger numbers", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { keys, now: clock() });
    ledger.append(draft());
    expect(ledger.get("L-000001")).toBeDefined();
    expect(code(() => ledger.append(draft({ type: "correction", corrects: "L-0000001", reason: "typo" })))).toBe("BAD_CORRECTS");
  });
});

describe("third round: re-check findings", () => {
  it("pins the rewritten entry when acknowledging a prev break", () => {
    const store = new MemoryStore();
    const first = Ledger.openSync(store, { keys, now: clock() });
    for (let i = 0; i < 4; i += 1) first.append(draft({ summary: `Step ${i + 1}` }));
    first.close();
    const rewrite = (summary: string) => {
      const entry = JSON.parse(store.lines[1]) as LedgerEntry;
      entry.summary = summary;
      const { hash: _old, ...rest } = entry;
      store.lines[1] = JSON.stringify({ ...rest, hash: hashEntry(rest as LedgerEntry) });
    };
    rewrite("Rewritten with a fresh hash");
    const ledger = Ledger.openSync(store, { keys, now: clock("2026-10-09T03:00:00Z") });
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000003", problem: "prev" });
    ledger.acknowledgeBreak(person, "Seen");
    ledger.close();
    expect(Ledger.openSync(store, { keys }).status.ok).toBe(true);
    rewrite("Rewritten again after the acknowledgement");
    expect(Ledger.openSync(store, { keys }).status).toMatchObject({ ok: false, brokenAt: "L-000003" });
  });

  it("can acknowledge a break when HEAD is missing or stale", () => {
    const store = new MemoryStore();
    const first = Ledger.openSync(store, { keys, now: clock() });
    for (let i = 0; i < 3; i += 1) first.append(draft({ summary: `Step ${i + 1}` }));
    first.close();
    const entry = JSON.parse(store.lines[1]);
    entry.summary = "edited";
    store.lines[1] = JSON.stringify(entry);
    store.head = undefined;
    const ledger = Ledger.openSync(store, { keys, now: clock("2026-10-09T03:00:00Z") });
    expect(ledger.status.ok).toBe(false);
    expect(ledger.acknowledgeBreak(person, "Seen").type).toBe("chain.acknowledged");
    expect(ledger.append(draft()).n).toBe("L-000005");
  });

  it("records a torn-line repair in the ledger as a system correction", () => {
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root), { keys, now: clock() });
    ledger.append(draft());
    ledger.close();
    const dir = path.join(root, ".perfect-planner", "ledger");
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"))!);
    fs.appendFileSync(file, '{"n":"L-0000');
    const reopened = Ledger.openSync(new FileStore(root), { keys, now: clock("2026-10-09T04:00:00Z") });
    const record = reopened.last()!;
    expect(record).toMatchObject({ type: "correction", corrects: "L-000001", actor: { kind: "system" } });
    expect(record.summary).toMatch(/Repaired the ledger file/);
    reopened.close();
  });
});
