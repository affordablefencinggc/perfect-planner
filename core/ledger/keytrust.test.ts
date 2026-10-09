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
/** The owner key the app pinned for the project made by project(), passed to every open. */
let pinnedOwner: string | undefined;
const pin = () => (pinnedOwner ? { ownerKey: pinnedOwner } : {});
afterEach(() => {
  pinnedOwner = undefined;
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
  pinnedOwner = ownerKeys.createKey("person:owner").keyId;
  let ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, now: clock("2026-10-09T02:00:00Z") });
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
function appendSigned(root: string, keys: MemoryKeyProvider | undefined, actor: Actor, fields: Partial<LedgerEntry>): void {
  const dir = path.join(root, ".perfect-planner", "ledger");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith(".jsonl")) ?? "2026-10.jsonl");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  const last = lines.length ? (JSON.parse(lines[lines.length - 1]) as LedgerEntry) : { hash: GENESIS_PREV };
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
  if (keys) {
    const signed = keys.sign(principalOf(actor), signedBytes(entry));
    const pub = keys.trustedKeys().find((k) => k.keyId === signed.keyId)!.publicKey;
    entry.sig = { key: signed.keyId, value: signed.signature, pub };
  }
  const full = { ...entry, hash: hashEntry(entry) } as LedgerEntry;
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
  fs.writeFileSync(path.join(dir, "HEAD"), JSON.stringify({ n: full.n, hash: full.hash }));
}

describe("who may trust a key", () => {
  it("refuses a helper trusting a key in the owner's name", () => {
    const { root, helperKeys } = project();
    const fake = helperKeys.createKey("person:owner");
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: helperKeys, now: clock("2026-10-09T04:00:00Z") });
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
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000004", problem: "signature" });
    expect(isAuthoritative(ledger.get("L-000004")!)).toBe(false);
    // The helper's own key.trusted entry is genuinely theirs, but it trusts nothing.
    expect(isAuthoritative(ledger.get("L-000003")!)).toBe(true);
  });

  it("lets the owner enrol a helper, whose entries then count on the owner's device", () => {
    const { root, ownerKeys, helperKeys } = project();
    let ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: helperKeys, now: clock("2026-10-09T04:00:00Z") });
    ledger.append({ actor: helper, type: "decision.made", subject: "D-1", summary: "Use email login", reason: "Simpler" });
    ledger.close();
    ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, readOnly: true });
    expect(ledger.status.ok).toBe(true);
    expect(isAuthoritative(ledger.get("L-000003")!)).toBe(true);
  });

  it("does not let an enrolled helper enrol anyone else", () => {
    const { root, helperKeys } = project();
    const stranger = new MemoryKeyProvider().createKey("person:stranger");
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: helperKeys, now: clock("2026-10-09T04:00:00Z") });
    expect(thrown(() => ledger.trustKey(helper, stranger, "My friend")).code).toBe("NOT_PERMITTED");
  });

  it("lets a person trust another key of their own, such as a second device", () => {
    const { root, ownerKeys, helperKeys } = project();
    const laptop = new MemoryKeyProvider();
    laptop.createKey("person:helper");
    let ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: helperKeys, now: clock("2026-10-09T04:00:00Z") });
    ledger.trustKey(helper, keyOf(laptop, "person:helper"), "My laptop");
    ledger.close();
    laptop.pin(keyOf(ownerKeys, "person:owner"));
    ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: laptop, now: clock("2026-10-09T05:00:00Z") });
    expect(ledger.status.ok).toBe(true);
    const entry = ledger.append({ actor: helper, type: "decision.made", subject: "D-1", summary: "From the laptop", reason: "Travelling" });
    ledger.close();
    ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, readOnly: true });
    expect(ledger.status.ok).toBe(true);
    expect(isAuthoritative(ledger.get(entry.n)!)).toBe(true);
  });

  it("takes the owner from the first person entry, which a later entry cannot change", () => {
    const { root, ownerKeys } = project();
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, readOnly: true });
    expect(ledger.owner).toBe("person:owner");
    expect(ownerPrincipal(ledger.entries(), ownerKeys.trustedKeys(), pinnedOwner)).toBe("person:owner");
  });
});

