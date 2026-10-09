import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./chain";

/**
 * A copy of the ledger's last entry kept outside the project folder (the
 * app's data folder), so cutting entries from the end of the ledger, and
 * its HEAD file with them, still shows on the next open. The ledger keys
 * each copy by its genesis hash and folder, so one data folder serves every
 * project and every copy of one. A process
 * running as the same user can still edit this copy too; it raises the bar,
 * it does not make truncation impossible.
 */
export interface HeadWitness {
  readonly description: string;
  /** The recorded head, undefined when there is none; throws when a copy exists but cannot be read. */
  read(id: string): WitnessedHead | undefined;
  write(id: string, head: WitnessedHead): void;
}

/** The id one copy of a ledger is kept under: its genesis hash and the store's folder. */
export function witnessIdFor(genesis: string, storeDescription: string): string {
  return sha256(`${genesis}\n${storeDescription}`);
}

export interface WitnessedHead {
  n: string;
  hash: string;
  /** How many entries the ledger had. */
  entries: number;
}

/** One small JSON file per project in `dir`, replaced atomically. */
export class FileHeadWitness implements HeadWitness {
  readonly dir: string;

  constructor(dir: string) {
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
    let parsed: { n?: unknown; hash?: unknown; entries?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("it is not valid JSON");
    }
    if (typeof parsed?.n !== "string" || typeof parsed?.hash !== "string" || !Number.isInteger(parsed?.entries)) throw new Error("it is missing its fields");
    return { n: parsed.n, hash: parsed.hash, entries: parsed.entries as number };
  }

  write(id: string, head: WitnessedHead): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ n: head.n, hash: head.hash, entries: head.entries })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private file(id: string): string {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new RangeError("a witness id is 64 hex characters");
    return path.join(this.dir, `${id}.json`);
  }
}

export class MemoryHeadWitness implements HeadWitness {
  readonly description = "memory";
  readonly heads = new Map<string, WitnessedHead>();

  read(id: string): WitnessedHead | undefined {
    const head = this.heads.get(id);
    return head && { ...head };
  }

  write(id: string, head: WitnessedHead): void {
    this.heads.set(id, { ...head });
  }
}
