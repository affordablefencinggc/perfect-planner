import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, appendFile, link, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkerMessageStore } from "../src/node/workerMessageStore.mjs";
import { acquirePlanLock, releasePlanLock } from "../src/node/planLock.mjs";

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-worker-comms-"));
  const scope = { projectId: "project-a", planRevision: 1, epoch: 1 };
  let time = 1000; let epoch = 1;
  const authenticate = async token => {
    if (!["coordinator-token", "worker-token", "other-token"].includes(token)) throw new Error("Secret error must not surface");
    return { ...scope, epoch, actorId: token.replace("-token", "") };
  };
  const config = { root, scope, authenticate, now: () => time, ...options };
  const store = await createWorkerMessageStore(config);
  const message = { messageId: "message-1", packageId: "B07", recipientId: "worker", payloadDigest: "a".repeat(64), kind: "brief", deadlineAt: 2000 };
  return { root, config, store, message, ref: { messageId: message.messageId, payloadDigest: message.payloadDigest }, tick: value => { time = value; }, revoke: () => { epoch = 2; } };
}

test("messages survive reopening and distinguish receipt, acknowledgment and verified action", async () => {
  const f = await fixture({ verifyEvidence: async ({ actorId, ...binding }) => binding });
  await f.store.send("coordinator-token", f.message);
  assert.equal((await f.store.inspect("worker-token"))[0].completionVerified, false);
  const reopened = await createWorkerMessageStore(f.config);
  await reopened.delivered("worker-token", f.ref);
  await reopened.acknowledge("worker-token", f.ref);
  assert.equal((await reopened.inspect("worker-token"))[0].completionVerified, false);
  await reopened.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) });
  assert.equal((await reopened.inspect("coordinator-token"))[0].completionVerified, true);
  const file = (await readdir(f.root)).find(name => name.endsWith(".jsonl"));
  const text = await readFile(path.join(f.root, file), "utf8");
  assert.equal(text.includes("-token"), false);
  assert.equal(text.split("\n").filter(Boolean).length, 4);
});

test("concurrent duplicate sends are idempotent and cannot replace payload or sender", async () => {
  const f = await fixture();
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => f.store.send("coordinator-token", f.message)));
  assert.equal(outcomes.filter(result => !result.duplicate).length, 1);
  await assert.rejects(() => f.store.send("coordinator-token", { ...f.message, payloadDigest: "c".repeat(64) }), /id-reuse/);
  await assert.rejects(() => f.store.send("other-token", f.message), /id-reuse/);
  assert.equal((await f.store.inspect("worker-token")).length, 1);
});

test("only the exact recipient and digest can acknowledge, and stages cannot be skipped", async () => {
  const f = await fixture(); await f.store.send("coordinator-token", f.message);
  await assert.rejects(() => f.store.acknowledge("worker-token", f.ref), /transition-invalid/);
  await assert.rejects(() => f.store.delivered("other-token", f.ref), /recipient-or-digest/);
  await assert.rejects(() => f.store.delivered("worker-token", { ...f.ref, payloadDigest: "b".repeat(64) }), /recipient-or-digest/);
  await f.store.delivered("worker-token", f.ref);
  await f.store.acknowledge("worker-token", f.ref);
  assert.equal((await f.store.acknowledge("worker-token", f.ref)).duplicate, true);
  assert.deepEqual(await f.store.inspect("other-token"), []);
});

test("authentication, changed epochs and cross-project identities fail closed", async () => {
  const f = await fixture(); await f.store.send("coordinator-token", f.message);
  await assert.rejects(() => f.store.inspect("forged"), /^Error: comms-authentication-refused$/);
  f.revoke(); await assert.rejects(() => f.store.delivered("worker-token", f.ref), /stale-or-foreign/);
  const other = await createWorkerMessageStore({ ...f.config, authenticate: async () => ({ ...f.config.scope, projectId: "project-b", actorId: "worker" }) });
  await assert.rejects(() => other.inspect("worker-token"), /stale-or-foreign/);
});

test("overdue messages remain visible but late acknowledgment cannot rewrite history", async () => {
  const f = await fixture(); await f.store.send("coordinator-token", f.message);
  f.tick(2000);
  const pending = (await f.store.inspect("worker-token"))[0];
  assert.equal(pending.status, "queued"); assert.equal(pending.acknowledgmentOverdue, true);
  await assert.rejects(() => f.store.delivered("worker-token", f.ref), /transition-invalid/);
  f.tick(999); await assert.rejects(() => f.store.inspect("worker-token"), /clock-invalid/);
});

