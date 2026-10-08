// Feature panels rendered inside imported-project workflow pages, keyed by workspace.
// Each feature adds one import and one entry; a panel receives { project, records, onWorkspace, onSelect }.
import { PlanApprovalStep } from "./PlanApprovalStep.jsx";
import { ProjectCollisionPanel } from "./ProjectCollisionPanel.jsx";
import { ProjectAllocationPanel } from "./ProjectAllocationPanel.jsx";
import { ProjectEvidencePanel } from "./ProjectEvidencePanel.jsx";
import { ProjectIntegrityPanel } from "./ProjectIntegrityPanel.jsx";

export const workspacePanels = Object.freeze({
  collision: ProjectCollisionPanel,
  allocation: ProjectAllocationPanel,
  plan: PlanApprovalStep,
  evidence: ProjectEvidencePanel,
  integrity: ProjectIntegrityPanel,
});
