import { assessNamingGuardrails, authorizePlannedEdits } from "./editScopeEngine.js";

const COMPONENT_KINDS = new Set(["ui", "service", "storage", "workflow", "integration", "security"]);
const WAVES = new Set(["architecture", "foundation", "build", "integration", "proof", "release"]);
const DIRECTIONS = new Set(["input", "output", "bidirectional"]);
const ACCESS = new Set(["read", "write"]);
const CLASSIFICATIONS = new Set(["public", "internal", "confidential", "restricted"]);

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const text = (value) => Boolean(String(value ?? "").trim());
const list = (value) => Array.isArray(value) && value.length > 0 && value.every(text);
const approvalActor = (value) => typeof value === "string" && value.trim().length > 0;
const approvalTime = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const catalogBody = (input) => ({ schemaVersion: input.schemaVersion, planId: input.planId, architectureDigest: input.architectureDigest, architectureRevision: input.architectureRevision, folderDigest: input.folderDigest, folderRevision: input.folderRevision, inventory: structuredClone(input.inventory), components: structuredClone(input.components) });
const safePath = (value) => { const path = String(value ?? "").trim().replaceAll("\\", "/"); return Boolean(path) && !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) && !path.split("/").includes("..") && !path.includes("//") && !path.endsWith("/"); };

function cycleMembers(components) {
  const dependencies = new Map(components.map((component) => [component.id, new Set((component.dependencies ?? []).map((dependency) => dependency.componentId))]));
  const ready = [...dependencies].filter(([, values]) => values.size === 0).map(([id]) => id).sort(); const visited = [];
  while (ready.length) { const id = ready.shift(); visited.push(id); for (const [candidate, values] of dependencies) if (values.delete(id) && values.size === 0 && !visited.includes(candidate) && !ready.includes(candidate)) ready.push(candidate); ready.sort(); }
  return visited.length === components.length ? [] : [...dependencies.keys()].filter((id) => !visited.includes(id)).sort();
}

