import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateLocalIdentity } from "./localIdentity.mjs";
import { withPlanLock } from "./planLock.mjs";
import { storeOpaqueSecret } from "./windowsDpapiSecretCustody.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const validatePassphrase = (value) => {
  if (String(value ?? "").length < 16) throw new Error("Identity vault passphrase must contain at least 16 characters.");
  return String(value);
};

async function atomicWrite(filePath, value) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600).catch(() => {});
}

function seal(identities, passphrase, options = {}) {
  const salt = randomBytes(32); const iv = randomBytes(12);
  const key = scryptSync(validatePassphrase(passphrase), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const publicIdentities = identities.map(({ actorId, signingFingerprint, encryptionFingerprint, signingPublicKey, encryptionPublicKey }) => ({ actorId, signingFingerprint, encryptionFingerprint, signingPublicKey, encryptionPublicKey })).sort((a, b) => a.actorId.localeCompare(b.actorId));
  const header = { schemaVersion: 1, kdf: "scrypt-N32768-r8-p1", cipher: "aes-256-gcm", createdAt: options.createdAt, updatedAt: options.updatedAt, publicIdentities, salt: salt.toString("base64"), iv: iv.toString("base64") };
  const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ identities }))), cipher.final()]);
  const vault = { ...header, ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
  return { ...vault, vaultFingerprint: hash(Buffer.from(JSON.stringify(vault))) };
}

