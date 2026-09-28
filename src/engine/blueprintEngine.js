export const blueprintTemplates = [
  { id: "web-saas", title: "Web SaaS", platforms: ["web"], required: ["businessModel", "targetUsers", "dataClassification", "authModel", "hostingBudget", "browserSupport", "exitStrategy"] },
  { id: "pwa-offline", title: "Offline-capable PWA", platforms: ["pwa"], required: ["targetUsers", "offlineContract", "syncConflictPolicy", "storageBudget", "installStrategy", "browserSupport", "exitStrategy"] },
  { id: "desktop-tauri", title: "Hardened Tauri desktop", platforms: ["tauri"], required: ["targetUsers", "osTargets", "nativeCapabilities", "capabilityPolicy", "updateSigning", "dataClassification", "exitStrategy"] },
  { id: "desktop-electron", title: "Node-powered Electron desktop", platforms: ["electron"], required: ["targetUsers", "osTargets", "nodeRuntimeNeed", "sandboxPolicy", "updateSigning", "memoryBudget", "exitStrategy"] },
  { id: "local-collaboration", title: "Local-first collaboration", platforms: ["tauri", "electron", "pwa"], required: ["participantModel", "handoffProtocol", "conflictPolicy", "encryptionModel", "identityModel", "recoveryPolicy", "exitStrategy"] },
  { id: "api-service", title: "API and worker service", platforms: ["server"], required: ["consumers", "apiContract", "dataClassification", "availabilityTarget", "queuePolicy", "costCeiling", "exitStrategy"] },
];

export const blueprintRulebookBoundary = Object.freeze({
  version: "2026.09.1",
  blueprintOwner: "intake-feasibility",
  blueprintTerminalVerdict: "READY_FOR_PLANNING",
  rulebookOwner: "architecture-contract",
  rulebookTerminalVerdict: "READY_FOR_ARCHITECTURE",
  freezeOwner: "rulebookEngine",
});

const truthy = (value) => value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
const unique = (values) => [...new Set(values)];

export function recommendTemplates(brief = {}) {
  return blueprintTemplates.map((template) => {
    let score = 0; const reasons = [];
    if (brief.localFirst && template.id === "local-collaboration") { score += 5; reasons.push("local-first handoff"); }
    if (brief.nativeCapabilities?.length && template.platforms.some((platform) => ["tauri", "electron"].includes(platform))) { score += 4; reasons.push("native capability requirement"); }
    if (brief.nodeRuntimeNeed && template.id === "desktop-electron") { score += 4; reasons.push("Node runtime required"); }
    if (brief.offline && template.id === "pwa-offline") { score += 4; reasons.push("offline browser delivery"); }
    if (brief.apiOnly && template.id === "api-service") { score += 5; reasons.push("service-only product"); }
    if (brief.subscription && template.id === "web-saas") { score += 3; reasons.push("subscription delivery"); }
    return { id: template.id, title: template.title, score, reasons };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function evaluateBlueprint(input = {}) {
  const blockers = []; const warnings = []; const requiredQuestions = []; const alternatives = [];
  const template = blueprintTemplates.find((candidate) => candidate.id === input.templateId);
  if (!template) return { ready: false, verdict: "BLOCKED", planningBoundary: blueprintRulebookBoundary, template: null, blockers: ["Select one registered intake template before rulebook work begins."], warnings, requiredQuestions: ["templateId"], alternatives: recommendTemplates(input.brief), score: 0 };
  const answers = input.answers ?? {};
  for (const question of template.required) if (!truthy(answers[question])) requiredQuestions.push(question);
  const platform = String(input.platform ?? template.platforms[0]);
  if (!template.platforms.includes(platform)) blockers.push(`Template ${template.id} does not permit platform ${platform}.`);
  const capabilities = new Set(input.nativeCapabilities ?? answers.nativeCapabilities ?? []);
  if (platform === "pwa" && [...capabilities].some((capability) => ["unrestricted-filesystem", "background-daemon", "native-process", "system-tray-autostart"].includes(capability))) {
    blockers.push("A PWA cannot honestly guarantee the requested unrestricted native capability set."); alternatives.push({ platform: "tauri", reason: "explicit least-privilege native capabilities" }, { platform: "electron", reason: "Node runtime and mature desktop integrations" });
  }
  if (platform === "tauri" && (input.nodeRuntimeNeed === true || answers.nodeRuntimeNeed === true)) {
    blockers.push("Tauri cannot be selected while an unrestricted embedded Node runtime is mandatory."); alternatives.push({ platform: "electron", reason: "native Node runtime requirement" }, { platform: "tauri", reason: "replace Node dependency with a reviewed Rust command or bounded sidecar" });
  }
  if (platform === "electron" && Number(answers.memoryBudget ?? Number.POSITIVE_INFINITY) < 250) warnings.push("Electron is unlikely to hold a sub-250 MB memory budget; benchmark Tauri before commitment.");
  if (["confidential", "restricted"].includes(answers.dataClassification) && !truthy(answers.threatModel)) requiredQuestions.push("threatModel");
  if (input.motive === "money" && !truthy(answers.unitEconomics)) requiredQuestions.push("unitEconomics");
  if (input.publicUsers === true) for (const question of ["accessibilityTarget", "privacyBasis", "abuseModel"]) if (!truthy(answers[question])) requiredQuestions.push(question);
  if (input.autopilot === true) for (const question of ["collisionPolicy", "proofPolicy", "rollbackPolicy", "capabilityPolicy", "humanStopPolicy"]) if (!truthy(answers[question])) requiredQuestions.push(question);
  const dependencies = input.dependencies ?? [];
  for (const dependency of dependencies) {
    if (!truthy(dependency.name) || !truthy(dependency.purpose)) blockers.push("Every dependency requires a name and explicit purpose.");
    if (dependency.critical === true && !truthy(dependency.fallback)) requiredQuestions.push(`fallback:${dependency.name || "unnamed"}`);
    if (!truthy(dependency.license)) requiredQuestions.push(`license:${dependency.name || "unnamed"}`);
  }
  const mustHaves = input.mustHaves ?? [];
  if (!mustHaves.length) requiredQuestions.push("mustHaves");
  if (mustHaves.some((item) => !truthy(item.acceptance))) blockers.push("Every must-have needs a falsifiable acceptance condition.");
  if (!truthy(input.debtBudget)) requiredQuestions.push("debtBudget");
  if (!truthy(input.contingencyTrigger)) requiredQuestions.push("contingencyTrigger");
  const questions = unique(requiredQuestions);
  const score = Math.max(0, 100 - blockers.length * 25 - questions.length * 7 - warnings.length * 3);
  return { ready: blockers.length === 0 && questions.length === 0, verdict: blockers.length || questions.length ? "BLOCKED" : blueprintRulebookBoundary.blueprintTerminalVerdict, planningBoundary: blueprintRulebookBoundary, template: { id: template.id, title: template.title, platform }, blockers, warnings, requiredQuestions: questions, alternatives, score };
}