describe("public keys in the ledger", () => {
  it("records the public key with every signature", () => {
    const { root, ownerKeys } = project();
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, readOnly: true });
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
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, readOnly: true });
    expect(ledger.status.ok).toBe(false);
  });

  it("recovers a lost keychain from the public key recorded in the ledger", () => {
    const { root } = project();
    const fresh = new MemoryKeyProvider();
    fresh.createKey("person:owner");
    let ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: fresh, now: clock("2026-10-09T06:00:00Z") });
    expect(ledger.status).toMatchObject({ ok: false, problem: "signature" });
    const old = recordedKeys(ledger.entries()).find((k) => k.principal === "person:owner")!;
    ledger.trustKey(owner, old, "Reinstalled; this was my previous key (fingerprint checked)");
    expect(ledger.status.ok).toBe(true);
    ledger.close();
    ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: fresh, readOnly: true });
    expect(isAuthoritative(ledger.get("L-000001")!)).toBe(true);
    // The helper's enrolment, signed by the old owner key, is honoured again too.
    expect(isAuthoritative(ledger.get("L-000002")!)).toBe(true);
  });
});

// Review 2026-10-09, batch 4, #4: the owner was whoever wrote the first person
// entry, signed or not, and a rotated-out key still signed new entries.
describe("the owner cannot be claimed from the file", () => {
  it("does not make a helper owner by writing the first person entry", () => {
    const root = tempRoot();
    const ownerKeys = new MemoryKeyProvider();
    const ownerKey = ownerKeys.createKey("person:owner");
    const helperKeys = new MemoryKeyProvider();
    let ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: helperKeys, now: clock("2026-10-09T02:00:00Z") });
    ledger.append({ actor: helper, type: "task.created", subject: "T-1", summary: "I start this project" });
    ledger.close();
    ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, ownerKey: ownerKey.keyId, readOnly: true });
    expect(ledger.owner).toBeUndefined();
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000001", problem: "signature" });
  });

  it("refuses, with the project's owner key set, a first person entry signed by anyone else", () => {
    const ownerKey = new MemoryKeyProvider().createKey("person:owner");
    const ledger = Ledger.openSync(new FileStore(tempRoot()), { keys: new MemoryKeyProvider(), ownerKey: ownerKey.keyId });
    expect(thrown(() => ledger.append({ actor: helper, type: "task.created", subject: "T-1", summary: "Mine now" })).code).toBe("NOT_PERMITTED");
    expect(ledger.entries()).toHaveLength(0);
  });

  it("rejects a ledger pre-created with an unsigned owner, and ignores what that 'owner' enrols", () => {
    const root = tempRoot();
    const mallory = { kind: "person" as const, id: "mallory" };
    const malloryKeys = new MemoryKeyProvider();
    const malloryKey = malloryKeys.createKey("person:mallory");
    appendSigned(root, undefined, mallory, { type: "task.created", subject: "T-1", summary: "Mallory's project" });
    appendSigned(root, malloryKeys, mallory, { type: "key.trusted", subject: malloryKey.keyId, summary: "trust", reason: "mine", data: { ...malloryKey } });
    appendSigned(root, malloryKeys, mallory, { type: "decision.made", subject: "D-1", summary: "Ship it", reason: "Owner says" });
    const ownerKeys = new MemoryKeyProvider();
    ownerKeys.createKey("person:owner");
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, readOnly: true });
    expect(ledger.owner).toBeUndefined();
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: "L-000001", problem: "signature" });
    expect(isAuthoritative(ledger.get("L-000003")!)).toBe(false);
  });

  it("will not let a helper relabel the owner's public key as their own", () => {
    const { root, ownerKeys, helperKeys } = project();
    const ownerKey = keyOf(ownerKeys, "person:owner");
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: helperKeys, now: clock("2026-10-09T04:00:00Z") });
    expect(thrown(() => ledger.trustKey(helper, { ...ownerKey, principal: "person:helper" }, "mine")).code).toBe("RULE");
    ledger.close();
    appendSigned(root, helperKeys, helper, {
      type: "key.trusted",
      subject: ownerKey.keyId,
      summary: "trust",
      reason: "mine",
      data: { ...ownerKey, principal: "person:helper" },
    });
    // The owner, after losing their keychain, can still recover their old key.
    const fresh = new MemoryKeyProvider();
    fresh.createKey("person:owner");
    const recovering = Ledger.openSync(new FileStore(root), { ...pin(), keys: fresh, now: clock("2026-10-09T06:00:00Z") });
    recovering.trustKey(owner, ownerKey, "Reinstalled; fingerprint checked");
    expect(isAuthoritative(recovering.get("L-000001")!)).toBe(true);
  });
});

