// Shared shapes for deep planning ("Deep planning: the hard questions first").
// Everything here is plain data so the app, the MCP tools and Jev can read it.

/** The ten areas whose decisions sink projects when they come late. */
export const AREAS = [
  "stack",
  "data",
  "auth",
  "money",
  "ai",
  "offline",
  "security",
  "scale",
  "testing",
  "platforms",
] as const;

export type Area = (typeof AREAS)[number];

export const AREA_TITLES: Readonly<Record<Area, string>> = {
  stack: "Stack",
  data: "Data",
  auth: "Users and auth",
  money: "Money",
  ai: "AI usage",
  offline: "Offline and sync",
  security: "Security and privacy",
  scale: "Scale and cost",
  testing: "Testing and release",
  platforms: "Platforms",
};

/** What we know about the thing being built, read from the idea and any repo scan. */
export interface IdeaProfile {
  /** The idea in the user's words. */
  idea: string;
  /** Signals found in the idea or the scan, such as "offline", "payments", "ai", "mobile". */
  signals: string[];
  /** Facts already decided by an existing repo, keyed by question id: the answer the scan found. */
  known: Record<string, string>;
  /** "solo" (one person plus helpers) or "team". */
  team: "solo" | "team";
}

export interface QuestionOption {
  id: string;
  label: string;
  /** One line on when this is the right pick. */
  fit: string;
  /** Rough monthly cost in plain words, when it matters ("free", "$20/mo"). */
  cost?: string;
}

export interface Recommendation {
  option: string;
  reason: string;
  /** 0..1: how sure the recommendation is. Below 0.5 means "ask, don't one-tap". */
  confidence: number;
  /** Research sources backing it, filled in by live research. */
  sources?: Source[];
}

export interface PlanningQuestion {
  /** Stable id, "<area>.<slug>", such as "data.store". */
  id: string;
  area: Area;
  text: string;
  /** Why this cannot wait. */
  why: string;
  /** A blocker must be settled before the plan can be approved. */
  blocking: boolean;
  options: QuestionOption[];
  recommendation: Recommendation;
  /** Query a research provider can run to compare the options. */
  research?: string;
}

export interface QuestionPack {
  area: Area;
  title: string;
  /** Builds the pack's questions for this idea; recommendations depend on the profile. */
  questions(profile: IdeaProfile): PlanningQuestion[];
}

export interface Source {
  title: string;
  url: string;
}

/** A settled planning answer, as replayed from the ledger. */
export interface PlanningAnswer {
  questionId: string;
  area: Area;
  q: string;
  /** The chosen option id, or "custom" for free text. */
  choice: string;
  text: string;
  decision?: string;
  /** Set when the answer was deferred into a dated spike task. */
  spike?: { task: string; due: string; risk: string };
  /** Read from the existing code (readRepoStack), so what it builds already exists. */
  fromRepo?: boolean;
}

// ---------- Mind map and roadmap ----------

export type MindNodeKind = "component" | "data" | "screen" | "integration" | "risk";

export interface MindNode {
  id: string;
  kind: MindNodeKind;
  label: string;
  /** The question ids whose answers produced this node. */
  from: string[];
  /** Sub-parts; a component with none is flagged by the depth check. */
  children: string[];
  note?: string;
  /** The repo already has it: an answer that produced it was read from the code. Risks never are. */
  existing?: boolean;
}

export interface MindLink {
  from: string;
  to: string;
  label?: string;
}

export interface MindMap {
  root: string;
  nodes: Record<string, MindNode>;
  links: MindLink[];
}

export type PhaseId = "foundation" | "core" | "integrations" | "hardening" | "release";

export interface RoadmapTask {
  /** Local key until the task is written to the ledger and gets its T- number. */
  key: string;
  title: string;
  phase: PhaseId;
  owner: string;
  doneWhen: string;
  /** Mind map node it came from. */
  node: string;
  change: "fix" | "feature" | "breaking";
  dependsOn: string[];
}

export interface RoadmapPhase {
  id: PhaseId;
  title: string;
  tasks: RoadmapTask[];
}

export interface Roadmap {
  phases: RoadmapPhase[];
  /** Parts the repo already has, which get no build task. */
  existing?: { node: string; label: string }[];
}
