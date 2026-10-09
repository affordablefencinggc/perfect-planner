import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileStore,
  Ledger,
  LedgerError,
  MemoryKeyProvider,
  hashEntry,
  isAuthoritative,
  ownerPrincipal,
  principalOf,
  recordedKeys,
  signedBytes,
  type Actor,
  type LedgerEntry,
} from "./index";

// Review 2026-10-09, batch 3, #4: any trusted person could trust a key for
// another principal. A helper made a key labelled person:owner, trusted it
// with their own key, and wrote decision.made as the owner; it was
// authoritative on the owner's device. Only the key's own person, or the
// ledger's owner (its first person), may now trust a key, and every signature
// records its public key in the ledger.

const owner = { kind: "person" as const, id: "owner" };
const helper = { kind: "person" as const, id: "helper" };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-keytrust-"));
  roots.push(root);
  return root;
}

function clock(start: string): () => Date {
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

function keyOf(keys: MemoryKeyProvider, principal: string) {
  return keys.trustedKeys().find((k) => k.principal === principal && !k.retired)!;
}

/** The owner starts the project and enrols the helper's key; the helper's device pins the owner's key. */
function project() {
  const root = tempRoot();
  const ownerKeys = new MemoryKeyProvider();
  const helperKeys = new MemoryKeyProvider();
  helperKeys.createKey("person:helper");
  let ledger = Ledger.openSync(new FileStore(root), { keys: ownerKeys, now: clock("2026-10-09T02:00:00Z") });
  ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Build the login page" });
  ledger.trustKey(owner, keyOf(helperKeys, "person:helper"), "Helper joined; fingerprint checked in person");
  ledger.close();
  helperKeys.pin(keyOf(ownerKeys, "person:owner"));
  return { root, ownerKeys, helperKeys };
}

/**
 * Appends a signed entry straight to the file, the way a person with their
 * own keys and a text editor could, skipping every write-time check.
 */
function appendSigned(root: string, keys: MemoryKeyProvider, actor: Actor, fields: Partial<LedgerEntry>): void {
  const dir = path.join(root, ".perfect-planner", "ledger");
  const file = path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith(".jsonl"))!);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]) as LedgerEntry;
  const n = `L-${String(lines.length + 1).padStart(6, "0")}`;
  const entry = {
    n,
    at: "2026-10-09T05:00:00Z",
    actor,
    type: "task.progress",
    subject: "T-1",
    summary: "x",
    evidence: [],
    refs: [],
    ...fields,
    prev: last.hash,
  } as Omit<LedgerEntry, "hash">;
  const principal = principalOf(actor);
  const signed = keys.sign(principal, signedBytes(entry));
  const pub = keys.trustedKeys().find((k) => k.keyId === signed.keyId)!.publicKey;
  entry.sig = { key: signed.keyId, value: signed.signature, pub };
  const full = { ...entry, hash: hashEntry(entry) } as LedgerEntry;
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
  fs.writeFileSync(path.join(dir, "HEAD"), JSON.stringify({ n: full.n, hash: full.hash }));
}

