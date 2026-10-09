import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileStore,
  GENESIS_PREV,
  Ledger,
  LedgerError,
  MemoryKeyProvider,
  canonicalJson,
  hashEntry,
  isAuthoritative,
  type EntryDraft,
  type LedgerEntry,
} from "./index";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

// Review 2026-10-09, batch 2, cross-cutting: actor kind was caller-declared
// and entries unsigned, so a process with write access to the ledger files
// could rewrite an agent entry as a person, recompute every hash and HEAD,
// and the chain verified. Person and system entries are now signed.

const owner = { kind: "person" as const, id: "owner" };
const gate = { kind: "system" as const, id: "gate" };
const agent = { kind: "agent" as const, id: "claude-code", model: "claude-x" };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-forgery-"));
  roots.push(root);
  return root;
}

function clock(start = "2026-10-09T02:00:00Z"): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
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

/** A small project: the owner asks a question, the agent proposes an answer. */
function seed(root: string, keys: MemoryKeyProvider): void {
  const ledger = Ledger.openSync(new FileStore(root), { keys, now: clock() });
  ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Build the login page" });
  ledger.append({ actor: agent, type: "question.asked", subject: "Q-1", summary: "Use email or username?" });
  ledger.append({ actor: agent, type: "question.answered", subject: "Q-1", summary: "Email, says the agent" });
  ledger.append({ actor: agent, type: "task.progress", subject: "T-1", summary: "Form drafted" });
  ledger.close();
}

function ledgerFile(root: string): string {
  const dir = path.join(root, ".perfect-planner", "ledger");
  const file = fs.readdirSync(dir).find((name) => name.endsWith(".jsonl"))!;
  return path.join(dir, file);
}

/**
 * What the review did: edit the lines on disk, re-chain every entry with
 * fresh hashes and rewrite HEAD, so the fingerprint chain alone verifies.
 */
function forge(root: string, change: (entries: LedgerEntry[]) => void): void {
  const file = ledgerFile(root);
  const entries = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
  change(entries);
  let prev = GENESIS_PREV;
  for (const entry of entries) {
    entry.prev = prev;
    entry.hash = hashEntry(entry);
    prev = entry.hash;
  }
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const last = entries[entries.length - 1];
  fs.writeFileSync(path.join(root, ".perfect-planner", "ledger", "HEAD"), JSON.stringify({ n: last.n, hash: last.hash }));
}

function asPerson(entry: LedgerEntry): void {
  entry.actor = { ...owner };
}

