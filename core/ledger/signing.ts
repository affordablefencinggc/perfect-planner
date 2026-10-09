import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256 } from "./chain";
import type { Actor, LedgerEntry } from "./types";

/**
 * Person and system entries carry an Ed25519 signature (`sig`) made by the
 * app process with a key held in the OS keychain, behind this interface.
 * Agents never hold a provider, so an agent with write access to the ledger
 * files can no longer make an entry that reads as a person's or the gate's.
 */
export interface KeyProvider {
  readonly description: string;
  /** Whether keys can be used right now; when not, `reason` says why in plain words. */
  state(): KeyState;
  /** Public keys this device trusts, including retired ones (verify only). */
  trustedKeys(): TrustedKey[];
  /**
   * Signs with the principal's active key. Throws when the principal has no
   * key here or the key store is unavailable; never returns an empty signature.
   */
  sign(principal: string, message: Buffer): { keyId: string; signature: string };
  /**
   * Rotation, used by ledger.rotateKey: make a new key that does not sign
   * yet, so the old key can vouch for it in the ledger first; then make it
   * the active key (the old one never signs again); or throw it away.
   */
  stageKey?(principal: string): TrustedKey;
  activateKey?(principal: string, keyId: string): void;
  discardStagedKey?(principal: string): void;
}

export interface KeyState {
  available: boolean;
  reason?: string;
}

export interface TrustedKey {
  /** "k-" and the first 16 hex characters of the sha256 of the public key. */
  keyId: string;
  /** "person:<actor id>" or "system". */
  principal: string;
  /** Ed25519 public key, SPKI DER, base64. */
  publicKey: string;
  /** A rotated-out key: still verifies the entries it signed, never signs again. */
  retired?: boolean;
}

export interface EntrySignature {
  /** keyIdOf(pub). */
  key: string;
  /** Ed25519 signature, base64. */
  value: string;
  /** The signing key's public half, SPKI DER base64, so the ledger records every key that signed it. */
  pub: string;
}

/** Actor kinds whose entries must be signed. */
export function needsSignature(actor: Actor | undefined): boolean {
  return actor?.kind === "person" || actor?.kind === "system";
}

/** The key that signs for an actor: each person has their own; the gate and watcher share the app's. */
export function principalOf(actor: Actor): string {
  return actor.kind === "system" ? "system" : `${actor.kind}:${actor.id}`;
}

export function keyIdOf(publicKey: string): string {
  return `k-${sha256(publicKey).slice(0, 16)}`;
}

/** The bytes a signature covers: every field except hash and sig, so n, at and prev are signed too. */
export function signedBytes(entry: Omit<LedgerEntry, "hash"> | LedgerEntry): Buffer {
  const { hash: _hash, sig: _sig, ...rest } = entry as LedgerEntry;
  return Buffer.from(canonicalJson(rest), "utf8");
}

const verified = new WeakSet<object>();

/** Set by the ledger on entry objects whose signature it checked against a trusted key. */
export function markVerified(entry: LedgerEntry): void {
  verified.add(entry);
}

export function isVerified(entry: LedgerEntry): boolean {
  return verified.has(entry);
}

/** Where in the ledger each key was retired: entries it signs after that index do not count. */
export type Retirements = ReadonlyMap<string, { index: number; n: string }>;

/**
 * Why an entry's signature does not hold, or undefined when it does. With
 * `at` (the entry's index) and `retired`, a key retired earlier in the
 * ledger no longer signs.
 */
export function signatureProblem(
  entry: LedgerEntry,
  trusted: ReadonlyMap<string, TrustedKey>,
  retired?: Retirements,
  at?: number,
): string | undefined {
  if (!needsSignature(entry.actor)) return undefined;
  const sig = entry.sig;
  if (!sig || typeof sig.key !== "string" || typeof sig.value !== "string") {
    return `${entry.n} is a ${entry.actor.kind} entry with no signature`;
  }
  if (typeof sig.pub !== "string" || keyIdOf(sig.pub) !== sig.key) {
    return `${entry.n}'s signature records a public key that is not key ${sig.key}`;
  }
  if (trusted.size === 0) return `${entry.n} is signed, but no trusted keys were given to check it (open the ledger with a key provider)`;
  const key = trusted.get(sig.key);
  if (!key) return `${entry.n} is signed by key ${sig.key}, which this device does not trust`;
  const principal = principalOf(entry.actor);
  if (key.principal !== principal) return `${entry.n} claims ${principal} but is signed by ${key.principal}'s key`;
  const retirement = retired?.get(sig.key);
  if (retirement && at !== undefined && at > retirement.index) return `${entry.n} is signed by key ${sig.key}, which was retired at ${retirement.n}`;
  try {
    const ok = cryptoVerify(null, signedBytes(entry), publicKeyObject(key.publicKey), Buffer.from(sig.value, "base64"));
    return ok ? undefined : `${entry.n}'s signature does not match its content`;
  } catch (error) {
    return `${entry.n}'s signature could not be checked (${(error as Error).message})`;
  }
}

