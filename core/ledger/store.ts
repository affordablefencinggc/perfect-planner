import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledgerNumber } from "./chain";
import type { LedgerEntry } from "./types";

export interface LoadResult {
  entries: LedgerEntry[];
  /** A line that could not be read; entries holds everything before it. */
  parseError?: { n: string; detail: string };
  /** Last entry the writer recorded, used to detect a cut-off tail. */
  head?: { n: string; hash: string };
}

export interface LedgerStore {
  load(): LoadResult;
  append(entry: LedgerEntry): void;
  /** True when this process may write. */
  acquireWriter(): boolean;
  releaseWriter(): void;
  readonly description: string;
}

export class MemoryStore implements LedgerStore {
  readonly description = "memory";
  lines: string[] = [];
  head?: { n: string; hash: string };
  private locked = false;

  constructor(entries: LedgerEntry[] = []) {
    for (const entry of entries) this.lines.push(JSON.stringify(entry));
    const last = entries[entries.length - 1];
    if (last) this.head = { n: last.n, hash: last.hash };
  }

  load(): LoadResult {
    return { ...parseLines(this.lines.map((line) => ({ line }))), head: this.head };
  }

  append(entry: LedgerEntry): void {
    this.lines.push(JSON.stringify(entry));
    this.head = { n: entry.n, hash: entry.hash };
  }

  acquireWriter(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  releaseWriter(): void {
    this.locked = false;
  }
}

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

/**
 * One JSON line per entry in <root>/.perfect-planner/ledger/YYYY-MM.jsonl,
 * appended and fsynced, never rewritten (spec §2.6).
 */
export class FileStore implements LedgerStore {
  readonly dir: string;
  private readonly lockPath: string;
  private readonly headPath: string;
  private holdsLock = false;

  constructor(projectRoot: string) {
    this.dir = path.join(projectRoot, ".perfect-planner", "ledger");
    this.lockPath = path.join(this.dir, ".writer.lock");
    this.headPath = path.join(this.dir, "HEAD");
  }

  get description(): string {
    return this.dir;
  }

  monthFiles(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((name) => MONTH_FILE.test(name))
      .sort()
      .map((name) => path.join(this.dir, name));
  }

  load(): LoadResult {
    const lines: { line: string }[] = [];
    for (const file of this.monthFiles()) {
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() !== "") lines.push({ line });
      }
    }
    let head: LoadResult["head"];
    if (fs.existsSync(this.headPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.headPath, "utf8"));
        if (typeof parsed?.n === "string" && typeof parsed?.hash === "string") head = { n: parsed.n, hash: parsed.hash };
      } catch {
        // An unreadable HEAD is ignored; the chain itself is still checked.
      }
    }
    return { ...parseLines(lines), head };
  }

  append(entry: LedgerEntry): void {
    if (!this.holdsLock) throw new Error("FileStore.append without the writer lock");
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${entry.at.slice(0, 7)}.jsonl`);
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.writeFileSync(this.headPath, `${JSON.stringify({ n: entry.n, hash: entry.hash })}\n`);
  }

  acquireWriter(): boolean {
    if (this.holdsLock) return true;
    fs.mkdirSync(this.dir, { recursive: true });
    const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), since: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(this.lockPath, mine, { flag: "wx" });
        this.holdsLock = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!this.lockIsStale()) return false;
        fs.rmSync(this.lockPath, { force: true });
      }
    }
    return false;
  }

  releaseWriter(): void {
    if (!this.holdsLock) return;
    this.holdsLock = false;
    fs.rmSync(this.lockPath, { force: true });
  }

  /** A lock is stale only when its process is on this host and gone. */
  private lockIsStale(): boolean {
    let owner: { pid?: number; host?: string };
    try {
      owner = JSON.parse(fs.readFileSync(this.lockPath, "utf8"));
    } catch {
      return false;
    }
    if (owner.host !== os.hostname() || typeof owner.pid !== "number") return false;
    if (owner.pid === process.pid) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
}

function parseLines(lines: { line: string }[]): Omit<LoadResult, "head"> {
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      const entry = JSON.parse(lines[i].line) as LedgerEntry;
      if (!entry || typeof entry !== "object" || typeof entry.n !== "string") throw new Error("not an entry");
      entries.push(entry);
    } catch (error) {
      return { entries, parseError: { n: ledgerNumber(i + 1), detail: `line ${i + 1} is not a ledger entry: ${(error as Error).message}` } };
    }
  }
  return { entries };
}
