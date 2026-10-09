import { describe, expect, it } from "vitest";
import {
  Ledger,
  LedgerError,
  MemoryKeyProvider,
  MemoryStore,
  hashEntry,
  isAuthoritative,
  signedBytes,
  type LedgerEntry,
} from "./index";
import { deriveRecoveryKey, formatRecoveryCode, ownerChain, parseRecoveryCode, recoveryStatement } from "./recovery";

// specs/owner-key-recovery.md, option B, with the reviewer's six conditions
// (REVIEW-2026-10-09.md): a code shown once proves the history on a new
// computer, is tied to its project, is single-use and bound to the head the
// person confirmed, and the old computer is told it was replaced.

const owner = { kind: "person" as const, id: "owner" };
const helper = { kind: "person" as const, id: "helper" };
const agent = { kind: "agent" as const, id: "claude-code", model: "x" };

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

/** The owner's first computer: a project with a decision, a helper, and a recovery code. */
function project() {
  const keys = new MemoryKeyProvider({ autoCreate: false });
  const ownerKey = keys.createKey("person:owner").keyId;
  const store = new MemoryStore();
  const ledger = Ledger.openSync(store, { keys, ownerKey, now: clock("2026-10-09T01:00:00Z") });
  ledger.append({ actor: owner, type: "decision.made", subject: "D-1", summary: "Ship the ledger", reason: "Planned" });
  ledger.append({ actor: agent, type: "task.progress", subject: "T-1", summary: "Working" });
  const { code } = ledger.setRecoveryCode(owner, "Project created");
  ledger.close();
  return { keys, ownerKey, store, code };
}

/** A new computer with the same ledger lines and no owner key. */
function newComputer(store: MemoryStore) {
  const keys = new MemoryKeyProvider({ autoCreate: false });
  keys.createKey("person:owner");
  const copy = new MemoryStore([...store.load().entries]);
  return { keys, store: copy, ledger: Ledger.openSync(copy, { keys, now: clock("2026-10-09T05:00:00Z") }) };
}

function recover(ledger: Ledger, code: string) {
  const check = ledger.checkRecoveryCode(code);
  return ledger.recoverOwner(owner, code, { n: check.head.n, hash: check.head.hash }, "New PC; the old one died");
}