test("an on-time acknowledgment allows separately bounded work completion after the acknowledgment window", async () => {
  const f = await fixture({ verifyEvidence: async ({ actorId, ...binding }) => binding });
  const message = { ...f.message, actionDeadlineAt: 5000 };
  await f.store.send("coordinator-token", message);
  await f.store.delivered("worker-token", f.ref);
  await f.store.acknowledge("worker-token", f.ref);
  f.tick(2500);
  const reopened = await createWorkerMessageStore(f.config);
  const waiting = (await reopened.inspect("coordinator-token"))[0];
  assert.equal(waiting.acknowledgmentOverdue, false);
  assert.equal(waiting.actionOverdue, false);
  assert.equal(waiting.completionVerified, false);
  await reopened.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) });
  const result = (await reopened.inspect("coordinator-token"))[0];
  assert.equal(result.status, "acted");
  assert.equal(result.completionVerified, true);
  assert.equal(result.message.actionDeadlineAt, 5000);
});

test("a longer action window never extends acknowledgment or allows stage skipping", async () => {
  const f = await fixture({ verifyEvidence: async ({ actorId, ...binding }) => binding });
  await f.store.send("coordinator-token", { ...f.message, actionDeadlineAt: 5000 });
  await f.store.delivered("worker-token", f.ref);
  f.tick(2000);
  await assert.rejects(() => f.store.acknowledge("worker-token", f.ref), /transition-invalid/);
  await assert.rejects(() => f.store.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) }), /transition-invalid/);
  const pending = (await f.store.inspect("coordinator-token"))[0];
  assert.equal(pending.status, "delivered");
  assert.equal(pending.acknowledgmentOverdue, true);
  assert.equal(pending.actionOverdue, false);
  assert.equal(pending.completionVerified, false);
});

test("missed action deadlines remain visible without altering the acknowledged journal", async () => {
  const f = await fixture({ verifyEvidence: async ({ actorId, ...binding }) => binding });
  await f.store.send("coordinator-token", { ...f.message, actionDeadlineAt: 5000 });
  await f.store.delivered("worker-token", f.ref);
  await f.store.acknowledge("worker-token", f.ref);
  const file = path.join(f.root, (await readdir(f.root)).find(name => name.endsWith(".jsonl")));
  const before = await readFile(file, "utf8");
  f.tick(5000);
  const expired = (await f.store.inspect("coordinator-token"))[0];
  assert.equal(expired.acknowledgmentOverdue, false);
  assert.equal(expired.actionOverdue, true);
  assert.equal(expired.completionVerified, false);
  await assert.rejects(() => f.store.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) }), /transition-invalid/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("invalid or rewritten action deadlines cannot enter or replace a queued message", async () => {
  const f = await fixture();
  for (const actionDeadlineAt of [1999, null, "5000", -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => f.store.send("coordinator-token", { ...f.message, actionDeadlineAt }), /message-invalid/);
  }
  assert.deepEqual(await f.store.inspect("worker-token"), []);
  await f.store.send("coordinator-token", { ...f.message, actionDeadlineAt: 5000 });
  await assert.rejects(() => f.store.send("coordinator-token", { ...f.message, actionDeadlineAt: 6000 }), /id-reuse/);
});

test("legacy records retain their original shared deadline without silent migration", async () => {
  const f = await fixture({ verifyEvidence: async ({ actorId, ...binding }) => binding });
  await f.store.send("coordinator-token", f.message);
  await f.store.delivered("worker-token", f.ref);
  await f.store.acknowledge("worker-token", f.ref);
  f.tick(2000);
  const reopened = await createWorkerMessageStore(f.config);
  const old = (await reopened.inspect("worker-token"))[0];
  assert.equal(Object.hasOwn(old.message, "actionDeadlineAt"), false);
  assert.equal(old.actionOverdue, true);
  await assert.rejects(() => reopened.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) }), /transition-invalid/);
});

test("completion needs an exact trusted evidence result, not a worker's green claim", async () => {
  for (const verifyEvidence of [undefined, async () => ({ valid: true }), async ({ actorId, ...binding }) => ({ ...binding, projectId: "wrong" })]) {
    const f = await fixture({ verifyEvidence }); await f.store.send("coordinator-token", f.message);
    await f.store.delivered("worker-token", f.ref); await f.store.acknowledge("worker-token", f.ref);
    await assert.rejects(() => f.store.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) }), /evidence/);
    assert.equal((await f.store.inspect("coordinator-token"))[0].completionVerified, false);
  }
});

