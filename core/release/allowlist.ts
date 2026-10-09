// Reviewed secret allowlist. A finding is let through only when its
// fingerprint ("<file>:<rule>:<sha256 hex of the matched value>") is listed in
// a reviewed file read from the BASE commit, never from the pushed head, so a
// push cannot allowlist its own secret. A fingerprint is a hash and leaks nothing.

import { createHash } from "node:crypto";

export const ALLOWLIST_PATH = ".perfect-planner/secret-allowlist.json";

/** `<file>:<rule>:<sha256 hex of value>`; the file path uses forward slashes. */
export function fingerprintOf(file: string, rule: string, value: string): string {
  return `${file.replace(/\\/g, "/")}:${rule}:${createHash("sha256").update(value).digest("hex")}`;
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