/** The ledger's owner as this device sees it; see keyTrust. */
export function ownerPrincipal(entries: readonly LedgerEntry[], anchors: readonly TrustedKey[] = [], ownerKey?: string): string | undefined {
  return keyTrust(anchors, entries, { ownerKey }).owner;
}

/** Who may trust a key for `principal`: that same person, or the owner. */
export function mayTrustKeyFor(signer: string, principal: string, owner: string | undefined): boolean {
  return signer === principal || (owner !== undefined && signer === owner);
}

export interface KeyTrust {
  trusted: Map<string, TrustedKey>;
  /** The owner's principal, when this device can verify the ledger's first person entry. */
  owner?: string;
  /** Why there is no owner although the ledger has person entries. */
  ownerProblem?: { n: string; detail: string };
  retired: Retirements;
}

/**
 * Which keys this device trusts for a ledger, who owns it, and which keys
 * were retired where. Replayed in ledger order, a fixed number of times, so
 * the answer never depends on how many entries the ledger has.
 *
 * - Anchors are the device's own and pinned keys (from the provider).
 * - A `key.trusted` entry adds a key when, at that point in the ledger, it
 *   was signed by a trusted, not-yet-retired key of the same person or of
 *   the owner. It is ignored when the ledger already records that key as
 *   another person's.
 * - A `key.retired` entry, signed the same way, retires a key for good:
 *   nothing it signs after that point counts, on any device that replays it.
 * - Recovery: a key a person re-trusts with their own key counts from the
 *   start of the ledger, so what it signed earlier counts again; its
 *   retirements still apply.
 * - The owner is the principal of the ledger's first person entry, only
 *   when the app pins `ownerKey` and that entry was signed by exactly that
 *   key, trusted without the owner's help. Without `ownerKey` there is no
 *   owner: nobody can trust or retire another person's key.
 */
export function keyTrust(anchors: readonly TrustedKey[], entries: readonly LedgerEntry[], options: { ownerKey?: string } = {}): KeyTrust {
  const bound = new Map<string, string>();
  for (const entry of entries) {
    const sig = entry.sig;
    if (needsSignature(entry.actor) && sig && typeof sig.key === "string" && !bound.has(sig.key)) bound.set(sig.key, principalOf(entry.actor));
  }
  const withoutOwner = settle(anchors, entries, bound, undefined);
  const firstIndex = entries.findIndex((entry) => entry.actor?.kind === "person" && typeof entry.actor.id === "string");
  let owner: string | undefined;
  let ownerProblem: KeyTrust["ownerProblem"];
  // Only the app can name the owner, by pinning the owner key it kept outside the ledger.
  if (firstIndex >= 0 && options.ownerKey) {
    const first = entries[firstIndex];
    const problem = signatureProblem(first, withoutOwner.trusted, withoutOwner.retired, firstIndex);
    if (problem) ownerProblem = { n: first.n, detail: `no owner: ${problem}` };
    else if (first.sig?.key !== options.ownerKey) {
      ownerProblem = { n: first.n, detail: `${first.n} was not signed by this project's owner key ${options.ownerKey}` };
    } else owner = principalOf(first.actor);
  }
  const result = owner ? settle(anchors, entries, bound, owner) : withoutOwner;
  return { trusted: result.trusted, owner, ownerProblem, retired: result.retired };
}

interface Replay {
  trusted: Map<string, TrustedKey>;
  retired: Map<string, { index: number; n: string }>;
  /** Keys re-trusted by their own person, and the index of that entry. */
  selfTrusted: Map<string, TrustedKey>;
}

