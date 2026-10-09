// The person's signing key. Rotating makes a new key (the old one never signs on this device again)
// and then writes key.retired for the old one, signed with the new key, so anything the old key
// signs from here on is a signature problem (core/ledger "Rotation and stolen keys").
import { HttpError, type Router } from "../router";
import { localPerson } from "./people";

export function registerKeyRoutes(router: Router): void {
  /** POST /keys/rotate { reason }: a new key for the person, and the old one retired in this project's ledger. */
  router.post("/keys/rotate", ({ project, host, body }) => {
    const reason = (body as { reason?: unknown } | undefined)?.reason;
    if (typeof reason !== "string" || !reason.trim()) throw new HttpError(400, "INVALID", "Say why the key is being replaced (for example: new PC, or the old one may be stolen).");
    const person = localPerson(project);
    const { oldKeyId, key } = host.keys.rotate(`person:${person.id}`);
    const retired = oldKeyId ? project.ledger.retireKey(person, oldKeyId, reason.trim().slice(0, 300)) : undefined;
    return { key: key.keyId, retired: oldKeyId ?? null, entry: retired?.n ?? null };
  });
}
