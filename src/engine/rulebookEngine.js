import { architecturePolicyVersion, architectureSha256, canonicalArchitectureJson, canonicalArchitectureValue, deepFreezeArchitecture, verifyArchitectureContract } from "./architectureContractVerification.js";
import { blueprintRulebookBoundary } from "./blueprintEngine.js";

export const architectureTemplates = Object.freeze([
  { id: "static-content-web", title: "Static content website", version: 1, platforms: ["web"], stages: ["brief", "content-model", "design-system", "pages", "accessibility", "deploy-proof"] },
  { id: "authenticated-web-saas", title: "Authenticated web SaaS", version: 1, platforms: ["web"], stages: ["brief", "tenancy-auth", "domain-data", "api-contract", "product-ui", "operations", "release-proof"] },
  { id: "offline-pwa", title: "Offline-first PWA", version: 1, platforms: ["pwa"], stages: ["brief", "offline-contract", "local-data", "sync-conflicts", "install-update", "journey-proof", "release-proof"] },
  { id: "tauri-local-desktop", title: "Least-privilege Tauri desktop", version: 1, platforms: ["tauri"], stages: ["brief", "capability-contract", "local-storage", "native-commands", "desktop-ui", "sign-update", "release-proof"] },
  { id: "electron-node-desktop", title: "Sandboxed Electron desktop", version: 1, platforms: ["electron"], stages: ["brief", "process-boundary", "ipc-contract", "local-storage", "desktop-ui", "sign-update", "release-proof"] },
  { id: "mobile-companion", title: "Mobile companion application", version: 1, platforms: ["mobile"], stages: ["brief", "device-contract", "auth-data", "offline-sync", "mobile-ui", "store-release", "operations"] },
  { id: "api-worker-platform", title: "API and worker platform", version: 1, platforms: ["server"], stages: ["brief", "service-contract", "domain-data", "queues-jobs", "security-observability", "capacity-cost", "release-proof"] },
  { id: "realtime-collaboration", title: "Realtime collaboration product", version: 1, platforms: ["web", "pwa", "tauri", "electron"], stages: ["brief", "identity-membership", "shared-model", "conflict-protocol", "presence-delivery", "client-journeys", "operations-proof"] },
  { id: "data-pipeline-dashboard", title: "Data pipeline and dashboard", version: 1, platforms: ["web", "server"], stages: ["brief", "source-contracts", "ingestion-quality", "model-lineage", "dashboard-access", "operations-cost", "release-proof"] },
  { id: "ai-autopilot-control-plane", title: "Guarded AI autopilot control plane", version: 1, platforms: ["tauri", "electron", "web"], stages: ["brief", "trust-capabilities", "plans-collisions", "execution-proof", "human-review", "ci-merge", "release-handover"] },
]);

export const architecturePlatformLabels = Object.freeze({
  web: "Website in a browser",
  pwa: "Installable web app (PWA)",
  tauri: "Desktop app (Tauri)",
  electron: "Desktop app (Electron)",
  mobile: "Mobile app",
  server: "Server or API",
});

export const useCaseRulebook = Object.freeze({
  "public-users": { questions: ["accessibilityTarget", "privacyBasis", "abuseModel", "supportModel"] },
  "money-motivated": { questions: ["unitEconomics", "billingFailurePolicy", "refundPolicy", "runwayThreshold"] },
  "regulated-data": { questions: ["dataResidency", "deletionSla", "incidentResponse", "auditRetention"] },
  "offline-first": { questions: ["offlineContract", "syncConflictPolicy", "recoveryPolicy", "offlineProof"] },
  collaboration: { questions: ["identityModel", "membershipPolicy", "conflictPolicy", "deliveryReceipt"] },
  "desktop-distribution": { questions: ["osTargets", "updateSigning", "rollbackChannel", "capabilityPolicy"] },
  "ai-autopilot": { questions: ["collisionPolicy", "proofPolicy", "rollbackPolicy", "capabilityPolicy", "humanStopPolicy", "costCeiling"] },
  "high-availability": { questions: ["availabilityTarget", "degradationPolicy", "recoveryTime", "recoveryPoint"] },
});

const capabilityMatrix = Object.freeze({
  "filesystem-scoped": { web: "unsupported", pwa: "bounded", tauri: "supported", electron: "supported", mobile: "bounded", server: "supported" },
  "unrestricted-filesystem": { web: "unsupported", pwa: "unsupported", tauri: "bounded", electron: "supported", mobile: "unsupported", server: "supported" },
  "background-daemon": { web: "unsupported", pwa: "unsupported", tauri: "bounded", electron: "supported", mobile: "bounded", server: "supported" },
  "native-process": { web: "unsupported", pwa: "unsupported", tauri: "bounded", electron: "supported", mobile: "unsupported", server: "supported" },
  "system-tray": { web: "unsupported", pwa: "unsupported", tauri: "supported", electron: "supported", mobile: "unsupported", server: "unsupported" },
  "offline-operation": { web: "bounded", pwa: "supported", tauri: "supported", electron: "supported", mobile: "supported", server: "unsupported" },
  "realtime-multi-user": { web: "supported", pwa: "bounded", tauri: "bounded", electron: "bounded", mobile: "bounded", server: "supported" },
  "push-notifications": { web: "bounded", pwa: "bounded", tauri: "bounded", electron: "bounded", mobile: "supported", server: "supported" },
  "local-encryption": { web: "bounded", pwa: "bounded", tauri: "supported", electron: "supported", mobile: "supported", server: "supported" },
});

