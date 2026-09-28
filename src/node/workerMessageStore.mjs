import { constants } from "node:fs";
import { lstat, open, realpath, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { withPlanLock } from "./planLock.mjs";

const LIMIT = 2 * 1024 * 1024;
const MAX_EVENTS = 2048;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const HASH = /^[a-f0-9]{64}$/;
const validId = value => typeof value === "string" && ID.test(value);
const validHash = value => typeof value === "string" && HASH.test(value);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const canonical = value => value && typeof value === "object" ? (Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const same = (a, b) => digest(a) === digest(b);
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) fail("comms-schema-invalid");
}
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const adapterActivity = new WeakMap();
async function boundedAdapter(adapter, call) {
  const activity = adapterActivity.get(adapter) ?? { pending: 0, stalled: 0 };
  adapterActivity.set(adapter, activity);
  if (activity.stalled || activity.pending >= 8) fail("comms-adapter-busy");
  activity.pending += 1;
  const cancellation = new AbortController();
  let timer; let timedOut = false;
  const pending = Promise.resolve().then(() => call(cancellation.signal));
  const release = () => { activity.pending -= 1; if (timedOut) activity.stalled -= 1; };
  pending.then(release, release);
  try {
    const result = await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true; activity.stalled += 1;
        reject(new Error("comms-adapter-timeout"));
        cancellation.abort();
      }, 2000);
    })]);
    // An abort listener can settle the adapter immediately. Cancellation must
    // never turn a timed-out operation into accepted authentication or evidence.
    if (timedOut) fail("comms-adapter-timeout");
    return result;
  } finally { clearTimeout(timer); }
}
const scopeKeys = ["projectId", "planRevision", "epoch"];
const messageKeys = ["messageId", "packageId", "recipientId", "payloadDigest", "kind", "deadlineAt"];
const transitionDeadline = (message, action) => action === "acted" ? (message.actionDeadlineAt ?? message.deadlineAt) : message.deadlineAt;

async function safeRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(root)) fail("comms-root-invalid");
  let cursor = path.resolve(root);
  for (;;) {
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("comms-root-redirected");
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  if (path.relative(path.resolve(root), await realpath(root)) !== "") fail("comms-root-redirected");
}

function validateMessage(message) {
  exact(message, Object.hasOwn(message ?? {}, "actionDeadlineAt") ? [...messageKeys, "actionDeadlineAt"] : messageKeys);
  if (![message.messageId, message.packageId, message.recipientId].every(v => typeof v === "string" && ID.test(v))
    || !validHash(message.payloadDigest) || !["brief", "question", "decision", "result"].includes(message.kind) || !timestamp(message.deadlineAt)) fail("comms-message-invalid");
  if (Object.hasOwn(message, "actionDeadlineAt") && (!timestamp(message.actionDeadlineAt) || message.actionDeadlineAt < message.deadlineAt)) fail("comms-message-invalid");
}

function replay(events, scope) {
  const messages = new Map(); let previousHash = "GENESIS"; let lastTime = 0;
  for (const [index, event] of events.entries()) {
    exact(event, ["schemaVersion", "scope", "sequence", "previousHash", "hash", "at", "actorId", "action", "message", "evidenceDigest"]);
    validateMessage(event.message);
    const { hash, ...body } = event;
    if (event.schemaVersion !== 1 || !same(event.scope, scope) || event.sequence !== index + 1 || event.previousHash !== previousHash
      || hash !== digest(body) || !validId(event.actorId) || !timestamp(event.at) || event.at < lastTime) fail("comms-journal-invalid");
    const old = messages.get(event.message.messageId);
    if (event.action === "queued") {
      if (old || event.evidenceDigest !== null || event.message.deadlineAt <= event.at) fail("comms-transition-invalid");
    } else {
      if (!old || !same(old.message, event.message) || event.actorId !== event.message.recipientId || event.at >= transitionDeadline(event.message, event.action)) fail("comms-transition-invalid");
      const expected = { delivered: "queued", acknowledged: "delivered", acted: "acknowledged" }[event.action];
      if (old.status !== expected || (event.action === "acted" ? !validHash(event.evidenceDigest) : event.evidenceDigest !== null)) fail("comms-transition-invalid");
    }
    messages.set(event.message.messageId, { message: event.message, senderId: old?.senderId ?? event.actorId, status: event.action, at: event.at, evidenceDigest: event.evidenceDigest });
    previousHash = hash; lastTime = event.at;
  }
  return { messages, previousHash, lastTime };
}