/** Three ledger-order replays: plain, then with re-trusted keys counting from the start, then re-checked. */
function settle(anchors: readonly TrustedKey[], entries: readonly LedgerEntry[], bound: ReadonlyMap<string, string>, owner: string | undefined): Replay {
  const first = replay(anchors, [], entries, bound, owner);
  const second = replay(anchors, [...first.selfTrusted.values()], entries, bound, owner);
  // Keep only recoveries the second replay still accepts; never feed back again.
  const kept = [...first.selfTrusted.values()].filter((key) => second.selfTrusted.has(key.keyId));
  return replay(anchors, kept, entries, bound, owner);
}

function replay(
  anchors: readonly TrustedKey[],
  recovered: readonly TrustedKey[],
  entries: readonly LedgerEntry[],
  bound: ReadonlyMap<string, string>,
  owner: string | undefined,
): Replay {
  const trusted = new Map<string, TrustedKey>();
  for (const key of [...anchors, ...recovered]) if (validKey(key) && !trusted.has(key.keyId)) trusted.set(key.keyId, { ...key });
  const retired = new Map<string, { index: number; n: string }>();
  const selfTrusted = new Map<string, TrustedKey>();
  entries.forEach((entry, index) => {
    if (entry.actor?.kind !== "person") return;
    if (entry.type === "key.trusted") {
      const key = keyFromData(entry.data);
      if (!key) return;
      // A key the ledger already shows signing for someone else cannot be relabelled.
      if ((bound.get(key.keyId) ?? key.principal) !== key.principal) return;
      if (signatureProblem(entry, trusted, retired, index) !== undefined) return;
      const signer = principalOf(entry.actor);
      if (!mayTrustKeyFor(signer, key.principal, owner)) return;
      if (!trusted.has(key.keyId)) trusted.set(key.keyId, key);
      if (signer === key.principal) selfTrusted.set(key.keyId, key);
    } else if (entry.type === "key.retired") {
      const keyId = entry.data?.keyId;
      if (typeof keyId !== "string" || retired.has(keyId)) return;
      const key = trusted.get(keyId);
      if (!key) return;
      if (signatureProblem(entry, trusted, retired, index) !== undefined) return;
      if (!mayTrustKeyFor(principalOf(entry.actor), key.principal, owner)) return;
      retired.set(keyId, { index, n: entry.n });
    }
  });
  return { trusted, retired, selfTrusted };
}

/** Trusted keys only; see keyTrust. */
export function trustedKeySet(anchors: readonly TrustedKey[], entries: readonly LedgerEntry[]): Map<string, TrustedKey> {
  return keyTrust(anchors, entries).trusted;
}

/**
 * Every public key the ledger records, trusted or not: from signatures and
 * from key.trusted entries. For showing fingerprints, and for recovery after
 * a lost keychain; recording a key is not trusting it.
 */
export function recordedKeys(entries: readonly LedgerEntry[]): TrustedKey[] {
  const found = new Map<string, TrustedKey>();
  for (const entry of entries) {
    const sig = entry.sig;
    if (needsSignature(entry.actor) && sig && typeof sig.pub === "string" && keyIdOf(sig.pub) === sig.key && !found.has(sig.key)) {
      const key = { keyId: sig.key, principal: principalOf(entry.actor), publicKey: sig.pub };
      if (validKey(key)) found.set(key.keyId, key);
    }
    if (entry.type === "key.trusted") {
      const key = keyFromData(entry.data);
      if (key && !found.has(key.keyId)) found.set(key.keyId, { keyId: key.keyId, principal: key.principal, publicKey: key.publicKey });
    }
  }
  return [...found.values()];
}

/** The key named by a key.trusted payload, when it is well formed. */
export function keyFromData(data: Record<string, unknown> | undefined): TrustedKey | undefined {
  if (!data) return undefined;
  const key = { keyId: data.keyId, principal: data.principal, publicKey: data.publicKey } as TrustedKey;
  if (data.retired === true) key.retired = true;
  return validKey(key) ? key : undefined;
}

