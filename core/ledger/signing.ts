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
  key: string;
  value: string;
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

/** Why an entry's signature does not hold, or undefined when it does. */
export function signatureProblem(entry: LedgerEntry, trusted: ReadonlyMap<string, TrustedKey>): string | undefined {
  if (!needsSignature(entry.actor)) return undefined;
  const sig = entry.sig;
  if (!sig || typeof sig.key !== "string" || typeof sig.value !== "string") {
    return `${entry.n} is a ${entry.actor.kind} entry with no signature`;
  }
  if (trusted.size === 0) return `${entry.n} is signed, but no trusted keys were given to check it (open the ledger with a key provider)`;
  const key = trusted.get(sig.key);
  if (!key) return `${entry.n} is signed by key ${sig.key}, which this device does not trust`;
  const principal = principalOf(entry.actor);
  if (key.principal !== principal) return `${entry.n} claims ${principal} but is signed by ${key.principal}'s key`;
  try {
    const ok = cryptoVerify(null, signedBytes(entry), publicKeyObject(key.publicKey), Buffer.from(sig.value, "base64"));
    return ok ? undefined : `${entry.n}'s signature does not match its content`;
  } catch (error) {
    return `${entry.n}'s signature could not be checked (${(error as Error).message})`;
  }
}

/**
 * Trusted keys for a ledger: the device's own (from the provider) plus keys
 * added by `key.trusted` entries that are themselves signed by a person's
 * trusted key. Repeats until nothing new is added, so a key trusted late in
 * the ledger also covers the entries it signed earlier (keychain recovery).
 */
export function trustedKeySet(anchors: readonly TrustedKey[], entries: readonly LedgerEntry[]): Map<string, TrustedKey> {
  const trusted = new Map<string, TrustedKey>();
  for (const key of anchors) if (validKey(key)) trusted.set(key.keyId, { ...key });
  for (let changed = true; changed; ) {
    changed = false;
    for (const entry of entries) {
      if (entry.type !== "key.trusted" || entry.actor?.kind !== "person") continue;
      const key = keyFromData(entry.data);
      if (!key || trusted.has(key.keyId)) continue;
      if (signatureProblem(entry, trusted) !== undefined) continue;
      trusted.set(key.keyId, key);
      changed = true;
    }
  }
  return trusted;
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
    return [...[...this.keys.values()].map((k) => ({ ...k.key })), ...this.retired.map((k) => ({ ...k }))];
  }

  createKey(principal: string): TrustedKey {
    const pair = newKeyPair();
    const key = { keyId: keyIdOf(pair.publicKey), principal, publicKey: pair.publicKey };
    this.keys.set(principal, { privateKey: pair.privateKey, key });
    return { ...key };
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
