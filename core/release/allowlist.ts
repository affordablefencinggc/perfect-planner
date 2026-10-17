// Reviewed secret-scan exceptions. A finding is identified by its fingerprint
// ("<file>:<rule>:<scrypt of the value salted with file and rule>"), which
// leaks nothing useful even for short values. The review gate honours a
// fingerprint only when a person approved it in the signed ledger
// (approvedFingerprints below). The local pre-push hook, which cannot verify
// ledger signatures, reads .perfect-planner/secret-allowlist.json from the
// remote default branch only, where an entry arrives through review.

import { scryptSync } from "node:crypto";
import { isAuthoritative, type Actor, type Ledger, type LedgerEntry } from "../ledger/index";
import { nextNumber } from "../numbering/index";

export const ALLOWLIST_PATH = ".perfect-planner/secret-allowlist.json";

/**
 * `<file>:<rule>:<scrypt hex>`; the file path uses forward slashes. The value is
 * hashed with scrypt (salt "perfect-planner:<file>:<rule>", 32 bytes, default
 * cost) so a short secret cannot be brute-forced cheaply from a public list.
 * hooks/pre-push.mjs carries an identical copy.
 */
export function fingerprintOf(file: string, rule: string, value: string): string {
  const f = file.replace(/\\/g, "/");
  return `${f}:${rule}:${scryptSync(value, `perfect-planner:${f}:${rule}`, 32).toString("hex")}`;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * Parses `{ "version": 1, "allow": [{ fingerprint, reason, approvedBy }] }`.
 * Invalid JSON, a wrong shape or an entry without fingerprint, reason and
 * approvedBy is ignored. Never throws.
 */
export function parseAllowlist(text: string): Set<string> {
  const out = new Set<string>();
  if (typeof text !== "string") return out;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof doc !== "object" || doc === null) return out;
  const d = doc as { version?: unknown; allow?: unknown };
  if (d.version !== 1 || !Array.isArray(d.allow)) return out;
  for (const e of d.allow) {
    if (typeof e !== "object" || e === null) continue;
    const { fingerprint, reason, approvedBy } = e as Record<string, unknown>;
    if (nonEmpty(fingerprint) && nonEmpty(reason) && nonEmpty(approvedBy)) out.add(fingerprint);
  }
  return out;
}

// A fingerprint is honoured by the review gate only when a person approved it
// in the ledger: a signed decision.made with this topic, checked with
// isAuthoritative(entry, { personOnly: true }). A file on a branch, however it
// got there, never approves anything on its own (two pushes could otherwise
// approve their own secret: push 1 adds the entry, push 2 the secret).
export const SECRET_ALLOWLIST_TOPIC = "secret-allowlist";

/** Fingerprints a person approved in the ledger. Entries by anyone else, or unsigned, are ignored. */
export function approvedFingerprints(entries: readonly LedgerEntry[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "decision.made" || entry.data?.topic !== SECRET_ALLOWLIST_TOPIC) continue;
    if (!isAuthoritative(entry, { personOnly: true })) continue;
    const fingerprint = entry.data?.fingerprint;
    if (nonEmpty(fingerprint)) {
      if (entry.data?.revoked === true) out.delete(fingerprint);
      else out.add(fingerprint);
    }
  }
  return out;
}

/** Records a person's approval (or, with revoke, withdrawal) of one finding's fingerprint. */
export function approveSecretFinding(
  ledger: Ledger,
  actor: Actor,
  input: { fingerprint: string; reason: string; revoke?: boolean },
): LedgerEntry {
  if (actor.kind !== "person") throw new Error("Only a person can allow a secret-looking value");
  if (!nonEmpty(input.fingerprint)) throw new Error("A fingerprint is required");
  return ledger.append({
    actor,
    type: "decision.made",
    subject: nextNumber(ledger.entries(), "D"),
    summary: input.revoke ? "Secret-scan exception withdrawn" : "Secret-scan exception approved",
    reason: input.reason,
    evidence: [],
    refs: [],
    data: { topic: SECRET_ALLOWLIST_TOPIC, fingerprint: input.fingerprint, revoked: input.revoke === true },
  });
}
