// Ledger storage (Core Spec §2): one canonical JSON line per entry in
// <repo>/.perfect-planner/ledger/YYYY-MM.jsonl, a single writer guarded by an
// exclusive lock file (pid + host + token, stale-lock detection), crash-safe
// appends (one write + fsync), and full hash-chain verification on read.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryHash, sha256Hex } from "./canonical.mjs";
import { formatEntryNumber, parseEntryNumber } from "./ids.mjs";
import { ledgerError } from "./rules.mjs";

const MONTH_FILE_RE = /^(\d{4})-(\d{2})\.jsonl$/;
export const LOCK_FILE = "ledger.lock";

export function ledgerDirectory(repoRoot) {
  return path.join(path.resolve(repoRoot), ".perfect-planner", "ledger");
}

export function monthFileName(at) {
  return `${at.slice(0, 7)}.jsonl`;
}

export function listMonthFiles(directory) {
  let names;
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter((name) => MONTH_FILE_RE.test(name)).sort();
}

function isEntryShape(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && parseEntryNumber(value.n) !== null
    && typeof value.at === "string"
    && value.actor && typeof value.actor === "object" && typeof value.actor.kind === "string" && typeof value.actor.id === "string"
    && typeof value.type === "string" && typeof value.subject === "string" && typeof value.summary === "string"
    && (value.prev === null || typeof value.prev === "string")
    && typeof value.hash === "string" && /^[0-9a-f]{64}$/.test(value.hash)
    && Array.isArray(value.evidence) && Array.isArray(value.refs);
}

/**
 * Reads every month file in order and re-checks the whole chain.
 * Returns { entries, breaks, rejected, last, files, lastFileNeedsNewline }.
 * `entries` holds only lines that pass every check; a parseable line that fails
 * the hash, prev or sequence check is listed in `rejected` ({ entry, ...break })
 * and is never replayed, acknowledged or not (a forged line must not reach the board).
 * A break is { firstBad, reason, file, line, lineSha, acknowledged }.
 * Acknowledged breaks are those named by a later, valid correction entry's
 * data.acknowledgedBreaks ({ firstBad, lineSha }).
 */
export function readChain(directory) {
  const files = listMonthFiles(directory);
  const entries = [];
  const breaks = [];
  const rejectedEntries = new Map(); // break -> parsed entry
  const acknowledgements = new Set();
  let last = null; // { n: number, hash, at }
  let lastFileNeedsNewline = false;

  files.forEach((name, fileIndex) => {
    const filePath = path.join(directory, name);
    const text = fs.readFileSync(filePath, "utf8");
    const endsWithNewline = text.length === 0 || text.endsWith("\n");
    const lines = text.split("\n");
    if (endsWithNewline) lines.pop();
    const isLastFile = fileIndex === files.length - 1;
    if (isLastFile) lastFileNeedsNewline = !endsWithNewline;

    lines.forEach((rawLine, lineIndex) => {
      const raw = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (raw.trim() === "") return;
      const expected = last ? last.n + 1 : 1;
      const where = { file: name, line: lineIndex + 1, lineSha: sha256Hex(raw) };
      const isFinalLine = isLastFile && lineIndex === lines.length - 1 && !endsWithNewline;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      if (!isEntryShape(parsed)) {
        breaks.push({ firstBad: formatEntryNumber(expected), reason: parsed === undefined ? (isFinalLine ? "torn-last-line" : "unparseable-line") : "malformed-entry", ...where });
        return;
      }
      const number = parseEntryNumber(parsed.n);
      const problems = [];
      if (entryHash(parsed) !== parsed.hash) problems.push("hash-mismatch");
      if (parsed.prev !== (last ? last.hash : null)) problems.push("prev-mismatch");
      if (number !== expected) problems.push("number-out-of-sequence");
      // The chain position still advances past a rejected line (the next line's prev
      // names its stored hash), so one bad line is reported once, not cascaded.
      last = { n: number, hash: parsed.hash, at: parsed.at };
      if (problems.length) {
        const item = { firstBad: parsed.n, reason: problems.join("+"), ...where };
        breaks.push(item);
        rejectedEntries.set(item, parsed);
        return;
      }
      if (parsed.type === "correction" && Array.isArray(parsed.data?.acknowledgedBreaks)) {
        for (const ack of parsed.data.acknowledgedBreaks) if (ack && ack.firstBad && ack.lineSha) acknowledgements.add(`${ack.firstBad}|${ack.lineSha}`);
      }
      entries.push(parsed);
    });
  });

  for (const item of breaks) item.acknowledged = acknowledgements.has(`${item.firstBad}|${item.lineSha}`);
  const rejected = [...rejectedEntries].map(([item, entry]) => ({ ...item, entry }));
  return { entries, breaks, rejected, last, files, lastFileNeedsNewline };
}

export function chainStatus(breaks) {
  const open = breaks.filter((item) => !item.acknowledged);
  if (open.length === 0) return { ok: true, breaks: breaks.map((item) => ({ ...item })) };
  return { ok: false, firstBad: open[0].firstBad, reason: open[0].reason, breaks: breaks.map((item) => ({ ...item })) };
}

/** Append-only writer: keeps the current month file open, fsyncs every line. */
export class LedgerWriter {
  constructor(directory, { lastFile = null, lastFileNeedsNewline = false } = {}) {
    this.directory = directory;
    this.currentName = null;
    this.fd = null;
    this.pendingNewline = new Set(lastFile && lastFileNeedsNewline ? [lastFile] : []);
  }

