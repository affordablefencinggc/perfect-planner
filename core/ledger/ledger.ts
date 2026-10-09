import { acknowledgesExactly, hashEntry, ledgerNumber, parseLedgerNumber, verifyWithAcknowledgements } from "./chain";
import { checkRecoveryCode, deriveRecoveryKey, formatRecoveryCode, newRecoverySecret, ownerChain, parseRecoveryCode, recoveryStatement, type RecoveryCheck } from "./recovery";
import type { LedgerStore } from "./store";
import type { HeadWitness } from "./witness";
import {
  recordedKeys,
  keyFromData,
  markVerified,
  mayTrustKeyFor,
  keyTrust,
  type KeyTrust,
  needsSignature,
  principalOf,
  signatureProblem,
  signedBytes,
  type KeyProvider,
  type TrustedKey,
} from "./signing";
import {
  ACTOR_KINDS,
  ENTRY_TYPES,
  GENESIS_PREV,
  LedgerError,
  REASON_REQUIRED_TYPES,
  DEFAULT_PERMISSIONS,
  ALLOCATING_TYPES,
  type PermissionTable,
  type Actor,
  type ChainResult,
  type EntryDraft,
  type LedgerEntry,
  type LedgerStatus,
} from "./types";

export type LedgerRule = (draft: EntryDraft, ledger: Ledger) => string | null;

export interface OpenOptions {
  /** Who may write which entry types; defaults to DEFAULT_PERMISSIONS. */
  permissions?: PermissionTable;
  readOnly?: boolean;
  /**
   * Signs person and system entries and supplies the keys this device
   * trusts. MemoryStore brings test keys; a FileStore ledger without keys
   * refuses person and system writes and cannot verify existing ones.
   */
  keys?: KeyProvider;
  /**
   * The project owner's key id, kept by the app outside the ledger (project
   * settings, keychain). The ledger's first person entry must be signed by
   * it, so nobody with file access can start a ledger as its owner.
   */
  ownerKey?: string;
  /** Clock for `at`; tests pass a fixed one. */
  now?: () => Date;
  /**
   * A copy of the head kept outside the project folder (the app's data
   * folder). Opening compares against it, so a ledger cut short together
   * with its HEAD file still reads as truncated; every write updates it.
   */
  witness?: HeadWitness;
}

const TYPES: ReadonlySet<string> = new Set(ENTRY_TYPES);
const KINDS: ReadonlySet<string> = new Set(ACTOR_KINDS);

export class Ledger {
  private readonly store: LedgerStore;
  private readonly list: LedgerEntry[];
  private readonly index = new Map<string, number>();
  private readonly listeners = new Set<(entry: LedgerEntry) => void>();
  private readonly rules: LedgerRule[] = [];
  private readonly now: () => Date;
  private readonly permissions: PermissionTable;
  private writable: boolean;
  private chain: ChainResult;
  private repaired?: string;
  private acknowledged: string[];
  private readonly keys?: KeyProvider;
  private anchors: TrustedKey[];
  private trusted: Map<string, TrustedKey>;
  private trust: KeyTrust;
  private ownerKey?: string;
  /** Set only inside setRecoveryCode and recoverOwner: owner.* entries are never written through append. */
  private writingOwnerEntry = false;
  private witness?: HeadWitness;
  private witnessProblem?: string;

  private constructor(
    store: LedgerStore,
    entries: LedgerEntry[],
    chain: ChainResult,
    acknowledged: string[],
    writable: boolean,
    now: () => Date,
    permissions: PermissionTable,
    keys: KeyProvider | undefined,
    anchors: TrustedKey[],
    trust: KeyTrust,
    ownerKey: string | undefined,
  ) {
    this.store = store;
    this.list = entries;
    entries.forEach((entry, i) => this.index.set(entry.n, i));
    this.chain = chain;
    this.acknowledged = acknowledged;
    this.writable = writable;
    this.now = now;
    this.permissions = permissions;
    this.keys = keys;
    this.anchors = anchors;
    this.trust = trust;
    this.trusted = trust.trusted;
    this.ownerKey = ownerKey;
  }

  /** Loads and re-checks the whole chain (spec §2.5), then takes the writer lock unless read-only. */
  static async open(store: LedgerStore, options: OpenOptions = {}): Promise<Ledger> {
    return Ledger.openSync(store, options);
  }

