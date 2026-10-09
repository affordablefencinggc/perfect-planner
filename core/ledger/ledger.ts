import { acknowledgesExactly, hashEntry, ledgerNumber, parseLedgerNumber, verifyWithAcknowledgements } from "./chain";
import type { LedgerStore } from "./store";
import {
  keyFromData,
  markVerified,
  needsSignature,
  principalOf,
  signatureProblem,
  signedBytes,
  trustedKeySet,
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
  /** Clock for `at`; tests pass a fixed one. */
  now?: () => Date;
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
    trusted: Map<string, TrustedKey>,
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
    this.trusted = trusted;
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
    let { chain, acknowledged, trusted } = assess(loaded.entries, permissions, anchors);
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
    if (writable && chain.ok && last && (loaded.head?.n !== last.n || loaded.head?.hash !== last.hash)) {
      // A crash between writing the line and the head leaves the head behind; catch it up.
      store.resetHead({ n: last.n, hash: last.hash });
    }
    const ledger = new Ledger(store, loaded.entries, chain, acknowledged, writable, options.now ?? (() => new Date()), permissions, keys, anchors, trusted);
    ledger.repaired = repaired;
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
    const base = { writable: this.writable, entries: this.list.length, head, acknowledged: [...this.acknowledged], ...(this.repaired ? { repaired: this.repaired } : {}) };
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

  private write(input: EntryDraft, acknowledging = false): LedgerEntry {
    if (!input || typeof input !== "object") throw new LedgerError("EMPTY_FIELD", "an entry is required");
    // Work on a frozen JSON copy: what is checked is what is hashed and stored,
    // and no rule or caller can change it in between.
    const draft = deepFreeze(jsonCopy(input));
    if (draft.type === "chain.acknowledged" && !acknowledging) {
      throw new LedgerError("RULE", "chain.acknowledged is written only by acknowledgeBreak, by a person");
    }
    this.validate(draft);
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
    if (entry.sig) markVerified(entry);
    if (entry.type === "key.trusted" || entry.type === "chain.acknowledged" || !this.chain.ok) {
      // A newly trusted key can make earlier signatures check out; re-check everything.
      const reassessed = assess(this.list, this.permissions, this.anchors);
      this.chain = reassessed.chain;
      this.acknowledged = reassessed.acknowledged;
      this.trusted = reassessed.trusted;
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
  private signEntry(unsigned: Omit<LedgerEntry, "hash">): { key: string; value: string } {
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
    const sig = { key: signed.keyId, value: signed.signature };
    if (!this.trusted.has(sig.key)) {
      // A key made since open (first use, or a rotation): pick up the device's keys again.
      this.anchors = readAnchors(this.keys);
      this.trusted = trustedKeySet(this.anchors, this.list);
    }
    const problem = signatureProblem({ ...unsigned, sig, hash: "" } as LedgerEntry, this.trusted);
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
): { chain: ChainResult; acknowledged: string[]; trusted: Map<string, TrustedKey> } {
  const trusted = trustedKeySet(anchors, entries);
  // Mark every entry whose signature holds, whatever else is wrong: authority is per entry.
  const problems = new Map<LedgerEntry, string>();
  for (const entry of entries) {
    if (!needsSignature(entry.actor)) continue;
    const problem = signatureProblem(entry, trusted);
    if (problem) problems.set(entry, problem);
    else markVerified(entry);
  }
  const { result, acknowledged } = verifyWithAcknowledgements(entries);
  if (!result.ok) return { chain: result, acknowledged, trusted };
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
      trusted,
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
    return { chain: { ok: false, firstBad: entry.n, problem: "signature", detail: problem }, acknowledged, trusted };
  }
  return { chain: { ok: true }, acknowledged, trusted };
}

function pinsEntry(ack: LedgerEntry, entry: LedgerEntry): boolean {
  const pins = Array.isArray(ack.data?.pins) ? (ack.data.pins as { n?: unknown }[]) : [];
  return pins.some((pin) => pin.n === entry.n);
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
