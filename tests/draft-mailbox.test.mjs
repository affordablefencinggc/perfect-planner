import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acceptLocalDraft, inspectDraftReceipt, listLocalInbox, publishLocalDraft } from "../src/node/draftMailbox.mjs";
import { createLocalDraftEnvelope, generateLocalIdentity } from "../src/node/localHandoff.mjs";

const sender = generateLocalIdentity("danie"); const recipient = generateLocalIdentity("mira"); const stranger = generateLocalIdentity("stranger");
const makeEnvelope = (draftId = "DRAFT-001", recipientIdentity = recipient) => createLocalDraftEnvelope({ senderId: sender.actorId, recipientId: recipientIdentity.actorId, senderSigningPrivateKey: sender.signingPrivateKey, senderSigningPublicKey: sender.signingPublicKey, recipientEncryptionPublicKey: recipientIdentity.encryptionPublicKey, draft: { planId: "PP-014", goal: "private local draft" } }, { draftId, createdAt: "2026-09-02T00:00:00.000Z", expiresAt: "2026-09-09T00:00:00.000Z" });
const trust = { expectedSenderId: sender.actorId, expectedSenderSigningPublicKey: sender.signingPublicKey, recipientId: recipient.actorId, recipientEncryptionPrivateKey: recipient.encryptionPrivateKey };
async function fixture() { return mkdtemp(path.join(os.tmpdir(), "pp-mailbox-")); }

test("published mailbox files contain no plaintext draft content", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await publishLocalDraft(root, makeEnvelope(), { senderId: "danie" });
  const listing = await listLocalInbox(root, "mira"); assert.equal(listing.length, 1); assert.equal(listing[0].content, "ENCRYPTED");
  const files = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(root, "drafts"))); const stored = await readFile(path.join(root, "drafts", files[0]), "utf8"); assert.equal(stored.includes("private local draft"), false); assert.equal(stored.includes("PP-014"), false);
});

test("inboxes expose only drafts addressed to the logged-in recipient", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await publishLocalDraft(root, makeEnvelope("DRAFT-MIRA")); await publishLocalDraft(root, makeEnvelope("DRAFT-STRANGER", stranger));
  assert.deepEqual((await listLocalInbox(root, "mira")).map((item) => item.draftId), ["DRAFT-MIRA"]); assert.deepEqual((await listLocalInbox(root, "stranger")).map((item) => item.draftId), ["DRAFT-STRANGER"]);
});

test("the intended recipient accepts once and receives a redacted durable receipt", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await publishLocalDraft(root, makeEnvelope());
  const opened = await acceptLocalDraft(root, "DRAFT-001", trust, { now: Date.parse("2026-09-03T00:00:00.000Z"), timestamp: "2026-09-03T00:00:00.000Z", actor: "mira" }); assert.equal(opened.draft.planId, "PP-014");
  const receipt = await inspectDraftReceipt(root, "DRAFT-001"); assert.equal(receipt.recipientId, "mira"); assert.equal(receipt.draft, "REDACTED"); assert.equal(JSON.stringify(receipt).includes("PP-014"), false);
});

test("wrong recipients cannot accept and no receipt is created", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await publishLocalDraft(root, makeEnvelope());
  await assert.rejects(() => acceptLocalDraft(root, "DRAFT-001", { ...trust, recipientId: "stranger", recipientEncryptionPrivateKey: stranger.encryptionPrivateKey }), /different recipient/);
  await assert.rejects(() => inspectDraftReceipt(root, "DRAFT-001"), /ENOENT/);
});

test("stored envelope tampering is refused before decryption", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await publishLocalDraft(root, makeEnvelope());
  const files = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(root, "drafts"))); const file = path.join(root, "drafts", files[0]); const stored = JSON.parse(await readFile(file, "utf8")); stored.envelope.ciphertext = `${stored.envelope.ciphertext.slice(0, -2)}AA`; await writeFile(file, JSON.stringify(stored));
  await assert.rejects(() => acceptLocalDraft(root, "DRAFT-001", trust), /envelope hash/);
});

test("duplicate publication and sender relabeling are refused", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const envelope = makeEnvelope(); await publishLocalDraft(root, envelope, { senderId: "danie" });
  await assert.rejects(() => publishLocalDraft(root, envelope), /already published/); await assert.rejects(() => publishLocalDraft(root, makeEnvelope("DRAFT-002"), { senderId: "other" }), /does not match/);
});

test("concurrent acceptance produces exactly one receipt and one winner", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await publishLocalDraft(root, makeEnvelope());
  const results = await Promise.allSettled([1, 2, 3, 4].map((index) => acceptLocalDraft(root, "DRAFT-001", trust, { now: Date.parse("2026-09-03T00:00:00.000Z"), actor: `mira-${index}` })));
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1); assert.equal(results.filter((item) => item.status === "rejected" && /already been accepted/.test(item.reason.message)).length, 3);
});

test("mailbox listing is bounded instead of scanning without limit", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await publishLocalDraft(root, makeEnvelope());
  await assert.rejects(() => listLocalInbox(root, "mira", { maxDrafts: 0 }), /bounded listing limit/);
});
