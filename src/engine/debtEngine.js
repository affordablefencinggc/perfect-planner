const severityWeight = { critical: 40, high: 15, medium: 5, low: 1 };
const DAY = 86_400_000;

export function assessTechnicalDebt(snapshot = {}, previous = {}, options = {}) {
  const blockers = []; const warnings = [];
  const requiredSurfaces = options.requiredSurfaces ?? [];
  const covered = new Set(snapshot.coveredSurfaces ?? []);
  const missingCoverage = requiredSurfaces.filter((surface) => !covered.has(surface));
  if (!snapshot.scanId || !snapshot.capturedAt) blockers.push("Debt assessment requires a scan identity and capture time.");
  if (missingCoverage.length) blockers.push(`Debt coverage is incomplete: ${missingCoverage.join(", ")}.`);
  const findings = snapshot.findings ?? [];
  const previousFindings = previous.findings ?? [];
  const ids = new Set();
  for (const finding of findings) {
    if (!finding.id || ids.has(finding.id)) blockers.push("Debt findings require unique stable identities.");
    ids.add(finding.id);
    if (!severityWeight[finding.severity]) blockers.push(`Debt finding ${finding.id || "unknown"} has invalid severity.`);
    if (!finding.surface || !finding.category || !finding.introducedAt) blockers.push(`Debt finding ${finding.id || "unknown"} lacks surface, category, or introduction date.`);
    if (finding.status !== "resolved" && !finding.owner) blockers.push(`Open debt finding ${finding.id || "unknown"} has no owner.`);
    if (finding.status !== "resolved" && !finding.evidence) blockers.push(`Open debt finding ${finding.id || "unknown"} has no evidence reference.`);
  }
  const open = findings.filter((finding) => finding.status !== "resolved");
  const counts = Object.fromEntries(Object.keys(severityWeight).map((severity) => [severity, open.filter((finding) => finding.severity === severity).length]));
  const budget = snapshot.budget ?? {};
  for (const severity of Object.keys(severityWeight)) if (Number.isFinite(budget[severity]) && counts[severity] > budget[severity]) blockers.push(`${severity} debt exceeds budget: ${counts[severity]}/${budget[severity]}.`);
  const now = Date.parse(snapshot.capturedAt);
  const maxAgeDays = snapshot.maxAgeDays ?? {};
  for (const finding of open) {
    const ageDays = (now - Date.parse(finding.introducedAt)) / DAY;
    if (!Number.isFinite(ageDays) || ageDays < 0) blockers.push(`Debt finding ${finding.id} has an invalid introduction date.`);
    else if (Number.isFinite(maxAgeDays[finding.severity]) && ageDays > maxAgeDays[finding.severity]) blockers.push(`Debt finding ${finding.id} exceeded its ${maxAgeDays[finding.severity]}-day ${finding.severity} age limit.`);
  }
  if (counts.critical > 0) blockers.push("Critical technical debt is a release stop.");
  const previousById = new Map(previousFindings.map((finding) => [finding.id, finding]));
  const currentById = new Map(findings.map((finding) => [finding.id, finding]));
  const added = findings.filter((finding) => !previousById.has(finding.id)).map((finding) => finding.id);
  const resolved = previousFindings.filter((finding) => finding.status !== "resolved" && currentById.get(finding.id)?.status === "resolved").map((finding) => finding.id);
  const removedWithoutResolution = previousFindings.filter((finding) => finding.status !== "resolved" && !currentById.has(finding.id)).map((finding) => finding.id);
  if (removedWithoutResolution.length) blockers.push(`Debt findings disappeared without resolution evidence: ${removedWithoutResolution.join(", ")}.`);
  const regressed = findings.filter((finding) => previousById.has(finding.id) && severityWeight[finding.severity] > severityWeight[previousById.get(finding.id).severity]).map((finding) => finding.id);
  if (regressed.length) warnings.push(`Debt severity regressed: ${regressed.join(", ")}.`);
  const weightedOpen = open.reduce((sum, finding) => sum + (severityWeight[finding.severity] ?? 0), 0);
  const coverageComplete = missingCoverage.length === 0 && requiredSurfaces.length > 0;
  const verdict = !coverageComplete ? "UNKNOWN" : blockers.length ? "BLOCKED" : "WITHIN_BUDGET";
  return { verdict, ready: verdict === "WITHIN_BUDGET", blockers: [...new Set(blockers)], warnings, coverage: { required: requiredSurfaces.length, covered: requiredSurfaces.length - missingCoverage.length, missing: missingCoverage }, counts, weightedOpen, delta: { added, resolved, regressed, removedWithoutResolution } };
}
