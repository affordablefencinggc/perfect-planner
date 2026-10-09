// Perfect Planner strict ledger (Core Spec §2, §3). The ledger is the only source
// of truth: every board, task state, doc and release is a view rebuilt by replay().
//
//   const ledger = await openLedger(repoRoot, { now })
//   await ledger.append({ actor, type, subject, summary, reason?, evidence?, refs?, corrects?, data? })
//   ledger.entries() / ledger.board() / ledger.nextId("T") / ledger.verify()
//   ledger.subscribe(fn) / ledger.acknowledgeBreak(reason) / ledger.close()
//
// `data` is an optional structured payload (hashed with the entry) that replay
// reads for fields a one-line summary cannot carry (test command, question
// options, commit sha/files, release version...). See replay.mjs for fallbacks.
import fs from "node:fs";
import { canonicalJson, entryHash } from "./canonical.mjs";
import { formatEntryNumber, parseEntryNumber, SERIES } from "./ids.mjs";
import { applyEntry, replay } from "./replay.mjs";
import { ledgerError, normalizeAppendInput, validateEntry } from "./rules.mjs";
import { acquireLock, chainStatus, ledgerDirectory, LedgerWriter, readChain } from "./storage.mjs";

export { canonicalJson, entryHash } from "./canonical.mjs";
export { replay, createBoard, applyEntry } from "./replay.mjs";
export { formatStamp, formatEntryNumber, parseEntryNumber, parseTaskId, parseSeriesId, parseClauseSubject, taskAttemptId, SERIES } from "./ids.mjs";
export { ENTRY_TYPES, ACTOR_KINDS, requiresReason, doneBlocker, validateEntry, normalizeAppendInput } from "./rules.mjs";
export { ledgerDirectory, readChain } from "./storage.mjs";

const SYSTEM_ACTOR = Object.freeze({ kind: "system", id: "perfect-planner" });

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function resolveClock(now, clock) {
  const source = typeof clock === "function" ? clock : clock && typeof clock.now === "function" ? () => clock.now() : now;
  return () => {
    const value = source();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw ledgerError("LEDGER_CLOCK", "ledger clock returned an invalid date");
    return date;
  };
}

class Ledger {
  #directory;
  #lock;
  #writer;
  #now;
  #entries = [];
  #board;
  #last = null; // { n, hash, at }
  #status = { ok: true, breaks: [] };
  #subscribers = new Set();
  #queue = Promise.resolve();
  #closed = false;

  constructor({ directory, lock, now, chain }) {
    this.#directory = directory;
    this.#lock = lock;
    this.#now = now;
    this.#load(chain);
  }

