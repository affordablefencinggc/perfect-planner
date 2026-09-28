import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { withPlanLock } from "./planLock.mjs";

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export async function readJournal(journalPath) {
  try {
    return (await readFile(journalPath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function verifyJournalEntries(entries) {
  let previousHash = "GENESIS";
  for (let index = 0; index < entries.length; index += 1) {
    const { hash, ...body } = entries[index];
    if (body.sequence !== index + 1 || body.previousHash !== previousHash || sha256(canonicalize(body)) !== hash) return { valid: false, brokenAt: index + 1 };
    previousHash = hash;
  }
  return { valid: true, brokenAt: null };
}

export async function appendJournalEvent(journalPath, event, options = {}) {
  await mkdir(path.dirname(path.resolve(journalPath)), { recursive: true });
  return withPlanLock(journalPath, { actor: options.actor, timeoutMs: options.timeoutMs ?? 5000, retryMs: options.retryMs ?? 10 }, async (holder) => {
    const entries = await readJournal(journalPath);
    const integrity = verifyJournalEntries(entries);
    if (!integrity.valid) throw new Error(`Journal chain is broken at entry ${integrity.brokenAt}; append refused.`);
    const body = {
      sequence: entries.length + 1,
      timestamp: options.timestamp ?? new Date().toISOString(),
      actor: holder.actor,
      session: options.session ?? holder.token.slice(0, 8),
      action: String(event.action),
      payload: event.payload ?? {},
      previousHash: entries.at(-1)?.hash ?? "GENESIS",
    };
    const entry = { ...body, hash: sha256(canonicalize(body)) };
    const handle = await open(journalPath, "a");
    try { await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return entry;
  });
}

export async function verifyJournal(journalPath) { return verifyJournalEntries(await readJournal(journalPath)); }