  static openSync(store: LedgerStore, options: OpenOptions = {}): Ledger {
    // Lock first, then read: a writer must never append to a list loaded before it held the lock.
    const writable = !options.readOnly && store.acquireWriter();
    const repaired = writable ? store.repairTornTail?.() : undefined;
    const loaded = store.load();
    const permissions = options.permissions ?? DEFAULT_PERMISSIONS;
    const keys = options.keys ?? store.defaultKeys;
    const anchors = readAnchors(keys);
    let { chain, acknowledged, trust } = assess(loaded.entries, permissions, anchors, options.ownerKey);
    if (chain.ok && loaded.parseError) {
      chain = { ok: false, firstBad: loaded.parseError.n, problem: "parse", detail: loaded.parseError.detail };
    }
    const last = loaded.entries[loaded.entries.length - 1];
    // A missing tail or a rewritten last entry is the more basic finding than a bad signature.
    if ((chain.ok || chain.problem === "signature") && loaded.head) {
      const head = loaded.head;
      if (!last || (parseLedgerNumber(last.n) ?? 0) < (parseLedgerNumber(head.n) ?? 0)) {
        chain = { ok: false, firstBad: head.n, problem: "truncated", detail: `the ledger ends at ${last?.n ?? "nothing"} but ${head.n} was written` };
      } else if (last.n === head.n && last.hash !== head.hash) {
        chain = { ok: false, firstBad: head.n, problem: "hash", detail: `${head.n} was rewritten after it was recorded` };
      }
    }
    const witness = options.witness;
    const witnessed = witness && loaded.entries.length ? readWitness(witness, loaded.entries[0].hash) : undefined;
    if (witnessed && (chain.ok || chain.problem === "signature")) {
      const same = loaded.entries.find((entry) => entry.n === witnessed.n);
      const where = `the copy of the head kept outside the project (${witness!.description})`;
      if (loaded.entries.length < witnessed.entries || !same) {
        chain = { ok: false, firstBad: witnessed.n, problem: "truncated", detail: `the ledger ends at ${last?.n ?? "nothing"} but ${where} says ${witnessed.n} was written; restore the missing entries, or, if an older copy was restored on purpose, remove that outside copy to accept it` };
      } else if (same.hash !== witnessed.hash) {
        chain = { ok: false, firstBad: witnessed.n, problem: "hash", detail: `${witnessed.n} differs from ${where}` };
      }
    }
    if (writable && chain.ok && last && (loaded.head?.n !== last.n || loaded.head?.hash !== last.hash)) {
      // A crash between writing the line and the head leaves the head behind; catch it up.
      store.resetHead({ n: last.n, hash: last.hash });
    }
    const ledger = new Ledger(store, loaded.entries, chain, acknowledged, writable, options.now ?? (() => new Date()), permissions, keys, anchors, trust, options.ownerKey);
    ledger.repaired = repaired;
    ledger.witness = witness;
    if (writable && chain.ok && last && (witnessed?.n !== last.n || witnessed?.hash !== last.hash)) ledger.updateWitness();
    if (repaired && chain.ok && last) {
      // Leave a record in the ledger itself of what the repair did, when this device can sign it.
      try {
        ledger.append({
        actor: { kind: "system", id: "ledger" },
        type: "correction",
        subject: last.n,
        summary: `Repaired the ledger file after a crash: ${repaired}`,
        reason: "A write was cut short by a crash before it finished",
        corrects: last.n,
        data: { repaired },
        });
      } catch (error) {
        if (!(error instanceof LedgerError && error.code === "NOT_SIGNED")) throw error;
        ledger.repaired = `${repaired} (not recorded in the ledger: ${error.message})`;
      }
    }
    return ledger;
  }

  get status(): LedgerStatus {
    const head = this.last()?.n;
    const base = {
      writable: this.writable,
      entries: this.list.length,
      head,
      acknowledged: [...this.acknowledged],
      ...(this.trust.owner ? { owner: this.trust.owner } : {}),
      ...(this.trust.ownerKeyReplaced ? { ownerKeyReplaced: { ...this.trust.ownerKeyReplaced } } : {}),
      ...(this.repaired ? { repaired: this.repaired } : {}),
      ...(this.witnessProblem ? { witnessProblem: this.witnessProblem } : {}),
    };
    if (this.chain.ok) return { ok: true, ...base };
    return { ok: false, ...base, brokenAt: this.chain.firstBad, problem: this.chain.problem, detail: this.chain.detail };
  }

  close(): void {
    if (this.writable) this.store.releaseWriter();
    this.writable = false;
  }

  addRule(rule: LedgerRule): () => void {
    this.rules.push(rule);
    return () => {
      const i = this.rules.indexOf(rule);
      if (i >= 0) this.rules.splice(i, 1);
    };
  }

