// Feature panels rendered inside imported-project workflow pages, keyed by workspace.
// Each feature adds one import and one entry; a panel receives { project, records, onWorkspace, onSelect }.
import { PlanApprovalStep } from "./PlanApprovalStep.jsx";

export const workspacePanels = Object.freeze({
  // collision: ProjectCollisionPanel,
  plan: PlanApprovalStep,
});