test("revocation during evidence verification refuses recording completion", async () => {
  const f = await fixture();
  const store = await createWorkerMessageStore({ ...f.config, verifyEvidence: async ({ actorId, ...binding }) => { f.revoke(); return binding; } });
  await store.send("coordinator-token", f.message); await store.delivered("worker-token", f.ref); await store.acknowledge("worker-token", f.ref);
  await assert.rejects(() => store.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) }), /stale-or-foreign/);
});

test("partial, tampered and hardlinked journals are preserved and refused", async () => {
  for (const corrupt of [async file => appendFile(file, '{"partial":'), async file => writeFile(file, (await readFile(file, "utf8")).replace('"queued"', '"acted"')), async file => link(file, `${file}.copy`)]) {
    const f = await fixture(); await f.store.send("coordinator-token", f.message);
    const file = path.join(f.root, (await readdir(f.root)).find(name => name.endsWith(".jsonl"))); await corrupt(file);
    const before = await readFile(file, "utf8");
    await assert.rejects(() => f.store.inspect("worker-token"));
    await assert.rejects(() => f.store.delivered("worker-token", f.ref));
    assert.equal(await readFile(file, "utf8"), before);
  }
});

test("requests cannot smuggle free text or mutate the captured payload after dispatch", async () => {
  const f = await fixture();
  await assert.rejects(() => f.store.send("coordinator-token", { ...f.message, text: "private source" }), /schema-invalid/);
  const message = { ...f.message }; const pending = f.store.send("coordinator-token", message); message.recipientId = "other";
  await pending; assert.equal((await f.store.inspect("worker-token"))[0].message.recipientId, "worker");
});

test("digest references are primitive strings, never coercible arrays or wrapped values", async () => {
  let verified = 0;
  const f = await fixture({ verifyEvidence: async ({ actorId, ...binding }) => { verified += 1; return binding; } });
  const invalid = [["a".repeat(64)], new String("a".repeat(64)), null, 123];
  for (const payloadDigest of invalid) {
    await assert.rejects(() => f.store.send("coordinator-token", { ...f.message, payloadDigest }), /message-invalid/);
  }
  assert.deepEqual(await f.store.inspect("worker-token"), []);
  await f.store.send("coordinator-token", f.message);
  for (const payloadDigest of invalid) {
    await assert.rejects(() => f.store.delivered("worker-token", { ...f.ref, payloadDigest }), /message-invalid/);
  }
  await f.store.delivered("worker-token", f.ref); await f.store.acknowledge("worker-token", f.ref);
  for (const evidenceDigest of invalid) {
    await assert.rejects(() => f.store.acted("worker-token", { ...f.ref, evidenceDigest }), /message-invalid/);
  }
  assert.equal(verified, 0);
  assert.equal((await f.store.inspect("worker-token"))[0].status, "acknowledged");
});

test("hung evidence adapters time out without completing or keeping the journal locked", async () => {
  let calls = 0; let signal;
  const f = await fixture({ verifyEvidence: (_binding, options) => { calls += 1; signal = options.signal; return new Promise(() => {}); } });
  await f.store.send("coordinator-token", f.message);
  await f.store.delivered("worker-token", f.ref); await f.store.acknowledge("worker-token", f.ref);
  await assert.rejects(() => f.store.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) }), /evidence-refused/);
  await assert.rejects(() => f.store.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) }), /evidence-refused/);
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
  assert.equal((await f.store.inspect("coordinator-token"))[0].status, "acknowledged");
  await f.store.send("coordinator-token", { ...f.message, messageId: "message-2" });
  assert.equal((await f.store.inspect("coordinator-token")).length, 2);
});

test("same-size journal modification during evidence verification is refused before append", async () => {
  const f = await fixture(); let altered;
  const store = await createWorkerMessageStore({ ...f.config, verifyEvidence: async ({ actorId, ...binding }) => {
    const file = path.join(f.root, (await readdir(f.root)).find(name => name.endsWith(".jsonl")));
    altered = (await readFile(file, "utf8")).replace('"B07"', '"B08"'); await writeFile(file, altered);
    return binding;
  } });
  await store.send("coordinator-token", f.message); await store.delivered("worker-token", f.ref); await store.acknowledge("worker-token", f.ref);
  await assert.rejects(() => store.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) }), /file-changed/);
  const file = path.join(f.root, (await readdir(f.root)).find(name => name.endsWith(".jsonl")));
  assert.equal(await readFile(file, "utf8"), altered);
});

