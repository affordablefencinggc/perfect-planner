export const architecturePolicyVersion = "2026.09.1";

const unique = (items) => [...new Set(items)];

export function canonicalArchitectureValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Architecture contracts refuse non-finite numbers."); return value; }
  if (typeof value !== "object") throw new Error("Architecture contracts accept JSON data only.");
  if (seen.has(value)) throw new Error("Architecture contracts refuse cyclic data.");
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => canonicalArchitectureValue(item, seen))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalArchitectureValue(value[key], seen)]));
  seen.delete(value);
  return result;
}

export const canonicalArchitectureJson = (value) => JSON.stringify(canonicalArchitectureValue(value));
export async function architectureSha256(value) { const bytes = new TextEncoder().encode(value); const result = await globalThis.crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
export function deepFreezeArchitecture(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreezeArchitecture(child); } return value; }

export async function verifyArchitectureContract(contract) {
  const reasons = [];
  if (contract?.schemaVersion !== 1) reasons.push("Unsupported architecture contract schema.");
  if (contract?.policyVersion !== architecturePolicyVersion) reasons.push(`Pinned policy ${contract?.policyVersion ?? "missing"} is not the installed policy ${architecturePolicyVersion}; explicit migration is required.`);
  if (!/^[a-f0-9]{64}$/.test(contract?.digest ?? "")) reasons.push("Architecture contract digest is missing or malformed.");
  let actualDigest = null;
  if (!reasons.some((reason) => reason.includes("schema"))) {
    try { const { digest: _digest, ...payload } = contract ?? {}; actualDigest = await architectureSha256(canonicalArchitectureJson(payload)); if (actualDigest !== contract?.digest) reasons.push("Architecture contract content changed after approval."); }
    catch (error) { reasons.push(error.message); }
  }
  return { valid: reasons.length === 0, reasons: unique(reasons), expectedDigest: contract?.digest ?? null, actualDigest };
}