function validKey(key: TrustedKey): boolean {
  if (typeof key.keyId !== "string" || typeof key.principal !== "string" || typeof key.publicKey !== "string") return false;
  if (!/^(person:.+|system)$/.test(key.principal) || keyIdOf(key.publicKey) !== key.keyId) return false;
  try {
    return publicKeyObject(key.publicKey).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
}

/** Signs with an Ed25519 private key held as PKCS8 DER, base64. */
export function signWith(privateKey: string, message: Buffer): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
  return cryptoSign(null, message, key).toString("base64");
}

/** A new Ed25519 key pair: the private half as PKCS8 DER base64, the public as SPKI DER base64. */
export function newKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/**
 * Keys in memory, for tests and for MemoryStore ledgers. Not for real
 * projects: nothing here is protected, and by default signing creates a key
 * for any principal on first use.
 */
export class MemoryKeyProvider implements KeyProvider {
  readonly description = "test keys in memory";
  private readonly keys = new Map<string, { privateKey: string; key: TrustedKey }>();
  private readonly retired: TrustedKey[] = [];
  private readonly pinned: TrustedKey[] = [];
  private readonly unavailable?: string;
  private readonly autoCreate: boolean;

  constructor(options: { unavailable?: string; autoCreate?: boolean } = {}) {
    this.unavailable = options.unavailable;
    this.autoCreate = options.autoCreate ?? true;
  }

  state(): KeyState {
    return this.unavailable ? { available: false, reason: this.unavailable } : { available: true };
  }

  trustedKeys(): TrustedKey[] {
    return [...[...this.keys.values()].map((k) => ({ ...k.key })), ...this.retired.map((k) => ({ ...k })), ...this.pinned.map((k) => ({ ...k }))];
  }

  /** Another provider holding the same keys: a stolen copy, for tests. */
  copy(): MemoryKeyProvider {
    const twin = new MemoryKeyProvider({ unavailable: this.unavailable, autoCreate: this.autoCreate });
    for (const [principal, entry] of this.keys) twin.keys.set(principal, { privateKey: entry.privateKey, key: { ...entry.key } });
    twin.retired.push(...this.retired.map((k) => ({ ...k })));
    twin.pinned.push(...this.pinned.map((k) => ({ ...k })));
    return twin;
  }

  /** Trusts someone else's public key on this device only, after its fingerprint was checked. */
  pin(key: TrustedKey): void {
    if (!validKey(key)) throw new RangeError("not a valid Ed25519 key");
    this.pinned.push({ keyId: key.keyId, principal: key.principal, publicKey: key.publicKey });
  }

  createKey(principal: string): TrustedKey {
    const pair = newKeyPair();
    const key = { keyId: keyIdOf(pair.publicKey), principal, publicKey: pair.publicKey };
    this.keys.set(principal, { privateKey: pair.privateKey, key });
    return { ...key };
  }

  private readonly staged = new Map<string, { privateKey: string; key: TrustedKey }>();

  stageKey(principal: string): TrustedKey {
    const pair = newKeyPair();
    const key = { keyId: keyIdOf(pair.publicKey), principal, publicKey: pair.publicKey };
    this.staged.set(principal, { privateKey: pair.privateKey, key });
    return { ...key };
  }

  activateKey(principal: string, keyId: string): void {
    const next = this.staged.get(principal);
    if (!next || next.key.keyId !== keyId) throw new Error(`no staged key ${keyId} for ${principal}`);
    const old = this.keys.get(principal);
    if (old) this.retired.push({ ...old.key, retired: true });
    this.keys.set(principal, next);
    this.staged.delete(principal);
  }

  discardStagedKey(principal: string): void {
    this.staged.delete(principal);
  }

  /** Retires the principal's key (it still verifies) and makes a new one. */
  rotateKey(principal: string): TrustedKey {
    const old = this.keys.get(principal);
    if (old) this.retired.push({ ...old.key, retired: true });
    return this.createKey(principal);
  }

  sign(principal: string, message: Buffer): { keyId: string; signature: string } {
    if (this.unavailable) throw new Error(this.unavailable);
    let entry = this.keys.get(principal);
    if (!entry && this.autoCreate) {
      this.createKey(principal);
      entry = this.keys.get(principal);
    }
    if (!entry) throw new Error(`there is no signing key for ${principal} on this device`);
    return { keyId: entry.key.keyId, signature: signWith(entry.privateKey, message) };
  }
}