describe("a retired key stops signing", () => {
  it("refuses entries a stolen, retired key signs after the retirement, and keeps the ones before", () => {
    const { root, ownerKeys } = project();
    const stolen = ownerKeys.copy();
    let ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, now: clock("2026-10-09T04:00:00Z") });
    const retire = ledger.rotateKey(owner, "Laptop stolen").retired;
    ledger.close();

    // The thief's own ledger refuses to write with it, even trusting the new key...
    stolen.pin(keyOf(ownerKeys, "person:owner"));
    ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: stolen, now: clock("2026-10-09T05:00:00Z") });
    expect(thrown(() => ledger.append({ actor: owner, type: "decision.made", subject: "D-1", summary: "x", reason: "y" })).code).toBe("NOT_SIGNED");
    ledger.close();
    // ...and an entry written straight to the file does not count.
    appendSigned(root, stolen, owner, { type: "decision.made", subject: "D-1", summary: "Ship without tests", reason: "Owner says" });
    ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, problem: "signature" });
    expect(ledger.status.detail).toContain(`retired at ${retire.n}`);
    expect(isAuthoritative(ledger.last()!)).toBe(false);
    expect(isAuthoritative(ledger.get("L-000001")!)).toBe(true);
  });

  it("lets only the key's own person or the owner retire it", () => {
    const { root, ownerKeys, helperKeys } = project();
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: helperKeys, now: clock("2026-10-09T04:00:00Z") });
    expect(thrown(() => ledger.retireKey(helper, keyOf(ownerKeys, "person:owner").keyId, "x")).code).toBe("NOT_PERMITTED");
    ledger.close();
    const asOwner = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, now: clock("2026-10-09T05:00:00Z") });
    asOwner.retireKey(owner, keyOf(helperKeys, "person:helper").keyId, "Helper left the project");
    expect(asOwner.status.ok).toBe(true);
  });
});

// Review 2026-10-09, batch 5, #4: whether a stolen, retired key still counted
// could depend on how many entries the ledger had (trust was recomputed until
// it stopped changing, and could flip between two answers), and a retirement
// written after the README's rotate-then-retire steps did not reach other
// devices, which did not trust the new key that signed it.
describe("retirement holds on every device, whatever the ledger's length", () => {
  /** Owner rotates on their device; the helper's device only ever pinned the old key. */
  function rotated() {
    const { root, ownerKeys, helperKeys } = project();
    const stolen = ownerKeys.copy();
    const oldKey = keyOf(ownerKeys, "person:owner");
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, now: clock("2026-10-09T04:00:00Z") });
    const { retired } = ledger.rotateKey(owner, "Laptop stolen");
    ledger.close();
    return { root, ownerKeys, helperKeys, stolen, oldKey, retired };
  }

  it("rotates by having the old key vouch for the new one before retiring it", () => {
    const { root, ownerKeys, oldKey, retired } = rotated();
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, readOnly: true });
    const enrol = ledger.get(`L-${String(Number(retired.n.slice(2)) - 1).padStart(6, "0")}`)!;
    expect(enrol).toMatchObject({ type: "key.trusted" });
    expect(enrol.sig!.key).toBe(oldKey.keyId);
    expect(retired.sig!.key).not.toBe(oldKey.keyId);
    expect(ledger.status.ok).toBe(true);
  });

  it("makes another device refuse what the stolen key signs after the retirement", () => {
    const { root, helperKeys, stolen } = rotated();
    appendSigned(root, stolen, owner, { type: "decision.made", subject: "D-1", summary: "Ship without tests", reason: "Owner says" });
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: helperKeys, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, problem: "signature" });
    expect(isAuthoritative(ledger.last()!)).toBe(false);
    expect(isAuthoritative(ledger.get("L-000001")!)).toBe(true);
    // The rotated-in key counts on the helper's device too.
    expect(ledger.entries().filter((e) => e.type.startsWith("key.")).every((e) => isAuthoritative(e))).toBe(true);
  });

  it.each([0, 1, 2, 3, 4, 5])("gives the same answer with %i extra entries, on both devices", (extra) => {
    const { root, ownerKeys, helperKeys, stolen, oldKey } = rotated();
    // The thief vouches for a key of their own with the stolen key, then retires the owner's new key with it.
    const thief = new MemoryKeyProvider();
    const thiefKey = thief.createKey("person:owner");
    const newKey = keyOf(ownerKeys, "person:owner");
    appendSigned(root, stolen, owner, { type: "key.trusted", subject: thiefKey.keyId, summary: "trust", reason: "mine", data: { ...thiefKey } });
    appendSigned(root, stolen, owner, { type: "key.retired", subject: newKey.keyId, summary: "retire", reason: "mine", data: { keyId: newKey.keyId } });
    for (let i = 0; i < extra; i += 1) appendSigned(root, undefined, { kind: "agent", id: "claude-code", model: "x" }, { summary: `pad ${i}` });
    appendSigned(root, thief, owner, { type: "decision.made", subject: "D-1", summary: "Ship without tests", reason: "Owner says" });
    for (const keys of [ownerKeys, helperKeys]) {
      const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys, readOnly: true });
      expect(isAuthoritative(ledger.last()!)).toBe(false);
      expect(ledger.entries().filter((e) => e.sig?.key === oldKey.keyId && e.type.startsWith("key.") && e.at === "2026-10-09T05:00:00Z").some((e) => isAuthoritative(e))).toBe(false);
      expect(ledger.status.ok).toBe(false);
    }
  });
});

