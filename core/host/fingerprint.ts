// Approvals are bound to the exact item the person is looking at. Each screen's
// GET returns a fingerprint of the pending item; the approving POST must send it
// back, and the host refuses (409 STALE) when the item has changed since, so a
// click can never approve something the person did not see.
import { createHash } from "node:crypto";
import { HttpError } from "./router";

/** sha256 over a stable JSON rendering (object keys sorted). */
export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

/** Throws 409 STALE unless the request's fingerprint matches the item as it is now. */
export function requireFingerprint(body: unknown, current: string, what: string): void {
  const sent = body && typeof body === "object" ? (body as { fingerprint?: unknown }).fingerprint : undefined;
  if (typeof sent !== "string" || !sent) throw new HttpError(400, "FINGERPRINT_REQUIRED", `Approving needs the ${what} you are looking at. Reload and try again.`);
  if (sent !== current) throw new HttpError(409, "STALE", `The ${what} changed since you looked at it. Review the new version, then approve again.`);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
