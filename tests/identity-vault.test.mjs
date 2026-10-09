import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addIdentityToVault, createIdentityVault, inspectIdentityVault, migrateIdentityVaultToOpaqueCustody, openIdentityVault, openIdentityVaultOpaque, removeIdentityFromVault, rotateIdentityInVault } from "../src/node/identityVault.mjs";

const password = "correct horse planner vault";
const mockDpapi = { protect: async (value) => Buffer.concat([Buffer.from("dpapi:"), Buffer.from(value)]), unprotect: async (value) => Buffer.from(value).subarray(6) };
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "pp-identity-vault-")); return { root, vault: path.join(root, "identities.vault.json") }; }

test("private identity keys are encrypted at rest", async (t) => {
  const { root, vault } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await createIdentityVault(vault, password, ["danie"], { timestamp: "2026-09-02T00:00:00.000Z" });
  const serialized = await readFile(vault, "utf8");
  assert.equal(serialized.includes("PRIVATE KEY"), false); assert.equal(serialized.includes("signingPrivateKey"), false); assert.equal(serialized.includes("encryptionPrivateKey"), false);
});

test("the correct passphrase restores both signing and encryption identities", async (t) => {
  const { root, vault } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await createIdentityVault(vault, password, ["danie"]); const opened = await openIdentityVault(vault, password);
  assert.equal(opened.identities[0].actorId, "danie"); assert.match(opened.identities[0].signingPrivateKey, /PRIVATE KEY/); assert.match(opened.identities[0].encryptionPrivateKey, /PRIVATE KEY/);
});

test("wrong passphrases and ciphertext tampering fail authentication", async (t) => {
  const { root, vault } = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await createIdentityVault(vault, password, ["danie"]);
  await assert.rejects(() => openIdentityVault(vault, "wrong passphrase long enough"), /authentication failed/);
  const value = JSON.parse(await readFile(vault, "utf8")); value.ciphertext = `${value.ciphertext.slice(0, -2)}AA`; await import("node:fs/promises").then(({ writeFile }) => writeFile(vault, JSON.stringify(value)));
  await assert.rejects(() => openIdentityVault(vault, password), /fingerprint mismatch/);
});

test("weak passphrases and duplicate actors are refused", async (t) => {
  const { root, vault } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => createIdentityVault(vault, "short", ["danie"]), /at least 16/);
  await assert.rejects(() => createIdentityVault(vault, password, ["danie", "danie"]), /unique/);
});

test("adding an identity preserves existing keys and rejects replacement", async (t) => {
  const { root, vault } = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await createIdentityVault(vault, password, ["danie"]);
  const before = await openIdentityVault(vault, password); await addIdentityToVault(vault, password, "mira"); const after = await openIdentityVault(vault, password);
  assert.equal(after.identities.length, 2); assert.equal(after.identities.find((item) => item.actorId === "danie").signingFingerprint, before.identities[0].signingFingerprint);
  await assert.rejects(() => addIdentityToVault(vault, password, "danie"), /already exists/);
});

test("inspection exposes fingerprints but never private material", async (t) => {
  const { root, vault } = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await createIdentityVault(vault, password, ["danie", "mira"]);
  const inspected = await inspectIdentityVault(vault); assert.equal(inspected.identityCount, 2); assert.equal(inspected.privateKeys, "REDACTED"); assert.equal(JSON.stringify(inspected).includes("PRIVATE KEY"), false);
});

// Each holder runs two synchronous scrypts inside the vault lock, so the last of four waiters
// queues behind three. The default 5 s wait is wall-clock and timed out on loaded machines while
// every holder was live; this test checks serialization (stuck holders: truth-core), so wait unbounded.
test("concurrent additions serialize without losing identities", { timeout: 120_000 }, async (t) => {
  const { root, vault } = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await createIdentityVault(vault, password, ["danie"]);
  await Promise.all(["mira", "jon", "agent-a", "agent-b"].map((id) => addIdentityToVault(vault, password, id, { timeoutMs: Number.POSITIVE_INFINITY })));
  const opened = await openIdentityVault(vault, password); assert.deepEqual(opened.identities.map((item) => item.actorId).sort(), ["agent-a", "agent-b", "danie", "jon", "mira"]);
});

test("routine identity opening returns opaque handles instead of private PEM", async (t) => {
  const { root, vault } = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await createIdentityVault(vault, password, ["danie"]); const opened = await openIdentityVaultOpaque(vault, password, path.join(root, "custody"), { dpapi: mockDpapi }); assert.match(opened.identities[0].secretHandle, /^dpapi:v1:/); assert.equal(opened.privateKeys, "OPAQUE"); assert.equal(JSON.stringify(opened).includes("PRIVATE KEY"), false);
});

test("identity rotation and actor removal require recorded recovery exports", async (t) => {
  const { root, vault } = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await createIdentityVault(vault, password, ["danie", "mira"]); const before = await openIdentityVault(vault, password); await assert.rejects(() => rotateIdentityInVault(vault, password, "danie"), /recovery export digest/); const rotated = await rotateIdentityInVault(vault, password, "danie", { recoveryExportDigest: "a".repeat(64) }); assert.notEqual(rotated.identities.find((item) => item.actorId === "danie").signingFingerprint, before.identities.find((item) => item.actorId === "danie").signingFingerprint);
  await assert.rejects(() => removeIdentityFromVault(vault, password, "mira"), /recovery export digest/); const removed = await removeIdentityFromVault(vault, password, "mira", { recoveryExportDigest: "b".repeat(64) }); assert.equal(removed.identityCount, 1); assert.equal(removed.removedActorId, "mira"); await assert.rejects(() => removeIdentityFromVault(vault, password, "danie", { recoveryExportDigest: "c".repeat(64) }), /final actor/);
});

test("legacy encrypted vault migration yields opaque handles and a recovery/audit-bound receipt", async (t) => {
  const { root, vault } = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await createIdentityVault(vault, password, ["danie"]); const stored = [];
  const custody = { kind: "reviewed-test-provider", store: async ({ ownerId, purpose, secret }) => { stored.push({ ownerId, purpose, containsPem: Buffer.from(secret).includes(Buffer.from("PRIVATE KEY")) }); return { handle: `opaque:${ownerId}`, version: 1 }; } }; const audits = [];
  const migrated = await migrateIdentityVaultToOpaqueCustody(vault, password, custody, { actor: "danie", recoveryOwner: "Danie", recoveryLocation: "offline encrypted removable media", appendAudit: async (event) => { audits.push(event); return { hash: "a".repeat(64) }; } }, { timestamp: "2026-09-02T00:00:00.000Z" });
  assert.equal(migrated.privateKeys, "OPAQUE"); assert.equal(migrated.legacyVault.state, "ENCRYPTED_RECOVERY_ONLY"); assert.match(migrated.receiptHash, /^[a-f0-9]{64}$/); assert.deepEqual(stored.map((item) => item.ownerId), ["danie"]); assert.equal(stored[0].containsPem, true); assert.equal(audits[0].recovery.auditRequiredBeforeRotationOrRemoval, true); assert.equal(JSON.stringify(migrated).includes("PRIVATE KEY"), false);
});