// Trusted-runtime construction only. The caller supplies real authentication and
// evidence adapters, never an LLM-supplied actor label or self-reported green flag.
// This stores references/digests, not prompt text, credentials or tool output.
export async function createWorkerMessageStore({ root, scope, authenticate, verifyEvidence, now = Date.now }) {
  exact(scope, scopeKeys);
  if (!validId(scope.projectId) || !Number.isSafeInteger(scope.planRevision) || scope.planRevision < 1 || !Number.isSafeInteger(scope.epoch) || scope.epoch < 1
    || typeof authenticate !== "function") fail("comms-authority-required");
  scope = Object.freeze({ ...scope });
  await safeRoot(root);
  const file = path.join(root, `worker-messages-${digest(scope)}.jsonl`);
  const checkpointFile = `${file}.checkpoint`;
  const readIdentity = new WeakMap();
  async function readCheckpoint() {
    let info;
    try { info = await lstat(checkpointFile); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 256) fail("comms-checkpoint-refused");
    const handle = await open(checkpointFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const buffer = Buffer.alloc(257); const { bytesRead } = await handle.read(buffer);
      const after = await handle.stat(); const current = await lstat(checkpointFile);
      if (bytesRead !== info.size || after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs
        || current.ino !== info.ino || current.dev !== info.dev || current.nlink !== 1 || current.isSymbolicLink()) fail("comms-checkpoint-refused");
      let checkpoint;
      try { checkpoint = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); } catch { fail("comms-checkpoint-refused"); }
      exact(checkpoint, ["sequence", "hash"]);
      if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0 || checkpoint.sequence > MAX_EVENTS
        || (checkpoint.sequence === 0 ? checkpoint.hash !== "GENESIS" : !validHash(checkpoint.hash))) fail("comms-checkpoint-refused");
      return checkpoint;
    } finally { await handle.close(); }
  }
  async function syncDirectory() {
    // Node cannot portably fsync a Windows directory. Do not claim power-loss durability there.
    if (process.platform === "win32") return;
    const handle = await open(root, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function saveCheckpoint(checkpoint) {
    await safeRoot(root); await readCheckpoint();
    const temporary = `${checkpointFile}.pending-${randomUUID()}`;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(JSON.stringify(checkpoint)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, checkpointFile); await syncDirectory();
  }

  async function actor(credentials) {
    let identity;
    try { identity = await boundedAdapter(authenticate, signal => authenticate(credentials, { signal })); } catch { fail("comms-authentication-refused"); }
    exact(identity, [...scopeKeys, "actorId"]);
    if (!validId(identity.actorId) || scopeKeys.some(key => identity[key] !== scope[key])) fail("comms-stale-or-foreign-session");
    return identity.actorId;
  }
  async function read() {
    await safeRoot(root);
    const checkpoint = await readCheckpoint();
    let info;
    try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") { if (checkpoint) fail("comms-reconciliation-required"); return []; } throw error; }
    if (!checkpoint) fail("comms-reconciliation-required");
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > LIMIT) fail("comms-file-refused");
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) fail("comms-file-changed");
      const buffer = Buffer.alloc(before.size + 1); let length = 0;
      while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length); if (!result.bytesRead) break; length += result.bytesRead; }
      const after = await handle.stat(); const current = await lstat(file); await safeRoot(root);
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.ino !== before.ino || current.dev !== before.dev
        || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.nlink !== 1 || current.isSymbolicLink()) fail("comms-file-changed");
      const text = buffer.subarray(0, length).toString("utf8");
      if (text && !text.endsWith("\n")) fail("comms-partial-journal");
      const lines = text ? text.slice(0, -1).split("\n") : [];
      if (lines.length > MAX_EVENTS) fail("comms-event-limit");
      let entries;
      try { entries = lines.map(line => JSON.parse(line)); } catch { fail("comms-partial-journal"); }
      if (entries.length !== checkpoint.sequence || (entries.at(-1)?.hash ?? "GENESIS") !== checkpoint.hash) fail("comms-reconciliation-required");
      readIdentity.set(entries, { ino: before.ino, dev: before.dev, size: before.size, mtimeMs: before.mtimeMs, bytesHash: createHash("sha256").update(buffer.subarray(0, length)).digest("hex") });
      return entries;
    } finally { await handle.close(); }
  }
  async function change(credentials, action, input) {
    // Snapshot input before any async boundary; a caller cannot mutate a queued request.
    input = structuredClone(input);
    if (action === "queued") validateMessage(input);
    else {
      exact(input, action === "acted" ? ["messageId", "payloadDigest", "evidenceDigest"] : ["messageId", "payloadDigest"]);
      if (!validId(input.messageId) || !validHash(input.payloadDigest) || (action === "acted" && !validHash(input.evidenceDigest))) fail("comms-message-invalid");
    }
    await safeRoot(root);
    return withPlanLock(file, { actor: "worker-message-service", timeoutMs: 3000 }, async () => {
      const actorId = await actor(credentials);
      const events = await read(); const state = replay(events, scope);
      if (await actor(credentials) !== actorId) fail("comms-stale-or-foreign-session");
      const at = now(); if (!timestamp(at) || at < state.lastTime) fail("comms-clock-invalid");
      const existing = state.messages.get(input.messageId);
      if (action === "queued" && existing) {
        if (existing.senderId !== actorId || !same(existing.message, input)) fail("comms-id-reuse-refused");
        await syncDirectory();
        return { ...existing, duplicate: true };
      }
      if (action !== "queued" && (!existing || actorId !== existing.message.recipientId || input.payloadDigest !== existing.message.payloadDigest)) fail("comms-recipient-or-digest-mismatch");
      if (action !== "queued" && existing.status === action) {
        if (action === "acted" && input.evidenceDigest !== existing.evidenceDigest) fail("comms-evidence-mismatch");
        await syncDirectory();
        return { ...existing, duplicate: true };
      }
      if (events.length >= MAX_EVENTS) fail("comms-event-limit");
      const message = action === "queued" ? input : existing.message;
      const evidenceDigest = action === "acted" ? input.evidenceDigest : null;
      const body = { schemaVersion: 1, scope, sequence: events.length + 1, previousHash: state.previousHash, at, actorId, action, message, evidenceDigest };
      let event = { ...body, hash: digest(body) };
      replay([...events, event], scope); // Validate before evidence lookup or writing.
      if (action === "acted") {
        if (typeof verifyEvidence !== "function") fail("comms-evidence-verifier-required");
        let result;
        const expected = { ...scope, messageId: message.messageId, payloadDigest: message.payloadDigest, evidenceDigest, valid: true };
        try { result = await boundedAdapter(verifyEvidence, signal => verifyEvidence(Object.freeze({ ...expected, actorId }), { signal })); } catch { fail("comms-evidence-refused"); }
        if (!same(result, expected)) fail("comms-evidence-refused");
        if (await actor(credentials) !== actorId) fail("comms-stale-or-foreign-session");
        const verifiedAt = now();
        if (!timestamp(verifiedAt) || verifiedAt < at || verifiedAt >= transitionDeadline(message, action)) fail("comms-clock-or-deadline-invalid");
      }
      if (await actor(credentials) !== actorId) fail("comms-stale-or-foreign-session");
      await safeRoot(root);
      const commitAt = now();
      if (!timestamp(commitAt) || commitAt < at || commitAt >= transitionDeadline(message, action)) fail("comms-clock-or-deadline-invalid");
      body.at = commitAt;
      event = { ...body, hash: digest(body) };
      const bytes = JSON.stringify(event) + "\n";
      if (!events.length) await saveCheckpoint({ sequence: 0, hash: "GENESIS" });
      const handle = await open(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const info = await handle.stat();
        const previousBytes = events.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value) + "\n"), 0);
        if (!info.isFile() || info.nlink !== 1 || info.size !== previousBytes || info.size + Buffer.byteLength(bytes) > LIMIT) fail("comms-file-refused");
        const identity = readIdentity.get(events);
        if (identity) {
          if (info.ino !== identity.ino || info.dev !== identity.dev || info.size !== identity.size || info.mtimeMs !== identity.mtimeMs) fail("comms-file-changed");
          const previous = Buffer.alloc(identity.size); let length = 0;
          while (length < previous.length) { const read = await handle.read(previous, length, previous.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
          if (length !== identity.size || createHash("sha256").update(previous).digest("hex") !== identity.bytesHash) fail("comms-file-changed");
        }
        await handle.writeFile(bytes); await handle.sync();
      } finally { await handle.close(); }
      await syncDirectory();
      await saveCheckpoint({ sequence: event.sequence, hash: event.hash });
      const observed = await read();
      if (observed.at(-1)?.hash !== event.hash) fail("comms-write-outcome-unknown");
      return { ...replay(observed, scope).messages.get(message.messageId), duplicate: false };
    });
  }
  return Object.freeze({
    send: (credentials, input) => change(credentials, "queued", input),
    delivered: (credentials, input) => change(credentials, "delivered", input),
    acknowledge: (credentials, input) => change(credentials, "acknowledged", input),
    acted: (credentials, input) => change(credentials, "acted", input),
    async inspect(credentials) {
      await safeRoot(root);
      // A writer publishes the journal and its checkpoint in separate durable steps.
      // Readers share its lock so that ordinary publication is not reported as corruption.
      return withPlanLock(file, { actor: "worker-message-inspector", timeoutMs: 3000 }, async () => {
        const actorId = await actor(credentials); const state = replay(await read(), scope);
        if (await actor(credentials) !== actorId) fail("comms-stale-or-foreign-session");
        const at = now(); if (!timestamp(at) || at < state.lastTime) fail("comms-clock-invalid");
        return [...state.messages.values()].filter(item => item.senderId === actorId || item.message.recipientId === actorId)
          .map(item => ({ ...item,
            acknowledgmentOverdue: !["acknowledged", "acted"].includes(item.status) && at >= item.message.deadlineAt,
            actionOverdue: item.status !== "acted" && at >= transitionDeadline(item.message, "acted"),
            completionVerified: item.status === "acted",
          }));
      });
    },
  });
}
