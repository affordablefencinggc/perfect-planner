// The copy of each ledger's head the app keeps outside the project folder (core/ledger HeadWitness).
// Agents can write inside a project folder, so a clean rollback there (an older, valid copy of the ledger
// and its HEAD put back) is only visible against something they cannot reach: this copy lives in the
// app's own data folder (baseRoot/witness/, next to the owner pins) and is signed with the app's system
// key, like the owner pin (core/host/owner.ts). A copy that is not signed by this app on this device is
// reported as unreadable (status.witnessProblem) and never overwritten. Deleting the copy is still
// possible for a process running as the same user; it raises the bar, it does not make rollback impossible.
import { createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FileHeadWitness, type HeadWitness, type WitnessedHead } from "../ledger/index";
import type { HostKeys } from "./keys";

const message = (id: string, head: WitnessedHead) => Buffer.from(JSON.stringify(["perfect-planner/head-witness/1", id, head.n, head.hash, head.entries]));

export function witnessDir(baseRoot: string): string {
  return path.join(baseRoot, "witness");
}

/** One signed JSON file per ledger copy, in the app's data folder, replaced atomically. */
export class SignedHeadWitness implements HeadWitness {
  readonly dir: string;

  constructor(dir: string, private readonly keys: HostKeys) {
    this.dir = dir;
  }

  get description(): string {
    return this.dir;
  }

  read(id: string): WitnessedHead | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.file(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: { n?: unknown; hash?: unknown; entries?: unknown; sig?: { key?: unknown; value?: unknown } };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("it is not valid JSON");
    }
    if (typeof parsed?.n !== "string" || typeof parsed?.hash !== "string" || !Number.isInteger(parsed?.entries)) throw new Error("it is missing its fields");
    const head = { n: parsed.n, hash: parsed.hash, entries: parsed.entries as number };
    const sig = parsed.sig;
    if (typeof sig?.key !== "string" || typeof sig?.value !== "string") throw new Error("it is not signed by this app");
    const system = this.keys.systemKey(sig.key);
    if (!system) throw new Error(`it is signed by key ${sig.key}, which is not this app's key on this device`);
    let ok = false;
    try {
      ok = verify(null, message(id, head), createPublicKey({ key: Buffer.from(system.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(sig.value, "base64"));
    } catch (error) {
      throw new Error(`its signature could not be checked (${(error as Error).message})`);
    }
    if (!ok) throw new Error("its signature does not match its content");
    return head;
  }

  write(id: string, head: WitnessedHead): void {
    const sig = this.keys.signForApp(message(id, head));
    if (!sig) throw new Error("this device has no key store to sign it with");
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ n: head.n, hash: head.hash, entries: head.entries, sig: { key: sig.keyId, value: sig.signature } })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private file(id: string): string {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new RangeError("a witness id is 64 hex characters");
    return path.join(this.dir, `${id}.json`);
  }
}

/** The witness the host opens every project with: signed when this device has a key store, plain otherwise. */
export function hostWitness(baseRoot: string, keys: HostKeys): HeadWitness {
  return keys.state().available ? new SignedHeadWitness(witnessDir(baseRoot), keys) : new FileHeadWitness(witnessDir(baseRoot));
}
