import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { openLocalDraftEnvelope } from "./localHandoff.mjs";
import { withPlanLock } from "./planLock.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const envelopeHash = (envelope) => hash(JSON.stringify(canonical(envelope)));
const safeKey = (draftId) => hash(`perfect-planner-draft:${draftId}`);

function validateEnvelope(envelope) {
  for (const field of ["draftId", "senderId", "recipientId", "createdAt", "expiresAt", "ciphertext", "signature"]) if (!String(envelope?.[field] ?? "").trim()) throw new Error(`Draft envelope is missing ${field}.`);
  if (envelope.schemaVersion !== 1 || !Number.isFinite(Date.parse(envelope.createdAt)) || !Number.isFinite(Date.parse(envelope.expiresAt))) throw new Error("Draft envelope metadata is invalid.");
  return envelope;
}

async function atomicWrite(filePath, value, options = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (options.exclusive) {
    try { await writeFile(filePath, await readFile(temporary), { flag: "wx", mode: 0o600 }); }
    finally { await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })); }
  } else await rename(temporary, filePath);
}

function locations(mailboxRoot, draftId) {
  const root = path.resolve(mailboxRoot); const key = safeKey(draftId);
  return { root, draft: path.join(root, "drafts", `${key}.json`), receipt: path.join(root, "receipts", `${key}.json`) };
}

export async function publishLocalDraft(mailboxRoot, envelope, options = {}) {
  validateEnvelope(envelope);
  if (options.senderId && options.senderId !== envelope.senderId) throw new Error("Publishing actor does not match the signed draft sender.");
  const target = locations(mailboxRoot, envelope.draftId).draft;
  const stored = { schemaVersion: 1, envelopeHash: envelopeHash(envelope), publishedAt: options.timestamp ?? new Date().toISOString(), envelope };
  try { await atomicWrite(target, stored, { exclusive: true }); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Draft ${envelope.draftId} is already published.`); throw error; }
  return { draftId: envelope.draftId, senderId: envelope.senderId, recipientId: envelope.recipientId, envelopeHash: stored.envelopeHash, publishedAt: stored.publishedAt };
}

export async function listLocalInbox(mailboxRoot, recipientId, options = {}) {
  const id = String(recipientId ?? "").trim(); if (!id) throw new Error("Inbox listing requires a recipient id.");
  const directory = path.join(path.resolve(mailboxRoot), "drafts"); let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (names.length > Number(options.maxDrafts ?? 1000)) throw new Error("Mailbox exceeds the bounded listing limit.");
  const results = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const filePath = path.join(directory, name); const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const stored = JSON.parse(await readFile(filePath, "utf8")); validateEnvelope(stored.envelope);
    if (stored.envelopeHash !== envelopeHash(stored.envelope)) throw new Error(`Stored draft ${stored.envelope.draftId} failed its envelope hash.`);
    if (stored.envelope.recipientId === id) results.push({ draftId: stored.envelope.draftId, senderId: stored.envelope.senderId, recipientId: id, createdAt: stored.envelope.createdAt, expiresAt: stored.envelope.expiresAt, publishedAt: stored.publishedAt, envelopeHash: stored.envelopeHash, content: "ENCRYPTED" });
  }
  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.draftId.localeCompare(b.draftId));
}

export async function acceptLocalDraft(mailboxRoot, draftId, trust, options = {}) {
  const target = locations(mailboxRoot, draftId);
  await mkdir(path.dirname(target.receipt), { recursive: true });
  return withPlanLock(target.receipt, { actor: options.actor ?? trust?.recipientId ?? "draft-recipient", timeoutMs: options.timeoutMs ?? 5000 }, async () => {
    try { await readFile(target.receipt, "utf8"); throw new Error(`Draft ${draftId} has already been accepted.`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const stored = JSON.parse(await readFile(target.draft, "utf8")); validateEnvelope(stored.envelope);
    if (stored.envelope.draftId !== draftId || stored.envelopeHash !== envelopeHash(stored.envelope)) throw new Error("Stored draft identity or envelope hash is invalid.");
    const opened = openLocalDraftEnvelope(stored.envelope, trust, { now: options.now, seenDraftIds: new Set() });
    const receipt = { schemaVersion: 1, draftId, senderId: opened.senderId, recipientId: opened.recipientId, envelopeHash: stored.envelopeHash, acceptedAt: options.timestamp ?? new Date(Number(options.now ?? Date.now())).toISOString(), acceptedBy: String(options.actor ?? trust.recipientId) };
    await atomicWrite(target.receipt, receipt, { exclusive: true });
    return { ...opened, receipt };
  });
}

export async function inspectDraftReceipt(mailboxRoot, draftId) {
  const receipt = JSON.parse(await readFile(locations(mailboxRoot, draftId).receipt, "utf8"));
  return { ...receipt, draft: "REDACTED" };
}
