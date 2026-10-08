// Feature panels rendered inside imported-project workflow pages, keyed by workspace.
// Each feature adds one import and one entry; a panel receives { project, records, onWorkspace, onSelect }.
import { ProjectEvidencePanel } from "./ProjectEvidencePanel.jsx";
import { ProjectIntegrityPanel } from "./ProjectIntegrityPanel.jsx";

export const workspacePanels = Object.freeze({
  // collision: ProjectCollisionPanel,
  evidence: ProjectEvidencePanel,
  integrity: ProjectIntegrityPanel,
});
