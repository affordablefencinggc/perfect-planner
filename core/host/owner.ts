// The project's owner key, pinned outside the ledger (core/ledger README "The owner"). The pin lives in
// the app's own data folder, outside every repo and worktree, and is keyed by the hash of the ledger's
// first entry (its genesis): moving or renaming the project folder keeps the genesis, so the pin is still
// found; a rewritten or swapped ledger has another genesis and matches no pin. Each pin is signed with the
// app's system key from the keychain, over the genesis hash, the owner key id and the principal.
//
// The app also remembers which genesis each folder held. A folder whose ledger was deleted or swapped is
// reported as replaced and never treated as a fresh project that the next person write would pin again.
//
// Only the host writes pins, and only after a write from the person's own window (host.ts). Every open
// passes the pinned key as Ledger.open({ ownerKey }).
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HostKeys } from "./keys";

export type OwnerPinState =
  /** A signed pin for this ledger's genesis, and its key is on this device. */
  | "pinned"
  /** Nobody has written to this ledger as a person: it opens with this device's person key, pinned on the first write. */
  | "new"
  /** The ledger has person entries but no pin on this device (made elsewhere, or before owners were pinned). */
  | "missing"
  /** A pin file that is not signed by this app on this device, or does not match this ledger. */
  | "tampered"
  /** The pinned owner key is not on this device. */
  | "key-missing"
  /** This folder held another ledger before: it was deleted or swapped. */
  | "replaced"
  /** No key store on this device. */
  | "unavailable";

export interface OwnerPin {
  ownerKey?: string;
  /** Whose key it is, e.g. "person:owner". */
  principal?: string;
  state: OwnerPinState;
  reason?: string;
  /** The ledger's first entry hash, when it has one. */
  genesis?: string;
}

interface PinFile {
  genesis: string;
  ownerKey: string;
  principal: string;
  at: string;
  /** Where the folder was when the pin was made. A hint for people only; never checked. */
  ledger: string;
  sig: { key: string; value: string };
}

interface FolderFile {
  folder: string;
  genesis: string;
  sig: { key: string; value: string };
}

const HASH = /^[0-9a-f]{64}$/;

/** The real path of a ledger folder. */
export function ledgerFolder(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

export function ownerPinFile(baseRoot: string, genesis: string): string {
  return path.join(baseRoot, "owners", `${genesis}.json`);
}

function folderFile(baseRoot: string, root: string): string {
  const id = createHash("sha256").update(ledgerFolder(root)).digest("hex").slice(0, 24);
  return path.join(baseRoot, "owners", "folders", `${id}.json`);
}

const pinMessage = (pin: Pick<PinFile, "genesis" | "ownerKey" | "principal" | "at">) =>
  Buffer.from(JSON.stringify(["perfect-planner/owner-pin/5", pin.genesis, pin.ownerKey, pin.principal, pin.at]));
const folderMessage = (record: Pick<FolderFile, "folder" | "genesis">) => Buffer.from(JSON.stringify(["perfect-planner/owner-folder/1", record.folder, record.genesis]));

function signedByApp(keys: HostKeys, message: Buffer, sig: { key?: unknown; value?: unknown } | undefined): string | null {
  if (typeof sig?.key !== "string" || typeof sig?.value !== "string") return "it is not signed by this app";
  const system = keys.systemKey(sig.key);
  if (!system) return `it is signed by key ${sig.key}, which is not this app's key on this device`;
  try {
    const ok = verify(null, message, createPublicKey({ key: Buffer.from(system.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(sig.value, "base64"));
    return ok ? null : "its signature does not match its content";
  } catch (error) {
    return `its signature could not be checked (${(error as Error).message})`;
  }
}

function readJson<T>(file: string): Partial<T> | "absent" | "unreadable" {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return "absent";
  }
  try {
    return JSON.parse(raw) as Partial<T>;
  } catch {
    return "unreadable";
  }
}

/** The genesis this folder held when it was last pinned on this device, if the app remembers one (signed). */
export function rememberedGenesis(baseRoot: string, root: string, keys: HostKeys): string | undefined {
  const record = readJson<FolderFile>(folderFile(baseRoot, root));
  if (record === "absent" || record === "unreadable") return undefined;
  if (record.folder !== ledgerFolder(root) || typeof record.genesis !== "string" || !HASH.test(record.genesis)) return undefined;
  return signedByApp(keys, folderMessage(record as FolderFile), record.sig) ? undefined : record.genesis;
}

/** Reads and checks the pin for a ledger's genesis. Never trusts an unsigned or wrongly signed file. */
export function readOwnerPin(baseRoot: string, genesis: string, keys: HostKeys): OwnerPin {
  const pin = readJson<PinFile>(ownerPinFile(baseRoot, genesis));
  if (pin === "absent") return { state: "missing", genesis };
  if (pin === "unreadable") return { state: "tampered", genesis, reason: "The owner pin file cannot be read." };
  if (pin.genesis !== genesis || typeof pin.ownerKey !== "string" || typeof pin.principal !== "string" || typeof pin.at !== "string") {
    return { state: "tampered", genesis, reason: "The owner pin does not belong to this project's ledger." };
  }
  const problem = signedByApp(keys, pinMessage(pin as PinFile), pin.sig);
  if (problem) return { state: "tampered", genesis, reason: `The owner pin is not trusted: ${problem}.` };
  if (!keys.trustedKeys().some((k) => k.keyId === pin.ownerKey)) {
    return { ownerKey: pin.ownerKey, principal: pin.principal, state: "key-missing", genesis, reason: `The owner's key ${pin.ownerKey} is not on this device.` };
  }
  return { ownerKey: pin.ownerKey, principal: pin.principal, state: "pinned", genesis };
}

/**
 * Pins the owner key for a ledger's genesis and remembers that this folder holds it. Called by the host
 * only after a write from the person's own window, on a ledger nobody had written to as a person before.
 */
export function writeOwnerPin(baseRoot: string, root: string, genesis: string, keys: HostKeys, ownerKey: string, principal: string, now = new Date()): boolean {
  const body = { genesis, ownerKey, principal, at: now.toISOString(), ledger: ledgerFolder(root) };
  const sig = keys.signForApp(pinMessage(body));
  if (!sig) return false;
  const file = ownerPinFile(baseRoot, genesis);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...body, sig: { key: sig.keyId, value: sig.signature } }, null, 2)}\n`);
  rememberFolder(baseRoot, root, genesis, keys);
  return true;
}

/** Remembers (signed) which genesis this folder holds, so a deleted or swapped ledger is noticed. */
export function rememberFolder(baseRoot: string, root: string, genesis: string, keys: HostKeys): void {
  const record = { folder: ledgerFolder(root), genesis };
  const sig = keys.signForApp(folderMessage(record));
  if (!sig) return;
  const file = folderFile(baseRoot, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...record, sig: { key: sig.keyId, value: sig.signature } }, null, 2)}\n`);
}
