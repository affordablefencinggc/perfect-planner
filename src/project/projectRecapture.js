import { createImportedProjectSession, createProjectSession, projectAuthorityKinds, validateProjectSession } from "./projectSession.js";

// Scanning a folder that already belongs to a saved project refreshes that
// project as its next generation: the new scan replaces the old one, while the
// project's id, creation time, screen position and saved approvals carry over.
// Approvals keep their own recorded state; the scan never upgrades them.
export function recaptureImportedProject(existing, input, { now = Date.now() } = {}) {
  const fresh = createImportedProjectSession({ ...input, now: input?.now ?? now });
  if (!existing || existing.kind !== "imported" || existing.projectId !== fresh.projectId) return fresh;
  const previous = validateProjectSession(existing);
  const updatedAt = new Date(Math.max(Date.parse(fresh.updatedAt), Date.parse(previous.updatedAt) + 1)).toISOString();
  const rebuilt = createProjectSession({
    projectId: previous.projectId,
    name: fresh.name,
    kind: "imported",
    state: fresh.state,
    registration: fresh.registration,
    census: fresh.census,
    discovery: fresh.discovery,
    authorities: previous.authorities,
    view: previous.view,
    generation: previous.generation + 1,
    createdAt: previous.createdAt,
    updatedAt,
  });
  const provenance = { ...rebuilt.provenance };
  for (const kind of projectAuthorityKinds) {
    const field = `authority.${kind}`;
    if (previous.provenance[field]) provenance[field] = previous.provenance[field];
  }
  return validateProjectSession({ ...structuredClone(rebuilt), provenance: structuredClone(provenance) });
}
