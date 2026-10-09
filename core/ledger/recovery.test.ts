import { describe, expect, it } from "vitest";
import {
  keyTrust,
  Ledger,
  LedgerError,
  MemoryKeyProvider,
  MemoryStore,
  hashEntry,
  isAuthoritative,
  recordedKeys,
  signedBytes,
  type LedgerEntry,
} from "./index";
import { deriveRecoveryKey, formatRecoveryCode, newRecoverySecret, ownerChain, parseRecoveryCode, recoveryStatement } from "./recovery";

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

  it("catches every single wrong character and every swap of neighbours, and never repeats the code", () => {
    const { store, code } = project();
    const pc = newComputer(store);
    const plain = code.replace(/-/g, "");
    for (let i = 0; i < plain.length; i += 1) {
      const wrong = plain[i] === "7" ? "8" : "7";
      const typo = plain.slice(0, i) + wrong + plain.slice(i + 1);
      const error = thrown(() => pc.ledger.checkRecoveryCode(typo));
      expect(error.message).toMatch(/typo|letters and digits/);
      expect(error.message).not.toContain(plain.slice(0, 8));
      if (i + 1 < plain.length && plain[i] !== plain[i + 1]) {
        const swapped = plain.slice(0, i) + plain[i + 1] + plain[i] + plain.slice(i + 2);
        expect(thrown(() => pc.ledger.checkRecoveryCode(swapped)).message).toMatch(/typo|letters and digits/);
      }
    }
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
    const spent = deriveRecoveryKey(secret, chain.root);
    const head = { n: last.n, hash: last.hash };
    const data = {
      root: chain.root,
      head,
      newKeyId: thiefKey.keyId,
      newPublicKey: thiefKey.publicKey,
      recoveryKeyId: spent.keyId,
      recoverySignature: spent.sign(recoveryStatement({ root: chain.root, head, newKeyId: thiefKey.keyId, recoveryKeyId: spent.keyId })),
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

// Review 2026-10-09 of #32 at 22a6d34 (HOLD): attacks A, C and D (high), B, E and F (medium).
describe("owner recovery after the review of 22a6d34", () => {
  /** The owner rotates their key on the first computer; a thief kept a copy of the old one. */
  function rotated() {
    const base = project();
    const stolen = base.keys.copy();
    const ledger = Ledger.openSync(base.store, { keys: base.keys, ownerKey: base.ownerKey });
    const { retired, recovery } = ledger.rotateKey(owner, "Laptop stolen");
    ledger.close();
    // The rotation voided the old code and showed a new one.
    return { ...base, stolen, retired, oldCode: base.code, code: recovery!.code };
  }

  it("A: a code does not validate a ledger rewritten after a kept non-person first entry", () => {
    const keys = new MemoryKeyProvider({ autoCreate: false });
    const ownerKey = keys.createKey("person:owner").keyId;
    const store = new MemoryStore();
    const ledger = Ledger.openSync(store, { keys, ownerKey, now: clock("2026-10-09T01:00:00Z") });
    ledger.append({ actor: agent, type: "task.progress", subject: "T-1", summary: "An agent wrote first" });
    ledger.append({ actor: owner, type: "decision.made", subject: "D-1", summary: "Real decision", reason: "Planned" });
    const { code } = ledger.setRecoveryCode(owner, "Project created");
    const real = ownerChain(ledger.entries())!.recovery!;
    // Keep the agent's first entry, rewrite the rest under the attacker's key, copy the real recovery key.
    const attacker = new MemoryKeyProvider({ autoCreate: false });
    attacker.createKey("person:owner");
    let forged = handWritten([ledger.entries()[0]], attacker, { type: "decision.made", subject: "D-1", summary: "Forged decision", reason: "x" });
    forged = handWritten(forged, attacker, {
      type: "owner.recovery.set",
      subject: real.keyId,
      summary: "copied",
      reason: "x",
      data: { root: ownerChain(forged)!.root, recoveryKeyId: real.keyId, recoveryPublicKey: real.publicKey },
    });
    expect(ownerChain(forged)!.recovery?.keyId).toBe(real.keyId);
    const pc = newComputer(new MemoryStore(forged));
    expect(thrown(() => pc.ledger.checkRecoveryCode(code)).message).toMatch(/does not open this project/);
  });

  it("C: a recovery never moves an earlier retirement later", () => {
    const { store, code, stolen, retired } = rotated();
    const pc = newComputer(store);
    const result = recover(pc.ledger, code);
    const oldKey = retired.data!.keyId as string;
    // The thief signs with the retired key, after the recovery.
    const forged = handWritten([...pc.store.load().entries], stolen, { type: "decision.made", subject: "D-9", summary: "Thief", reason: "x" });
    const trust = keyTrust(pc.keys.trustedKeys(), forged, { ownerKey: result.ownerKey });
    expect(trust.retired.get(oldKey)?.n).toBe(retired.n);
    const ledger = Ledger.openSync(new MemoryStore(forged), { keys: pc.keys, ownerKey: result.ownerKey, readOnly: true });
    expect(ledger.status).toMatchObject({ ok: false, problem: "signature", brokenAt: forged.at(-1)!.n });
    expect(isAuthoritative(forged.at(-1)!)).toBe(false);
  });

  it("D: a retired owner key cannot set its own recovery code and take the project", () => {
    const { keys, store, stolen } = rotated();
    let entries = [...store.load().entries];
    const chain = ownerChain(entries)!;
    const secret = newRecoverySecret();
    const thiefCode = formatRecoveryCode(secret);
    const theirs = deriveRecoveryKey(secret, chain.root);
    entries = handWritten(entries, stolen, {
      type: "owner.recovery.set",
      subject: theirs.keyId,
      summary: "Thief's code",
      reason: "x",
      data: { root: chain.root, recoveryKeyId: theirs.keyId, recoveryPublicKey: theirs.publicKey },
    });
    expect(ownerChain(entries)!.recovery?.keyId).not.toBe(theirs.keyId);
    const thiefPc = new MemoryKeyProvider({ autoCreate: false });
    const thiefKey = thiefPc.createKey("person:owner");
    entries = handWritten(entries, thiefPc, recoveredFor(entries, thiefCode, thiefKey, entries.at(-1)!, theirs.keyId));
    expect(ownerChain(entries)!.keys.map((k) => k.keyId)).not.toContain(thiefKey.keyId);
    // The owner's computer, pinned to its current key, does not see a recovery and refuses the entries.
    const current = keys.trustedKeys().find((k) => k.principal === "person:owner" && !k.retired)!.keyId;
    const ledger = Ledger.openSync(new MemoryStore(entries), { keys, ownerKey: current, readOnly: true });
    expect(ledger.status.ok).toBe(false);
    expect(ledger.status.ownerKeyReplaced).toBeUndefined();
  });

  it("B: the owner can set a new code after rotating their key", () => {
    const { keys, store } = rotated();
    const current = keys.trustedKeys().find((k) => k.principal === "person:owner" && !k.retired)!.keyId;
    const ledger = Ledger.openSync(store, { keys, ownerKey: current });
    const { code } = ledger.setRecoveryCode(owner, "After rotation");
    ledger.close();
    expect(newComputer(store).ledger.checkRecoveryCode(code).owner).toBe("person:owner");
  });

  it("E: a tamper the recovery cannot fix stops it before the code is spent", () => {
    const { store, code } = project();
    // Someone else's key signs an owner entry further on.
    const outsider = new MemoryKeyProvider({ autoCreate: false });
    outsider.createKey("person:owner");
    const tampered = handWritten([...store.load().entries], outsider, { type: "decision.made", subject: "D-5", summary: "Inserted", reason: "x" });
    const pc = newComputer(new MemoryStore(tampered));
    // Checking the code already says so (review LOW: it used to say the code opens the project).
    expect(thrown(() => pc.ledger.checkRecoveryCode(code)).message).toMatch(/code was not used/);
    const last = tampered.at(-1)!;
    const error = thrown(() => pc.ledger.recoverOwner(owner, code, { n: last.n, hash: last.hash }, "New PC"));
    expect(error.code).toBe("CHAIN_BROKEN");
    expect(error.message).toMatch(/code was not used/);
    expect(pc.ledger.entries()).toHaveLength(tampered.length);
    expect(ownerChain(pc.ledger.entries())!.recovery).toBeDefined();
  });

  it.each(["old pin", "current pin"])("F: a rotated first computer (%s) stops signing once another computer recovers", (which) => {
    const { keys, ownerKey, store, code } = rotated();
    const pc = newComputer(store);
    const result = recover(pc.ledger, code);
    const current = keys.trustedKeys().find((k) => k.principal === "person:owner" && !k.retired)!.keyId;
    const pin = which === "old pin" ? ownerKey : current;
    const old = Ledger.openSync(new MemoryStore([...pc.store.load().entries]), { keys, ownerKey: pin });
    expect(old.status.ownerKeyReplaced).toEqual({ n: result.recovered.n, keyId: result.ownerKey });
    expect(old.status.ownKeysRetired?.map((k) => k.keyId)).toEqual([current]);
    const error = thrown(() => old.append({ actor: owner, type: "decision.made", subject: "D-2", summary: "Still mine", reason: "x" }));
    expect(error.code).toBe("NOT_SIGNED");
    expect(error.message).toMatch(/recovered on another computer/);
  });
});

// Review of #32 at b3781aa (merge after fix): one HIGH, two MED, two LOW.
describe("owner recovery after the review of b3781aa", () => {
  it("HIGH: recovers a project whose gate and helper entries only the old computer could verify", () => {
    const keys = new MemoryKeyProvider({ autoCreate: false });
    const ownerKey = keys.createKey("person:owner").keyId;
    keys.createKey("system");
    keys.createKey("person:helper");
    const store = new MemoryStore();
    const ledger = Ledger.openSync(store, { keys, ownerKey, now: clock("2026-10-09T01:00:00Z") });
    ledger.append({ actor: owner, type: "decision.made", subject: "D-1", summary: "Ship it", reason: "Planned" });
    ledger.append({ actor: { kind: "system", id: "gate" }, type: "test.passed", subject: "T-1", summary: "Gate ran the tests", data: { test: "npm test" } });
    ledger.append({ actor: helper, type: "task.progress", subject: "T-1", summary: "Helper note" });
    const { code } = ledger.setRecoveryCode(owner, "Project created");
    ledger.close();
    const pc = newComputer(store);
    const result = recover(pc.ledger, code);
    expect(result.unverified).toEqual(["L-000002", "L-000003"]);
    expect(pc.ledger.owner).toBe("person:owner");
    expect(isAuthoritative(pc.ledger.get("L-000001")!)).toBe(true);
    expect(isAuthoritative(pc.ledger.get("L-000002")!)).toBe(false);
    // The owner then checks and trusts the old computer's gate key, and the ledger checks out again.
    const gate = recordedKeys(pc.ledger.entries()).find((k) => k.principal === "system")!;
    pc.ledger.trustKey(owner, gate, "The old computer's gate (fingerprint checked)");
    const helperKey = recordedKeys(pc.ledger.entries()).find((k) => k.principal === "person:helper")!;
    pc.ledger.trustKey(owner, helperKey, "The helper's key (fingerprint checked)");
    expect(pc.ledger.status.ok).toBe(true);
    expect(isAuthoritative(pc.ledger.get("L-000002")!)).toBe(true);
  });

  it("MED: a rotation retires a device key a thief added with the stolen key, so the thief cannot set a code", () => {
    const { keys, ownerKey, store } = project();
    const stolen = keys.copy();
    const thiefDevice = new MemoryKeyProvider({ autoCreate: false });
    const added = thiefDevice.createKey("person:owner");
    const thief = Ledger.openSync(store, { keys: stolen, ownerKey });
    thief.trustKey(owner, added, "My new laptop");
    thief.close();
    const ledger = Ledger.openSync(store, { keys, ownerKey });
    const { others } = ledger.rotateKey(owner, "Laptop stolen");
    ledger.close();
    expect(others.map((e) => e.data!.keyId)).toContain(added.keyId);
    let entries = [...store.load().entries];
    expect(ownerChain(entries)!.active).not.toContain(added.keyId);
    const secret = newRecoverySecret();
    const theirs = deriveRecoveryKey(secret, ownerChain(entries)!.root);
    entries = handWritten(entries, thiefDevice, {
      type: "owner.recovery.set",
      subject: theirs.keyId,
      summary: "Thief's code",
      reason: "x",
      data: { root: ownerChain(entries)!.root, recoveryKeyId: theirs.keyId, recoveryPublicKey: theirs.publicKey },
    });
    expect(ownerChain(entries)!.recovery?.keyId).not.toBe(theirs.keyId);
  });

  it("MED: a rotation keeps the other keys the person listed, and tells the dropped device", () => {
    const { keys, ownerKey, store } = project();
    const laptop = new MemoryKeyProvider({ autoCreate: false });
    const laptopKey = laptop.createKey("person:owner");
    const desktop = new MemoryKeyProvider({ autoCreate: false });
    const desktopKey = desktop.createKey("person:owner");
    const ledger = Ledger.openSync(store, { keys, ownerKey });
    ledger.trustKey(owner, laptopKey, "Laptop");
    ledger.trustKey(owner, desktopKey, "Desktop");
    const { others } = ledger.rotateKey(owner, "Yearly rotation", { keep: [laptopKey.keyId] });
    ledger.close();
    expect(others.map((e) => e.data!.keyId)).toEqual([desktopKey.keyId]);
    expect(ownerChain(store.load().entries)!.active).toContain(laptopKey.keyId);
    // Review LOW: the dropped desktop is told its key was retired.
    desktop.pin(keys.trustedKeys().find((k) => k.keyId === ownerKey)!);
    const onDesktop = Ledger.openSync(new MemoryStore([...store.load().entries]), { keys: desktop, ownerKey, readOnly: true });
    expect(onDesktop.status.ownKeysRetired?.map((k) => k.keyId)).toEqual([desktopKey.keyId]);
  });
});

// Review of #32 at 60c03a1 (HOLD): a code set with a stolen owner key outlived the owner's rotation.
describe("a recovery code set with a stolen key", () => {
  it("is void once the owner rotates, and the owner gets a new code", () => {
    const { keys, ownerKey, store } = project();
    // 1. A thief with a copy of the owner key sets their own code.
    const stolen = keys.copy();
    const thief = Ledger.openSync(store, { keys: stolen, ownerKey });
    const { code: thiefCode } = thief.setRecoveryCode(owner, "Mine now");
    thief.close();
    // 2. The owner notices and rotates.
    const ledger = Ledger.openSync(store, { keys, ownerKey });
    const { others, recovery } = ledger.rotateKey(owner, "Laptop stolen");
    expect(others).toHaveLength(0);
    expect(recovery?.code).toBeDefined();
    expect(ledger.recoveryCodeSet).toBe(true);
    ledger.close();
    // 3. The thief's code no longer opens the project on any computer; the owner's new one does.
    const pc = newComputer(store);
    expect(thrown(() => pc.ledger.checkRecoveryCode(thiefCode)).message).toMatch(/does not open this project/);
    const thiefPc = new MemoryKeyProvider({ autoCreate: false });
    thiefPc.createKey("person:owner");
    const head = pc.ledger.last()!;
    expect(thrown(() => pc.ledger.recoverOwner(owner, thiefCode, { n: head.n, hash: head.hash }, "Thief")).code).toBe("RULE");
    expect(pc.ledger.owner).toBeUndefined();
    expect(pc.ledger.checkRecoveryCode(recovery!.code).owner).toBe("person:owner");
  });

  it("is void when the key that set it is retired any other way, and the ledger says a new code is needed", () => {
    const { keys, ownerKey, store, code } = project();
    const desktop = new MemoryKeyProvider({ autoCreate: false });
    const desktopKey = desktop.createKey("person:owner");
    const ledger = Ledger.openSync(store, { keys, ownerKey });
    ledger.trustKey(owner, desktopKey, "Desktop");
    ledger.close();
    // The desktop revokes the laptop's key (the one that set the code), without a rotation.
    desktop.pin(keys.trustedKeys().find((k) => k.keyId === ownerKey)!);
    const onDesktop = Ledger.openSync(store, { keys: desktop, ownerKey });
    onDesktop.retireKey(owner, ownerKey, "Laptop lost");
    expect(onDesktop.recoveryCodeSet).toBe(false);
    expect(thrown(() => onDesktop.checkRecoveryCode(code)).message).toMatch(/does not open this project/);
    // The desktop holds an owner key in force, so it can make the new code.
    const { code: fresh } = onDesktop.setRecoveryCode(owner, "Laptop lost");
    expect(onDesktop.checkRecoveryCode(fresh).owner).toBe("person:owner");
  });

  it("is spent by a recovery, which issues the next code", () => {
    const { store, code } = project();
    const pc = newComputer(store);
    const result = recover(pc.ledger, code);
    expect(pc.ledger.recoveryCodeSet).toBe(true);
    expect(thrown(() => pc.ledger.checkRecoveryCode(code)).message).toMatch(/does not open this project/);
    expect(pc.ledger.checkRecoveryCode(result.code).owner).toBe("person:owner");
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
function recoveredFor(entries: LedgerEntry[], code: string, newKey: { keyId: string; publicKey: string }, headEntry: LedgerEntry, expectKeyId?: string) {
  const chain = ownerChain(entries)!;
  const key = deriveRecoveryKey(parseRecoveryCode(code), chain.root);
  if (expectKeyId) expect(key.keyId).toBe(expectKeyId);
  const head = { n: headEntry.n, hash: headEntry.hash };
  const data = {
    root: chain.root,
    head,
    newKeyId: newKey.keyId,
    newPublicKey: newKey.publicKey,
    recoveryKeyId: key.keyId,
    recoverySignature: key.sign(recoveryStatement({ root: chain.root, head, newKeyId: newKey.keyId, recoveryKeyId: key.keyId })),
  };
  return { type: "owner.recovered" as const, subject: newKey.keyId, summary: "Recovered", reason: "x", data };
}
