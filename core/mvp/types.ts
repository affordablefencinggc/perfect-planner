// Shared shapes for core/mvp. Every other file in this module codes against
// these; change them only together with their users.

import type { Actor } from "../ledger/index";

/** Stage ids never change; only their display names do. */
export type StageId = "mvp" | "beta" | "v1" | "scale";

export const STAGE_IDS: readonly StageId[] = ["mvp", "beta", "v1", "scale"];

export const DEFAULT_STAGE_NAMES: Readonly<Record<StageId, string>> = {
  mvp: "MVP",
  beta: "Beta",
  v1: "v1",
  scale: "Scale",
};

export interface Stage {
  id: StageId;
  name: string;   // display name, renamable ("MVP" -> "Pilot")
  order: number;  // 0 for mvp, 3 for scale
}

/** How finished a feature is in the code that exists today. */
export type FeatureStatus = "done" | "partial" | "missing";

/** One piece of proof behind a status: a file, optionally a line, and why it counts. */
export interface Evidence {
  file: string;     // repo-relative, forward slashes: "src/components/ViewModeToggle.jsx"
  line?: number;    // 1-based, for markers such as TODO
  note: string;     // "source present", "test present", "declared but missing", "TODO marker"
}

export interface Feature {
  id: string;            // stable: "C057" from a registry, or a slug "view-mode-toggle"
  name: string;          // plain words: "Simple/Advanced view toggle"
  description?: string;
  dependsOn: string[];   // other feature ids
  userFacing: boolean;   // has a screen or a command a person touches
}

export interface ScannedFeature extends Feature {
  status: FeatureStatus;
  evidence: Evidence[];
  /** Short reasons for the status, e.g. "2 of 9 declared files are missing". */
  findings: string[];
}

export interface ScanResult {
  root: string;               // absolute path that was scanned
  source: string;             // which feature source produced the list: "registry:src/engine/appMapRegistry.js"
  features: ScannedFeature[];
  counts: Record<FeatureStatus, number>;
}

/** Where a feature sits, and why it is not in the MVP when it is not. */
export interface Placement {
  feature: string;   // feature id
  stage: StageId;
  reason: string;    // one line; required (non-empty, not "TBD") when stage !== "mvp"
}

/** The end-to-end user journey that decides when the MVP is done. */
export interface Journey {
  name: string;          // "Import a project and sign it off"
  steps: string[];       // plain-words steps a person takes
  test: string;          // command that runs it: "npm run test:e2e"
  features: string[];    // feature ids the journey exercises; all of them land in the MVP
}

export interface MvpProposal {
  by: Actor;             // who proposed it (Jev, or the mock)
  journey: Journey;
  placements: Placement[];
  summary: string;       // one line: "12 of 40 features in the MVP, 9 already done"
}

/** What the advisor is told. For a new project features have no status. */
export interface ProposalInput {
  mode: "new" | "existing";
  goal: string;                          // what the product is for, one line
  features: (Feature | ScannedFeature)[];
  journey?: Partial<Journey>;            // a journey the user already named, if any
}

/**
 * Jev, as core/mvp sees it. The real one lands from the check-in thread
 * (core/jev); until then MockJev stands in with the same shape.
 */
export interface MvpAdvisor {
  readonly actor: Actor;
  proposeMvp(input: ProposalInput): Promise<MvpProposal>;
}

/** The live board: stage names plus where every feature sits. Rebuilt from the ledger. */
export interface StageBoard {
  stages: Stage[];
  placements: Placement[];
  journey?: Journey;
  confirmed: boolean;           // the user confirmed the MVP line
  confirmedBy?: string;         // person id
  proposalEntry?: string;       // L- number of the proposal that started the board
}

export class MvpError extends Error {
  constructor(public readonly code: "REASON_REQUIRED" | "UNKNOWN_FEATURE" | "UNKNOWN_STAGE" | "BAD_NAME" | "NOT_A_PERSON" | "NO_PROPOSAL", message: string) {
    super(message);
    this.name = "MvpError";
  }
}