// Review 2026-10-09, batch 5, #4: without ownerKey the owner fell back to the
// first verifiable writer, so a helper who wrote first became owner.
describe("no owner without the project's owner key", () => {
  it("makes nobody owner when the ledger is opened without ownerKey, so nobody can enrol another person", () => {
    const root = tempRoot();
    const helperKeys = new MemoryKeyProvider();
    helperKeys.createKey("person:helper");
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: helperKeys, now: clock("2026-10-09T02:00:00Z") });
    ledger.append({ actor: helper, type: "task.created", subject: "T-1", summary: "I wrote first" });
    expect(ledger.owner).toBeUndefined();
    expect(ledger.status.owner).toBeUndefined();
    const stranger = new MemoryKeyProvider().createKey("person:stranger");
    expect(thrown(() => ledger.trustKey(helper, stranger, "My friend")).code).toBe("NOT_PERMITTED");
    // Their own second device is still fine: that needs no owner.
    ledger.trustKey(helper, new MemoryKeyProvider().createKey("person:helper"), "My laptop");
    ledger.close();
  });

  it("names the owner only when the app pins the owner key", () => {
    const { root, ownerKeys } = project();
    const ownerKey = keyOf(ownerKeys, "person:owner").keyId;
    expect(Ledger.openSync(new FileStore(root), { ...pin(), ownerKey: undefined, keys: ownerKeys, readOnly: true }).owner).toBeUndefined();
    const pinned = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, ownerKey, readOnly: true });
    expect(pinned.owner).toBe("person:owner");
    expect(pinned.status.owner).toBe("person:owner");
    expect(pinned.ownerKeyPinned).toBe(true);
    expect(pinned.pinnedOwnerKey).toBe(ownerKey);
    const unpinned = Ledger.openSync(new FileStore(root), { keys: ownerKeys, readOnly: true });
    expect(unpinned.ownerKeyPinned).toBe(false);
    expect(unpinned.pinnedOwnerKey).toBeUndefined();
  });
});

// The reviewer's batch 5 sequence: retirement signed by a key rotated outside
// the ledger, then the thief vouches for that key with the stolen one.
describe("retiring with a key other devices cannot know", () => {
  it("refuses retireKey after a rotation done outside the ledger", () => {
    const { root, ownerKeys } = project();
    const oldKey = keyOf(ownerKeys, "person:owner");
    ownerKeys.rotateKey("person:owner");
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, now: clock("2026-10-09T04:00:00Z") });
    const error = thrown(() => ledger.retireKey(owner, oldKey.keyId, "Laptop stolen"));
    expect(error.code).toBe("RULE");
    expect(error.message).toContain("rotateKey");
  });

  it.each([5, 6, 7, 8])("refuses the thief's decisions on the helper's device at %i entries after rotateKey", (total) => {
    const { root, ownerKeys, helperKeys } = project();
    const stolen = ownerKeys.copy();
    const ledger = Ledger.openSync(new FileStore(root), { ...pin(), keys: ownerKeys, now: clock("2026-10-09T04:00:00Z") });
    ledger.rotateKey(owner, "Laptop stolen");
    ledger.close();
    const newKey = keyOf(ownerKeys, "person:owner");
    appendSigned(root, stolen, owner, { type: "key.trusted", subject: newKey.keyId, summary: "trust", reason: "mine", data: { ...newKey } });
    let count = 5;
    while (count < total) {
      appendSigned(root, stolen, owner, { type: "decision.made", subject: `D-${count}`, summary: "Ship without tests", reason: "Owner says" });
      count += 1;
    }
    appendSigned(root, stolen, owner, { type: "decision.made", subject: "D-99", summary: "Ship without tests", reason: "Owner says" });
    const view = Ledger.openSync(new FileStore(root), { ...pin(), keys: helperKeys, readOnly: true });
    expect(view.entries().filter((e) => e.type === "decision.made").some((e) => isAuthoritative(e))).toBe(false);
  });
});
