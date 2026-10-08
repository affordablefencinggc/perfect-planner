// Feature panels rendered inside imported-project workflow pages, keyed by workspace.
// Each feature adds one import and one entry; a panel receives { project, records, onWorkspace, onSelect }.
import { ProjectBuildBoard } from "./ProjectBuildBoard.jsx";
import { ProjectIndexPanel } from "./ProjectIndexPanel.jsx";
export const workspacePanels = Object.freeze({
  // collision: ProjectCollisionPanel,
  build: ProjectBuildBoard,
  index: ProjectIndexPanel,
});
