import type { Actor, Ledger, LedgerEntry } from "../ledger/index";
import { budgetStatus, formatCents } from "./budget";
import { affectedTests } from "./ciPlan";
import { DEFAULT_PRESET, PRESETS, needsDeepReview } from "./presets";
import { triageRisk, type RiskRater, type Triage } from "./risk";
import { scanChange } from "./secrets";
import { checkSize, type SizeCapOptions } from "./sizeCap";
import type { ChangeSet, CheckResult, PresetName } from "./types";

// Cheap checks first, deep review only when it is earned. The order is by
// cost: budget (free), size cap (free), secret scan (cheap, local), tests on
// the changed files (local CPU), small-model triage (pennies), deep review
// (the expensive one). The first check that does not pass stops the run, so
// a held or blocked change never spends money on the later stages.

export interface DeepReviewOutcome {
  verdict: "approve" | "reject";
  notes: string[];
}

export interface PipelineOptions {
  preset?: PresetName;
  /** Ledger entries, for the monthly budget. Omit to skip the budget check. */
  entries?: readonly LedgerEntry[];
  now?: Date;
  size?: SizeCapOptions;
  /** Every test file in the repo; the changed files pick theirs from it. */
  allTests?: string[];
  /** Runs the given test files locally. Omit to skip (reported as skipped, never as passed). */
  runTests?: (tests: string[], all: boolean) => Promise<{ ok: boolean; summary: string }>;
  rater?: RiskRater;
  /** The deep review (Jev, core/jev). Required for a change that needs one, or the change is held. */
  deepReview?: (change: ChangeSet, triage: Triage) => Promise<DeepReviewOutcome>;
}

export type PipelineVerdict = "ready" | "held" | "blocked";

export interface PipelineResult {
  preset: PresetName;
  verdict: PipelineVerdict;
  checks: CheckResult[];
  triage?: Triage;
  deep: boolean;
  summary: string;
}

const ORDER = ["budget", "size-cap", "secret-scan", "local-tests", "risk-triage", "deep-review"] as const;

function finish(preset: PresetName, checks: CheckResult[], verdict: PipelineVerdict, deep: boolean, triage?: Triage): PipelineResult {
  const ran = new Set(checks.map((check) => check.check));
  for (const name of ORDER) {
    if (!ran.has(name)) checks.push({ check: name, status: "skipped", summary: verdict === "ready" ? "not needed" : "not run, an earlier check stopped the change" });
  }
  const stopper = checks.find((check) => check.status === "fail" || check.status === "hold");
  const summary = verdict === "ready"
    ? `Ready to merge under ${PRESETS[preset].label}${deep ? ", deep review approved" : ""}`
    : `${verdict === "held" ? "Held" : "Blocked"} by ${stopper?.check ?? "a check"}: ${stopper?.summary ?? ""}`;
  return { preset, verdict, checks, triage, deep, summary };
}

export async function runCheapFirst(change: ChangeSet, options: PipelineOptions = {}): Promise<PipelineResult> {
  const preset = options.preset ?? DEFAULT_PRESET;
  const checks: CheckResult[] = [];

  // 1. Budget: a stopped month starts no new review spend.
  if (options.entries) {
    const status = budgetStatus(options.entries, options.now ?? new Date());
    if (status.state === "stopped") {
      checks.push({ check: "budget", status: "hold", summary: `Monthly budget reached (${formatCents(status.spentCents)} of ${formatCents(status.budgetCents ?? 0)})`, detail: status });
      return finish(preset, checks, "held", false);
    }
    checks.push({ check: "budget", status: "pass", summary: status.state === "uncapped" ? "No monthly cap set" : `${formatCents(status.spentCents)} of ${formatCents(status.budgetCents ?? 0)} used`, detail: status });
  }

  // 2. Size cap: oversize changes are held and split, not reviewed.
  const size = checkSize(change, options.size);
  checks.push(size);
  if (size.status !== "pass") return finish(preset, checks, "held", false);

  // 3. Secret scan on the added lines and file names.
  const findings = scanChange(change.files);
  if (findings.length > 0) {
    checks.push({
      check: "secret-scan",
      status: "fail",
      summary: `${findings.length} secret-looking value${findings.length === 1 ? "" : "s"}: ${findings.slice(0, 3).map((f) => `${f.file}${f.line ? `:${f.line}` : ""} ${f.rule}`).join(", ")}`,
      detail: findings, // previews are already masked by the scanner
    });
    return finish(preset, checks, "blocked", false);
  }
  checks.push({ check: "secret-scan", status: "pass", summary: `No secrets in ${change.files.length} changed file${change.files.length === 1 ? "" : "s"}` });

  // 4. Tests for what changed, locally.
  if (options.runTests && options.allTests) {
    const picked = affectedTests(change.files.map((file) => file.path), options.allTests);
    if (picked.tests.length === 0) {
      checks.push({ check: "local-tests", status: "skipped", summary: "No tests cover the changed files" });
    } else {
      const run = await options.runTests(picked.tests, picked.all);
      checks.push({ check: "local-tests", status: run.ok ? "pass" : "fail", summary: run.summary, detail: picked });
      if (!run.ok) return finish(preset, checks, "blocked", false);
    }
  }

  // 5. Triage, then 6. deep review only when the preset says it is earned.
  const triage = await triageRisk(change, options.rater);
  checks.push({ check: "risk-triage", status: "pass", summary: `Risk ${triage.level}: ${triage.reasons.join("; ")}`, detail: triage });
  const decision = needsDeepReview(preset, triage);
  if (!decision.deep) {
    checks.push({ check: "deep-review", status: "skipped", summary: `Not needed (${decision.why})` });
    return finish(preset, checks, "ready", false, triage);
  }
  if (!options.deepReview) {
    checks.push({ check: "deep-review", status: "hold", summary: `Needs a deep review (${decision.why}) and no reviewer is configured` });
    return finish(preset, checks, "held", true, triage);
  }
  const outcome = await options.deepReview(change, triage);
  checks.push({
    check: "deep-review",
    status: outcome.verdict === "approve" ? "pass" : "fail",
    summary: outcome.verdict === "approve" ? `Approved (${decision.why})` : `Rejected: ${outcome.notes.join("; ") || "no notes"}`,
    detail: outcome,
  });
  return finish(preset, checks, outcome.verdict === "approve" ? "ready" : "blocked", true, triage);
}

/** Records the pipeline outcome as a review.verdict entry on the task. */
export function recordPipeline(ledger: Ledger, actor: Actor, task: string, result: PipelineResult): LedgerEntry {
  return ledger.append({
    actor,
    type: "review.verdict",
    subject: task,
    summary: result.summary,
    evidence: [],
    refs: [],
    data: {
      stage: "cheap-first",
      preset: result.preset,
      verdict: result.verdict,
      deep: result.deep,
      risk: result.triage?.level,
      checks: result.checks.map(({ check, status, summary }) => ({ check, status, summary })),
    },
  });
}
