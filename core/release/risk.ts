import type { ChangeSet, RiskLevel } from "./types";

// Risk triage (plan: "A small model triages each diff first. Only risky
// changes get the expensive deep review: auth, payments, data migrations,
// secrets handling, or anything over the planned size.")
//
// Two halves: a deterministic path heuristic that always runs and can never
// be argued down, and an optional small-model rating that can only raise it.

export type SensitiveArea = "auth" | "payments" | "migrations" | "secrets" | "ci" | "tests" | "oversize";

const AREA_PATTERNS: ReadonlyArray<[Exclude<SensitiveArea, "oversize" | "tests">, RegExp]> = [
  ["auth", /(^|[/_.-])(auth|login|logout|session|oauth|sso|jwt|permission|permissions|acl|rbac|password|signin|signup)([/_.-]|$)/i],
  ["payments", /(^|[/_.-])(payment|payments|billing|invoice|checkout|stripe|paypal|subscription|refund|charge)s?([/_.-]|$)/i],
  ["migrations", /(^|\/)(migrations?|schema|seeds?)(\/|\.)|\.sql$|(^|[/_.-])migrat/i],
  ["secrets", /(^|[/_.-])(secret|secrets|credential|credentials|keychain|keyring|vault|token|tokens|apikey|api-key|crypto|encrypt)s?([/_.-]|$)|(^|\/)\.env/i],
  ["ci", /^\.github\/|(^|\/)(Dockerfile|docker-compose[^/]*|\.gitlab-ci\.yml)$|(^|\/)src-tauri\/tauri\.conf/i],
];

const LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

export interface Triage {
  level: RiskLevel;
  areas: SensitiveArea[];
  reasons: string[];      // plain lines, shown to the person
  rater: "heuristic" | "heuristic+model";
}

/** Sensitive areas a path touches. */
export function areasOf(path: string): SensitiveArea[] {
  const normal = path.replace(/\\/g, "/");
  return AREA_PATTERNS.filter(([, pattern]) => pattern.test(normal)).map(([area]) => area);
}

function changedLines(change: ChangeSet): number {
  return change.files.reduce((sum, file) => sum + (file.binary ? 0 : file.added + file.removed), 0);
}

/** The deterministic half: sensitive paths are high, oversize is high, big or test-deleting changes are medium. */
export function heuristicRisk(change: ChangeSet): Triage {
  const areas = new Set<SensitiveArea>();
  const reasons: string[] = [];
  for (const file of change.files) {
    for (const area of areasOf(file.path)) {
      if (!areas.has(area)) reasons.push(`touches ${area} (${file.path})`);
      areas.add(area);
    }
  }
  let level: RiskLevel = areas.size > 0 ? "high" : "low";

  const lines = changedLines(change);
  if (change.plannedLines !== undefined && change.plannedLines > 0 && lines > change.plannedLines) {
    areas.add("oversize");
    reasons.push(`${lines} lines changed, plan was ${change.plannedLines}`);
    level = "high";
  } else if (lines > 400) {
    reasons.push(`${lines} lines changed`);
    level = maxRisk(level, "medium");
  }

  const deletedTests = change.files.filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file.path) && (file.deleted || file.removed > file.added));
  if (deletedTests.length > 0) {
    // Weakening tests is how a change slips past its own proof, so it always
    // earns the deep review, whatever the preset (see needsDeepReview).
    areas.add("tests");
    reasons.push(`removes test lines in ${deletedTests.map((file) => file.path).join(", ")}`);
    level = maxRisk(level, "medium");
  }
  if (reasons.length === 0) reasons.push("no sensitive areas, within planned size");
  return { level, areas: [...areas], reasons, rater: "heuristic" };
}

/** What the small model sees: paths and counts, never file contents, so nothing secret leaves the machine. */
export interface RaterInput {
  task?: string;
  files: { path: string; added: number; removed: number }[];
  heuristic: Triage;
}

export type RiskRater = (input: RaterInput) => Promise<{ level: RiskLevel; reason: string }>;

/**
 * Full triage: heuristic first, then the small model when one is configured.
 * The model can raise the level but never lower it below the heuristic, and a
 * failing model leaves the heuristic in charge and says so.
 */
export async function triageRisk(change: ChangeSet, rater?: RiskRater): Promise<Triage> {
  const heuristic = heuristicRisk(change);
  if (!rater) return heuristic;
  try {
    const rating = await rater({
      task: change.task,
      files: change.files.map(({ path, added, removed }) => ({ path, added, removed })),
      heuristic,
    });
    if (!LEVELS.includes(rating.level)) throw new Error(`unknown level ${String(rating.level)}`);
    const reasons = [...heuristic.reasons];
    if (rating.reason.trim()) reasons.push(`small model: ${rating.reason.trim()}`);
    return { level: maxRisk(heuristic.level, rating.level), areas: heuristic.areas, reasons, rater: "heuristic+model" };
  } catch (error) {
    return {
      ...heuristic,
      reasons: [...heuristic.reasons, `small-model rating unavailable (${error instanceof Error ? error.message : String(error)}), path rules used`],
    };
  }
}
