import { validateWorkspaceCensus } from "../native/workspaceCensus.js";
import { validateProjectSession } from "../project/projectSession.js";

function bindingFor(project) {
  const checked = validateProjectSession(project);
  if (checked.kind !== "imported" || ["stale", "unavailable"].includes(checked.state) || !checked.census || checked.registration?.access !== "metadata-read-only") return null;
  return {
    projectId: checked.projectId,
    workspaceId: checked.registration.workspaceId,
    rootIdentity: checked.registration.rootIdentity,
    registryRevision: checked.registration.registryRevision,
    censusDigest: checked.census.digest,
    generatedAt: checked.census.generatedAt,
    fileCount: checked.census.fileCount,
    skippedCount: checked.census.skippedCount,
    totalBytesHashed: checked.census.totalBytesHashed,
  };
}

// Session-only definition observations. These are neither installation nor execution receipts.
export function captureOperationDefinitions(project, rawCensus) {
  try {
    const binding = bindingFor(project);
    if (!binding || rawCensus?.available !== true || rawCensus?.authoritative !== true) return null;
    const { available, authoritative, ...wire } = rawCensus;
    const census = validateWorkspaceCensus(wire);
    if (census.workspaceId !== binding.workspaceId || census.rootIdentity !== binding.rootIdentity
      || census.registryRevision !== binding.registryRevision || census.digest !== binding.censusDigest
      || census.fileCount !== binding.fileCount || census.skipped.length !== binding.skippedCount
      || census.totalBytesHashed !== binding.totalBytesHashed || new Date(census.generatedEpochMs).toISOString() !== binding.generatedAt) return null;
    const paths = new Set(census.files.map((file) => file.path.replaceAll("\\", "/")));
    if (paths.size !== census.files.length) return null;
    return Object.freeze({
      binding: Object.freeze(binding),
      definitions: Object.freeze({
        gitHooks: paths.has(".githooks/pre-commit") && paths.has(".githooks/pre-push"),
        secretScanner: paths.has("scripts/verify-secrets.mjs"),
        ciWorkflow: paths.has(".github/workflows/guardrail-ci.yml"),
      }),
      coverage: census.skipped.length ? "partial" : "bounded",
      executionVerified: false,
    });
  } catch { return null; }
}

export function selectOperationDefinitions(project, observation) {
  try {
    const binding = bindingFor(project);
    if (!binding || !observation || observation.executionVerified !== false) return null;
    if (Object.entries(binding).some(([key, value]) => observation.binding?.[key] !== value)) return null;
    return observation;
  } catch { return null; }
}