export function assessComponentPlans(input) {
  const blockers = []; const warnings = []; const inventory = Array.isArray(input?.inventory) ? input.inventory : []; const components = Array.isArray(input?.components) ? input.components : [];
  if (input?.schemaVersion !== 1) blockers.push("schemaVersion must equal 1.");
  if (!text(input?.planId)) blockers.push("planId is required.");
  if (!/^[a-f0-9]{64}$/.test(input?.architectureDigest ?? "")) blockers.push("architectureDigest must bind the component plans to an exact approved architecture.");
  if (!Number.isSafeInteger(input?.architectureRevision) || input.architectureRevision < 1) blockers.push("architectureRevision must identify a positive saved architecture revision.");
  if (typeof input?.folderDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.folderDigest)) blockers.push("folderDigest must bind the component plans to an exact saved folder contract.");
  if (!Number.isSafeInteger(input?.folderRevision) || input.folderRevision < 1) blockers.push("folderRevision must identify a positive saved folder revision.");
  if (!inventory.length) blockers.push("The architecture inventory must name at least one component.");
  const inventoryIds = new Set(); const inventoryNames = new Set();
  for (const [index, item] of inventory.entries()) { const prefix = `inventory[${index}]`; if (!/^C\d{3,}$/.test(item?.id ?? "")) blockers.push(`${prefix}.id must be a stable C-number.`); else if (inventoryIds.has(item.id)) blockers.push(`Duplicate inventory id ${item.id}.`); inventoryIds.add(item?.id); if (!text(item?.name)) blockers.push(`${prefix}.name is required.`); else if (inventoryNames.has(item.name)) blockers.push(`Duplicate inventory name ${item.name}.`); inventoryNames.add(item?.name); if (!COMPONENT_KINDS.has(item?.kind)) blockers.push(`${prefix}.kind is invalid.`); if (!/^F\d{3,}$/.test(item?.folderNodeId ?? "")) blockers.push(`${prefix}.folderNodeId must reference a stable F-number.`); }
  const componentIds = new Set(); const fileClaims = [];
  for (const [index, component] of components.entries()) {
    const prefix = `components[${index}]`;
    if (!/^C\d{3,}$/.test(component?.id ?? "")) blockers.push(`${prefix}.id must be a stable C-number.`); else if (componentIds.has(component.id)) blockers.push(`Duplicate component plan ${component.id}.`); componentIds.add(component?.id);
    if (!inventoryIds.has(component?.id)) blockers.push(`${component?.id ?? prefix} is not present in the architecture inventory.`);
    const inventoryItem = inventory.find((item) => item.id === component?.id); if (inventoryItem && (inventoryItem.name !== component.name || inventoryItem.kind !== component.kind || inventoryItem.folderNodeId !== component.folderNodeId || inventoryItem.scopeLabel !== component.scopeLabel || inventoryItem.definition !== component.definition || inventoryItem.notThis !== component.notThis)) blockers.push(`${component.id} does not match its inventory identity.`);
    if (!text(component?.purpose) || !text(component?.definitiveOutcome)) blockers.push(`${component?.id ?? prefix} requires purpose and definitiveOutcome.`);
    if (!text(component?.owner) || !text(component?.reviewer) || !text(component?.taskId)) blockers.push(`${component?.id ?? prefix} requires owner, reviewer, and taskId.`);
    if (!WAVES.has(component?.wave) || !Number.isFinite(component?.estimateHours) || component.estimateHours <= 0) blockers.push(`${component?.id ?? prefix} requires a valid wave and positive estimateHours.`);
    if (!list(component?.responsibilities) || !list(component?.nonResponsibilities)) blockers.push(`${component?.id ?? prefix} requires explicit responsibilities and nonResponsibilities.`);
    if (!Array.isArray(component?.interfaces) || !component.interfaces.length) blockers.push(`${component?.id ?? prefix} requires at least one typed interface.`);
    for (const [interfaceIndex, item] of (component?.interfaces ?? []).entries()) if (!/^I\d{2,}$/.test(item?.id ?? "") || !DIRECTIONS.has(item?.direction) || !text(item?.name) || !text(item?.contract) || !text(item?.version)) blockers.push(`${component?.id ?? prefix}.interfaces[${interfaceIndex}] requires stable id, direction, name, contract, and version.`);
    if (!Array.isArray(component?.fileClaims) || !component.fileClaims.length) blockers.push(`${component?.id ?? prefix} requires exact file claims.`);
    for (const [claimIndex, claim] of (component?.fileClaims ?? []).entries()) { if (!safePath(claim?.path) || !ACCESS.has(claim?.access) || !text(claim?.reason)) blockers.push(`${component?.id ?? prefix}.fileClaims[${claimIndex}] requires a safe path, access, and reason.`); else fileClaims.push({ ...claim, componentId: component.id }); }
    for (const [dependencyIndex, dependency] of (component?.dependencies ?? []).entries()) { if (!inventoryIds.has(dependency?.componentId) || dependency.componentId === component.id || !text(dependency?.reason) || typeof dependency?.critical !== "boolean") blockers.push(`${component?.id ?? prefix}.dependencies[${dependencyIndex}] is invalid.`); if (dependency?.critical && !text(dependency?.fallback)) blockers.push(`${component?.id ?? prefix} critical dependency ${dependency.componentId} requires a fallback.`); }
    const data = component?.dataOwnership; if (!text(data?.sourceOfTruth) || !CLASSIFICATIONS.has(data?.classification) || !text(data?.retention) || !text(data?.deletion)) blockers.push(`${component?.id ?? prefix} requires complete data ownership, classification, retention, and deletion rules.`);
    if (!Array.isArray(component?.states) || component.states.length < 2 || component.states.some((state) => !text(state?.name) || !text(state?.entry) || !text(state?.exit))) blockers.push(`${component?.id ?? prefix} requires explicit lifecycle states with entry and exit rules.`);
    if (!Array.isArray(component?.failureModes) || !component.failureModes.length || component.failureModes.some((failure) => !text(failure?.name) || !text(failure?.trigger) || !text(failure?.detection) || !text(failure?.containment) || !text(failure?.recovery) || !text(failure?.proof))) blockers.push(`${component?.id ?? prefix} requires complete failure-mode contingencies.`);
    const security = component?.security; if (!text(security?.trustBoundary) || !Array.isArray(security?.capabilities) || !Array.isArray(security?.secrets) || !list(security?.threats) || !text(security?.privacy)) blockers.push(`${component?.id ?? prefix} requires trust boundary, capability, secret, threat, and privacy rules.`);
    const proof = component?.proof; if (!list(proof?.acceptanceCriteria) || proof.acceptanceCriteria.length < 2 || !list(proof?.tests) || proof?.diffRequired !== true || typeof proof?.screenshotRequired !== "boolean") blockers.push(`${component?.id ?? prefix} requires tests, at least two acceptance criteria, scoped diff proof, and an explicit screenshot rule.`);
    if (!Array.isArray(component?.decisions) || !component.decisions.length || component.decisions.some((decision) => !text(decision?.decision) || !text(decision?.reason) || !text(decision?.owner) || !text(decision?.evidence))) blockers.push(`${component?.id ?? prefix} requires owned evidence-backed decisions.`);
    if (!Array.isArray(component?.assumptions) || !component.assumptions.length || component.assumptions.some((assumption) => !text(assumption?.statement) || !text(assumption?.validation) || !text(assumption?.owner))) blockers.push(`${component?.id ?? prefix} requires owned assumptions with validation paths.`);
    const handover = component?.handover; if (!text(handover?.summary) || !text(handover?.firstAction) || !list(handover?.readFirst) || !list(handover?.doNotAssume) || !Array.isArray(handover?.openQuestions) || !Number.isFinite(Date.parse(handover?.updatedAt))) blockers.push(`${component?.id ?? prefix} requires a complete cold-start handover.`);
    else for (const question of handover.openQuestions) if (text(question)) blockers.push(`${component.id} unresolved planning question: ${String(question).trim()}`);
  }
  for (const item of inventory) if (!componentIds.has(item.id)) blockers.push(`Missing component plan for ${item.id} · ${item.name}.`);
  const naming = assessNamingGuardrails({ inventory, components }); blockers.push(...naming.blockers);
  const cycles = cycleMembers(components); if (cycles.length) blockers.push(`Component dependency cycle includes ${cycles.join(", ")}.`);
  const collisions = [];
  for (let leftIndex = 0; leftIndex < fileClaims.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < fileClaims.length; rightIndex += 1) { const left = fileClaims[leftIndex]; const right = fileClaims[rightIndex]; if (left.componentId !== right.componentId && left.path === right.path && (left.access === "write" || right.access === "write")) { const collision = `${left.componentId} and ${right.componentId} both claim ${left.path}.`; collisions.push(collision); blockers.push(`Unresolved component file collision: ${collision}`); } }
  if (!components.length) blockers.push("At least one detailed component plan is required.");
  const complete = inventory.filter((item) => componentIds.has(item.id)).length;
  return { ready: blockers.length === 0, verdict: blockers.length ? "BLOCKED" : "READY FOR APPROVAL", blockers, warnings, collisions, naming, inventory, components, coverage: { required: inventory.length, complete, percentage: inventory.length ? Math.floor((complete / inventory.length) * 100) : 0, interfaces: components.reduce((sum, component) => sum + (component.interfaces?.length ?? 0), 0), fileClaims: fileClaims.length } };
}