test("an adapter resolving valid evidence on abort cannot turn timeout into completion", async () => {
  let aborted = false;
  const f = await fixture({ verifyEvidence: ({ actorId, ...binding }, { signal }) => new Promise(resolve => {
    signal.addEventListener("abort", () => { aborted = true; resolve(binding); }, { once: true });
  }) });
  await f.store.send("coordinator-token", f.message);
  await f.store.delivered("worker-token", f.ref); await f.store.acknowledge("worker-token", f.ref);
  await assert.rejects(() => f.store.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) }), /evidence-refused/);
  assert.equal(aborted, true);
  const result = (await f.store.inspect("coordinator-token"))[0];
  assert.equal(result.status, "acknowledged"); assert.equal(result.completionVerified, false);
});

test("a deadline reached during verification prevents a late completion receipt", async () => {
  for (const actionDeadlineAt of [null, 5000]) {
    const f = await fixture();
    const message = actionDeadlineAt === null ? f.message : { ...f.message, actionDeadlineAt };
    const store = await createWorkerMessageStore({ ...f.config, verifyEvidence: async ({ actorId, ...binding }) => { f.tick(actionDeadlineAt ?? 2000); return binding; } });
    await store.send("coordinator-token", message); await store.delivered("worker-token", f.ref); await store.acknowledge("worker-token", f.ref);
    if (actionDeadlineAt !== null) f.tick(2500);
    await assert.rejects(() => store.acted("worker-token", { ...f.ref, evidenceDigest: "b".repeat(64) }), /deadline-invalid/);
    assert.equal((await store.inspect("coordinator-token"))[0].completionVerified, false);
  }
});

test("valid-prefix rollback and a missing journal require reconciliation after restart", async () => {
  for (const remove of [false, true]) {
    const f = await fixture(); await f.store.send("coordinator-token", f.message);
    const file = path.join(f.root, (await readdir(f.root)).find(name => name.endsWith(".jsonl")));
    const first = await readFile(file, "utf8");
    await f.store.delivered("worker-token", f.ref);
    if (remove) await rename(file, `${file}.preserved`); else await writeFile(file, first);
    const reopened = await createWorkerMessageStore(f.config);
    await assert.rejects(() => reopened.inspect("worker-token"), /reconciliation-required/);
    await assert.rejects(() => reopened.send("coordinator-token", { ...f.message, messageId: "message-2" }), /reconciliation-required/);
    if (!remove) assert.equal(await readFile(file, "utf8"), first);
  }
});

test("a complete event without its checkpoint is preserved as an unknown outcome, never duplicate success", async () => {
  const f = await fixture(); await f.store.send("coordinator-token", f.message);
  const file = path.join(f.root, (await readdir(f.root)).find(name => name.endsWith(".jsonl")));
  const checkpoint = await readFile(`${file}.checkpoint`, "utf8");
  await f.store.delivered("worker-token", f.ref);
  const journal = await readFile(file, "utf8");
  // Simulate interruption after a complete journal append but before checkpoint publication.
  await writeFile(`${file}.checkpoint`, checkpoint);
  const reopened = await createWorkerMessageStore(f.config);
  await assert.rejects(() => reopened.delivered("worker-token", f.ref), /reconciliation-required/);
  await assert.rejects(() => reopened.inspect("coordinator-token"), /reconciliation-required/);
  assert.equal(await readFile(file, "utf8"), journal);
  assert.equal(await readFile(`${file}.checkpoint`, "utf8"), checkpoint);
});

test("inspection waits for checkpoint publication instead of reporting a transient mismatch", async () => {
  const f = await fixture(); await f.store.send("coordinator-token", f.message);
  const file = path.join(f.root, (await readdir(f.root)).find(name => name.endsWith(".jsonl")));
  const earlier = await readFile(`${file}.checkpoint`, "utf8");
  await f.store.delivered("worker-token", f.ref);
  const published = await readFile(`${file}.checkpoint`, "utf8");
  const lock = await acquirePlanLock(file, { actor: "test-publication" });
  let inspected;
  try {
    await writeFile(`${file}.checkpoint`, earlier);
    // Observe fulfillment or rejection immediately so a regression cannot hide as an unhandled rejection.
    inspected = f.store.inspect("worker-token").then(value => ({ value }), error => ({ error }));
    const first = await Promise.race([inspected, new Promise(resolve => setTimeout(() => resolve("waiting"), 60))]);
    assert.equal(first, "waiting");
    await writeFile(`${file}.checkpoint`, published);
  } finally { await releasePlanLock(lock); }
  const result = await inspected;
  assert.equal(result.error, undefined);
  assert.equal(result.value[0].status, "delivered");
});
