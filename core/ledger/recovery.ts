import { createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { canonicalJson } from "./chain";
import { keyIdOf, principalOf, signedBytes } from "./signing";
import { LedgerError, type LedgerEntry } from "./types";

/**
 * Owner recovery (specs/owner-key-recovery.md, option B). At setup the owner
 * is shown a one-time code; only a public key derived from it goes in the
 * ledger, in an owner.recovery.set entry signed by the owner key. On a new
 * computer the person types the code: the key it derives must match the
 * ledger's latest recovery key, which proves the history is the owner's own,
 * and it signs an owner.recovered entry handing ownership to the new
 * computer's key. The code is never stored, logged, or put in an error message.
 */

const INFO = "pp-owner-recovery-v1";
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const CODE_BYTES = 16; // 128 bits
const BODY_CHARS = 26;
const CHECK_CHARS = 2;

/** A new random code as raw bytes; format it with formatRecoveryCode and wipe it with .fill(0). */
export function newRecoverySecret(): Buffer {
  return randomBytes(CODE_BYTES);
}

/** "XXXX-XXXX-…" (28 characters, the last two a typo check). */
export function formatRecoveryCode(secret: Buffer): string {
  const text = toBase32(secret) + checkChars(secret);
  return text.match(/.{1,4}/g)!.join("-");
}

/**
 * The raw bytes of a typed code. Spaces, dashes and case do not matter, and
 * O, I and L read as 0, 1 and 1. A typo fails the check characters with a
 * message that never repeats the code.
 */
export function parseRecoveryCode(typed: string): Buffer {
  const text = String(typed ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (text.length !== BODY_CHARS + CHECK_CHARS || [...text].some((c) => !ALPHABET.includes(c))) {
    throw new LedgerError("RULE", `a recovery code is ${BODY_CHARS + CHECK_CHARS} letters and digits; check what was typed`);
  }
  const secret = fromBase32(text.slice(0, BODY_CHARS));
  if (!secret || checkChars(secret) !== text.slice(BODY_CHARS)) {
    secret?.fill(0);
    throw new LedgerError("RULE", "that recovery code has a typo: it does not pass its own check; compare it with the saved copy");
  }
  return secret;
}

export interface RecoveryKey {
  keyId: string;
  /** Ed25519 public key, SPKI DER base64. */
  publicKey: string;
  /** Signs with the derived private key; call wipe() when done. */
  sign(message: Buffer): string;
  wipe(): void;
}

/**
 * The Ed25519 key a code derives for one ledger: HKDF-SHA256 with the
 * ledger's genesis hash as salt, so a code for one project means nothing in
 * another. The genesis entry's hash covers its time, author and signature,
 * so it identifies the project.
 */
export function deriveRecoveryKey(secret: Buffer, genesis: string): RecoveryKey {
  const seed = Buffer.from(hkdfSync("sha256", secret, Buffer.from(`pp-project:${genesis}`, "utf8"), Buffer.from(INFO, "utf8"), 32));
  // PKCS8 wrapper for a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  seed.fill(0);
  let privateKey: ReturnType<typeof createPrivateKey> | undefined = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  der.fill(0);
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
  return {
    keyId: keyIdOf(publicKey),
    publicKey,
    sign(message) {
      if (!privateKey) throw new Error("the recovery key was already wiped");
      return cryptoSign(null, message, privateKey).toString("base64");
    },
    wipe() {
      privateKey = undefined;
    },
  };
}

/** What the recovery key signs in owner.recovered: the project, the exact head it follows, and both keys. */
export function recoveryStatement(data: { genesis: string; head: { n: string; hash: string }; newKeyId: string; recoveryKeyId: string }): Buffer {
  return Buffer.from(
    canonicalJson({ v: INFO, genesis: data.genesis, head: { n: data.head.n, hash: data.head.hash }, newKeyId: data.newKeyId, recoveryKeyId: data.recoveryKeyId }),
    "utf8",
  );
}

export interface OwnerKeyStep {
  keyId: string;
  publicKey: string;
  /** Index of the entry that made this the owner key (the first person entry, or an owner.recovered). */
  from: number;
  /** Index of the owner.recovered that replaced it; nothing it signs after that counts. */
  replacedAt?: { index: number; n: string };
}

export interface OwnerChain {
  principal: string;
  genesis: string;
  /** Owner keys in order; the last one is current. */
  keys: OwnerKeyStep[];
  /** The latest recovery key the current owner key set, unless a recovery has used it since. */
  recovery?: { keyId: string; publicKey: string; n: string };
}

/**
 * Follows ownership through the ledger from what the entries themselves
 * prove, before any device trust: the first person entry's key, recovery
 * keys that the then-current owner key set, and owner.recovered entries that
 * the latest unused recovery key signed for exactly the entry before them.
 * Anything else is ignored here (and fails as an untrusted signature later).
 * Which chain counts is decided by the app's pinned owner key (keyTrust).
 */
export function ownerChain(entries: readonly LedgerEntry[]): OwnerChain | undefined {
  const firstIndex = entries.findIndex((entry) => entry.actor?.kind === "person" && typeof entry.actor.id === "string");
  if (firstIndex < 0) return undefined;
  const first = entries[firstIndex];
  if (!selfSigned(first)) return undefined;
  const chain: OwnerChain = {
    principal: principalOf(first.actor),
    genesis: entries[0].hash,
    keys: [{ keyId: first.sig!.key, publicKey: first.sig!.pub, from: firstIndex }],
  };
  for (let i = firstIndex + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.actor?.kind !== "person" || principalOf(entry.actor) !== chain.principal) continue;
    const current = chain.keys[chain.keys.length - 1];
    if (entry.type === "owner.recovery.set") {
      const data = entry.data ?? {};
      if (entry.sig?.key !== current.keyId || !selfSigned(entry)) continue;
      if (data.genesis !== chain.genesis || typeof data.recoveryPublicKey !== "string" || !isEd25519(data.recoveryPublicKey)) continue;
      if (data.recoveryKeyId !== keyIdOf(data.recoveryPublicKey)) continue;
      chain.recovery = { keyId: data.recoveryKeyId, publicKey: data.recoveryPublicKey, n: entry.n };
    } else if (entry.type === "owner.recovered") {
      const data = entry.data ?? {};
      const before = entries[i - 1];
      const head = data.head as { n?: unknown; hash?: unknown } | undefined;
      if (!chain.recovery || data.recoveryKeyId !== chain.recovery.keyId || data.genesis !== chain.genesis) continue;
      if (!head || head.n !== before.n || head.hash !== before.hash || entry.prev !== before.hash) continue;
      if (!selfSigned(entry) || entry.sig!.key !== data.newKeyId || entry.sig!.pub !== data.newPublicKey) continue;
      if (chain.keys.some((k) => k.keyId === data.newKeyId) || typeof data.recoverySignature !== "string") continue;
      const statement = recoveryStatement({ genesis: chain.genesis, head: { n: before.n, hash: before.hash }, newKeyId: data.newKeyId, recoveryKeyId: chain.recovery.keyId });
      if (!verifies(chain.recovery.publicKey, statement, data.recoverySignature)) continue;
      current.replacedAt = { index: i, n: entry.n };
      chain.keys.push({ keyId: data.newKeyId, publicKey: data.newPublicKey as string, from: i });
      chain.recovery = undefined; // single use
    }
  }
  return chain;
}

export interface RecoveryCheck {
  /** The project's owner, as the code proves it. */
  owner: string;
  /** The owner key in force before recovery. */
  ownerKey: string;
  /**
   * The ledger as it is on this computer, for the person to confirm before
   * recovering: the code proves where the history starts, not that nothing
   * was cut from its end.
   */
  head: { entries: number; n: string; hash: string; at: string; summary: string };
}

/** Checks a typed code against a ledger's entries; throws a plain-language LedgerError when it does not fit. */
export function checkRecoveryCode(entries: readonly LedgerEntry[], typed: string): RecoveryCheck {
  const secret = parseRecoveryCode(typed);
  try {
    const chain = ownerChain(entries);
    if (!chain) throw new LedgerError("RULE", "this ledger has no owner to recover");
    const key = deriveRecoveryKey(secret, chain.genesis);
    key.wipe();
    if (!chain.recovery || chain.recovery.keyId !== key.keyId) {
      throw new LedgerError(
        "RULE",
        "this code does not open this project: it may belong to another project, be an older code that was replaced, or have been used already",
      );
    }
    const last = entries[entries.length - 1];
    return {
      owner: chain.principal,
      ownerKey: chain.keys[chain.keys.length - 1].keyId,
      head: { entries: entries.length, n: last.n, hash: last.hash, at: last.at, summary: last.summary },
    };
  } finally {
    secret.fill(0);
  }
}

function selfSigned(entry: LedgerEntry): boolean {
  const sig = entry.sig;
  if (!sig || typeof sig.pub !== "string" || typeof sig.value !== "string" || keyIdOf(sig.pub) !== sig.key) return false;
  return verifies(sig.pub, signedBytes(entry), sig.value);
}

function verifies(publicKey: string, message: Buffer, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" && cryptoVerify(null, message, key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function isEd25519(publicKey: string): boolean {
  try {
    return createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function toBase32(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  for (let i = 0; i < BODY_CHARS; i += 1) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

function fromBase32(text: string): Buffer | undefined {
  let value = 0n;
  for (const c of text) value = (value << 5n) | BigInt(ALPHABET.indexOf(c));
  if (value >> BigInt(CODE_BYTES * 8) !== 0n) return undefined;
  return Buffer.from(value.toString(16).padStart(CODE_BYTES * 2, "0"), "hex");
}

/** Two characters (10 bits) from a hash of the code: a single typo slips through about once in a thousand. */
function checkChars(secret: Buffer): string {
  const digest = createHashOf(secret);
  const bits = (digest[0] << 2) | (digest[1] >> 6);
  return ALPHABET[bits >> 5] + ALPHABET[bits & 31];
}

function createHashOf(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from("pp-recovery-check", "utf8"), 2));
}