export async function freezeComponentPlans(input, approval) {
  input = structuredClone(input);
  approval = structuredClone(approval);
  const assessment = assessComponentPlans(input); if (!assessment.ready) throw new Error(`Component plans cannot freeze: ${assessment.blockers.join(" ")}`);
  if (approval?.planId !== input.planId || !approvalActor(approval?.actor) || !approvalTime(approval?.approvedAt)) throw new Error("Component plans require exact plan approval, named actor, and valid ISO time.");
  const catalog = catalogBody(input); const catalogDigest = await digest(catalog); const body = { ...catalog, catalogDigest, approvedBy: approval.actor, approvedAt: approval.approvedAt }; return { ...body, digest: await digest(body) };
}

export async function verifyComponentPlans(contract) {
  try {
  if (!contract?.digest) return { valid: false, reasons: ["Component contract digest is missing."] }; const { digest: stored, ...body } = contract; const reasons = [];
  if (!approvalActor(contract.approvedBy) || !approvalTime(contract.approvedAt)) reasons.push("Component approval actor or ISO timestamp is invalid.");
  if (await digest(body) !== stored) reasons.push("Component plans changed after approval."); const catalog = catalogBody(contract); if (await digest(catalog) !== contract.catalogDigest) reasons.push("Component catalog digest is invalid."); const assessment = assessComponentPlans(catalog); if (!assessment.ready) reasons.push(...assessment.blockers); return { valid: reasons.length === 0, reasons };
  } catch { return { valid: false, reasons: ["Component contract is malformed or unbound."] }; }
}

export function compareComponentPlans(before, after) {
  const first = assessComponentPlans(before); const second = assessComponentPlans(after); if (!first.ready || !second.ready) throw new Error("Only complete component plans can be compared."); const previous = new Map(before.components.map((component) => [component.id, component])); const next = new Map(after.components.map((component) => [component.id, component])); const changes = [];
  for (const [id, component] of previous) { if (!next.has(id)) changes.push({ id, type: "removed" }); else if (canonical(next.get(id)) !== canonical(component)) changes.push({ id, type: "contract-changed" }); } for (const id of next.keys()) if (!previous.has(id)) changes.push({ id, type: "added" });
  const parentBindingChanged = ["architectureDigest", "architectureRevision", "folderDigest", "folderRevision"].some(key => before[key] !== after[key]);
  const refreshRequired = changes.length > 0 || parentBindingChanged;
  return { changes, parentBindingChanged, architectureApprovalRequired: refreshRequired, collisionRescanRequired: refreshRequired, proofPlanRefreshRequired: refreshRequired, affectedComponentIds: changes.map((change) => change.id).sort() };
}

export function authorizeComponentEdit(input, request) {
  const assessment = assessComponentPlans(input); if (!assessment.ready) return { allowed: false, verdict: "REFUSED", blockers: ["Component catalog is incomplete or invalid.", ...assessment.blockers], componentId: request?.componentId ?? null, taskId: null, requiredRecovery: "Repair and approve the component catalog before requesting any edit." };
  return authorizePlannedEdits(input, request);
}

export const componentPlanKinds = [...COMPONENT_KINDS];