describe("forged authority on disk", () => {
  it("fails the chain when an agent answer is rewritten as the owner's and every hash is recomputed", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    forge(root, (entries) => asPerson(entries[2]));

    const ledger = Ledger.openSync(new FileStore(root), { keys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000003", problem: "signature" });
    expect(isAuthoritative(ledger.get("L-000003")!)).toBe(false);
    // The genuine, signed owner entry still counts.
    expect(isAuthoritative(ledger.get("L-000001")!)).toBe(true);
  });

  it("fails when the forged entry is made a system (gate) entry instead", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    forge(root, (entries) => {
      entries[3].actor = { ...gate };
      entries[3].type = "test.passed";
    });
    const ledger = Ledger.openSync(new FileStore(root), { keys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000004", problem: "signature" });
    expect(isAuthoritative(ledger.get("L-000004")!)).toBe(false);
  });

  it("fails when the forger signs with a key of their own", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    const rogue = generateKeyPairSync("ed25519");
    forge(root, (entries) => {
      asPerson(entries[2]);
      const { hash: _h, sig: _s, ...rest } = entries[2] as LedgerEntry & { sig?: unknown };
      entries[2].sig = {
        key: "k-rogue",
        value: cryptoSign(null, Buffer.from(canonicalJson(rest)), rogue.privateKey).toString("base64"),
      };
    });
    const ledger = Ledger.openSync(new FileStore(root), { keys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000003", problem: "signature" });
  });

  it("fails when a real signature is copied from another owner entry", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    forge(root, (entries) => {
      asPerson(entries[2]);
      entries[2].sig = entries[0].sig;
    });
    const ledger = Ledger.openSync(new FileStore(root), { keys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000003", problem: "signature" });
  });

  it("fails when the owner's own signed entry is edited and re-hashed", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    forge(root, (entries) => {
      entries[0].summary = "Build the login page without tests";
    });
    const ledger = Ledger.openSync(new FileStore(root), { keys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000001", problem: "signature" });
  });

  it("ignores a forged key.trusted entry signed by a key nobody trusted", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    const rogue = new MemoryKeyProvider();
    rogue.createKey("person:owner");
    const rogueKey = rogue.trustedKeys()[0];
    forge(root, (entries) => {
      const trust = {
        n: "L-000005",
        at: "2026-10-09T03:00:00Z",
        actor: { ...owner },
        type: "key.trusted",
        subject: rogueKey.keyId,
        summary: "Trusted a new key",
        reason: "New laptop",
        evidence: [],
        refs: [],
        data: { ...rogueKey },
        prev: "",
        hash: "",
      } as unknown as LedgerEntry;
      const { hash: _h, ...unsigned } = trust;
      const signed = rogue.sign("person:owner", Buffer.from(canonicalJson(unsigned)));
      trust.sig = { key: signed.keyId, value: signed.signature };
      entries.push(trust);
      // Now an owner "answer" signed by the rogue key.
      asPerson(entries[2]);
      const { hash: _h2, sig: _s2, ...rest } = entries[2];
      const s = rogue.sign("person:owner", Buffer.from(canonicalJson(rest)));
      entries[2].sig = { key: s.keyId, value: s.signature };
    });
    const ledger = Ledger.openSync(new FileStore(root), { keys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000003", problem: "signature" });
  });
});

describe("acknowledging a forgery", () => {
  it("lets the owner acknowledge it to resume work, but the forged entry never counts", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    forge(root, (entries) => asPerson(entries[2]));
    const ledger = Ledger.openSync(new FileStore(root), { keys, now: clock("2026-10-09T04:00:00Z") });
    ledger.acknowledgeBreak(owner, "Seen: that answer was not mine");
    expect(ledger.status).toMatchObject({ ok: true, acknowledged: ["L-000003"] });
    expect(isAuthoritative(ledger.get("L-000003")!)).toBe(false);
    ledger.close();
  });

  it("does not accept an acknowledgement the forger wrote as the owner", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    forge(root, (entries) => asPerson(entries[2]));
    // Second pass: the forged entry is final now, so the fake acknowledgement pins it exactly.
    forge(root, (entries) => {
      entries.push({
        n: "L-000005",
        at: "2026-10-09T03:00:00Z",
        actor: { ...owner },
        type: "chain.acknowledged",
        subject: "L-000003",
        summary: "acknowledged",
        reason: "forged",
        evidence: [],
        refs: [],
        data: { firstBad: "L-000003", hash: entries[2].hash, content: hashEntry(entries[2]), pins: [], problem: "signature" },
        prev: "",
        hash: "",
      } as LedgerEntry);
    });
    const ledger = Ledger.openSync(new FileStore(root), { keys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, problem: "signature", acknowledged: [] });
    expect(isAuthoritative(ledger.get("L-000005")!)).toBe(false);
  });
});

describe("signing", () => {
  it("signs person and system entries, covers the signature with the hash, and leaves agent entries unsigned", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    const ledger = Ledger.openSync(new FileStore(root), { keys });
    expect(ledger.status.ok).toBe(true);
    const created = ledger.get("L-000001")!;
    expect(created.sig?.key).toMatch(/^k-[0-9a-f]{16}$/);
    expect(hashEntry(created)).toBe(created.hash);
    expect(ledger.get("L-000002")!.sig).toBeUndefined();
    expect(isAuthoritative(ledger.get("L-000002")!)).toBe(false);
    ledger.close();
  });

  it("refuses to write a person entry to a file ledger with no key provider, rather than storing it unsigned", () => {
    const root = tempRoot();
    const ledger = Ledger.openSync(new FileStore(root));
    const error = thrown(() => ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "x" }));
    expect(error.code).toBe("NOT_SIGNED");
    expect(ledger.entries()).toHaveLength(0);
    // Agents can still report.
    ledger.append({ actor: agent, type: "task.progress", subject: "T-1", summary: "Working" });
    ledger.close();
  });

  it("refuses when the key store is unavailable and says why", () => {
    const keys = new MemoryKeyProvider({ unavailable: "No keychain on this system" });
    const ledger = Ledger.openSync(new FileStore(tempRoot()), { keys });
    const error = thrown(() => ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "x" }));
    expect(error.code).toBe("NOT_SIGNED");
    expect(error.message).toContain("No keychain on this system");
    expect(ledger.entries()).toHaveLength(0);
  });

  it("cannot verify signatures without the trusted keys, and says so", () => {
    const root = tempRoot();
    seed(root, new MemoryKeyProvider());
    const ledger = Ledger.openSync(new FileStore(root), { readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000001", problem: "signature" });
    expect(ledger.status.detail).toContain("no trusted keys");
    expect(isAuthoritative(ledger.get("L-000001")!)).toBe(false);
  });

  it("does not treat a hand-built or re-parsed entry as authoritative", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    const ledger = Ledger.openSync(new FileStore(root), { keys, readOnly: true });
    const copy = JSON.parse(JSON.stringify(ledger.get("L-000001"))) as LedgerEntry;
    expect(isAuthoritative(ledger.get("L-000001")!)).toBe(true);
    expect(isAuthoritative(copy)).toBe(false);
  });

  it("keeps old entries valid after a key rotation", () => {
    const root = tempRoot();
    const keys = new MemoryKeyProvider();
    seed(root, keys);
    const before = keys.trustedKeys().find((k) => k.principal === "person:owner")!;
    keys.rotateKey("person:owner");
    const ledger = Ledger.openSync(new FileStore(root), { keys, now: clock("2026-10-09T05:00:00Z") });
    expect(ledger.status.ok).toBe(true);
    const entry = ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "Second task" });
    expect(entry.sig!.key).not.toBe(before.keyId);
    expect(isAuthoritative(ledger.get("L-000001")!)).toBe(true);
    expect(isAuthoritative(entry)).toBe(true);
    ledger.close();
  });

  it("recovers from a lost keychain: the person trusts their old key again with a new one", () => {
    const root = tempRoot();
    const lost = new MemoryKeyProvider();
    seed(root, lost);
    const oldKey = lost.trustedKeys().find((k) => k.principal === "person:owner")!;

    const fresh = new MemoryKeyProvider();
    fresh.createKey("person:owner");
    let ledger = Ledger.openSync(new FileStore(root), { keys: fresh, now: clock("2026-10-09T06:00:00Z") });
    expect(ledger.status).toMatchObject({ ok: false, problem: "signature" });
    // The app shows the old key's fingerprint; the owner confirms it was theirs.
    ledger.trustKey(owner, oldKey, "Reinstalled; this was my previous key (fingerprint checked)");
    expect(ledger.status.ok).toBe(true);
    ledger.close();

    ledger = Ledger.openSync(new FileStore(root), { keys: fresh, readOnly: true });
    expect(ledger.status.ok).toBe(true);
    expect(isAuthoritative(ledger.get("L-000001")!)).toBe(true);
  });

  it("refuses key.trusted from an agent and from append", () => {
    const keys = new MemoryKeyProvider();
    keys.createKey("person:owner");
    const key = keys.trustedKeys()[0];
    const ledger = Ledger.openSync(new FileStore(tempRoot()), { keys });
    const draft = { actor: agent, type: "key.trusted", subject: key.keyId, summary: "trust", reason: "x", data: { ...key } } as EntryDraft;
    expect(thrown(() => ledger.append(draft)).code).toBe("NOT_PERMITTED");
    expect(thrown(() => ledger.trustKey(agent as never, key, "x")).code).toBe("BAD_ACTOR");
  });
});
