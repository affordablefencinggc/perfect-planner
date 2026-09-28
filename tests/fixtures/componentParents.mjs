import { freezeArchitectureContract } from '../../src/engine/rulebookEngine.js';
import { inspectArchitectureContracts, publishArchitectureContract } from '../../src/node/architectureContractStore.mjs';
import { inspectFolderContracts, publishFolderContract } from '../../src/node/folderContractStore.mjs';

const scenario = kind => ({ kind, trigger: 'named threshold', detection: 'machine signal', owner: 'fixture-owner', immediateAction: 'stop', recovery: 'fallback', verification: 'proof rerun' });
const decision = kind => ({ kind, choice: `${kind} choice`, rationale: 'evidence-backed fit', evidence: 'ADR source', alternatives: [{ choice: 'other', rejectionReason: 'fails a stated constraint' }] });
export const componentArchitectureInput = () => ({ templateId: 'ai-autopilot-control-plane', templateVersion: 1, platform: 'tauri', brief: { autopilot: true, localFirst: true }, useCases: ['ai-autopilot', 'desktop-distribution'], answers: { collisionPolicy: 'fail closed', proofPolicy: 'paired proof', rollbackPolicy: 'restore checkpoint', capabilityPolicy: 'deny by default', humanStopPolicy: 'explicit gate', costCeiling: '$5/run', osTargets: ['windows'], updateSigning: 'signed', rollbackChannel: 'stable previous' }, capabilities: [{ id: 'native-process', necessity: 'mandatory', mitigation: 'reviewed bounded sidecar', proof: 'capability test' }], scenarios: ['security-breach', 'data-loss', 'critical-dependency-failure', 'vendor-exit'].map(scenario), dependencies: [{ name: 'Tauri', purpose: 'desktop shell', license: 'MIT/Apache-2.0', pinnedVersion: '2.x exact lock', maintenanceEvidence: 'release history', securityEvidence: 'advisory review', critical: true, fallback: 'PWA reduced mode', switchTrigger: 'native proof fails', dependsOn: [] }], decisions: ['platform', 'data', 'identity-auth', 'state-sync', 'deployment-distribution'].map(decision), nonFunctional: { performanceBudget: 'startup P80 <2s', securityTarget: 'zero critical', accessibilityTarget: 'WCAG 2.2 AA', operatingCostCeiling: '$100/month', recoveryTarget: 'RPO 0 local ledger', observabilityProof: 'hashed run report' } });

// Real persisted parent fixtures, never a production bypass. Preserve every
// source/test/config claim and approve its directory or exact root file explicitly.
export async function bindComponentParents(root, catalog) {
  const value = structuredClone(catalog), planId = value.planId;
  let architecture = await inspectArchitectureContracts(root, planId);
  if (!architecture.head) {
    const contract = await freezeArchitectureContract(componentArchitectureInput(), { planId, actor: 'fixture-owner', approvedAt: '2026-09-02T00:00:00.000Z' });
    await publishArchitectureContract(root, contract, { actor: 'fixture-owner' });
    architecture = await inspectArchitectureContracts(root, planId);
  }
  const binding = { architectureContractDigest: architecture.head.contractDigest, architectureRevision: architecture.head.revision };
  let folder = await inspectFolderContracts(root, planId);
  if (!folder.head) {
    const claims = value.components.flatMap(component => component.fileClaims.map(claim => claim.path));
    const folders = ['src', ...[...new Set(claims.filter(claim => claim.includes('/')).map(claim => claim.split('/')[0]))].filter(name => name !== 'src').sort()];
    const files = [...new Set(claims.filter(claim => !claim.includes('/')))].sort();
    const nodes = [...folders.map(path => ({ kind: 'folder', path })), ...files.map(path => ({ kind: 'file', path }))].map((node, index) => ({ id: `F${String(index + 1).padStart(3, '0')}`, ...node, purpose: 'Reviewed component source, proof or configuration boundary', owner: 'fixture-owner', taskId: 'B01', createAtStage: 'approval', allowedContents: 'Named component claims only', changePolicy: 'collision-review', renameFallback: 'Stop for named review', dependsOn: [] }));
    const input = { schemaVersion: 1, planId, ...binding, workspaceMode: 'private', nodes };
    await publishFolderContract(root, input, { planId, ...binding, expectedRevision: 0, expectedHeadDigest: 'GENESIS' }, { actor: 'fixture-owner', timestamp: '2026-09-02T00:00:00.000Z' });
    folder = await inspectFolderContracts(root, planId);
  }
  value.architectureDigest = architecture.head.contractDigest;
  value.architectureRevision = architecture.head.revision;
  value.folderDigest = folder.head.contractDigest;
  value.folderRevision = folder.head.revision;
  for (const item of [...value.inventory, ...value.components]) item.folderNodeId = 'F001';
  return value;
}
