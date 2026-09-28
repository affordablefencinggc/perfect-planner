import { createHash } from "node:crypto";

export const CLAMSHIELD_PROTOCOL_VERSION = 1;

const CHECKS = new Set(["inventory", "delta", "malware", "secrets", "code-risk", "dependencies"]);
const SECURITY = new Set(["CLEAN", "THREAT", "INCOMPLETE"]);
const INTEGRITY = new Set(["UNCHANGED", "CHANGED", "UNKNOWN"]);
const CI = new Set(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]);
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer of at least ${minimum}.`);
  return value;
}

function exactId(value, name) {
  if (!ID.test(String(value ?? ""))) throw new Error(`${name} is not a bounded exact identity.`);
  return String(value);
}

function digest(value, name) {
  if (!DIGEST.test(String(value ?? ""))) throw new Error(`${name} requires a lowercase SHA-256 digest.`);
  return String(value);
}

function uniqueChecks(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("At least one ClamShield check is required.");
  if (new Set(values).size !== values.length || values.some((value) => !CHECKS.has(value))) throw new Error("ClamShield checks must be unique registered check names.");
  return [...values];
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function contractDigest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function createClamShieldRequest(input) {
  const request = {
    schemaVersion: CLAMSHIELD_PROTOCOL_VERSION,
    requestId: exactId(input?.requestId, "requestId"),
    workspaceId: exactId(input?.workspaceId, "workspaceId"),
    canonicalRootDigest: digest(input?.canonicalRootDigest, "canonicalRootDigest"),
    censusDigest: digest(input?.censusDigest, "censusDigest"),
    baselineGeneration: input?.baselineGeneration == null ? null : exactId(input.baselineGeneration, "baselineGeneration"),
    requestedChecks: uniqueChecks(input?.requestedChecks),
    limits: {
      maxFiles: integer(input?.limits?.maxFiles, "maxFiles", 1),
      maxFileBytes: integer(input?.limits?.maxFileBytes, "maxFileBytes", 1),
      maxTotalBytes: integer(input?.limits?.maxTotalBytes, "maxTotalBytes", 1),
      timeoutMs: integer(input?.limits?.timeoutMs, "timeoutMs", 1),
    },
    authority: "EVIDENCE_ONLY",
  };
  return Object.freeze({ ...request, requestDigest: contractDigest(request) });
}

export function assessClamShieldReceipt(request, receipt) {
  if (receipt?.schemaVersion !== CLAMSHIELD_PROTOCOL_VERSION) throw new Error("Unsupported ClamShield receipt schema.");
  for (const key of ["requestId", "workspaceId", "canonicalRootDigest", "censusDigest", "requestDigest"]) {
    if (receipt?.[key] !== request?.[key]) throw new Error(`ClamShield receipt identity mismatch: ${key}.`);
  }
  exactId(receipt.agentId, "agentId");
  exactId(receipt.indexGeneration, "indexGeneration");
  digest(receipt.engineDigest, "engineDigest");
  digest(receipt.policyDigest, "policyDigest");
  const completedChecks = uniqueChecks(receipt.completedChecks);
  if (request.requestedChecks.some((check) => !completedChecks.includes(check))) throw new Error("ClamShield receipt is missing a requested check.");
  if (!SECURITY.has(receipt.security) || !INTEGRITY.has(receipt.integrity) || !CI.has(receipt.ci)) throw new Error("ClamShield receipt contains an unknown verdict.");
  const counts = {};
  for (const key of ["observed", "hashed", "scanned", "cacheHits", "threats", "secretFindings", "codeRisks", "skipped", "errors"]) counts[key] = integer(receipt?.counts?.[key], key);
  if (counts.hashed > counts.observed || counts.scanned > counts.observed || counts.cacheHits > counts.observed) throw new Error("ClamShield receipt counters exceed observed files.");
  const problems = [];
  if (receipt.coverageComplete !== true) problems.push("coverage incomplete");
  if (counts.skipped > 0) problems.push(`${counts.skipped} skipped`);
  if (counts.errors > 0) problems.push(`${counts.errors} errors`);
  if (receipt.security === "THREAT" || counts.threats > 0) problems.push("threat detected");
  if (receipt.security === "INCOMPLETE") problems.push("security incomplete");
  // This version performs consistency checks only. No authenticated producer,
  // current definition set or complete content-bound scan has been verified.
  // A self-computed digest is not a signature and cannot open a security gate.
  problems.push("external receipt authenticity and freshness are not verified");
  return Object.freeze({
    schemaVersion: CLAMSHIELD_PROTOCOL_VERSION,
    authority: "UNTRUSTED_EXTERNAL_EVIDENCE",
    canApprove: false,
    canExecute: false,
    canMarkComplete: false,
    reportedSecurity: receipt.security,
    reportedIntegrity: receipt.integrity,
    reportedCi: receipt.ci,
    security: "UNAVAILABLE",
    integrity: "UNKNOWN",
    ci: "NOT_RUN",
    securityGate: "BLOCKED",
    problems: Object.freeze(problems),
    receiptDigest: contractDigest(receipt),
  });
}
