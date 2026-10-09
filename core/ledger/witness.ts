import fs from "node:fs";
import path from "node:path";

/**
 * A copy of the ledger's last entry kept outside the project folder (the
 * app's data folder), so cutting entries from the end of the ledger, and
 * its HEAD file with them, still shows on the next open. Keyed by the
 * ledger's genesis hash, so one folder serves every project. A process
 * running as the same user can still edit this copy too; it raises the bar,
 * it does not make truncation impossible.
 */
export interface HeadWitness {
  readonly description: string;
  read(genesis: string): WitnessedHead | undefined;
  write(genesis: string, head: WitnessedHead): void;
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

  read(genesis: string): WitnessedHead | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(genesis), "utf8"));
      if (typeof parsed?.n === "string" && typeof parsed?.hash === "string" && Number.isInteger(parsed?.entries)) {
        return { n: parsed.n, hash: parsed.hash, entries: parsed.entries };
      }
    } catch {
      // Missing or unreadable: no copy to compare against.
    }
    return undefined;
  }

  write(genesis: string, head: WitnessedHead): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(genesis);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ n: head.n, hash: head.hash, entries: head.entries })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private file(genesis: string): string {
    if (!/^[0-9a-f]{64}$/.test(genesis)) throw new RangeError("a ledger genesis hash is 64 hex characters");
    return path.join(this.dir, `${genesis}.json`);
  }
}

export class MemoryHeadWitness implements HeadWitness {
  readonly description = "memory";
  readonly heads = new Map<string, WitnessedHead>();

  read(genesis: string): WitnessedHead | undefined {
    const head = this.heads.get(genesis);
    return head && { ...head };
  }

  write(genesis: string, head: WitnessedHead): void {
    this.heads.set(genesis, { ...head });
  }
}
