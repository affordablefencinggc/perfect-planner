// The person's signing key. Rotating goes through ledger.rotateKey: the provider stages a new key, the
// old key vouches for it (key.trusted), the new key becomes active and retires the old one (key.retired),
// so every device that trusted the old key follows (core/ledger "Rotation and stolen keys"). Only the
// person's own window can do this: POSTs need the claimed session, and HostKeys stages a person's key
// only inside that person's own request.
import { HttpError, type Router } from "../router";
import { localPerson } from "./people";

export function registerKeyRoutes(router: Router): void {
  /** POST /keys/rotate { reason }: a new key for the person; the old one is retired in this project's ledger. */
  router.post("/keys/rotate", ({ project, body }) => {
    const reason = (body as { reason?: unknown } | undefined)?.reason;
    if (typeof reason !== "string" || !reason.trim()) throw new HttpError(400, "INVALID", "Say why the key is being replaced (for example: new PC, or the old one may be stolen).");
    const person = localPerson(project);
    const { trusted, retired, recovery } = project.ledger.rotateKey(person, reason.trim().slice(0, 300));
    // Retiring the key that set the recovery code voids it, so the ledger makes a new one. It exists only
    // in this answer: the person's window shows it once (never logged, stored or copied by the app).
    return { key: retired.sig?.key ?? null, retired: trusted.sig?.key ?? null, entries: [trusted.n, retired.n], ...(recovery ? { recovery: { code: recovery.code, entry: recovery.entry.n } } : {}) };
  });
}