describe("owner recovery code", () => {
  it("restores ownership on a new computer, and the old history counts again", () => {
    const { store, code } = project();
    const pc = newComputer(store);
    expect(pc.ledger.status).toMatchObject({ ok: false, problem: "signature" });
    const check = pc.ledger.checkRecoveryCode(code);
    expect(check.owner).toBe("person:owner");
    expect(check.head).toMatchObject({ entries: 3, n: "L-000003" });
    const result = recover(pc.ledger, code);
    expect(pc.ledger.status).toMatchObject({ ok: true, owner: "person:owner" });
    expect(pc.ledger.pinnedOwnerKey).toBe(result.ownerKey);
    expect(isAuthoritative(pc.ledger.get("L-000001")!)).toBe(true);
    expect(result.code).not.toBe(code);
    pc.ledger.append({ actor: owner, type: "decision.made", subject: "D-2", summary: "Carry on", reason: "Recovered" });
    pc.ledger.close();
    // The app pins the new key; a later open checks out with it.
    const reopened = Ledger.openSync(pc.store, { keys: pc.keys, ownerKey: result.ownerKey, readOnly: true });
    expect(reopened.status).toMatchObject({ ok: true, owner: "person:owner" });
    expect(isAuthoritative(reopened.get("L-000001")!)).toBe(true);
    expect(isAuthoritative(reopened.bySubject("D-2")[0])).toBe(true);
  });

  it("does not open a whole-file forgery: the code only fits the project it was made for", () => {
    const { code } = project();
    // Same-user malware rewrites the ledger from scratch under its own key, with its own code.
    const forged = project();
    const pc = newComputer(forged.store);
    expect(thrown(() => pc.ledger.checkRecoveryCode(code)).message).toMatch(/does not open this project/);
    expect(thrown(() => recover(pc.ledger, code)).code).toBe("RULE");
    expect(pc.ledger.owner).toBeUndefined();
  });

  it("derives a different key for the same code in another project", () => {
    const secret = Buffer.alloc(16, 7);
    expect(deriveRecoveryKey(secret, "a".repeat(64)).keyId).not.toBe(deriveRecoveryKey(secret, "b".repeat(64)).keyId);
  });

  it("catches a typo with its check characters and never repeats the code", () => {
    const { store, code } = project();
    const pc = newComputer(store);
    const last = code.replace(/-/g, "").at(-3)!;
    const typo = code.replace(/.(?=-?..$)/, last === "7" ? "8" : "7");
    expect(typo).not.toBe(code);
    const error = thrown(() => pc.ledger.checkRecoveryCode(typo));
    expect(error.message).toMatch(/typo/);
    expect(error.message).not.toContain(code.slice(0, 9));
    expect(error.message).not.toContain(typo.slice(0, 9));
    // Case, spaces and look-alike letters do not matter.
    expect(pc.ledger.checkRecoveryCode(code.toLowerCase().replace(/-/g, " ")).owner).toBe("person:owner");
  });

  it("round-trips the code format", () => {
    const secret = Buffer.from("00ff10aa55cc33ee0123456789abcdef", "hex");
    const code = formatRecoveryCode(secret);
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(parseRecoveryCode(code).equals(secret)).toBe(true);
  });

  it("is single-use: the spent code no longer works, and a replayed recovery entry is not trusted", () => {
    const { store, code } = project();
    const pc = newComputer(store);
    recover(pc.ledger, code);
    expect(thrown(() => pc.ledger.checkRecoveryCode(code)).message).toMatch(/does not open this project/);
    // A thief with the spent code writes a second owner.recovered for their own key, by hand.
    const thief = new MemoryKeyProvider({ autoCreate: false });
    const thiefKey = thief.createKey("person:owner");
    const entries = [...pc.store.load().entries];
    const last = entries[entries.length - 1];
    const chain = ownerChain(entries)!;
    const secret = parseRecoveryCode(code);
    const spent = deriveRecoveryKey(secret, chain.genesis);
    const head = { n: last.n, hash: last.hash };
    const data = {
      genesis: chain.genesis,
      head,
      newKeyId: thiefKey.keyId,
      newPublicKey: thiefKey.publicKey,
      recoveryKeyId: spent.keyId,
      recoverySignature: spent.sign(recoveryStatement({ genesis: chain.genesis, head, newKeyId: thiefKey.keyId, recoveryKeyId: spent.keyId })),
    };
    const forged = handWritten(entries, thief, { type: "owner.recovered", subject: thiefKey.keyId, summary: "Mine", reason: "Stolen code", data });
    expect(ownerChain(forged)!.keys.map((k) => k.keyId)).not.toContain(thiefKey.keyId);
    const victim = Ledger.openSync(new MemoryStore(forged), { keys: pc.keys, ownerKey: pc.ledger.pinnedOwnerKey, readOnly: true });
    expect(victim.status).toMatchObject({ ok: false, problem: "signature", brokenAt: last.n.replace(/\d+$/, (d) => String(Number(d) + 1).padStart(d.length, "0")) });
  });

  it("never accepts a second recovery under the same code, even before a new code is set", () => {
    const { store, code } = project();
    const pc = newComputer(store);
    const result = recover(pc.ledger, code);
    // Drop the new code's entry, so the spent recovery key is the latest one the ledger set.
    const entries = pc.store.load().entries.filter((e) => e.n !== result.codeEntry.n);
    const thief = new MemoryKeyProvider({ autoCreate: false });
    const thiefKey = thief.createKey("person:owner");
    const forged = handWritten(entries, thief, recoveredFor(entries, code, thiefKey, entries[entries.length - 1]));
    expect(ownerChain(forged)!.keys.map((k) => k.keyId)).toEqual([...ownerChain(entries)!.keys.map((k) => k.keyId)]);
  });

  it("ignores a recovery signed for an earlier head and replayed later", () => {
    const { store, code } = project();
    const entries = store.load().entries;
    const thief = new MemoryKeyProvider({ autoCreate: false });
    const thiefKey = thief.createKey("person:owner");
    // The code's signature was made when L-000002 was the head; the ledger has moved on since.
    const stale = handWritten(entries, thief, recoveredFor(entries, code, thiefKey, entries[1]));
    expect(ownerChain(stale)!.keys).toHaveLength(1);
    // The same entry for the real head would be accepted, so the head is what made the difference.
    const fresh = handWritten(entries, thief, recoveredFor(entries, code, thiefKey, entries[entries.length - 1]));
    expect(ownerChain(fresh)!.keys).toHaveLength(2);
  });

  it("only accepts the latest code: a new code replaces the old one", () => {
    const { keys, ownerKey, store, code } = project();
    const ledger = Ledger.openSync(store, { keys, ownerKey });
    const { code: newer } = ledger.setRecoveryCode(owner, "Rotating the code");
    ledger.close();
    const pc = newComputer(store);
    expect(thrown(() => pc.ledger.checkRecoveryCode(code)).message).toMatch(/older code that was replaced/);
    expect(pc.ledger.checkRecoveryCode(newer).owner).toBe("person:owner");
  });

  it("binds the recovery to the head the person confirmed", () => {
    const { store, code } = project();
    const pc = newComputer(store);
    // The person confirmed an earlier head than the one on disk now (the file changed in between).
    const seen = pc.ledger.entries()[1];
    expect(thrown(() => pc.ledger.recoverOwner(owner, code, { n: seen.n, hash: seen.hash }, "New PC")).message).toMatch(/not the one that was confirmed/);
    expect(pc.ledger.owner).toBeUndefined();
  });

  it("shows a cut tail to the person instead of hiding it", () => {
    const { keys, ownerKey, store, code } = project();
    const ledger = Ledger.openSync(store, { keys, ownerKey });
    ledger.append({ actor: owner, type: "decision.made", subject: "D-2", summary: "Remove the helper", reason: "Left the team" });
    ledger.close();
    const full = store.load().entries;
    // Same-user malware keeps the genuine start and drops the last entry before the new PC sees it.
    const pc = newComputer(new MemoryStore(full.slice(0, -1)));
    const check = pc.ledger.checkRecoveryCode(code);
    expect(check.head.entries).toBe(full.length - 1);
    expect(check.head.summary).not.toBe("Remove the helper");
  });

  it("lets only the owner set a code, never an agent, and never through append", () => {
    const { keys, ownerKey, store } = project();
    keys.createKey("person:helper");
    const ledger = Ledger.openSync(store, { keys, ownerKey });
    expect(thrown(() => ledger.setRecoveryCode(helper, "Mine")).code).toBe("NOT_PERMITTED");
    expect(thrown(() => ledger.setRecoveryCode(agent as never, "Mine")).code).toBe("BAD_ACTOR");
    const data = { genesis: ledger.entries()[0].hash, recoveryKeyId: "k-0", recoveryPublicKey: "x" };
    expect(thrown(() => ledger.append({ actor: agent, type: "owner.recovery.set", subject: "k-0", summary: "x", reason: "x", data })).code).toBe("NOT_PERMITTED");
    expect(thrown(() => ledger.append({ actor: owner, type: "owner.recovery.set", subject: "k-0", summary: "x", reason: "x", data })).message).toMatch(/written only by setRecoveryCode/);
    expect(thrown(() => ledger.append({ actor: owner, type: "owner.recovered", subject: "k-0", summary: "x", reason: "x", data })).message).toMatch(/written only by setRecoveryCode or recoverOwner/);
  });

  it("refuses a code for someone who is not the owner", () => {
    const { store, code } = project();
    const pc = newComputer(store);
    pc.keys.createKey("person:helper");
    const check = pc.ledger.checkRecoveryCode(code);
    expect(thrown(() => pc.ledger.recoverOwner(helper, code, { n: check.head.n, hash: check.head.hash }, "Me")).code).toBe("NOT_PERMITTED");
  });

  it("tells the old computer it was replaced, and its owner key stops signing", () => {
    const { keys, ownerKey, store, code } = project();
    const pc = newComputer(store);
    const result = recover(pc.ledger, code);
    const old = Ledger.openSync(new MemoryStore([...pc.store.load().entries]), { keys, ownerKey });
    expect(old.status.ownerKeyReplaced).toEqual({ n: result.recovered.n, keyId: result.ownerKey });
    expect(old.status).toMatchObject({ ok: true, owner: "person:owner" });
    expect(isAuthoritative(old.get("L-000001")!)).toBe(true);
    const error = thrown(() => old.append({ actor: owner, type: "decision.made", subject: "D-2", summary: "Still mine", reason: "x" }));
    expect(error.code).toBe("NOT_SIGNED");
    expect(error.message).toMatch(/recovered on another computer/);
  });

  it("leaves no owner.recovered for an old key to vouch for after the handover", () => {
    const { keys, ownerKey, store, code } = project();
    const pc = newComputer(store);
    recover(pc.ledger, code);
    const entries = [...pc.store.load().entries];
    // The old key signs a decision after it was replaced, written by hand.
    const forged = handWritten(entries, keys, { type: "decision.made", subject: "D-9", summary: "Old key", reason: "x" });
    const ledger = Ledger.openSync(new MemoryStore(forged), { keys: pc.keys, ownerKey: pc.ledger.pinnedOwnerKey, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, problem: "signature" });
    expect(ledger.status.detail).toMatch(/retired/);
    expect(ownerKey).toBeDefined();
  });
});

