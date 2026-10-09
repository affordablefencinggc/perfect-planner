import { createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { canonicalJson } from "./chain";
import { keyFromData, keyIdOf, principalOf, signedBytes } from "./signing";
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

/**
 * Where the app mounts the screens that show or take a recovery code. Evidence
 * capture (src/node/screenshotEvidence.mjs) refuses any address naming it.
 */
export const OWNER_RECOVERY_PATH = "/owner-recovery";
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
 * The Ed25519 key a code derives for one project: HKDF-SHA256 salted with the
 * project's root, which is the hash of the ledger's first person entry and the
 * key that signed it (see OwnerChain.root). That entry is the owner's own,
 * signed, and its hash covers everything before it, so a code means nothing
 * in another project or in a ledger rewritten from that point under another key.
 */
export function deriveRecoveryKey(secret: Buffer, root: string): RecoveryKey {
  const seed = Buffer.from(hkdfSync("sha256", secret, Buffer.from(`pp-project:${root}`, "utf8"), Buffer.from(INFO, "utf8"), 32));
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
export function recoveryStatement(data: { root: string; head: { n: string; hash: string }; newKeyId: string; recoveryKeyId: string }): Buffer {
  return Buffer.from(
    canonicalJson({ v: INFO, root: data.root, head: { n: data.head.n, hash: data.head.hash }, newKeyId: data.newKeyId, recoveryKeyId: data.recoveryKeyId }),
    "utf8",
  );
}

export interface OwnerKeyStep {
  keyId: string;
  publicKey: string;
  /** Index of the entry that made this an owner key. */
  from: number;
  /**
   * The entry that stopped it: a key.retired (a rotation, or a lost key) or
   * an owner.recovered (another computer took over). Nothing it signs after
   * that counts.
   */
  replacedAt?: { index: number; n: string; by: "retired" | "recovered" };
}

export interface OwnerChain {
  principal: string;
  /** "<hash of the first person entry>/<the key id that signed it>": what a code is bound to. */
  root: string;
  /** Every key that was ever an owner key, in the order it became one. */
  keys: OwnerKeyStep[];
  /** Owner keys in force at the end of the ledger. */
  active: string[];
  /** The latest recovery key an owner key set, unless a recovery has used it since. */
  recovery?: { keyId: string; publicKey: string; n: string };
  /** Each owner.recovered, in order. */
  recoveries: { index: number; n: string; keyId: string }[];
}

/**
 * Follows ownership through the ledger from what the entries themselves
 * prove, before any device trust. The first person entry's key starts it.
 * After that, an owner key in force may:
 * - add an owner key (key.trusted for the owner, as in a rotation or a
 *   second device);
 * - retire one (key.retired), which stops it for good;
 * - set the recovery key (owner.recovery.set).
 * An owner.recovered that the latest unused recovery key signed for exactly
 * the entry before it replaces every owner key in force with the new
 * computer's key. Anything else is ignored here, and fails as an untrusted
 * signature later. Which chain counts is decided by the app's pinned owner
 * key (keyTrust).
 */
export function ownerChain(entries: readonly LedgerEntry[]): OwnerChain | undefined {
  const firstIndex = entries.findIndex((entry) => entry.actor?.kind === "person" && typeof entry.actor.id === "string");
  if (firstIndex < 0) return undefined;
  const first = entries[firstIndex];
  if (!selfSigned(first)) return undefined;
  const chain: OwnerChain = {
    principal: principalOf(first.actor),
    root: `${first.hash}/${first.sig!.key}`,
    keys: [{ keyId: first.sig!.key, publicKey: first.sig!.pub, from: firstIndex }],
    active: [first.sig!.key],
    recoveries: [],
  };
  const step = (keyId: unknown) => chain.keys.find((k) => k.keyId === keyId);
  const stop = (keyId: string, index: number, n: string, by: "retired" | "recovered") => {
    const k = step(keyId);
    if (k && !k.replacedAt) k.replacedAt = { index, n, by };
    chain.active = chain.active.filter((id) => id !== keyId);
  };
  for (let i = firstIndex + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.actor?.kind !== "person" || principalOf(entry.actor) !== chain.principal) continue;
    const data = entry.data ?? {};
    // Every change below except owner.recovered must be signed by an owner key in force.
    const byOwner = typeof entry.sig?.key === "string" && chain.active.includes(entry.sig.key) && selfSigned(entry);
    if (entry.type === "key.trusted") {
      const key = keyFromData(data);
      if (!byOwner || !key || key.principal !== chain.principal || step(key.keyId)) continue;
      chain.keys.push({ keyId: key.keyId, publicKey: key.publicKey, from: i });
      chain.active.push(key.keyId);
    } else if (entry.type === "key.retired") {
      if (!byOwner || typeof data.keyId !== "string" || !chain.active.includes(data.keyId)) continue;
      stop(data.keyId, i, entry.n, "retired");
    } else if (entry.type === "owner.recovery.set") {
      if (!byOwner || data.root !== chain.root || typeof data.recoveryPublicKey !== "string" || !isEd25519(data.recoveryPublicKey)) continue;
      if (data.recoveryKeyId !== keyIdOf(data.recoveryPublicKey)) continue;
      chain.recovery = { keyId: data.recoveryKeyId, publicKey: data.recoveryPublicKey, n: entry.n };
    } else if (entry.type === "owner.recovered") {
      const before = entries[i - 1];
      const head = data.head as { n?: unknown; hash?: unknown } | undefined;
      if (!chain.recovery || data.recoveryKeyId !== chain.recovery.keyId || data.root !== chain.root) continue;
      if (!head || head.n !== before.n || head.hash !== before.hash || entry.prev !== before.hash) continue;
      if (!selfSigned(entry) || entry.sig!.key !== data.newKeyId || entry.sig!.pub !== data.newPublicKey) continue;
      if (step(data.newKeyId) || typeof data.recoverySignature !== "string") continue;
      const statement = recoveryStatement({ root: chain.root, head: { n: before.n, hash: before.hash }, newKeyId: data.newKeyId, recoveryKeyId: chain.recovery.keyId });
      if (!verifies(chain.recovery.publicKey, statement, data.recoverySignature)) continue;
      for (const keyId of [...chain.active]) stop(keyId, i, entry.n, "recovered");
      chain.keys.push({ keyId: data.newKeyId, publicKey: data.newPublicKey as string, from: i });
      chain.active = [data.newKeyId];
      chain.recoveries.push({ index: i, n: entry.n, keyId: data.newKeyId });
      chain.recovery = undefined; // single use
    }
  }
  return chain;
}

export interface RecoveryCheck {
  /** The project's owner, as the code proves it. */
  owner: string;
  /** The owner keys in force before recovery. */
  ownerKeys: string[];
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
    const key = deriveRecoveryKey(secret, chain.root);
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
      ownerKeys: [...chain.active],
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

/**
 * Two characters holding the code's value mod 1021 (a prime below 32²): any
 * single wrong character or swap of two neighbours changes it, so such typos
 * are always caught.
 */
function checkChars(secret: Buffer): string {
  const value = Number(BigInt(`0x${secret.toString("hex")}`) % 1021n);
  return ALPHABET[value >> 5] + ALPHABET[value & 31];
}
