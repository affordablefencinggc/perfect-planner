import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { createLocalDraftEnvelope, createLocalDraftEnvelopeOpaque, generateLocalIdentity, openLocalDraftEnvelope, openLocalDraftEnvelopeOpaque } from "../src/node/localHandoff.mjs";

const sender = generateLocalIdentity("danie"); const recipient = generateLocalIdentity("mira"); const stranger = generateLocalIdentity("stranger");
const envelope = () => createLocalDraftEnvelope({ senderId: sender.actorId, recipientId: recipient.actorId, senderSigningPrivateKey: sender.signingPrivateKey, senderSigningPublicKey: sender.signingPublicKey, recipientEncryptionPublicKey: recipient.encryptionPublicKey, draft: { planId: "PP-014", goal: "collision-safe build" } }, { createdAt: "2026-09-02T00:00:00.000Z", expiresAt: "2026-09-09T00:00:00.000Z", draftId: "DRAFT-001" });
const trust = { expectedSenderId: sender.actorId, expectedSenderSigningPublicKey: sender.signingPublicKey, recipientId: recipient.actorId, recipientEncryptionPrivateKey: recipient.encryptionPrivateKey };

test("the transferable envelope contains no plaintext plan content", () => {
  const serialized = JSON.stringify(envelope()); assert.equal(serialized.includes("collision-safe build"), false); assert.equal(serialized.includes("PP-014"), false);
});

test("the intended recipient opens a trusted signed draft", () => {
  const opened = openLocalDraftEnvelope(envelope(), trust, { now: Date.parse("2026-09-03T00:00:00.000Z") }); assert.equal(opened.draft.planId, "PP-014"); assert.equal(opened.senderId, "danie");
});

test("serialized PEM exchange works without relying on newer Node implicit key conversion", () => {
  assert.equal(typeof recipient.encryptionPrivateKey, "string");
  const transported = JSON.parse(JSON.stringify(envelope()));
  assert.equal(typeof transported.ephemeralPublicKey, "string");
  assert.match(transported.ephemeralPublicKey, /^-----BEGIN PUBLIC KEY-----/);
  const opened = openLocalDraftEnvelope(transported, JSON.parse(JSON.stringify(trust)), { now: Date.parse("2026-09-03T00:00:00.000Z") });
  assert.deepEqual(opened.draft, { planId: "PP-014", goal: "collision-safe build" });
  assert.equal(JSON.stringify(transported).includes("PRIVATE KEY"), false);
});

test("invalid exchange keys fail without consuming a draft's replay slot", () => {
  const sealed = envelope();
  const seenDraftIds = new Set();
  assert.throws(() => openLocalDraftEnvelope(sealed, { ...trust, recipientEncryptionPrivateKey: "invalid fixture key" }, { now: Date.parse("2026-09-03T00:00:00.000Z"), seenDraftIds }));
  assert.equal(seenDraftIds.size, 0);
  assert.equal(openLocalDraftEnvelope(sealed, trust, { now: Date.parse("2026-09-03T00:00:00.000Z"), seenDraftIds }).draft.planId, "PP-014");
});

test("an already parsed private key remains supported without exporting it", () => {
  const privateKey = createPrivateKey(recipient.encryptionPrivateKey);
  const opened = openLocalDraftEnvelope(envelope(), { ...trust, recipientEncryptionPrivateKey: privateKey }, { now: Date.parse("2026-09-03T00:00:00.000Z") });
  assert.equal(opened.draft.planId, "PP-014");
});

test("a different recipient cannot decrypt or relabel the draft", () => {
  assert.throws(() => openLocalDraftEnvelope(envelope(), { ...trust, recipientId: "stranger", recipientEncryptionPrivateKey: stranger.encryptionPrivateKey }, { now: Date.parse("2026-09-03T00:00:00.000Z") }), /different recipient/);
  assert.throws(() => openLocalDraftEnvelope(envelope(), { ...trust, recipientEncryptionPrivateKey: stranger.encryptionPrivateKey }, { now: Date.parse("2026-09-03T00:00:00.000Z") }), /decryption or authentication failed/);
});

test("ciphertext, metadata, and sender-key tampering are refused", () => {
  const changedCipher = envelope(); changedCipher.ciphertext = `${changedCipher.ciphertext.slice(0,-2)}AA`; assert.throws(() => openLocalDraftEnvelope(changedCipher, trust), /signature verification/);
  const changedRecipient = envelope(); changedRecipient.recipientId = "other"; assert.throws(() => openLocalDraftEnvelope(changedRecipient, trust), /different recipient/);
  assert.throws(() => openLocalDraftEnvelope(envelope(), { ...trust, expectedSenderSigningPublicKey: stranger.signingPublicKey }), /pinned sender key/);
});

test("expired drafts fail closed", () => {
  assert.throws(() => openLocalDraftEnvelope(envelope(), trust, { now: Date.parse("2026-09-10T00:00:00.000Z") }), /expired/);
});

test("accepted draft ids cannot be replayed in the recipient store", () => {
  const seenDraftIds = new Set(); openLocalDraftEnvelope(envelope(), trust, { now: Date.parse("2026-09-03T00:00:00.000Z"), seenDraftIds }); assert.throws(() => openLocalDraftEnvelope(envelope(), trust, { now: Date.parse("2026-09-03T00:00:00.000Z"), seenDraftIds }), /replay refused/);
});

test("native exchange consumes private keys only inside opaque-handle custody callbacks", async () => {
  const records = new Map([["opaque:sender", Buffer.from(JSON.stringify({ signingPrivateKey: sender.signingPrivateKey }))], ["opaque:recipient", Buffer.from(JSON.stringify({ encryptionPrivateKey: recipient.encryptionPrivateKey }))]]); const uses = [];
  const custody = { kind: "test-opaque", use: async (handle, context, consumer) => { uses.push({ handle, context }); const value = Buffer.from(records.get(handle)); try { return await consumer(value); } finally { value.fill(0); } } };
  const sealed = await createLocalDraftEnvelopeOpaque({ senderId: sender.actorId, recipientId: recipient.actorId, senderSecretHandle: "opaque:sender", senderSigningPublicKey: sender.signingPublicKey, recipientEncryptionPublicKey: recipient.encryptionPublicKey, draft: { planId: "PP-OPAQUE" } }, custody, { createdAt: "2026-09-02T00:00:00.000Z", expiresAt: "2026-09-09T00:00:00.000Z" });
  const opened = await openLocalDraftEnvelopeOpaque(sealed, { expectedSenderId: sender.actorId, expectedSenderSigningPublicKey: sender.signingPublicKey, recipientId: recipient.actorId, recipientSecretHandle: "opaque:recipient" }, custody, { now: Date.parse("2026-09-03T00:00:00.000Z") }); assert.equal(opened.draft.planId, "PP-OPAQUE"); assert.deepEqual(uses.map((item) => item.handle), ["opaque:sender", "opaque:recipient"]); assert.ok(uses.every((item) => item.context.purpose === "perfect-planner-local-identity-v1"));
  await assert.rejects(() => createLocalDraftEnvelopeOpaque({ senderId: "danie" }, { kind: "plaintext", use: async () => {} }), /opaque sender handle/);
});