  subscribe(listener: (entry: LedgerEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  entries(): readonly LedgerEntry[] {
    return this.list;
  }

  get(n: string): LedgerEntry | undefined {
    const i = this.index.get(n);
    return i === undefined ? undefined : this.list[i];
  }

  last(): LedgerEntry | undefined {
    return this.list[this.list.length - 1];
  }

  bySubject(subject: string): LedgerEntry[] {
    return this.list.filter((entry) => entry.subject === subject);
  }

  since(n: string): LedgerEntry[] {
    const i = this.index.get(n);
    return i === undefined ? [] : this.list.slice(i + 1);
  }

  range(from: string, to: string): LedgerEntry[] {
    const a = this.index.get(from);
    const b = this.index.get(to);
    if (a === undefined || b === undefined || b < a) return [];
    return this.list.slice(a, b + 1);
  }

  /** Validates, numbers, stamps, chains and persists one entry. */
  append(draft: EntryDraft): LedgerEntry {
    if (!this.writable) throw new LedgerError("READ_ONLY", `this ledger is read-only (${this.store.description})`);
    if (!this.chain.ok) {
      throw new LedgerError("CHAIN_BROKEN", `writes are stopped: ${this.chain.firstBad} failed the fingerprint check (${this.chain.problem}); acknowledge it first`);
    }
    return this.write(draft);
  }

  /**
   * Records that a person has seen the break and reopens writes. The break
   * stays visible as acknowledged on every later open.
   */
  acknowledgeBreak(person: Actor, reason: string): LedgerEntry {
    if (!this.writable) throw new LedgerError("READ_ONLY", `this ledger is read-only (${this.store.description})`);
    if (this.chain.ok) throw new LedgerError("RULE", "the fingerprint chain is intact; there is nothing to acknowledge");
    if (person.kind !== "person") throw new LedgerError("BAD_ACTOR", "only a person can acknowledge a broken chain");
    if (this.chain.problem === "parse") {
      throw new LedgerError("RULE", `${this.chain.firstBad} cannot be read; restore the ledger file from git before writing`);
    }
    if (this.chain.problem === "write") {
      throw new LedgerError("RULE", `a write failed at ${this.chain.firstBad}; close and reopen the ledger to re-read what reached disk`);
    }
    if (this.chain.problem === "truncated") {
      throw new LedgerError("RULE", `entries up to ${this.chain.firstBad} are missing; restore them from git before writing`);
    }
    const broken = this.chain;
    const bad = this.get(broken.firstBad);
    if (!bad) throw new LedgerError("RULE", `${broken.firstBad} is not in the ledger; restore it from git before writing`);
    const before = this.list[this.list.indexOf(bad) - 1];
    // HEAD may be missing or stale when the chain is broken; the person has seen the files as they are.
    const tip = this.last();
    if (tip) this.store.resetHead({ n: tip.n, hash: tip.hash });
    const entry = this.write(
      {
        actor: person,
        type: "chain.acknowledged",
        subject: broken.firstBad,
        summary: `Fingerprint break at ${broken.firstBad} acknowledged`,
        reason,
        // The hash pins what the person saw: editing the entry again is a new break.
        data: {
          firstBad: broken.firstBad,
          hash: bad.hash,
          content: hashEntry(bad),
          pins: broken.problem === "prev" && before ? [{ n: before.n, hash: before.hash, content: hashEntry(before) }] : [],
          problem: broken.problem,
          detail: broken.detail,
        },
      },
      true,
    );
    // Re-check everything: a second break further on still stops writes.
    return entry;
  }

  /**
   * A person trusts a public key: a new device, a helper, or their own key
   * from before a lost keychain, after checking its fingerprint. Allowed
   * while the only problem is signatures this device could not check.
   */
  trustKey(person: Actor, key: TrustedKey, reason: string): LedgerEntry {
    if (!this.writable) throw new LedgerError("READ_ONLY", `this ledger is read-only (${this.store.description})`);
    if (person?.kind !== "person") throw new LedgerError("BAD_ACTOR", "only a person can trust a key");
    if (!this.chain.ok && this.chain.problem !== "signature") {
      throw new LedgerError("CHAIN_BROKEN", `writes are stopped: ${this.chain.firstBad} failed the fingerprint check (${this.chain.problem}); acknowledge it first`);
    }
    // The hash chain is intact here, so the tip is safe to record as HEAD.
    const tip = this.last();
    if (!this.chain.ok && tip) this.store.resetHead({ n: tip.n, hash: tip.hash });
    const entry = this.write({
      actor: person,
      type: "key.trusted",
      subject: key.keyId,
      summary: `Trusted ${key.principal}'s key ${key.keyId}`,
      reason,
      data: { keyId: key.keyId, principal: key.principal, publicKey: key.publicKey, ...(key.retired ? { retired: true } : {}) },
    });
    return entry;
  }

  /**
   * A person stops one of their keys (or, the owner, anyone's) signing from
   * here on: after a rotation, or when a key is lost or stolen. Entries the
   * key signed before this point still count.
   */
  retireKey(person: Actor, keyId: string, reason: string): LedgerEntry {
    if (person?.kind !== "person") throw new LedgerError("BAD_ACTOR", "only a person can retire a key");
    // Other devices only honour a retirement signed by a key they can know from the ledger.
    const signer = this.keys?.trustedKeys().find((k) => k.principal === principalOf(person) && !k.retired)?.keyId;
    const known = signer !== undefined && (signer === this.ownerKey || recordedKeys(this.list).some((k) => k.keyId === signer));
    if (!known) {
      throw new LedgerError("RULE", `this device's key ${signer ?? "(none)"} is not in the ledger yet, so other devices would ignore the retirement; use rotateKey, or trust this key first`);
    }
    return this.append({ actor: person, type: "key.retired", subject: keyId, summary: `Retired key ${keyId}`, reason, data: { keyId } });
  }

  /**
   * Rotates a person's key so every device follows: a new key is staged,
   * the old key vouches for it (key.trusted, signed by the old key), the new
   * key becomes active, and it retires the old one (key.retired). Devices
   * that trusted the old key trust the new one from that entry, and refuse
   * anything the old key signs after the retirement.
   */
  rotateKey(person: Actor, reason: string): { trusted: LedgerEntry; retired: LedgerEntry } {
    if (person?.kind !== "person") throw new LedgerError("BAD_ACTOR", "only a person can rotate their key");
    const keys = this.keys;
    if (!keys?.stageKey || !keys.activateKey) throw new LedgerError("NOT_SIGNED", "this device's key store cannot rotate keys");
    const principal = principalOf(person);
    const next = keys.stageKey(principal);
    let trusted: LedgerEntry;
    try {
      trusted = this.trustKey(person, next, `Key rotation: ${reason}`);
    } catch (error) {
      keys.discardStagedKey?.(principal);
      throw error;
    }
    keys.activateKey(principal, next.keyId);
    const previous = trusted.sig!.key;
    // Only the key that vouched is retired; this person's keys on other devices keep working.
    const retired = this.retireKey(person, previous, `Key rotation: ${reason}`);
    return { trusted, retired };
  }

  /** The project owner key id this ledger was opened with (OpenOptions.ownerKey), if any. */
  get pinnedOwnerKey(): string | undefined {
    return this.ownerKey;
  }

  /** True when the ledger was opened with the project's owner key pinned. */
  get ownerKeyPinned(): boolean {
    return this.ownerKey !== undefined;
  }

  /** Who owns this ledger as this device sees it, or undefined when it cannot tell. */
  get owner(): string | undefined {
    return this.trust.owner;
  }

  /**
   * The owner makes a new recovery code (specs/owner-key-recovery.md). Only
   * the code's public key is recorded, in owner.recovery.set signed by the
   * current owner key; any earlier code stops working. The code is returned
   * once, to show the person: never copy it to the clipboard, log it, or
   * capture it in evidence screenshots. App use only, from the person's own
   * session; never expose this on an agent or MCP route.
   */
  setRecoveryCode(person: Actor, reason: string): { code: string; entry: LedgerEntry } {
    if (!this.writable) throw new LedgerError("READ_ONLY", `this ledger is read-only (${this.store.description})`);
    if (person?.kind !== "person") throw new LedgerError("BAD_ACTOR", "only a person can set a recovery code");
    if (!this.chain.ok) {
      throw new LedgerError("CHAIN_BROKEN", `writes are stopped: ${this.chain.firstBad} failed the fingerprint check (${this.chain.problem}); acknowledge it first`);
    }
    const principal = principalOf(person);
    if (!this.trust.owner || this.trust.owner !== principal) {
      throw new LedgerError("NOT_PERMITTED", "only the project's owner, on a computer that holds the owner key, can set a recovery code");
    }
    const chain = ownerChain(this.list)!;
    const current = chain.keys[chain.keys.length - 1].keyId;
    const mine = this.keys?.trustedKeys().find((k) => k.principal === principal && !k.retired)?.keyId;
    if (mine !== current) {
      throw new LedgerError("NOT_PERMITTED", `this computer does not hold the current owner key ${current}, so it cannot set a recovery code`);
    }
    const secret = newRecoverySecret();
    const code = formatRecoveryCode(secret);
    const key = deriveRecoveryKey(secret, chain.genesis);
    secret.fill(0);
    key.wipe();
    const entry = this.writeOwnerEntry({
      actor: person,
      type: "owner.recovery.set",
      subject: key.keyId,
      summary: "Set a new owner recovery code (earlier codes no longer work)",
      reason,
      data: { genesis: chain.genesis, recoveryKeyId: key.keyId, recoveryPublicKey: key.publicKey },
    });
    return { code, entry };
  }

  /**
   * Checks a typed recovery code against this ledger without writing: who
   * the owner is, and the ledger's head for the person to confirm (a code
   * proves where the history starts, not that its end is all there).
   */
  checkRecoveryCode(typed: string): RecoveryCheck {
    return checkRecoveryCode(this.list, typed);
  }

  /**
   * On a computer without the owner key: the person types the recovery code
   * and confirms the head checkRecoveryCode showed them. The code's key
   * signs an owner.recovered entry for exactly that head, countersigned by
   * this computer's key, which becomes the owner key (the old one stops
   * signing). The code is spent, and a new one is made and returned once.
   * The app must then pin `ownerKey` for this project. App use only, from
   * the person's own session; never on an agent or MCP route.
   */
  recoverOwner(
    person: Actor,
    typed: string,
    confirmedHead: { n: string; hash: string },
    reason: string,
  ): { ownerKey: string; recovered: LedgerEntry; code: string; codeEntry: LedgerEntry } {
    if (!this.writable) throw new LedgerError("READ_ONLY", `this ledger is read-only (${this.store.description})`);
    if (person?.kind !== "person") throw new LedgerError("BAD_ACTOR", "only a person can recover a project");
    // Without the owner key, entries it signed show as unchecked signatures; anything worse must be fixed first.
    if (!this.chain.ok && this.chain.problem !== "signature") {
      throw new LedgerError("CHAIN_BROKEN", `the ledger is damaged at ${this.chain.firstBad} (${this.chain.problem}); restore it before recovering`);
    }
    const last = this.last();
    if (!last || last.n !== confirmedHead?.n || last.hash !== confirmedHead?.hash) {
      throw new LedgerError("RULE", `the ledger's last entry is ${last?.n ?? "nothing"}, not the one that was confirmed; check it again before recovering`);
    }
    const check = checkRecoveryCode(this.list, typed);
    const principal = principalOf(person);
    if (check.owner !== principal) throw new LedgerError("NOT_PERMITTED", `this project belongs to ${check.owner.replace(/^person:/, "")}; only they can recover it`);
    const keys = this.keys;
    if (!keys) throw new LedgerError("NOT_SIGNED", `recovery needs this computer's key store (${this.store.description})`);
    let mine = keys.trustedKeys().find((k) => k.principal === principal && !k.retired);
    if (!mine && keys.stageKey && keys.activateKey) {
      mine = keys.stageKey(principal);
      keys.activateKey(principal, mine.keyId);
    }
    if (!mine) throw new LedgerError("NOT_SIGNED", `this computer has no key for ${principal} to take over as owner`);
    if (mine.keyId === check.ownerKey) throw new LedgerError("RULE", "this computer already holds the owner key; there is nothing to recover");
    const chain = ownerChain(this.list)!;
    const secret = parseRecoveryCode(typed);
    const recoveryKey = deriveRecoveryKey(secret, chain.genesis);
    secret.fill(0);
    const head = { n: last.n, hash: last.hash };
    let recoverySignature: string;
    try {
      recoverySignature = recoveryKey.sign(recoveryStatement({ genesis: chain.genesis, head, newKeyId: mine.keyId, recoveryKeyId: recoveryKey.keyId }));
    } finally {
      recoveryKey.wipe();
    }
    const previousPin = this.ownerKey;
    if (!this.chain.ok) this.store.resetHead(head);
    // Pin the new key first so the entry is checked as the owner's once written.
    this.ownerKey = mine.keyId;
    let recovered: LedgerEntry;
    try {
      recovered = this.writeOwnerEntry({
        actor: person,
        type: "owner.recovered",
        subject: mine.keyId,
        summary: `Recovered ownership on a new computer with the recovery code; owner key is now ${mine.keyId}`,
        reason,
        data: { genesis: chain.genesis, head, newKeyId: mine.keyId, newPublicKey: mine.publicKey, recoveryKeyId: recoveryKey.keyId, recoverySignature },
      });
    } catch (error) {
      this.ownerKey = previousPin;
      this.reassess();
      throw error;
    }
    this.reassess();
    if (this.trust.owner !== principal) {
      throw new LedgerError("RULE", `the recovery entry ${recovered.n} was written but did not establish ownership: ${this.chain.ok ? "unknown reason" : this.chain.detail}`);
    }
    const next = this.setRecoveryCode(person, "New code after recovery: the old one is spent");
    return { ownerKey: mine.keyId, recovered, code: next.code, codeEntry: next.entry };
  }

  /** Records the head outside the project; a failure is shown in status, never thrown after a stored write. */
  private updateWitness(): void {
    const last = this.last();
    if (!this.witness || !last) return;
    try {
      this.witness.write(this.list[0].hash, { n: last.n, hash: last.hash, entries: this.list.length });
      this.witnessProblem = undefined;
    } catch (error) {
      this.witnessProblem = `could not update the copy of the head kept outside the project (${this.witness.description}): ${(error as Error).message}`;
    }
  }

  private writeOwnerEntry(draft: EntryDraft): LedgerEntry {
    this.writingOwnerEntry = true;
    try {
      return this.write(draft);
    } finally {
      this.writingOwnerEntry = false;
    }
  }

  private write(input: EntryDraft, acknowledging = false): LedgerEntry {
    if (!input || typeof input !== "object") throw new LedgerError("EMPTY_FIELD", "an entry is required");
    // Work on a frozen JSON copy: what is checked is what is hashed and stored,
    // and no rule or caller can change it in between.
    const draft = deepFreeze(jsonCopy(input));
    if (draft.type === "chain.acknowledged" && !acknowledging) {
      throw new LedgerError("RULE", "chain.acknowledged is written only by acknowledgeBreak, by a person");
    }
    this.validate(draft);
    if (draft.type.startsWith("owner.") && !this.writingOwnerEntry) {
      throw new LedgerError("RULE", `${draft.type} is written only by setRecoveryCode or recoverOwner, from the person's own app session`);
    }
    const previous = this.last();
    let at = this.now();
    if (previous && at.getTime() < Date.parse(previous.at)) at = new Date(previous.at);
    const unsigned = jsonCopy({
      n: ledgerNumber((previous ? parseLedgerNumber(previous.n) ?? this.list.length : 0) + 1),
      at: at.toISOString().replace(/\.\d{3}Z$/, "Z"),
      actor: draft.actor,
      type: draft.type,
      subject: draft.subject.trim(),
      summary: draft.summary.trim(),
      reason: draft.reason?.trim() || undefined,
      evidence: draft.evidence ?? [],
      refs: draft.refs ?? [],
      corrects: draft.corrects,
      data: draft.data,
      prev: previous?.hash ?? GENESIS_PREV,
    }) as Omit<LedgerEntry, "hash">;
    if (needsSignature(draft.actor)) unsigned.sig = this.signEntry(unsigned);
    const entry = deepFreeze({ ...unsigned, hash: hashEntry(unsigned) }) as LedgerEntry;
    try {
      this.store.append(entry, previous && { n: previous.n, hash: previous.hash });
    } catch (error) {
      // The line may or may not have reached disk; stop rather than risk a reused number or a fork.
      this.chain = { ok: false, firstBad: entry.n, problem: "write", detail: (error as Error).message };
      throw new LedgerError("CHAIN_BROKEN", `writing ${entry.n} failed (${(error as Error).message}); writes are stopped until the ledger is reopened`);
    }
    this.index.set(entry.n, this.list.length);
    this.list.push(entry);
    this.updateWitness();
    if (entry.sig) markVerified(entry);
    if (entry.type.startsWith("key.") || entry.type.startsWith("owner.") || entry.type === "chain.acknowledged" || !this.chain.ok || this.trust.owner === undefined) {
      // A key change (or the first person entry) can change what checks out; re-check everything.
      this.reassess();
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A crashing view must not make a stored entry look unwritten.
      }
    }
    return entry;
  }

  /** Signs on behalf of a person or the system, or refuses: never stored unsigned. */
  private signEntry(unsigned: Omit<LedgerEntry, "hash">): { key: string; value: string; pub: string } {
    const principal = principalOf(unsigned.actor);
    if (!this.keys) {
      throw new LedgerError("NOT_SIGNED", `${unsigned.actor.kind} entries must be signed, and this ledger was opened without keys (${this.store.description})`);
    }
    const state = this.keys.state();
    if (!state.available) throw new LedgerError("NOT_SIGNED", `cannot sign for ${principal}: ${state.reason ?? "the key store is unavailable"}`);
    let signed: { keyId: string; signature: string };
    try {
      signed = this.keys.sign(principal, signedBytes(unsigned));
    } catch (error) {
      throw new LedgerError("NOT_SIGNED", `cannot sign for ${principal}: ${(error as Error).message}`);
    }
    if (!this.trusted.has(signed.keyId)) {
      // A key made since open (first use, or a rotation): pick up the device's keys again.
      this.anchors = readAnchors(this.keys);
      this.trust = keyTrust(this.anchors, this.list, { ownerKey: this.ownerKey });
      this.trusted = this.trust.trusted;
    }
    const replaced = this.trust.ownerKeyReplaced;
    if (replaced && signed.keyId === this.ownerKey) {
      throw new LedgerError("NOT_SIGNED", `this project was recovered on another computer at ${replaced.n}; this computer's owner key no longer signs. If that was not you, keep this copy read-only and start a new project from it`);
    }
    const pub = this.trusted.get(signed.keyId)?.publicKey;
    if (!pub) throw new LedgerError("NOT_SIGNED", `${principal} signed with key ${signed.keyId}, which this device does not trust`);
    const sig = { key: signed.keyId, value: signed.signature, pub };
    if (unsigned.actor.kind === "person" && this.ownerKey && sig.key !== this.ownerKey && !this.list.some((e) => e.actor?.kind === "person")) {
      throw new LedgerError("NOT_PERMITTED", `only the project owner's key ${this.ownerKey} may write this ledger's first person entry`);
    }
    const problem = signatureProblem({ ...unsigned, sig, hash: "" } as LedgerEntry, this.trusted, this.trust.retired, this.list.length);
    if (problem) throw new LedgerError("NOT_SIGNED", `the signature for ${principal} did not check out: ${problem}`);
    return sig;
  }

  private validate(draft: EntryDraft): void {
    if (!draft || typeof draft !== "object") throw new LedgerError("EMPTY_FIELD", "an entry is required");
    if (!TYPES.has(draft.type)) throw new LedgerError("UNKNOWN_TYPE", `unknown entry type "${draft.type}"`);
    const actor = draft.actor;
    if (!actor || !KINDS.has(actor.kind) || !isFilled(actor.id)) {
      throw new LedgerError("BAD_ACTOR", "actor needs a kind (person, agent, jev or system) and an id");
    }
    if ((actor.kind === "agent" || actor.kind === "jev") && !isFilled(actor.model)) {
      throw new LedgerError("BAD_ACTOR", `an ${actor.kind} actor must name its model`);
    }
    if (!permitted(this.permissions, actor.kind, draft.type)) {
      throw new LedgerError("NOT_PERMITTED", `${actor.kind === "jev" ? "Jev" : `an ${actor.kind}`} (${actor.id}) may not write ${draft.type}`);
    }
    if (!isFilled(draft.subject)) throw new LedgerError("EMPTY_FIELD", "subject may not be empty");
    if (!isFilled(draft.summary)) throw new LedgerError("EMPTY_FIELD", "summary may not be empty or TBD");
    if (draft.reason !== undefined && !isFilled(draft.reason)) {
      throw new LedgerError("EMPTY_FIELD", "reason may not be empty or TBD");
    }
    if (REASON_REQUIRED_TYPES.has(draft.type) && !isFilled(draft.reason)) {
      throw new LedgerError("REASON_REQUIRED", `${draft.type} needs a reason`);
    }
    for (const list of [draft.evidence, draft.refs]) {
      if (list !== undefined && (!Array.isArray(list) || list.some((item) => !isFilled(item)))) {
        throw new LedgerError("EMPTY_FIELD", "evidence and refs must be lists of non-empty strings");
      }
    }
    if (draft.type === "correction" && draft.corrects === undefined) {
      throw new LedgerError("BAD_CORRECTS", "a correction must name the entry it corrects");
    }
    if (draft.corrects !== undefined && !this.get(draft.corrects)) {
      throw new LedgerError("BAD_CORRECTS", `${draft.corrects} is not an existing entry`);
    }
    this.checkSeries(draft);
    if (draft.type === "task.done") this.checkDone(draft.subject.trim());
    if (draft.type === "test.approved") this.checkApproved(draft);
    if (draft.type === "key.trusted") this.checkKeyTrusted(draft);
    if (draft.type === "key.retired") this.checkKeyRetired(draft);
    for (const rule of this.rules) {
      const refusal = rule(draft, this);
      if (refusal) throw new LedgerError("RULE", refusal);
    }
  }

  /**
   * Spec §2.4: task.done needs a test.passed for the task's approved test,
   * later than its last commit (and its last approval or reopen).
   */
  private checkDone(task: string): void {
    const base = taskBase(task);
    let approvedTest: string | undefined;
    let anchor = -1;
    let passedAfterAnchor = false;
    this.list.forEach((entry, i) => {
      if (taskBase(entry.subject) !== base) return;
      switch (entry.type) {
        case "test.approved":
          approvedTest = String(entry.data?.test ?? "");
          anchor = i;
          passedAfterAnchor = false;
          break;
        case "commit.observed":
        case "task.reopened":
          anchor = i;
          passedAfterAnchor = false;
          break;
        case "test.passed":
        case "test.failed":
          // The latest run of the approved test after the anchor decides.
          if (approvedTest !== undefined && i > anchor && String(entry.data?.test ?? "") === approvedTest) {
            passedAfterAnchor = entry.type === "test.passed";
          }
          break;
        default:
          break;
      }
    });
    if (approvedTest === undefined) {
      throw new LedgerError("DONE_WITHOUT_PASS", `${task} has no approved test`);
    }
    if (!passedAfterAnchor) {
      throw new LedgerError("DONE_WITHOUT_PASS", `${task} has no passing run of its approved test after its last commit`);
    }
  }

  /** Spec §3.1: an entry that hands out a number takes exactly the next one in its series. */
  private checkSeries(draft: EntryDraft): void {
    const series = SERIES_BY_TYPE.get(draft.type);
    if (!series) return;
    let highest = 0;
    for (const entry of this.list) {
      if (SERIES_BY_TYPE.get(entry.type) !== series) continue;
      const match = SERIES_NUMBER.exec(entry.subject);
      if (match && match[1] === series) highest = Math.max(highest, Number(match[2]));
    }
    const expected = `${series}-${highest + 1}`;
    if (draft.subject.trim() !== expected) {
      throw new LedgerError("RULE", `${draft.type} must take the next ${series} number, ${expected}, not "${draft.subject}"`);
    }
  }

  /** key.trusted comes from a person and names a well-formed Ed25519 key. */
  private checkKeyTrusted(draft: EntryDraft): void {
    if (draft.actor.kind !== "person") throw new LedgerError("NOT_PERMITTED", "only a person can trust a key");
    const key = keyFromData(draft.data);
    if (!key) throw new LedgerError("RULE", "key.trusted needs data.keyId, data.principal (person:<id> or system) and an Ed25519 data.publicKey that match");
    if (draft.subject.trim() !== key.keyId) throw new LedgerError("RULE", `key.trusted must be about the key itself, ${key.keyId}`);
    // The first person entry makes its writer the owner; trusting a key may be that entry.
    const owner = this.ownerFor(draft.actor);
    if (!mayTrustKeyFor(principalOf(draft.actor), key.principal, owner)) {
      throw new LedgerError("NOT_PERMITTED", `only ${key.principal.replace(/^person:/, "")} or the owner may trust a key for ${key.principal}`);
    }
    const bound = recordedKeys(this.list).find((k) => k.keyId === key.keyId);
    if (bound && bound.principal !== key.principal) {
      throw new LedgerError("RULE", `key ${key.keyId} already signs for ${bound.principal} in this ledger; it cannot be trusted as ${key.principal}`);
    }
  }

  /** key.retired: the key's own person or the owner stops a key signing anything later. */
  private checkKeyRetired(draft: EntryDraft): void {
    if (draft.actor.kind !== "person") throw new LedgerError("NOT_PERMITTED", "only a person can retire a key");
    const keyId = draft.data?.keyId;
    const key = typeof keyId === "string" ? this.trusted.get(keyId) ?? recordedKeys(this.list).find((k) => k.keyId === keyId) : undefined;
    if (!key) throw new LedgerError("RULE", "key.retired needs data.keyId, a key this ledger knows");
    if (draft.subject.trim() !== key.keyId) throw new LedgerError("RULE", `key.retired must be about the key itself, ${key.keyId}`);
    if (!mayTrustKeyFor(principalOf(draft.actor), key.principal, this.ownerFor(draft.actor))) {
      throw new LedgerError("NOT_PERMITTED", `only ${key.principal.replace(/^person:/, "")} or the owner may retire a key of ${key.principal}`);
    }
    if (this.trust.retired.has(key.keyId)) throw new LedgerError("RULE", `key ${key.keyId} was already retired at ${this.trust.retired.get(key.keyId)!.n}`);
  }

  /** The owner, or, before any person entry, the person writing when their key is the pinned owner key. */
  private ownerFor(actor: Actor): string | undefined {
    if (this.trust.owner || !this.ownerKey || this.list.some((e) => e.actor?.kind === "person")) return this.trust.owner;
    const own = this.trusted.get(this.ownerKey);
    return own && own.principal === principalOf(actor) ? own.principal : undefined;
  }

  private reassess(): void {
    const reassessed = assess(this.list, this.permissions, this.anchors, this.ownerKey);
    this.chain = reassessed.chain;
    this.acknowledged = reassessed.acknowledged;
    this.trust = reassessed.trust;
    this.trusted = reassessed.trust.trusted;
  }

  /** test.approved must approve a command that was defined for the same task. */
  private checkApproved(draft: EntryDraft): void {
    const test = draft.data?.test;
    if (typeof test !== "string" || test.trim() === "") {
      throw new LedgerError("EMPTY_FIELD", "test.approved needs data.test, the command being approved");
    }
    const base = taskBase(draft.subject);
    const defined = this.list.some((entry) => entry.type === "test.defined" && taskBase(entry.subject) === base && entry.data?.test === test);
    if (!defined) throw new LedgerError("RULE", `${base} has no defined test "${test}" to approve`);
  }
}

/** Chain check plus who-wrote-what check, with person acknowledgements applied to both. */
function assess(
  entries: readonly LedgerEntry[],
  permissions: PermissionTable,
  anchors: readonly TrustedKey[],
  ownerKey?: string,
): { chain: ChainResult; acknowledged: string[]; trust: KeyTrust } {
  const trust = keyTrust(anchors, entries, { ownerKey });
  const trusted = trust;
  // Mark every entry whose signature holds, whatever else is wrong: authority is per entry.
  const problems = new Map<LedgerEntry, string>();
  entries.forEach((entry, index) => {
    if (!needsSignature(entry.actor)) return;
    const problem =
      signatureProblem(entry, trust.trusted, trust.retired, index) ??
      // A first person entry that is not the owner's breaks the ledger's root of trust.
      (trust.ownerProblem?.n === entry.n ? trust.ownerProblem.detail : undefined);
    if (problem) problems.set(entry, problem);
    else markVerified(entry);
  });
  const { result, acknowledged } = verifyWithAcknowledgements(entries);
  if (!result.ok) return { chain: result, acknowledged, trust: trusted };
  for (const entry of entries) {
    if (permitted(permissions, entry.actor?.kind, entry.type)) continue;
    const acked = entries.some(
      (e) => e.type === "chain.acknowledged" && e.actor?.kind === "person" && e.data?.firstBad === entry.n && acknowledgesExactly(e, entry, entries),
    );
    if (acked) {
      acknowledged.push(entry.n);
      continue;
    }
    return {
      chain: { ok: false, firstBad: entry.n, problem: "permission", detail: `${entry.actor?.kind ?? "unknown"} ${entry.actor?.id ?? ""} may not write ${entry.type}` },
      acknowledged,
      trust: trusted,
    };
  }
  for (const entry of entries) {
    const problem = problems.get(entry);
    if (!problem || acknowledged.includes(entry.n)) continue;
    // An acknowledged signature break lets writes continue; the entry still never counts as
    // authoritative. A prev-break acknowledgement also covers the rewritten entry it pins.
    const acked = entries.some(
      (e) =>
        e.type === "chain.acknowledged" &&
        e.actor?.kind === "person" &&
        !problems.has(e) &&
        (e.data?.firstBad === entry.n || pinsEntry(e, entry)) &&
        acknowledgesExactly(e, entries.find((b) => b.n === e.data?.firstBad) ?? entry, entries),
    );
    if (acked) {
      acknowledged.push(entry.n);
      continue;
    }
    return { chain: { ok: false, firstBad: entry.n, problem: "signature", detail: problem }, acknowledged, trust: trusted };
  }
  return { chain: { ok: true }, acknowledged, trust: trusted };
}

function pinsEntry(ack: LedgerEntry, entry: LedgerEntry): boolean {
  const pins = Array.isArray(ack.data?.pins) ? (ack.data.pins as { n?: unknown }[]) : [];
  return pins.some((pin) => pin.n === entry.n);
}

function readWitness(witness: HeadWitness, genesis: string) {
  try {
    return witness.read(genesis);
  } catch {
    return undefined;
  }
}

function readAnchors(keys: KeyProvider | undefined): TrustedKey[] {
  if (!keys) return [];
  try {
    return keys.trustedKeys();
  } catch {
    // An unreadable key store trusts nothing; signed entries then show as unchecked.
    return [];
  }
}

const SERIES_NUMBER = /^([PTQDR])-(\d+)$/;
const SERIES_BY_TYPE = new Map<string, string>(
  Object.entries(ALLOCATING_TYPES).flatMap(([series, types]) => types.map((type) => [type, series] as [string, string])),
);

function permitted(table: PermissionTable, kind: string | undefined, type: string): boolean {
  const allowed = kind === undefined ? undefined : table[kind as keyof PermissionTable];
  return allowed === "any" || (Array.isArray(allowed) && allowed.includes(type));
}

/** A plain JSON copy: drops undefined and functions, turns Dates into strings, Sets and Maps into {}. */
function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** "T-14.a2" and "T-14" are the same task. */
function taskBase(subject: string): string {
  return subject.trim().replace(/\.a\d+$/, "");
}

function isFilled(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text !== "" && text.toUpperCase() !== "TBD";
}
