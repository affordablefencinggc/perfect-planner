import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

const reviewAreas = ["architecture", "security", "tests", "debt"];
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function sealPortableProviderVault(entries, passphrase, options = {}) {
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > 3) throw new Error("Peer-review vault requires exactly two or three providers.");
  if (!String(passphrase ?? "") || String(passphrase).length < 12) throw new Error("Peer-review vault passphrase must contain at least 12 characters.");
  const ids = new Set();
  for (const entry of entries) {
    if (!entry.providerId || !entry.apiKey || ids.has(entry.providerId)) throw new Error("Each provider requires a unique id and non-empty API key.");
    ids.add(entry.providerId);
  }
  const salt = options.salt ?? randomBytes(32); const iv = options.iv ?? randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const header = { schemaVersion: 1, custody: "PORTABLE_FALLBACK_NOT_OS_BACKED", providerIds: [...ids].sort(), salt: Buffer.from(salt).toString("base64"), iv: Buffer.from(iv).toString("base64"), kdf: "scrypt-N16384-r8-p1", cipher: "aes-256-gcm" };
  const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const plaintext = Buffer.from(JSON.stringify(entries.map((entry) => ({ providerId: entry.providerId, apiKey: entry.apiKey }))));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ...header, ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), vaultFingerprint: hash(Buffer.concat([Buffer.from(JSON.stringify(header)), ciphertext, cipher.getAuthTag()])) };
}

export function sealProviderVault(entries, passphrase, options = {}) { return sealPortableProviderVault(entries, passphrase, options); }

export function openProviderVault(vault, passphrase) {
  if (vault?.schemaVersion !== 1 || vault.kdf !== "scrypt-N16384-r8-p1" || vault.cipher !== "aes-256-gcm") throw new Error("Unsupported provider vault format.");
  const key = scryptSync(passphrase, Buffer.from(vault.salt, "base64"), 32, { N: 16384, r: 8, p: 1 });
  const header = Object.fromEntries(Object.entries(vault).filter(([key]) => !["ciphertext", "authTag", "vaultFingerprint"].includes(key)));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(vault.iv, "base64")); decipher.setAAD(Buffer.from(JSON.stringify(header))); decipher.setAuthTag(Buffer.from(vault.authTag, "base64"));
  try { return JSON.parse(Buffer.concat([decipher.update(Buffer.from(vault.ciphertext, "base64")), decipher.final()]).toString("utf8")); }
  catch { throw new Error("Provider vault authentication failed."); }
}

export function openPortableProviderVault(vault, passphrase) {
  if (vault?.custody !== "PORTABLE_FALLBACK_NOT_OS_BACKED") throw new Error("Provider vault is not an explicit portable fallback.");
  return openProviderVault(vault, passphrase);
}

export function assessPeerReview(input = {}) {
  const reviews = input.reviews ?? [];
  const requiredQuorum = Number(input.requiredQuorum ?? 2);
  const blockers = []; const providerIds = new Set();
  if (requiredQuorum < 2 || requiredQuorum > 3) blockers.push("Peer-review quorum must be two or three independent providers.");
  for (const review of reviews) {
    if (!review.providerId || providerIds.has(review.providerId)) blockers.push("Every review must come from a unique named provider.");
    providerIds.add(review.providerId);
    if (!review.promptHash || !review.artifactHash || !review.completedAt) blockers.push(`Review provenance is incomplete: ${review.providerId ?? "unknown"}.`);
    for (const area of reviewAreas) if (!review.findings?.[area] || !["clear", "warning", "block"].includes(review.findings[area].verdict) || !review.findings[area].evidence) blockers.push(`Review ${review.providerId ?? "unknown"} lacks ${area} verdict evidence.`);
  }
  if (providerIds.size < requiredQuorum) blockers.push(`Independent review quorum is incomplete: ${providerIds.size}/${requiredQuorum}.`);
  const criticalBlocks = reviews.flatMap((review) => reviewAreas.filter((area) => review.findings?.[area]?.verdict === "block").map((area) => ({ providerId: review.providerId, area, evidence: review.findings[area].evidence })));
  if (criticalBlocks.length) blockers.push(`${criticalBlocks.length} provider block finding(s) remain unresolved.`);
  const disagreements = reviewAreas.flatMap((area) => {
    const verdicts = reviews.map((review) => review.findings?.[area]?.verdict).filter(Boolean);
    return new Set(verdicts).size > 1 ? [{ area, verdicts: reviews.map((review) => ({ providerId: review.providerId, verdict: review.findings?.[area]?.verdict })) }] : [];
  });
  if (disagreements.length) blockers.push(`${disagreements.length} peer-review disagreement(s) require disposition.`);
  const ready = blockers.length === 0 && reviews.length >= requiredQuorum;
  return { ready, verdict: ready ? "QUORUM_CLEAR" : "BLOCKED", blockers: [...new Set(blockers)], requiredQuorum, providers: [...providerIds], criticalBlocks, disagreements, areas: reviewAreas };
}

export function redactProviderVault(vault) { return { schemaVersion: vault.schemaVersion, custody: vault.custody ?? "LEGACY_PORTABLE_FALLBACK", providerIds: vault.providerIds, kdf: vault.kdf, cipher: vault.cipher, vaultFingerprint: vault.vaultFingerprint, secrets: "REDACTED" }; }