describe("who may trust a key", () => {
  it("refuses a helper trusting a key in the owner's name", () => {
    const { root, helperKeys } = project();
    const fake = helperKeys.createKey("person:owner");
    const ledger = Ledger.openSync(new FileStore(root), { keys: helperKeys, now: clock("2026-10-09T04:00:00Z") });
    expect(ledger.status.ok).toBe(true);
    expect(thrown(() => ledger.trustKey(helper, fake, "Owner asked me to")).code).toBe("NOT_PERMITTED");
    ledger.close();
  });

  it("ignores, on the owner's device, a helper's key.trusted for an owner key and the decision it signed", () => {
    const { root, ownerKeys, helperKeys } = project();
    const fake = helperKeys.createKey("person:owner");
    // Written straight to disk, past the write-time check.
    appendSigned(root, helperKeys, helper, {
      type: "key.trusted",
      subject: fake.keyId,
      summary: "Trusted a key",
      reason: "Owner asked me to",
      data: { ...fake },
    });
    appendSigned(root, helperKeys, owner, {
      type: "decision.made",
      subject: "D-1",
      summary: "Ship without tests",
      reason: "Owner decided",
    });
    const ledger = Ledger.openSync(new FileStore(root), { keys: ownerKeys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000004", problem: "signature" });
    expect(isAuthoritative(ledger.get("L-000004")!)).toBe(false);
    // The helper's own key.trusted entry is genuinely theirs, but it trusts nothing.
    expect(isAuthoritative(ledger.get("L-000003")!)).toBe(true);
  });

  it("lets the owner enrol a helper, whose entries then count on the owner's device", () => {
    const { root, ownerKeys, helperKeys } = project();
    let ledger = Ledger.openSync(new FileStore(root), { keys: helperKeys, now: clock("2026-10-09T04:00:00Z") });
    ledger.append({ actor: helper, type: "decision.made", subject: "D-1", summary: "Use email login", reason: "Simpler" });
    ledger.close();
    ledger = Ledger.openSync(new FileStore(root), { keys: ownerKeys, readOnly: true });
    expect(ledger.status.ok).toBe(true);
    expect(isAuthoritative(ledger.get("L-000003")!)).toBe(true);
  });

  it("does not let an enrolled helper enrol anyone else", () => {
    const { root, helperKeys } = project();
    const stranger = new MemoryKeyProvider().createKey("person:stranger");
    const ledger = Ledger.openSync(new FileStore(root), { keys: helperKeys, now: clock("2026-10-09T04:00:00Z") });
    expect(thrown(() => ledger.trustKey(helper, stranger, "My friend")).code).toBe("NOT_PERMITTED");
  });

  it("lets a person trust another key of their own, such as a second device", () => {
    const { root, ownerKeys, helperKeys } = project();
    const laptop = new MemoryKeyProvider();
    laptop.createKey("person:helper");
    let ledger = Ledger.openSync(new FileStore(root), { keys: helperKeys, now: clock("2026-10-09T04:00:00Z") });
    ledger.trustKey(helper, keyOf(laptop, "person:helper"), "My laptop");
    ledger.close();
    laptop.pin(keyOf(ownerKeys, "person:owner"));
    ledger = Ledger.openSync(new FileStore(root), { keys: laptop, now: clock("2026-10-09T05:00:00Z") });
    expect(ledger.status.ok).toBe(true);
    const entry = ledger.append({ actor: helper, type: "decision.made", subject: "D-1", summary: "From the laptop", reason: "Travelling" });
    ledger.close();
    ledger = Ledger.openSync(new FileStore(root), { keys: ownerKeys, readOnly: true });
    expect(ledger.status.ok).toBe(true);
    expect(isAuthoritative(ledger.get(entry.n)!)).toBe(true);
  });

  it("takes the owner from the first person entry, which a later entry cannot change", () => {
    const { root, ownerKeys } = project();
    const ledger = Ledger.openSync(new FileStore(root), { keys: ownerKeys, readOnly: true });
    expect(ownerPrincipal(ledger.entries())).toBe("person:owner");
  });
});

describe("public keys in the ledger", () => {
  it("records the public key with every signature", () => {
    const { root, ownerKeys } = project();
    const ledger = Ledger.openSync(new FileStore(root), { keys: ownerKeys, readOnly: true });
    const first = ledger.get("L-000001")!;
    expect(first.sig!.pub).toBe(keyOf(ownerKeys, "person:owner").publicKey);
    expect(recordedKeys(ledger.entries()).map((k) => k.keyId)).toContain(first.sig!.key);
  });

  it("fails a signature whose recorded public key does not match its key id", () => {
    const { root, ownerKeys } = project();
    const dir = path.join(root, ".perfect-planner", "ledger");
    const file = path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith(".jsonl"))!);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const first = JSON.parse(lines[0]) as LedgerEntry;
    first.sig = { ...first.sig!, pub: new MemoryKeyProvider().createKey("person:owner").publicKey };
    first.hash = hashEntry(first);
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const ledger = Ledger.openSync(new FileStore(root), { keys: ownerKeys, readOnly: true });
    expect(ledger.status.ok).toBe(false);
  });

  it("recovers a lost keychain from the public key recorded in the ledger", () => {
    const { root } = project();
    const fresh = new MemoryKeyProvider();
    fresh.createKey("person:owner");
    let ledger = Ledger.openSync(new FileStore(root), { keys: fresh, now: clock("2026-10-09T06:00:00Z") });
    expect(ledger.status).toMatchObject({ ok: false, problem: "signature" });
    const old = recordedKeys(ledger.entries()).find((k) => k.principal === "person:owner")!;
    ledger.trustKey(owner, old, "Reinstalled; this was my previous key (fingerprint checked)");
    expect(ledger.status.ok).toBe(true);
    ledger.close();
    ledger = Ledger.openSync(new FileStore(root), { keys: fresh, readOnly: true });
    expect(isAuthoritative(ledger.get("L-000001")!)).toBe(true);
    // The helper's enrolment, signed by the old owner key, is honoured again too.
    expect(isAuthoritative(ledger.get("L-000002")!)).toBe(true);
  });
});
