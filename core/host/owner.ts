// The project's owner key, pinned outside the ledger (core/ledger README "The owner"). The app makes
// the owner's key when it creates a project and keeps its id here, in its own data folder, signed with
// the app's system key from the keychain. Every open passes it as Ledger.open({ ownerKey }).
//
// Anyone who can write files could write a ledger's first person line, or this file. A pin whose
// signature does not check out against this device's system key is ignored, so the project opens
// with no owner (nobody can enrol helpers) and status says the pin was tampered with, instead of
// trusting whoever wrote the file.
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HostKeys } from "./keys";

export type OwnerPinState = "pinned" | "created" | "missing" | "tampered" | "key-missing" | "unavailable";

export interface OwnerPin {
  ownerKey?: string;
  /** Whose key it is, e.g. "person:owner". */
  principal?: string;
  state: OwnerPinState;
  reason?: string;
}

interface PinFile {
  project: string;
  /** The ledger folder this pin is for (real path): a pin never carries over to another folder. */
  ledger: string;
  ownerKey: string;
  principal: string;
  at: string;
  sig: { key: string; value: string };
}

/** The real path of a ledger folder, as pins name it. */
export function ledgerFolder(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

/** One pin per project key and ledger folder, so pointing a project at a new folder starts a new owner. */
export function ownerPinFile(baseRoot: string, key: string, root: string): string {
  const folder = createHash("sha256").update(ledgerFolder(root)).digest("hex").slice(0, 16);
  return path.join(baseRoot, "owners", `${key}-${folder}.json`);
}

const signed = (pin: Omit<PinFile, "sig">) => Buffer.from(JSON.stringify(["perfect-planner/owner-pin/2", pin.project, pin.ledger, pin.ownerKey, pin.principal, pin.at]));

/** Reads and checks the pin. Never trusts an unsigned or wrongly signed file. */
export function readOwnerPin(baseRoot: string, key: string, root: string, keys: HostKeys): OwnerPin {
  let raw: string;
  try {
    raw = fs.readFileSync(ownerPinFile(baseRoot, key, root), "utf8");
  } catch {
    return { state: "missing" };
  }
  let pin: Partial<PinFile>;
  try {
    pin = JSON.parse(raw) as Partial<PinFile>;
  } catch {
    return { state: "tampered", reason: "The owner pin file cannot be read." };
  }
  if (typeof pin.ownerKey !== "string" || typeof pin.principal !== "string" || typeof pin.at !== "string" || pin.project !== key || pin.ledger !== ledgerFolder(root) || typeof pin.sig?.key !== "string" || typeof pin.sig?.value !== "string") {
    return { state: "tampered", reason: "The owner pin file is not signed by this app." };
  }
  const system = keys.systemKey(pin.sig.key);
  if (!system) return { state: "tampered", reason: `The owner pin is signed by key ${pin.sig.key}, which is not this app's key on this device.` };
  try {
    const ok = verify(null, signed(pin as PinFile), createPublicKey({ key: Buffer.from(system.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(pin.sig.value, "base64"));
    if (!ok) return { state: "tampered", reason: "The owner pin's signature does not match its content." };
  } catch (error) {
    return { state: "tampered", reason: `The owner pin's signature could not be checked (${(error as Error).message}).` };
  }
  if (!keys.trustedKeys().some((k) => k.keyId === pin.ownerKey)) {
    return { ownerKey: pin.ownerKey, principal: pin.principal, state: "key-missing", reason: `The owner's key ${pin.ownerKey} is not on this device.` };
  }
  return { ownerKey: pin.ownerKey, principal: pin.principal, state: "pinned" };
}

/** Makes the owner's key and writes the signed pin, for a project nobody has written to as a person yet. */
/**
 * Makes the owner's key and writes the signed pin, for a project nobody has written to as a person yet.
 * replace: overwrite an earlier pin (only for a ledger with no person entries, where it protects nothing).
 */
export function createOwnerPin(baseRoot: string, key: string, root: string, keys: HostKeys, principal: string, now = new Date(), replace = false): OwnerPin {
  const ownerKey = keys.ownerKeyFor(principal);
  if (!ownerKey) return { state: "unavailable", reason: "This device has no key store, so the project has no owner." };
  const body = { project: key, ledger: ledgerFolder(root), ownerKey, principal, at: now.toISOString() };
  const sig = keys.signForApp(signed(body));
  if (!sig) return { state: "unavailable", reason: "This device has no key store, so the project has no owner." };
  const file = ownerPinFile(baseRoot, key, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...body, sig: { key: sig.keyId, value: sig.signature } }, null, 2)}\n`, { flag: replace ? "w" : "wx" });
  return { ownerKey, principal, state: "created" };
}