/** Appends one owner-signed entry by hand, as malware with file access (and some key) would. */
function handWritten(entries: LedgerEntry[], keys: MemoryKeyProvider, draft: Pick<LedgerEntry, "type" | "subject" | "summary"> & Partial<LedgerEntry>): LedgerEntry[] {
  const last = entries[entries.length - 1];
  const n = `L-${String(Number(last.n.slice(2)) + 1).padStart(6, "0")}`;
  const unsigned = { n, at: "2026-10-09T09:00:00Z", actor: owner, evidence: [], refs: [], ...draft, prev: last.hash } as Omit<LedgerEntry, "hash">;
  const signed = keys.sign("person:owner", signedBytes(unsigned));
  const pub = keys.trustedKeys().find((k) => k.keyId === signed.keyId)!.publicKey;
  const entry = { ...unsigned, sig: { key: signed.keyId, value: signed.signature, pub } } as Omit<LedgerEntry, "hash">;
  return [...entries, { ...entry, hash: hashEntry(entry) } as LedgerEntry];
}

/** An owner.recovered draft for `newKey`, signed with the code's key for the given head. */
function recoveredFor(entries: LedgerEntry[], code: string, newKey: { keyId: string; publicKey: string }, headEntry: LedgerEntry) {
  const chain = ownerChain(entries)!;
  const key = deriveRecoveryKey(parseRecoveryCode(code), chain.genesis);
  const head = { n: headEntry.n, hash: headEntry.hash };
  const data = {
    genesis: chain.genesis,
    head,
    newKeyId: newKey.keyId,
    newPublicKey: newKey.publicKey,
    recoveryKeyId: key.keyId,
    recoverySignature: key.sign(recoveryStatement({ genesis: chain.genesis, head, newKeyId: newKey.keyId, recoveryKeyId: key.keyId })),
  };
  return { type: "owner.recovered" as const, subject: newKey.keyId, summary: "Recovered", reason: "x", data };
}
