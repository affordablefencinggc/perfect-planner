import { createHash, generateKeyPairSync } from "node:crypto";

const fingerprint = (pem) => createHash("sha256").update(pem).digest("hex");

export function generateLocalIdentity(actorId) {
  if (!String(actorId ?? "").trim()) throw new Error("Local identity requires an actor id.");
  const signing = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const encryption = generateKeyPairSync("x25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  return { actorId: String(actorId), signingPublicKey: signing.publicKey, signingPrivateKey: signing.privateKey, encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey, signingFingerprint: fingerprint(signing.publicKey), encryptionFingerprint: fingerprint(encryption.publicKey) };
}
