// core/mvp: MVP-first stages. See README.md.

import type { Ledger, LedgerEntry } from "../ledger/index";
import { proposeWith } from "./advisor";
import { recordProposal } from "./board";
import { scanFeatures, type DeclaredFeature, type FeatureSource } from "./scan";
import type { Feature, Journey, MvpAdvisor, MvpProposal, ScanResult } from "./types";

export * from "./types";
export { MockJev, dependencyClosure, proposeWith, validateProposal } from "./advisor";
export {
  MVP_STAGER, boardFromLedger, confirmMvp, confirmedByPerson, installMvpRules, featuresIn, isOneLineReason, missingDependencies, moveFeature,
  mvpDoneWhen, recordProposal, renameStage, setJourney, stageOf,
} from "./board";
export { classify, folderSource, plannedSource, registrySource, scanFeatures, type DeclaredFeature, type FeatureSource } from "./scan";
export { boardReport, scanReport } from "./report";

export interface StagedProject {
  proposal: MvpProposal;
  entry: LedgerEntry;
}

/** New project: the advisor proposes which planned features belong in the MVP. */
export async function stageNewProject(
  ledger: Ledger,
  advisor: MvpAdvisor,
  input: { goal: string; features: Feature[]; journey?: Partial<Journey> },
): Promise<StagedProject> {
  const proposal = await proposeWith(advisor, { mode: "new", ...input });
  return { proposal, entry: recordProposal(ledger, proposal) };
}

/** Existing code: scan Done/Partial/Missing with evidence, then propose the MVP line for the user to confirm. */
export async function stageExistingProject(
  ledger: Ledger,
  advisor: MvpAdvisor,
  input: { root: string; goal: string; journey?: Partial<Journey>; sources?: FeatureSource[]; planned?: DeclaredFeature[] },
): Promise<StagedProject & { scan: ScanResult }> {
  const scan = scanFeatures(input.root, { sources: input.sources, planned: input.planned });
  const proposal = await proposeWith(advisor, { mode: "existing", goal: input.goal, features: scan.features, journey: input.journey });
  return { scan, proposal, entry: recordProposal(ledger, proposal) };
}
