// The deferral catcher: "No silent deferral." An answer like "TBD" or "we'll
// figure it out later" is not an answer. It must become a decision, or a
// dated spike task with its risk written down.

export interface DeferralPattern {
  label: string;
  pattern: RegExp;
}

/** Phrases that put a decision off. Matched case-insensitively on word boundaries. */
export const DEFERRAL_PATTERNS: readonly DeferralPattern[] = [
  { label: "TBD", pattern: /\bt\.?b\.?[dca]\b/i },
  { label: "to be decided", pattern: /\bto be (decided|determined|confirmed|discussed|defined)\b/i },
  { label: "later", pattern: /\b(later|later on)\b/i },
  { label: "figure it out", pattern: /\bfigure (it|this|that|them)? ?out\b/i },
  { label: "not sure", pattern: /\b(not sure|unsure|no idea|don'?t know|dunno|undecided)\b/i },
  { label: "eventually", pattern: /\b(eventually|someday|some day|one day|down the (road|line))\b/i },
  { label: "we'll see", pattern: /\bwe('| wi)ll see\b/i },
  { label: "maybe", pattern: /\b(maybe|perhaps|possibly)\b/i },
  { label: "depends", pattern: /\b(it depends|depends on)\b/i },
  { label: "defer", pattern: /\b(defer(red)?|punt(ed)?|park(ed)? (it|this)|revisit)\b/i },
  { label: "todo", pattern: /\b(todo|to-do|fixme|xxx)\b/i },
  { label: "whatever", pattern: /\b(whatever|anything works|doesn'?t matter|don'?t care)\b/i },
  { label: "question marks", pattern: /^\s*\?+\s*$|\?\?/ },
];

export interface DeferralCheck {
  deferred: boolean;
  /** Labels of the patterns that matched; "empty" for blank text. */
  matches: string[];
}

export function catchDeferral(text: string | undefined | null): DeferralCheck {
  const value = String(text ?? "").trim();
  if (!value) return { deferred: true, matches: ["empty"] };
  const matches = DEFERRAL_PATTERNS.filter((p) => p.pattern.test(value)).map((p) => p.label);
  return { deferred: matches.length > 0, matches };
}

export interface DeferralHit {
  /** 1-based line number. */
  line: number;
  text: string;
  matches: string[];
}

/** Every line of a plan, spec or note that puts something off. */
export function findDeferrals(text: string): DeferralHit[] {
  const hits: DeferralHit[] = [];
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const check = catchDeferral(line);
      if (check.deferred) hits.push({ line: i + 1, text: line, matches: check.matches });
    });
  return hits;
}

/** A deferral made honest: who looks into it, by when, and what breaks if nobody does. */
export interface SpikePlan {
  /** Due date, YYYY-MM-DD (UTC). */
  due: string;
  /** What goes wrong if this stays open. */
  risk: string;
  owner?: string;
}

/** Longest a spike may run before it must come back as a decision. */
export const MAX_SPIKE_DAYS = 30;

/** Returns why a spike is not acceptable, or null when it is. */
export function spikeProblem(spike: SpikePlan | undefined, now: Date = new Date()): string | null {
  if (!spike) return "a spike needs a due date and a risk";
  const due = String(spike.due ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`))) {
    return `a spike needs a due date like 2026-10-20, not "${due}"`;
  }
  const dueMs = Date.parse(`${due}T23:59:59Z`);
  if (dueMs < now.getTime()) return `the spike's due date ${due} is already past`;
  if (dueMs - now.getTime() > MAX_SPIKE_DAYS * 86_400_000) return `a spike may run at most ${MAX_SPIKE_DAYS} days; ${due} is too far out`;
  const risk = String(spike.risk ?? "").trim();
  if (risk.length < 8) return "a spike needs its risk written down in a sentence";
  const riskCheck = catchDeferral(risk);
  if (riskCheck.deferred) return `the spike's risk is itself vague (${riskCheck.matches.join(", ")})`;
  return null;
}
