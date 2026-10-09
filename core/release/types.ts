// Shared shapes for core/release ("Shipping safely" in the plan).
// Every module here is plain Node with injected effects (git, network, test
// runner, model), so the logic is testable on Windows, macOS and Linux
// without a real repository, network or model.

/** Review presets, cheapest first. Balanced is the default. */
export type PresetName = "cheap" | "balanced" | "thorough";

export type RiskLevel = "low" | "medium" | "high";

/** One changed file in a diff, as `git diff --numstat` reports it. */
export interface ChangedFile {
  path: string;          // forward slashes, repo-relative
  added: number;
  removed: number;
  /** Added lines, when the caller has them; the secret scan reads these. */
  addedText?: string;
  binary?: boolean;
  deleted?: boolean;
}

/** A change about to be reviewed, pushed or merged. */
export interface ChangeSet {
  task?: string;         // "T-14"
  files: ChangedFile[];
  /** Planned size in changed lines, from the task's plan. */
  plannedLines?: number;
}

/** A secret-looking finding. Never carries the secret itself. */
export interface SecretFinding {
  file: string;
  line?: number;
  rule: string;          // "github-token", "private-key", "env-file", ...
  /** The match with everything but the first 4 characters masked. */
  preview: string;
  /** "<file>:<rule>:<salted scrypt of value>" - what a person approves in the ledger. */
  fingerprint?: string;
}

/** Runs a command and returns its output; injected so tests need no git. */
export type CommandRunner = (command: string, args: readonly string[], options?: { cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A check's outcome in the cheap-first pipeline. */
export type CheckStatus = "pass" | "fail" | "hold" | "skipped";

export interface CheckResult {
  check: string;         // "local-tests", "secret-scan", "size-cap", "risk-triage", "deep-review", "budget"
  status: CheckStatus;
  summary: string;       // one plain line
  detail?: unknown;
}

/** Dollars, kept as integer cents to avoid float drift. */
export type Cents = number;