function openSealed(vault, passphrase) {
  if (vault?.schemaVersion !== 1 || vault.kdf !== "scrypt-N32768-r8-p1" || vault.cipher !== "aes-256-gcm") throw new Error("Unsupported identity vault format.");
  const { ciphertext, authTag, vaultFingerprint, ...header } = vault;
  if (hash(Buffer.from(JSON.stringify({ ...header, ciphertext, authTag }))) !== vaultFingerprint) throw new Error("Identity vault fingerprint mismatch.");
  const key = scryptSync(validatePassphrase(passphrase), Buffer.from(vault.salt, "base64"), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(vault.iv, "base64")); decipher.setAAD(Buffer.from(JSON.stringify(header))); decipher.setAuthTag(Buffer.from(authTag, "base64"));
  try { return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8")).identities; }
  catch { throw new Error("Identity vault authentication failed."); }
}

async function readVault(vaultPath) { return JSON.parse(await readFile(vaultPath, "utf8")); }

export async function createIdentityVault(vaultPath, passphrase, actorIds, options = {}) {
  validatePassphrase(passphrase);
  const ids = [...new Set((actorIds ?? []).map((actorId) => String(actorId).trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error("Identity vault requires at least one named actor.");
  if (ids.length !== (actorIds ?? []).length) throw new Error("Identity vault actor ids must be unique and non-empty.");
  return withPlanLock(vaultPath, { actor: options.actor ?? "identity-vault-create" }, async () => {
    try { await readVault(vaultPath); throw new Error("Identity vault already exists."); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const now = options.timestamp ?? new Date().toISOString();
    const vault = seal(ids.map(generateLocalIdentity), passphrase, { createdAt: now, updatedAt: now });
    await atomicWrite(vaultPath, vault);
    return inspectIdentityVault(vaultPath);
  });
}

export async function addIdentityToVault(vaultPath, passphrase, actorId, options = {}) {
  const id = String(actorId ?? "").trim(); if (!id) throw new Error("Identity vault requires a named actor.");
  return withPlanLock(vaultPath, { actor: options.actor ?? `identity-vault-add-${id}`, timeoutMs: options.timeoutMs ?? 5000 }, async () => {
    const vault = await readVault(vaultPath); const identities = openSealed(vault, passphrase);
    if (identities.some((identity) => identity.actorId === id)) throw new Error(`Identity ${id} already exists.`);
    identities.push(generateLocalIdentity(id));
    const updated = seal(identities, passphrase, { createdAt: vault.createdAt, updatedAt: options.timestamp ?? new Date().toISOString() });
    await atomicWrite(vaultPath, updated);
    return inspectIdentityVault(vaultPath);
  });
}

export async function openIdentityVault(vaultPath, passphrase) {
  const vault = await readVault(vaultPath); const identities = openSealed(vault, passphrase);
  return { schemaVersion: 1, vaultFingerprint: vault.vaultFingerprint, identities };
}

export async function openIdentityVaultOpaque(vaultPath, passphrase, custodyRoot, options = {}) {
  const opened = await openIdentityVault(vaultPath, passphrase); const identities = [];
  for (const identity of opened.identities) {
    const secret = Buffer.from(JSON.stringify({ signingPrivateKey: identity.signingPrivateKey, encryptionPrivateKey: identity.encryptionPrivateKey }));
    const stored = await storeOpaqueSecret(custodyRoot, { ownerId: identity.actorId, purpose: "perfect-planner-local-identity-v1", secret }, { dpapi: options.dpapi, timestamp: options.timestamp }); secret.fill(0);
    identities.push({ actorId: identity.actorId, signingFingerprint: identity.signingFingerprint, encryptionFingerprint: identity.encryptionFingerprint, signingPublicKey: identity.signingPublicKey, encryptionPublicKey: identity.encryptionPublicKey, secretHandle: stored.handle, secretVersion: stored.version });
  }
  return { schemaVersion: 1, vaultFingerprint: opened.vaultFingerprint, identities, privateKeys: "OPAQUE" };
}

export async function migrateIdentityVaultToOpaqueCustody(vaultPath, passphrase, custody, input, options = {}) {
  const actor = String(input?.actor ?? "").trim(); const recoveryOwner = String(input?.recoveryOwner ?? "").trim(); const recoveryLocation = String(input?.recoveryLocation ?? "").trim();
  if (!actor || !recoveryOwner || !recoveryLocation || custody?.kind === "plaintext" || typeof custody?.store !== "function" || typeof input?.appendAudit !== "function") throw new Error("Opaque vault migration requires a named actor, reviewed non-plaintext custody, recovery owner/location, and audit appender.");
  const opened = await openIdentityVault(vaultPath, passphrase); const identities = [];
  for (const identity of opened.identities) { const secret = Buffer.from(JSON.stringify({ signingPrivateKey: identity.signingPrivateKey, encryptionPrivateKey: identity.encryptionPrivateKey })); let stored; try { stored = await custody.store({ ownerId: identity.actorId, purpose: "perfect-planner-local-identity-v1", secret }); } finally { secret.fill(0); } if (!String(stored?.handle ?? "").trim()) throw new Error("Opaque custody did not return a handle."); identities.push({ actorId: identity.actorId, signingFingerprint: identity.signingFingerprint, encryptionFingerprint: identity.encryptionFingerprint, signingPublicKey: identity.signingPublicKey, encryptionPublicKey: identity.encryptionPublicKey, secretHandle: stored.handle, secretVersion: stored.version ?? 1 }); }
  const auditBody = { action: "identity-vault.migrated-to-opaque-custody", actor, vaultFingerprint: opened.vaultFingerprint, custodyKind: String(custody.kind), identityFingerprints: identities.map(({ actorId, signingFingerprint, encryptionFingerprint }) => ({ actorId, signingFingerprint, encryptionFingerprint })), recovery: { policy: "offline-passphrase-authenticated-export-v1", owner: recoveryOwner, location: recoveryLocation, auditRequiredBeforeRotationOrRemoval: true }, legacyVault: { state: "ENCRYPTED_RECOVERY_ONLY", routineAccess: "REFUSED_BY_NATIVE_EXCHANGE" } };
  const audit = await input.appendAudit(auditBody); if (!/^[a-f0-9]{64}$/.test(audit?.hash ?? "")) throw new Error("Opaque vault migration audit appender did not return a journal hash."); const body = { schemaVersion: 1, vaultFingerprint: opened.vaultFingerprint, custodyKind: String(custody.kind), identities, privateKeys: "OPAQUE", recovery: auditBody.recovery, legacyVault: auditBody.legacyVault, auditHash: audit.hash, migratedAt: options.timestamp ?? new Date().toISOString() };
  return { ...body, receiptHash: hash(JSON.stringify(body)) };
}

export async function rotateIdentityInVault(vaultPath, passphrase, actorId, options = {}) {
  const id = String(actorId ?? "").trim(); if (!id || !/^[a-f0-9]{64}$/.test(options.recoveryExportDigest ?? "")) throw new Error("Identity rotation requires a named actor and exact recovery export digest for the prior keys.");
  return withPlanLock(vaultPath, { actor: options.actor ?? `identity-vault-rotate-${id}` }, async () => { const vault = await readVault(vaultPath); const identities = openSealed(vault, passphrase); const index = identities.findIndex((identity) => identity.actorId === id); if (index < 0) throw new Error(`Identity ${id} does not exist.`); identities[index] = generateLocalIdentity(id); const updated = seal(identities, passphrase, { createdAt: vault.createdAt, updatedAt: options.timestamp ?? new Date().toISOString() }); await atomicWrite(vaultPath, updated); return { ...(await inspectIdentityVault(vaultPath)), rotatedActorId: id, priorRecoveryExportDigest: options.recoveryExportDigest }; });
}

export async function removeIdentityFromVault(vaultPath, passphrase, actorId, options = {}) {
  const id = String(actorId ?? "").trim(); if (!id || !/^[a-f0-9]{64}$/.test(options.recoveryExportDigest ?? "")) throw new Error("Identity removal requires a named actor and exact recovery export digest.");
  return withPlanLock(vaultPath, { actor: options.actor ?? `identity-vault-remove-${id}` }, async () => { const vault = await readVault(vaultPath); const identities = openSealed(vault, passphrase); const existing = identities.find((identity) => identity.actorId === id); if (!existing) throw new Error(`Identity ${id} does not exist.`); if (identities.length === 1) throw new Error("Identity vault cannot remove its final actor."); const updated = seal(identities.filter((identity) => identity.actorId !== id), passphrase, { createdAt: vault.createdAt, updatedAt: options.timestamp ?? new Date().toISOString() }); await atomicWrite(vaultPath, updated); return { ...(await inspectIdentityVault(vaultPath)), removedActorId: id, removedSigningFingerprint: existing.signingFingerprint, removedEncryptionFingerprint: existing.encryptionFingerprint, recoveryExportDigest: options.recoveryExportDigest }; });
}

export async function inspectIdentityVault(vaultPath) {
  const vault = await readVault(vaultPath);
  return { schemaVersion: vault.schemaVersion, kdf: vault.kdf, cipher: vault.cipher, createdAt: vault.createdAt, updatedAt: vault.updatedAt, vaultFingerprint: vault.vaultFingerprint, identityCount: vault.publicIdentities.length, identities: vault.publicIdentities.map(({ actorId, signingFingerprint, encryptionFingerprint }) => ({ actorId, signingFingerprint, encryptionFingerprint })), privateKeys: "REDACTED" };
}