const mandatoryScenarios = ["security-breach", "data-loss", "critical-dependency-failure", "vendor-exit"];
const mandatoryDecisions = ["platform", "data", "identity-auth", "state-sync", "deployment-distribution"];
export { architecturePolicyVersion, verifyArchitectureContract };
const truthy = (value) => value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
const unique = (items) => [...new Set(items)];

function findCycle(dependencies) {
  const graph = new Map(dependencies.map((item) => [item.name, item.dependsOn ?? []])); const visiting = new Set(); const visited = new Set();
  function visit(name, trail = []) { if (visiting.has(name)) return [...trail, name]; if (visited.has(name)) return null; visiting.add(name); for (const next of graph.get(name) ?? []) { const cycle = visit(next, [...trail, name]); if (cycle) return cycle; } visiting.delete(name); visited.add(name); return null; }
  for (const name of graph.keys()) { const cycle = visit(name); if (cycle) return cycle; } return null;
}

export function recommendArchitectureTemplates(brief = {}) {
  return architectureTemplates.map((template) => {
    let score = 0; const reasons = [];
    if (brief.autopilot && template.id === "ai-autopilot-control-plane") { score += 8; reasons.push("autopilot guardrails"); }
    if (brief.localFirst && ["tauri-local-desktop", "realtime-collaboration", "ai-autopilot-control-plane"].includes(template.id)) { score += 5; reasons.push("local-first state"); }
    if (brief.realtime && template.id === "realtime-collaboration") { score += 7; reasons.push("shared realtime model"); }
    if (brief.offline && template.id === "offline-pwa") { score += 6; reasons.push("offline browser delivery"); }
    if (brief.apiOnly && template.id === "api-worker-platform") { score += 7; reasons.push("service-only delivery"); }
    if (brief.nativeCapabilities?.length && template.platforms.some((platform) => ["tauri", "electron"].includes(platform))) { score += 4; reasons.push("native capabilities"); }
    return { id: template.id, title: template.title, version: template.version, score, reasons };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function evaluateArchitectureRulebook(input = {}) {
  const blockers = []; const warnings = []; const questions = []; const template = architectureTemplates.find((item) => item.id === input.templateId && item.version === Number(input.templateVersion ?? 1));
  if (!template) return { verdict: "BLOCKED", ready: false, planningBoundary: blueprintRulebookBoundary, template: null, blockers: ["Select an exact registered architecture template id and version after intake feasibility."], warnings, requiredQuestions: ["templateId", "templateVersion"], alternatives: recommendArchitectureTemplates(input.brief), executionMap: null };
  const platform = String(input.platform ?? ""); if (!platform) blockers.push(`Pick a platform for the ${template.title} template. Allowed: ${template.platforms.map((item) => architecturePlatformLabels[item] ?? item).join(", ")}.`); else if (!template.platforms.includes(platform)) blockers.push(`Template ${template.id}@${template.version} does not permit platform ${platform}.`);
  const answers = input.answers ?? {}; const useCases = unique(input.useCases ?? []);
  if (!useCases.length) questions.push("useCases");
  for (const useCase of useCases) { const rule = useCaseRulebook[useCase]; if (!rule) { blockers.push(`Unknown use case: ${useCase}.`); continue; } for (const question of rule.questions) if (!truthy(answers[question])) questions.push(`${useCase}:${question}`); }
  if (useCases.includes("ai-autopilot") && template.id === "static-content-web") blockers.push("A static content template cannot satisfy AI autopilot execution and supervision.");
  if (useCases.includes("regulated-data") && template.id === "static-content-web") blockers.push("A static content template cannot own regulated data lifecycle guarantees.");
  const capabilities = input.capabilities ?? [];
  for (const capability of capabilities) {
    const support = capabilityMatrix[capability.id]?.[platform];
    if (!support) { blockers.push(`Unknown capability or platform mapping: ${capability.id || "(blank)"}.`); continue; }
    if (capability.necessity === "mandatory" && support === "unsupported") blockers.push(`Mandatory capability ${capability.id} is unsupported on ${platform}.`);
    if (capability.necessity === "mandatory" && support === "bounded" && (!truthy(capability.mitigation) || !truthy(capability.proof))) questions.push(`bounded-capability:${capability.id}:mitigation-and-proof`);
    if (capability.necessity !== "mandatory" && !["optional", "preferred"].includes(capability.necessity)) blockers.push(`Capability ${capability.id} requires mandatory, preferred, or optional necessity.`);
  }
  const scenarios = input.scenarios ?? [];
  for (const kind of mandatoryScenarios) {
    const scenario = scenarios.find((item) => item.kind === kind); if (!scenario) { questions.push(`scenario:${kind}`); continue; }
    for (const field of ["trigger", "detection", "owner", "immediateAction", "recovery", "verification"]) if (!truthy(scenario[field])) questions.push(`scenario:${kind}:${field}`);
  }
  const scenarioKinds = scenarios.map((item) => item.kind); if (new Set(scenarioKinds).size !== scenarioKinds.length) blockers.push("Failure scenarios require unique kinds.");
  const dependencies = input.dependencies ?? []; const dependencyNames = dependencies.map((item) => item.name);
  if (new Set(dependencyNames).size !== dependencyNames.length) blockers.push("Dependencies require unique names.");
  for (const dependency of dependencies) {
    for (const field of ["name", "purpose", "license", "pinnedVersion", "maintenanceEvidence", "securityEvidence"]) if (!truthy(dependency[field])) questions.push(`dependency:${dependency.name || "unnamed"}:${field}`);
    if (dependency.critical && (!truthy(dependency.fallback) || !truthy(dependency.switchTrigger))) questions.push(`dependency:${dependency.name || "unnamed"}:fallback-and-trigger`);
    for (const required of dependency.dependsOn ?? []) if (!dependencyNames.includes(required)) blockers.push(`Dependency ${dependency.name} references unknown prerequisite ${required}.`);
  }
  const cycle = findCycle(dependencies); if (cycle) blockers.push(`Dependency cycle blocks ordering: ${cycle.join(" -> ")}.`);
  const decisions = input.decisions ?? [];
  for (const kind of mandatoryDecisions) {
    const decision = decisions.find((item) => item.kind === kind); if (!decision) { questions.push(`decision:${kind}`); continue; }
    for (const field of ["choice", "rationale", "evidence"]) if (!truthy(decision[field])) questions.push(`decision:${kind}:${field}`);
    if (!decision.alternatives?.length || decision.alternatives.some((item) => !truthy(item.choice) || !truthy(item.rejectionReason))) questions.push(`decision:${kind}:alternatives-with-rejection-reasons`);
  }
  const decisionKinds = decisions.map((item) => item.kind); if (new Set(decisionKinds).size !== decisionKinds.length) blockers.push("Architecture decisions require unique kinds.");
  const nfr = input.nonFunctional ?? {};
  for (const field of ["performanceBudget", "securityTarget", "accessibilityTarget", "operatingCostCeiling", "recoveryTarget", "observabilityProof"]) if (!truthy(nfr[field])) questions.push(`nonFunctional:${field}`);
  const executionMap = { direction: "top-down", template: `${template.id}@${template.version}`, nodes: template.stages.map((stage, index) => ({ id: `S${String(index + 1).padStart(2, "0")}`, stage, order: index + 1 })), edges: template.stages.slice(1).map((_, index) => ({ from: `S${String(index + 1).padStart(2, "0")}`, to: `S${String(index + 2).padStart(2, "0")}` })) };
  const requiredQuestions = unique(questions); const ready = blockers.length === 0 && requiredQuestions.length === 0;
  return { verdict: ready ? blueprintRulebookBoundary.rulebookTerminalVerdict : "BLOCKED", ready, planningBoundary: blueprintRulebookBoundary, template: { id: template.id, title: template.title, version: template.version, platform }, blockers: unique(blockers), warnings, requiredQuestions, alternatives: recommendArchitectureTemplates(input.brief), capabilityAssessment: capabilities.map((capability) => ({ id: capability.id, necessity: capability.necessity, support: capabilityMatrix[capability.id]?.[platform] ?? "unknown" })), scenarioCoverage: { required: mandatoryScenarios.length, present: mandatoryScenarios.filter((kind) => scenarios.some((item) => item.kind === kind)).length }, decisionCoverage: { required: mandatoryDecisions.length, present: mandatoryDecisions.filter((kind) => decisions.some((item) => item.kind === kind)).length }, executionMap };
}

export async function freezeArchitectureContract(input, options = {}) {
  const assessment = evaluateArchitectureRulebook(input);
  if (!assessment.ready) throw new Error(`Architecture contract cannot freeze while ${assessment.requiredQuestions.length} contract(s) and ${assessment.blockers.length} blocker(s) remain.`);
  if (!options.actor || !options.approvedAt || !Number.isFinite(Date.parse(options.approvedAt))) throw new Error("Architecture contract freeze requires a named actor and valid approval time.");
  const payload = canonicalArchitectureValue({
    schemaVersion: 1,
    policyVersion: architecturePolicyVersion,
    planningBoundaryVersion: blueprintRulebookBoundary.version,
    planId: options.planId,
    actor: options.actor,
    approvedAt: options.approvedAt,
    input,
    template: assessment.template,
    executionMap: assessment.executionMap,
    capabilityAssessment: assessment.capabilityAssessment,
    scenarioCoverage: assessment.scenarioCoverage,
    decisionCoverage: assessment.decisionCoverage,
  });
  if (!payload.planId) throw new Error("Architecture contract freeze requires a plan identity.");
  return deepFreezeArchitecture({ ...payload, digest: await architectureSha256(canonicalArchitectureJson(payload)) });
}