  #load(chain) {
    this.#entries = chain.entries.map(deepFreeze);
    this.#board = replay(this.#entries);
    this.#last = chain.last;
    this.#status = chainStatus(chain.breaks);
    this.#writer?.close();
    this.#writer = new LedgerWriter(this.#directory, { lastFile: chain.files.at(-1) ?? null, lastFileNeedsNewline: chain.lastFileNeedsNewline });
  }

  get directory() { return this.#directory; }
  get closed() { return this.#closed; }

  append(input) {
    const run = this.#queue.then(() => this.#appendNow(input, { allowBroken: false }));
    this.#queue = run.catch(() => {});
    return run;
  }

  #assertOpen() {
    if (this.#closed) throw ledgerError("LEDGER_CLOSED", "ledger is closed");
  }

  #appendNow(input, { allowBroken }) {
    this.#assertOpen();
    if (!allowBroken && !this.#status.ok) {
      throw ledgerError("LEDGER_CHAIN_BROKEN", `ledger chain is broken at ${this.#status.firstBad} (${this.#status.reason}); writes are blocked until acknowledgeBreak(reason)`, { firstBad: this.#status.firstBad, reason: this.#status.reason });
    }
    const normalized = normalizeAppendInput(input);
    let at = this.#now().toISOString();
    if (this.#last?.at && at < this.#last.at) at = this.#last.at; // keep time (and month files) monotonic
    const candidate = {
      n: formatEntryNumber((this.#last?.n ?? 0) + 1),
      at,
      actor: normalized.actor,
      type: normalized.type,
      subject: normalized.subject,
      summary: normalized.summary,
      reason: normalized.reason,
      evidence: normalized.evidence,
      refs: normalized.refs,
      corrects: normalized.corrects,
      prev: this.#last?.hash ?? null,
    };
    if (normalized.data !== undefined) candidate.data = normalized.data;
    validateEntry(this.#board, candidate);
    candidate.hash = entryHash(candidate);
    this.#writer.write(canonicalJson(candidate), at);
    const entry = deepFreeze(candidate);
    this.#entries.push(entry);
    applyEntry(this.#board, entry);
    this.#last = { n: parseEntryNumber(entry.n), hash: entry.hash, at: entry.at };
    for (const subscriber of [...this.#subscribers]) {
      try { subscriber(entry); } catch { /* a failing view must never affect the ledger */ }
    }
    return entry;
  }

  entries() {
    return this.#entries.slice();
  }

  /** Current board (a fresh copy of the replayed view). */
  board() {
    return structuredClone(this.#board);
  }

  nextId(series) {
    if (series === "L") return formatEntryNumber((this.#last?.n ?? 0) + 1);
    if (!SERIES.includes(series)) throw ledgerError("LEDGER_RULE", `unknown id series "${series}"`, { rule: "series-unknown" });
    return `${series}-${this.#board.sequence[series] + 1}`;
  }

  /** Re-reads the files on disk and re-checks the whole chain. A break blocks writes. */
  verify() {
    const chain = readChain(this.#directory);
    let status = chainStatus(chain.breaks);
    const diskLast = chain.last?.hash ?? null;
    const memoryLast = this.#last?.hash ?? null;
    if (status.ok && diskLast !== memoryLast) {
      const memoryCount = this.#entries.length;
      const firstBad = chain.entries[memoryCount]?.n ?? formatEntryNumber((this.#last?.n ?? 0) + 1);
      status = { ok: false, firstBad, reason: "changed-outside-writer", breaks: status.breaks };
    }
    // Only acknowledgeBreak() clears a break; verify() can only report or raise one.
    if (!status.ok) this.#status = status;
    return { ...status, breaks: status.breaks.map((item) => ({ ...item })) };
  }

  /** Writes a correction entry acknowledging every open chain break, unblocking writes. */
  acknowledgeBreak(reason, { actor = SYSTEM_ACTOR } = {}) {
    const run = this.#queue.then(() => {
      this.#assertOpen();
      if (typeof reason !== "string" || reason.trim() === "") throw ledgerError("LEDGER_RULE", "acknowledgeBreak requires a non-empty reason", { rule: "reason-required" });
      const chain = readChain(this.#directory);
      const open = chain.breaks.filter((item) => !item.acknowledged);
      if (open.length === 0 && this.#status.ok) throw ledgerError("LEDGER_RULE", "there is no unacknowledged chain break", { rule: "no-break" });
      this.#load(chain);
      if (open.length === 0) {
        // The files changed outside this writer but still chain correctly: reload and record it.
        return this.#appendNow({ actor, type: "correction", subject: chain.entries.at(-1)?.n ?? "ledger", summary: "Reloaded a ledger that changed outside the single writer", reason, data: { acknowledgedBreaks: [] } }, { allowBroken: true });
      }
      const first = open[0];
      const knownEntry = chain.entries.some((entry) => entry.n === first.firstBad);
      const entry = this.#appendNow({
        actor,
        type: "correction",
        subject: first.firstBad,
        summary: `Acknowledged ${open.length} ledger chain break(s) starting at ${first.firstBad} (${first.reason})`,
        reason,
        evidence: open.map((item) => `${item.file}:${item.line}`),
        corrects: knownEntry ? first.firstBad : null,
        data: { acknowledgedBreaks: open.map((item) => ({ firstBad: item.firstBad, lineSha: item.lineSha, reason: item.reason, file: item.file, line: item.line })) },
      }, { allowBroken: true });
      this.#load(readChain(this.#directory));
      if (!this.#status.ok) throw ledgerError("LEDGER_CHAIN_BROKEN", `chain still broken at ${this.#status.firstBad} after acknowledgement`, { firstBad: this.#status.firstBad });
      return entry;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  subscribe(fn) {
    if (typeof fn !== "function") throw new TypeError("subscribe(fn) requires a function");
    this.#subscribers.add(fn);
    return () => { this.#subscribers.delete(fn); };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#writer?.close();
    this.#lock.release();
    this.#subscribers.clear();
  }
}

export async function openLedger(repoRoot, { now = () => new Date(), clock } = {}) {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "") throw new TypeError("openLedger(repoRoot) requires a repository path");
  const directory = ledgerDirectory(repoRoot);
  fs.mkdirSync(directory, { recursive: true });
  const lock = acquireLock(directory);
  try {
    const chain = readChain(directory);
    return new Ledger({ directory, lock, now: resolveClock(now, clock), chain });
  } catch (error) {
    lock.release();
    throw error;
  }
}