  write(line, at) {
    const name = monthFileName(at);
    if (name !== this.currentName) this.#openFile(name);
    const prefix = this.pendingNewline.has(name) ? "\n" : "";
    const buffer = Buffer.from(`${prefix}${line}\n`, "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(this.fd, buffer, offset, buffer.length - offset);
    fs.fsyncSync(this.fd);
    this.pendingNewline.delete(name);
  }

  #openFile(name) {
    this.close();
    const filePath = path.join(this.directory, name);
    const isNew = !fs.existsSync(filePath);
    this.fd = fs.openSync(filePath, "a");
    this.currentName = name;
    if (isNew && process.platform !== "win32") {
      // Persist the new directory entry; directories cannot be opened for fsync on Windows.
      try { const dirFd = fs.openSync(this.directory, "r"); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); } } catch { /* best effort */ }
    }
  }

  close() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
    }
    this.fd = null;
    this.currentName = null;
  }
}

// ---------------------------------------------------------------- locking

const heldLocks = new Map(); // lockPath -> token
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const [lockPath, token] of heldLocks) releaseLockFile(lockPath, token);
  });
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function bootTimeMs() {
  return Date.now() - os.uptime() * 1000;
}

export function inspectLock(lockPath, { unparseableStaleMs = 10_000, now = Date.now(), bootSlackMs = 60_000 } = {}) {
  let text;
  let stat;
  try { text = fs.readFileSync(lockPath, "utf8"); stat = fs.statSync(lockPath); } catch (error) { if (error.code === "ENOENT") return { state: "missing" }; throw error; }
  let holder = null;
  try { holder = JSON.parse(text); } catch { holder = null; }
  if (!holder || typeof holder !== "object") {
    // A holder may be mid-write; only treat an unreadable lock as stale once it is old.
    return { state: now - stat.mtimeMs > unparseableStaleMs ? "stale" : "held", holder: null, raw: text };
  }
  const summary = { pid: holder.pid ?? null, hostname: holder.hostname ?? null, startedAt: holder.startedAt ?? null };
  if (holder.hostname && holder.hostname !== os.hostname()) return { state: "held", holder: summary, foreignHost: true, raw: text };
  if (holder.pid === process.pid) return { state: "held", holder: summary, raw: text };
  // A lock written before this machine last booted cannot have a live holder, even
  // when its pid has since been reused by an unrelated process.
  const started = Date.parse(holder.startedAt ?? "");
  if (Number.isFinite(started) && started < bootTimeMs() - bootSlackMs) return { state: "stale", holder: summary, raw: text, beforeBoot: true };
  return { state: isProcessAlive(holder.pid) ? "held" : "stale", holder: summary, raw: text };
}

function releaseLockFile(lockPath, token) {
  try {
    const holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (holder.token === token) fs.unlinkSync(lockPath);
  } catch { /* already gone or not ours */ }
  heldLocks.delete(lockPath);
}

/**
 * Removes a stale lock atomically: the lock is renamed to a unique side name (only
 * one racer can win the rename) and deleted only if it is still the exact lock that
 * was judged stale. If another writer replaced it in between, it is put back when the
 * slot is still free. Returns true when the stale lock was removed by this call.
 */
export function takeOverStaleLock(lockPath, staleText) {
  const aside = `${lockPath}.${randomUUID()}.stale`;
  try { fs.renameSync(lockPath, aside); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  let text = null;
  try { text = fs.readFileSync(aside, "utf8"); } catch { text = null; }
  if (text === staleText) {
    try { fs.unlinkSync(aside); } catch { /* best effort */ }
    return true;
  }
  try { fs.linkSync(aside, lockPath); } catch { /* the slot was taken again; the live writer re-checks its token */ }
  try { fs.unlinkSync(aside); } catch { /* best effort */ }
  return false;
}

/**
 * Acquires the exclusive single-writer lock or throws LEDGER_LOCKED.
 * options.override: true takes over a lock on this host even when its pid looks
 * alive (owner-confirmed recovery when a crashed writer's pid was reused).
 */
export function acquireLock(directory, options = {}) {
  const lockPath = path.join(directory, LOCK_FILE);
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), token });
  let staleCleared = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const inspection = inspectLock(lockPath, options);
      if (inspection.state === "missing") continue;
      if (inspection.state === "held" && !(options.override === true && !inspection.foreignHost && inspection.holder?.pid !== process.pid)) {
        throw ledgerError("LEDGER_LOCKED", `ledger is locked by another writer (pid ${inspection.holder?.pid ?? "unknown"}${inspection.foreignHost ? ` on ${inspection.holder.hostname}` : ""})`, { holder: inspection.holder ?? null, lockPath });
      }
      if (takeOverStaleLock(lockPath, inspection.raw)) staleCleared = inspection.holder ?? { pid: null };
      continue;
    }
    try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Confirm we own it (guards against a racing stale-lock cleanup).
    const holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (holder.token !== token) throw ledgerError("LEDGER_LOCKED", "ledger lock was taken by another writer during acquisition", { lockPath });
    heldLocks.set(lockPath, token);
    installExitHook();
    return { lockPath, token, staleCleared, release: () => releaseLockFile(lockPath, token) };
  }
  throw ledgerError("LEDGER_LOCKED", "could not acquire the ledger lock", { lockPath });
}
