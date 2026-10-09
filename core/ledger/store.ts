import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledgerNumber } from "./chain";
import { excludePrivateFolder } from "./ignore";
import { MemoryKeyProvider, type KeyProvider } from "./signing";
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
  /**
   * Persists one entry. `previous` is the entry the writer believes is last;
   * a store that can see it changed underneath throws instead of forking.
   */
  append(entry: LedgerEntry, previous?: { n: string; hash: string }): void;
  /**
   * Writer only, before load: repairs a final line cut short by a crash
   * mid-write and returns what it did, or undefined when nothing was torn.
   */
  repairTornTail?(): string | undefined;
  /** Records the last entry as the head, when a crash left the head behind the entries. */
  resetHead(head: { n: string; hash: string }): void;
  /** True when this process may write. */
  acquireWriter(): boolean;
  releaseWriter(): void;
  readonly description: string;
  /** Keys used when Ledger.open is given none; only MemoryStore has them (test keys). */
  readonly defaultKeys?: KeyProvider;
}

export class MemoryStore implements LedgerStore {
  readonly description = "memory";
  /** Test keys shared by every ledger opened on this store; nothing in memory is persisted. */
  readonly defaultKeys = new MemoryKeyProvider();
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

  append(entry: LedgerEntry, previous?: { n: string; hash: string }): void {
    if (!sameHead(this.head, previous)) throw new Error("the ledger changed underneath this writer");
    this.lines.push(JSON.stringify(entry));
    this.head = { n: entry.n, hash: entry.hash };
  }

  resetHead(head: { n: string; hash: string }): void {
    this.head = { ...head };
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
  private readonly projectRoot: string;
  private excluded = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.dir = path.join(projectRoot, ".perfect-planner", "ledger");
    this.lockPath = path.join(this.dir, ".writer.lock");
    this.headPath = path.join(this.dir, "HEAD");
  }

  get description(): string {
    return this.dir;
  }

  /** Creates the ledger folder and, inside a git repo, keeps .perfect-planner/ out of commits first. */
  private makeDir(): void {
    if (!this.excluded) {
      excludePrivateFolder(this.projectRoot);
      this.excluded = true;
    }
    fs.mkdirSync(this.dir, { recursive: true });
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
    return { ...parseLines(lines), head: this.readHead() };
  }

  private readHead(): LoadResult["head"] {
    if (!fs.existsSync(this.headPath)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.headPath, "utf8"));
      if (typeof parsed?.n === "string" && typeof parsed?.hash === "string") return { n: parsed.n, hash: parsed.hash };
    } catch {
      // An unreadable HEAD is ignored on load; the chain itself is still checked.
    }
    return undefined;
  }

  append(entry: LedgerEntry, previous?: { n: string; hash: string }): void {
    if (!this.holdsLock) throw new Error("FileStore.append without the writer lock");
    this.makeDir();
    if (!sameHead(this.readHead(), previous)) {
      throw new Error(`the ledger files changed underneath this writer (expected head ${previous?.n ?? "none"})`);
    }
    const file = path.join(this.dir, `${entry.at.slice(0, 7)}.jsonl`);
    const fd = fs.openSync(file, "a");
    try {
      writeAll(fd, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.writeHead({ n: entry.n, hash: entry.hash });
  }

  /** HEAD is replaced atomically: written to a temp file, fsynced, then renamed over. */
  private writeHead(head: { n: string; hash: string }): void {
    const tmp = `${this.headPath}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      writeAll(fd, `${JSON.stringify(head)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.headPath);
  }

  repairTornTail(): string | undefined {
    if (!this.holdsLock) throw new Error("FileStore.repairTornTail without the writer lock");
    const file = this.monthFiles().at(-1);
    if (!file) return undefined;
    const text = fs.readFileSync(file, "utf8");
    if (text === "" || text.endsWith("\n")) return undefined;
    const cut = text.lastIndexOf("\n") + 1;
    const tail = text.slice(cut);
    try {
      const entry = JSON.parse(tail);
      if (entry && typeof entry.n === "string" && typeof entry.hash === "string") {
        fs.appendFileSync(file, "\n");
        return `completed ${entry.n}, whose line was written without its newline`;
      }
    } catch {
      // Not a whole entry: the write was cut short.
    }
    const saved = path.join(this.dir, `torn-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
    fs.writeFileSync(saved, tail);
    fs.truncateSync(file, Buffer.byteLength(text.slice(0, cut), "utf8"));
    return `dropped an incomplete final line (${Buffer.byteLength(tail, "utf8")} bytes, kept in ${path.basename(saved)})`;
  }

  resetHead(head: { n: string; hash: string }): void {
    if (!this.holdsLock) throw new Error("FileStore.resetHead without the writer lock");
    this.writeHead(head);
  }

  acquireWriter(): boolean {
    if (this.holdsLock) return false;
    this.makeDir();
    const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), since: new Date().toISOString() });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.writeFileSync(this.lockPath, mine, { flag: "wx" });
        this.holdsLock = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stale = this.staleLockContent();
        if (stale === undefined) return false;
        this.takeOverStaleLock(stale);
      }
    }
    return false;
  }

  /**
   * Moves a stale lock aside atomically. Two processes racing here cannot
   * both win: only one rename of the same file succeeds, and a rename that
   * caught a fresh lock instead of the stale one puts it back.
   */
  private takeOverStaleLock(stale: string): void {
    const aside = `${this.lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      fs.renameSync(this.lockPath, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // someone else moved it first
      throw error;
    }
    if (fs.readFileSync(aside, "utf8") === stale) {
      fs.rmSync(aside, { force: true });
      return;
    }
    // We moved another process's fresh lock: restore it unless a newer one already exists.
    try {
      fs.linkSync(aside, this.lockPath);
    } catch {
      // A lock exists again; ours to drop.
    }
    fs.rmSync(aside, { force: true });
  }

  releaseWriter(): void {
    if (!this.holdsLock) return;
    this.holdsLock = false;
    fs.rmSync(this.lockPath, { force: true });
  }

  /** The lock's content when it is stale (its process is on this host and gone), else undefined. */
  private staleLockContent(): string | undefined {
    let text: string;
    let owner: { pid?: number; host?: string };
    try {
      text = fs.readFileSync(this.lockPath, "utf8");
      owner = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (owner.host !== os.hostname() || typeof owner.pid !== "number") return undefined;
    if (owner.pid === process.pid) return undefined;
    try {
      process.kill(owner.pid, 0);
      return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? text : undefined;
    }
  }
}

function writeAll(fd: number, text: string): void {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}

function sameHead(a?: { n: string; hash: string }, b?: { n: string; hash: string }): boolean {
  if (!a || !b) return !a && !b;
  return a.n === b.n && a.hash === b.hash;
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
