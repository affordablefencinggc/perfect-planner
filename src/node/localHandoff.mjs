import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, KeyObject, randomBytes, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";
export { generateLocalIdentity } from "./localIdentity.mjs";

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fingerprint(pem) { return createHash("sha256").update(pem).digest("hex"); }
function equalText(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }

export function createLocalDraftEnvelope(input, options = {}) {
  const senderId = String(input?.senderId ?? "").trim(); const recipientId = String(input?.recipientId ?? "").trim();
  if (!senderId || !recipientId || !input?.senderSigningPrivateKey || !input?.senderSigningPublicKey || !input?.recipientEncryptionPublicKey) throw new Error("Draft handoff requires sender identity, signing keys, recipient identity, and recipient encryption key.");
  const createdAt = options.createdAt ?? new Date().toISOString();
  const expiresAt = options.expiresAt ?? new Date(Date.parse(createdAt) + 7 * 86_400_000).toISOString();
  if (!(Date.parse(expiresAt) > Date.parse(createdAt))) throw new Error("Draft expiry must be after creation.");
  const ephemeral = generateKeyPairSync("x25519");
  // Node 22 requires KeyObjects here; the transport deliberately carries PEM.
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey(input.recipientEncryptionPublicKey) });
  const salt = randomBytes(32); const iv = randomBytes(12);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from("perfect-planner-local-handoff-v1"), 32));
  const header = { schemaVersion: 1, draftId: options.draftId ?? randomUUID(), senderId, recipientId, createdAt, expiresAt, senderSigningFingerprint: fingerprint(input.senderSigningPublicKey), recipientEncryptionFingerprint: fingerprint(input.recipientEncryptionPublicKey), ephemeralPublicKey: ephemeral.publicKey.export({ type: "spki", format: "pem" }), salt: salt.toString("base64"), iv: iv.toString("base64") };
  const plaintext = Buffer.from(JSON.stringify({ schemaVersion: 1, draft: input.draft }));
  const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(canonicalize(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const unsigned = { ...header, ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
  const signature = sign(null, Buffer.from(canonicalize(unsigned)), input.senderSigningPrivateKey).toString("base64");
  return { ...unsigned, signature };
}

export function openLocalDraftEnvelope(envelope, trust, options = {}) {
  if (envelope?.schemaVersion !== 1) throw new Error("Unsupported local handoff schema.");
  if (!trust?.expectedSenderSigningPublicKey || !trust?.recipientEncryptionPrivateKey || !trust?.recipientId) throw new Error("Opening a draft requires pinned sender trust and recipient credentials.");
  if (envelope.recipientId !== trust.recipientId) throw new Error("Draft is addressed to a different recipient.");
  if (trust.expectedSenderId && envelope.senderId !== trust.expectedSenderId) throw new Error("Draft sender identity does not match the trusted sender.");
  if (!equalText(envelope.senderSigningFingerprint, fingerprint(trust.expectedSenderSigningPublicKey))) throw new Error("Draft signing key does not match the pinned sender key.");
  const { signature, ...unsigned } = envelope;
  if (!verify(null, Buffer.from(canonicalize(unsigned)), trust.expectedSenderSigningPublicKey, Buffer.from(signature, "base64"))) throw new Error("Draft signature verification failed.");
  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(now) || now > Date.parse(envelope.expiresAt)) throw new Error("Draft handoff has expired.");
  const seen = options.seenDraftIds ?? new Set();
  if (seen.has(envelope.draftId)) throw new Error("Draft handoff replay refused.");
  const privateKey = trust.recipientEncryptionPrivateKey instanceof KeyObject ? trust.recipientEncryptionPrivateKey : createPrivateKey(trust.recipientEncryptionPrivateKey);
  const shared = diffieHellman({ privateKey, publicKey: createPublicKey(envelope.ephemeralPublicKey) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(envelope.salt, "base64"), Buffer.from("perfect-planner-local-handoff-v1"), 32));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  const header = Object.fromEntries(Object.entries(unsigned).filter(([key]) => !["ciphertext", "authTag"].includes(key)));
  decipher.setAAD(Buffer.from(canonicalize(header))); decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  let decoded;
  try { decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8")); }
  catch { throw new Error("Draft decryption or authentication failed."); }
  seen.add(envelope.draftId);
  return { draftId: envelope.draftId, senderId: envelope.senderId, recipientId: envelope.recipientId, createdAt: envelope.createdAt, expiresAt: envelope.expiresAt, draft: decoded.draft };
}

export async function createLocalDraftEnvelopeOpaque(input, custody, options = {}) {
  if (!input?.senderSecretHandle || !custody?.use || custody.kind === "plaintext") throw new Error("Native draft exchange requires an opaque sender handle and reviewed custody provider.");
  return custody.use(input.senderSecretHandle, { ownerId: input.senderId, purpose: "perfect-planner-local-identity-v1" }, async (secret) => { let keys; try { keys = JSON.parse(Buffer.from(secret).toString("utf8")); } catch { throw new Error("Opaque sender identity payload is invalid."); } return createLocalDraftEnvelope({ ...input, senderSigningPrivateKey: keys.signingPrivateKey, senderSecretHandle: undefined }, options); });
}

export async function openLocalDraftEnvelopeOpaque(envelope, trust, custody, options = {}) {
  if (!trust?.recipientSecretHandle || !custody?.use || custody.kind === "plaintext") throw new Error("Native draft exchange requires an opaque recipient handle and reviewed custody provider.");
  return custody.use(trust.recipientSecretHandle, { ownerId: trust.recipientId, purpose: "perfect-planner-local-identity-v1" }, async (secret) => { let keys; try { keys = JSON.parse(Buffer.from(secret).toString("utf8")); } catch { throw new Error("Opaque recipient identity payload is invalid."); } return openLocalDraftEnvelope(envelope, { ...trust, recipientEncryptionPrivateKey: keys.encryptionPrivateKey, recipientSecretHandle: undefined }, options); });
}
