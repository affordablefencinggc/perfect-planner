const SHA = /^[a-f0-9]{40}$/i;
const DAY = 86_400_000;
const defaultAllowedLicenses = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0"]);

// Planning descriptors only. The authority-owned adapter must recheck access at click time.
export function planTaskRoutes(input = {}) {
  const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 500;
  if (!text(input.projectId) || !text(input.taskId) || !text(input.goal) || !text(input.task)
    || !Number.isSafeInteger(input.revision) || input.revision < 1) throw Error("SONAR_TASK_CONTEXT_REQUIRED");
  const sources = input.sources ?? [];
  if (!Array.isArray(sources) || sources.length > 32) throw Error("SONAR_SOURCE_LIMIT");
  const ids = new Set();
  const context = { projectId: input.projectId, taskId: input.taskId, revision: input.revision };
  const routes = sources.map(source => {
    if (!source || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) || ids.has(source.id)
      || !text(source.label) || !["connected", "connectable", "local", "unavailable"].includes(source.state)
      || source.projectId !== input.projectId || source.revision !== input.revision
      || !text(source.capability) || !["read", "import"].includes(source.scope)) throw Error("SONAR_SOURCE_INVALID");
    ids.add(source.id);
    const supported = source.state !== "unavailable" && /^[a-zA-Z0-9_-]{1,80}$/.test(source.adapterId ?? "");
    const state = supported ? source.state : "unavailable";
    const rank = { connected: 0, local: 1, connectable: 2, unavailable: 4 }[state];
    const verb = { connected: "Review source", local: "Choose files", connectable: "Connect", unavailable: "Explore another route" }[state];
    const why = {
      connected: "Existing access offers a path with fewer setup steps; check it before reading.",
      local: "Use selected files without setting up another service.",
      connectable: "A supported connection can supply this input after you review access.",
      unavailable: "This source has no usable action in the current plan; use another path.",
    }[state];
    return {
      id: `source-${source.id}`, title: source.label, state, rank, why,
      enables: source.capability, fallbackId: "inventory", executionAuthorized: false,
      action: supported ? { ...context, adapterId: source.adapterId, sourceId: source.id,
        scope: source.scope, label: verb, kind: state === "connected" ? "review-source" : state === "local" ? "select-files" : "authorize-connection",
        requiresCapabilityRecheck: true, executionAuthorized: false } : null,
    };
  });
  routes.push({ id: "inventory", title: "Map where the inputs could come from", state: "planning", rank: 3,
    why: "Keep planning while access is missing: identify sources, alternatives and only the questions that change the path.",
    enables: "A source inventory and acquisition plan", fallbackId: null, action: null, executionAuthorized: false });
  routes.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1, ...context, goal: input.goal, task: input.task,
    status: "PLAN_DRAFT", rankingBasis: "Access and setup effort; coverage, cost and user preferences still need review.",
    routes: routes.map((route, index) => ({ ...route, order: index + 1 })),
    map: { nodes: [{ id: "goal", label: input.goal }, { id: "task", label: input.task },
      ...routes.map(route => ({ id: route.id, label: route.title }))],
      edges: [{ from: "goal", to: "task", kind: "task" },
        ...routes.map(route => ({ from: "task", to: route.id, kind: "alternative" })),
        ...routes.filter(route => route.fallbackId).map(route => ({ from: route.id, to: route.fallbackId, kind: "fallback" }))] },
    executionAuthorized: false,
  };
}

