const MODES = new Set(["git", "private", "hybrid"]);
const KINDS = new Set(["folder", "file"]);
const STAGES = ["approval", "architecture", "build", "proof", "release"];
const POLICIES = new Set(["owner-only", "collision-review", "immutable-after-approval"]);

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function normalizeContractPath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

const parentPath = (value) => value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : null;

function cycleMembers(nodes) {
  const dependencies = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn ?? [])])); const ready = [...dependencies].filter(([, values]) => values.size === 0).map(([id]) => id).sort(); const visited = [];
  while (ready.length) { const id = ready.shift(); visited.push(id); for (const [candidate, values] of dependencies) { if (values.delete(id) && values.size === 0 && !visited.includes(candidate) && !ready.includes(candidate)) ready.push(candidate); } ready.sort(); }
  return visited.length === nodes.length ? [] : [...dependencies.keys()].filter((id) => !visited.includes(id));
}

export function assessFolderContract(input) {
  const blockers = []; const nodes = Array.isArray(input?.nodes) ? input.nodes : [];
  if (input?.schemaVersion !== 1) blockers.push("schemaVersion must equal 1.");
  if (!String(input?.planId ?? "").trim()) blockers.push("planId is required.");
  if (!/^[a-f0-9]{64}$/.test(input?.architectureContractDigest ?? "")) blockers.push("architectureContractDigest must bind the folder contract to an exact approved architecture.");
  if (!Number.isInteger(input?.architectureRevision) || input.architectureRevision < 1) blockers.push("architectureRevision must bind the folder contract to a positive approved architecture revision.");
  if (!MODES.has(input?.workspaceMode)) blockers.push("workspaceMode must be git, private, or hybrid.");
  if (nodes.length === 0) blockers.push("At least one named folder or file is required.");
  const ids = new Set(); const paths = new Set(); const folderPaths = new Set(nodes.filter((node) => node.kind === "folder").map((node) => normalizeContractPath(node.path)));
  for (const [index, node] of nodes.entries()) {
    const prefix = `nodes[${index}]`; const normalized = normalizeContractPath(node.path);
    if (!/^F\d{3,}$/.test(node.id ?? "")) blockers.push(`${prefix}.id must be a stable F-number.`); else if (ids.has(node.id)) blockers.push(`Duplicate node id ${node.id}.`); ids.add(node.id);
    if (!KINDS.has(node.kind)) blockers.push(`${prefix}.kind must be folder or file.`);
    if (!normalized || normalized !== node.path || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").includes("..")) blockers.push(`${prefix}.path must be a normalized safe relative path.`);
    else if (paths.has(normalized)) blockers.push(`Duplicate planned path ${normalized}.`); paths.add(normalized);
    if (!String(node.purpose ?? "").trim() || !String(node.owner ?? "").trim() || !String(node.taskId ?? "").trim()) blockers.push(`${prefix} requires purpose, owner, and taskId.`);
    const placeholders = { purpose: "define this boundary before approval", owner: "unallocated", taskId: "unassigned", allowedContents: "name allowed artifacts" };
    for (const [field, placeholder] of Object.entries(placeholders)) {
      if (String(node[field] ?? "").trim().toLowerCase() === placeholder) blockers.push(`${prefix}.${field} is an unresolved placeholder.`);
    }
    if (!STAGES.includes(node.createAtStage)) blockers.push(`${prefix}.createAtStage is invalid.`);
    if (!POLICIES.has(node.changePolicy)) blockers.push(`${prefix}.changePolicy is invalid.`);
    if (!String(node.allowedContents ?? "").trim() || !String(node.renameFallback ?? "").trim()) blockers.push(`${prefix} requires allowedContents and renameFallback.`);
    const parent = parentPath(normalized); if (parent && !folderPaths.has(parent)) blockers.push(`${prefix} is missing planned parent folder ${parent}.`);
  }
  for (const node of nodes) for (const dependency of node.dependsOn ?? []) if (!ids.has(dependency)) blockers.push(`${node.id} depends on unknown node ${dependency}.`);
  const cycles = cycleMembers(nodes); if (cycles.length) blockers.push(`Folder dependency cycle includes ${cycles.join(", ")}.`);
  const reservations = blockers.length ? [] : nodes.map((node) => ({ id: `RES-${node.id}`, nodeId: node.id, kind: "file", surface: node.kind === "folder" ? `${node.path}/**` : node.path, access: "write", owner: node.owner, taskId: node.taskId, state: "forward-reservation", changePolicy: node.changePolicy }));
  return { ready: blockers.length === 0, verdict: blockers.length ? "BLOCKED" : "READY FOR APPROVAL", blockers, nodes, reservations, coverage: { named: nodes.length, owned: nodes.filter((node) => node.owner).length, staged: nodes.filter((node) => STAGES.includes(node.createAtStage)).length } };
}

export async function folderDraftStructureDigest(input) {
  const assessment = assessFolderContract(input);
  if (!assessment.ready) return null;
  return digest({ schemaVersion: 1, planId: input.planId, architectureContractDigest: input.architectureContractDigest, architectureRevision: input.architectureRevision, workspaceMode: input.workspaceMode, nodes: structuredClone(input.nodes), reservations: assessment.reservations });
}

export async function freezeFolderContract(input, approval) {
  const assessment = assessFolderContract(input); if (!assessment.ready) throw new Error(`Folder contract cannot freeze: ${assessment.blockers.join(" ")}`);
  if (approval?.planId !== input.planId || !String(approval?.actor ?? "").trim() || !Number.isFinite(Date.parse(approval?.approvedAt))) throw new Error("Folder contract requires exact plan approval, named actor, and valid time.");
  if (approval?.architectureContractDigest !== input.architectureContractDigest || approval?.architectureRevision !== input.architectureRevision) throw new Error("Folder contract approval must match the exact current architecture digest and revision.");
  const structure = { schemaVersion: 1, planId: input.planId, architectureContractDigest: input.architectureContractDigest, architectureRevision: input.architectureRevision, workspaceMode: input.workspaceMode, nodes: structuredClone(input.nodes), reservations: assessment.reservations }; const structureDigest = await digest(structure);
  const body = { ...structure, structureDigest, approvedBy: approval.actor, approvedAt: approval.approvedAt };
  return { ...body, digest: await digest(body) };
}

export async function verifyFolderContract(contract) {
  if (!contract?.digest) return { valid: false, reasons: ["Folder contract digest is missing."] };
  const { digest: stored, ...body } = contract; const reasons = [];
  if (await digest(body) !== stored) reasons.push("Folder contract changed after approval.");
  const structure = { schemaVersion: contract.schemaVersion, planId: contract.planId, architectureContractDigest: contract.architectureContractDigest, architectureRevision: contract.architectureRevision, workspaceMode: contract.workspaceMode, nodes: contract.nodes, reservations: contract.reservations }; if (await digest(structure) !== contract.structureDigest) reasons.push("Folder structure digest is invalid.");
  const assessment = assessFolderContract({ schemaVersion: 1, planId: contract.planId, architectureContractDigest: contract.architectureContractDigest, architectureRevision: contract.architectureRevision, workspaceMode: contract.workspaceMode, nodes: contract.nodes }); if (!assessment.ready) reasons.push(...assessment.blockers);
  return { valid: reasons.length === 0, reasons };
}

export function materializationWave(input, stage) {
  const assessment = assessFolderContract(input); if (!assessment.ready) throw new Error("Invalid folder contract cannot materialize."); const limit = STAGES.indexOf(stage); if (limit < 0) throw new Error("Unknown materialization stage.");
  return input.nodes.filter((node) => STAGES.indexOf(node.createAtStage) <= limit).slice().sort((left, right) => left.path.split("/").length - right.path.split("/").length || left.path.localeCompare(right.path));
}

export function compareFolderContracts(before, after) {
  const first = assessFolderContract(before); const second = assessFolderContract(after); if (!first.ready || !second.ready) throw new Error("Only valid folder contracts can be compared.");
  const previous = new Map(before.nodes.map((node) => [node.id, node])); const next = new Map(after.nodes.map((node) => [node.id, node])); const changes = [];
  for (const [id, node] of previous) { if (!next.has(id)) changes.push({ id, type: "removed", from: node.path, to: null }); else if (next.get(id).path !== node.path) changes.push({ id, type: "renamed", from: node.path, to: next.get(id).path }); else if (canonical(next.get(id)) !== canonical(node)) changes.push({ id, type: "contract-changed", from: node.path, to: node.path }); }
  for (const [id, node] of next) if (!previous.has(id)) changes.push({ id, type: "added", from: null, to: node.path });
  if (before.architectureContractDigest !== after.architectureContractDigest || before.architectureRevision !== after.architectureRevision) changes.push({ id: "ARCHITECTURE", type: "architecture-rebound", from: `${before.architectureRevision}:${before.architectureContractDigest}`, to: `${after.architectureRevision}:${after.architectureContractDigest}` });
  return { changes, architectureApprovalRequired: changes.length > 0, collisionRescanRequired: changes.length > 0, affectedNodeIds: changes.map((change) => change.id).sort() };
}

export function analyzeWorkspaceStructure(census, contract) {
  const assessment = assessFolderContract(contract);
  if (!assessment.ready) throw new Error(`Workspace gaps require a valid folder contract: ${assessment.blockers.join(" ")}`);
  if (census?.schemaVersion !== 1 || census?.contentReturned !== false || !Array.isArray(census?.files) || !/^[a-f0-9]{64}$/.test(census?.digest ?? "")) {
    throw new Error("Workspace gaps require an exact metadata-only schema-one census receipt.");
  }
  if (census.fileCount !== census.files.length) throw new Error("Workspace census file count does not reconcile.");
  const actual = new Set(); const byBasename = new Map();
  for (const file of census.files) {
    const normalized = normalizeContractPath(file?.path);
    if (!normalized || normalized !== file.path || normalized.startsWith("/") || normalized.split("/").includes("..") || "content" in file) throw new Error("Workspace census contains an unsafe or content-bearing file record.");
    if (actual.has(normalized)) throw new Error(`Workspace census repeats ${normalized}.`);
    actual.add(normalized); const basename = normalized.split("/").at(-1); const matches = byBasename.get(basename) ?? []; matches.push(normalized); byBasename.set(basename, matches);
  }
  const nodes = contract.nodes.map((node) => ({ ...node, path: normalizeContractPath(node.path) }));
  const coveredByPlan = (file) => nodes.some((node) => node.kind === "file" ? node.path === file : file.startsWith(`${node.path}/`));
  const gaps = []; const proposals = []; let verified = 0;
  for (const node of nodes) {
    const present = node.kind === "file" ? actual.has(node.path) : [...actual].some((file) => file.startsWith(`${node.path}/`));
    if (present) { verified += 1; continue; }
    const gap = { nodeId: node.id, kind: node.kind, plannedPath: node.path, state: node.kind === "folder" ? "UNOBSERVED_EMPTY_OR_MISSING" : "MISSING" };
    gaps.push(gap);
    if (node.kind === "file") {
      const candidates = (byBasename.get(node.path.split("/").at(-1)) ?? []).filter((file) => !coveredByPlan(file));
      if (candidates.length === 1 && !actual.has(node.path)) proposals.push({ proposalId: `MOVE-${node.id}`, action: "move", from: candidates[0], to: node.path, confidence: "basename-only", approvalRequired: true, executable: false, reason: "One out-of-contract file shares the exact planned basename; content meaning is not inferred." });
      if (candidates.length > 1) gap.candidates = candidates;
    }
  }
  const unexpected = [...actual].filter((file) => !coveredByPlan(file)).map((path) => ({ path, state: "OUTSIDE_CONTRACT" }));
  const percentage = nodes.length ? Math.floor((verified / nodes.length) * 100) : 0;
  return Object.freeze({
    verdict: gaps.length || unexpected.length ? "RESOLUTION_REQUIRED" : "ALIGNED",
    censusDigest: census.digest,
    planId: contract.planId,
    verifiedNodes: verified,
    plannedNodes: nodes.length,
    completionPercentage: percentage,
    gaps: Object.freeze(gaps),
    unexpected: Object.freeze(unexpected),
    proposals: Object.freeze(proposals),
    mutationAuthorized: false,
  });
}

export function prepareFolderOrganizationReview(analysis, contract) {
  const assessment = assessFolderContract(contract);
  if (!assessment.ready) throw new Error("Folder organisation review requires a valid structure contract.");
  if (!analysis || analysis.planId !== contract.planId || !/^[a-f0-9]{64}$/.test(analysis.censusDigest ?? "") || !Array.isArray(analysis.proposals) || analysis.mutationAuthorized !== false) throw new Error("Folder organisation review requires the exact non-authoritative gap analysis.");
  const nodes = new Map(contract.nodes.map((node) => [node.id, { ...node, path: normalizeContractPath(node.path) }]));
  const normalized = analysis.proposals.map((proposal) => {
    const nodeId = String(proposal?.proposalId ?? "").replace(/^MOVE-/, "");
    const node = nodes.get(nodeId);
    const from = normalizeContractPath(proposal?.from); const to = normalizeContractPath(proposal?.to);
    if (!node || proposal.action !== "move" || proposal.approvalRequired !== true || proposal.executable !== false || !from || !to || node.path !== to || from === to) throw new Error(`Folder proposal ${proposal?.proposalId ?? "missing"} is not bound to its exact contract node.`);
    return { ...proposal, nodeId, from, to };
  });
  const duplicateSurface = (proposal) => normalized.some((other) => other.proposalId !== proposal.proposalId && [other.from, other.to].some((path) => path === proposal.from || path === proposal.to));
  const proposals = normalized.map((proposal) => {
    const dependants = contract.nodes.filter((node) => (node.dependsOn ?? []).includes(proposal.nodeId)).map((node) => node.id).sort();
    const internalCollision = duplicateSurface(proposal);
    return Object.freeze({
      proposalId: proposal.proposalId,
      nodeId: proposal.nodeId,
      action: "move",
      readClaims: Object.freeze([proposal.from]),
      writeClaims: Object.freeze([proposal.from, proposal.to]),
      dependantNodeIds: Object.freeze(dependants),
      previewState: internalCollision ? "INTERNAL_COLLISION" : "AUTHORITY_REQUIRED",
      internalCollision,
      approvalRequired: true,
      rollbackReceiptRequired: true,
      executionAllowed: false,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    planId: contract.planId,
    censusDigest: analysis.censusDigest,
    proposals: Object.freeze(proposals),
    collisionAuthorityRequired: true,
    namedApprovalRequired: true,
    rollbackReceiptRequired: true,
    executionAllowed: false,
  });
}

export const folderContractStages = [...STAGES];
