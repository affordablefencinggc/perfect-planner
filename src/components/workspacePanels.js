// Feature panels rendered inside imported-project workflow pages, keyed by workspace.
// Each feature adds one lazy entry; a panel receives { project, records, onWorkspace, onSelect }.
// Panels load on demand so the first screen stays within the bundle budget.
import { lazy } from "react";

const panel = (load, name) => lazy(() => load().then((module) => ({ default: module[name] })));

export const workspacePanels = Object.freeze({
  collision: panel(() => import("./ProjectCollisionPanel.jsx"), "ProjectCollisionPanel"),
  allocation: panel(() => import("./ProjectAllocationPanel.jsx"), "ProjectAllocationPanel"),
  plan: panel(() => import("./PlanApprovalStep.jsx"), "PlanApprovalStep"),
  evidence: panel(() => import("./ProjectEvidencePanel.jsx"), "ProjectEvidencePanel"),
  integrity: panel(() => import("./ProjectIntegrityPanel.jsx"), "ProjectIntegrityPanel"),
  build: panel(() => import("./ProjectBuildBoard.jsx"), "ProjectBuildBoard"),
  index: panel(() => import("./ProjectIndexPanel.jsx"), "ProjectIndexPanel"),
});