export function assessRepositorySonar(input = {}, options = {}) {
  const required = [...new Set(input.requiredCapabilities ?? [])];
  if (!required.length) return { verdict: "BLOCKED", blockers: ["Repository sonar requires explicit capabilities before search."], candidates: [], recommendation: null };
  const now = Number(options.now ?? Date.now()); const allowedLicenses = new Set(options.allowedLicenses ?? defaultAllowedLicenses);
  const candidates = (input.candidates ?? []).map((candidate) => {
    const blockers = []; const warnings = [];
    if (!candidate.sourceUrl || !SHA.test(String(candidate.commitSha ?? ""))) blockers.push("Source URL and immutable 40-character commit SHA are required.");
    if (!candidate.licenseSpdx || !candidate.licenseSource) blockers.push("Licence identity and licence evidence are required.");
    else if (!allowedLicenses.has(candidate.licenseSpdx)) blockers.push(`Licence ${candidate.licenseSpdx} is outside the approved policy.`);
    if (candidate.archived === true) blockers.push("Repository is archived.");
    const ageDays = (now - Date.parse(candidate.updatedAt)) / DAY;
    if (!Number.isFinite(ageDays) || ageDays < 0) blockers.push("Maintenance date is invalid.");
    else if (ageDays > Number(options.maxMaintenanceAgeDays ?? 365)) warnings.push(`Repository maintenance is stale (${Math.floor(ageDays)} days).`);
    if ((candidate.securityAdvisories ?? []).some((advisory) => ["critical", "high"].includes(advisory.severity) && advisory.status !== "resolved")) blockers.push("Unresolved high/critical security advisory exists.");
    if (candidate.sbomAvailable !== true) blockers.push("SBOM or dependency inventory is missing.");
    if (candidate.provenanceAttested !== true) blockers.push("Source provenance is not attested.");
    const supported = new Set(candidate.capabilities ?? []); const matched = required.filter((capability) => supported.has(capability)); const missing = required.filter((capability) => !supported.has(capability));
    if (missing.length) warnings.push(`Capability gaps: ${missing.join(", ")}.`);
    const coverage = matched.length / required.length;
    const freshness = Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / Number(options.maxMaintenanceAgeDays ?? 365)) : 0;
    const score = Math.round(coverage * 55 + freshness * 15 + Math.min(10, Number(candidate.maintainers ?? 0) * 2) + (candidate.testEvidence ? 10 : 0) + (candidate.documentationEvidence ? 5 : 0) + (candidate.releaseEvidence ? 5 : 0));
    return { id: candidate.id, title: candidate.title, eligible: blockers.length === 0 && coverage >= Number(options.minimumCoverage ?? 0.5), score, coverage: Math.round(coverage * 100), matched, missing, blockers, warnings, licence: candidate.licenseSpdx ?? "UNKNOWN", commitSha: candidate.commitSha ?? null, sourceUrl: candidate.sourceUrl ?? null, action: "SHORTLIST_ONLY" };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || String(a.id).localeCompare(String(b.id)));
  const eligible = candidates.filter((candidate) => candidate.eligible);
  return { verdict: eligible.length ? "SHORTLIST_READY" : "BLOCKED", blockers: eligible.length ? [] : ["No repository candidate satisfies licence, provenance, security, maintenance, SBOM, and minimum-fit policy."], candidates, recommendation: eligible[0] ? { candidateId: eligible[0].id, action: "SHORTLIST_ONLY", reason: "Highest eligible evidence-backed fit; human licence/architecture review still required before any import." } : null };
}

export function generateUnverifiedNames(seedTerms = []) {
  const words = seedTerms.map((term) => String(term).toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean).slice(0, 4);
  if (words.length < 2) return [];
  const variants = [`${words[0]}${words[1]}`, `${words[0]}-${words.at(-1)}`, `${words[1]}${words[0]}`, `${words[0]}-forge`, `${words[0]}-spine`, `${words[0]}-ledger`];
  return [...new Set(variants)].map((name, index) => ({ id: `NAME-${String(index + 1).padStart(2, "0")}`, name, status: "UNVERIFIED", evidence: [] }));
}

export function assessNameCandidates(candidates = [], options = {}) {
  const requiredChecks = options.requiredChecks ?? ["domain", "package", "repository", "trademark"];
  return candidates.map((candidate) => {
    const checks = candidate.evidence ?? []; const missing = requiredChecks.filter((kind) => !checks.some((check) => check.kind === kind && check.source && check.checkedAt));
    const conflicts = checks.filter((check) => check.available === false).map((check) => check.kind);
    const stale = checks.filter((check) => Number(options.now ?? Date.now()) - Date.parse(check.checkedAt) > Number(options.maxCheckAgeDays ?? 30) * DAY).map((check) => check.kind);
    const status = conflicts.length ? "CONFLICT" : missing.length || stale.length ? "UNVERIFIED" : "AVAILABLE_AT_CHECK_TIME";
    return { id: candidate.id, name: candidate.name, status, missing, conflicts, stale, caveat: status === "AVAILABLE_AT_CHECK_TIME" ? "Availability is time-bound and is not legal clearance." : "Do not select this name yet." };
  });
}
