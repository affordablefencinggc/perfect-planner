import { baseNumber, parseNumber, type Series } from "../numbering/index";
import { clauseNumber } from "./clauses";

export type Ref =
  | { kind: "clause"; plan?: string; clause: string; text: string }
  | { kind: "number"; series: Series; id: string; attempt?: number; text: string };

/**
 * Parses any reference the app search and lookup(ref) accept (spec §3.6):
 * "§3.1", "P-2 §3.1", "T-14", "T-14.a2", "D-3", "R-1", "L-000231", "P-2".
 */
export function parseRef(input: string): Ref | undefined {
  const text = String(input).trim().replace(/\s+/g, " ");
  const withPlan = /^(P-\d+)\s*§\s*(\d+(?:\.\d+)*)$/.exec(text);
  if (withPlan) return { kind: "clause", plan: withPlan[1], clause: withPlan[2], text: `${withPlan[1]} §${withPlan[2]}` };
  if (text.startsWith("§")) {
    const clause = clauseNumber(text);
    return clause ? { kind: "clause", clause, text: `§${clause}` } : undefined;
  }
  const parsed = parseNumber(text);
  if (!parsed) return undefined;
  return { kind: "number", series: parsed.series, id: baseNumber(text), attempt: parsed.attempt, text };
}

/** Whether a ref string written in an entry (refs, subject) points at this clause, in any plan version. */
export function refMatchesClause(written: string, clause: string, plan?: string): boolean {
  const ref = parseRef(written);
  if (!ref || ref.kind !== "clause" || ref.clause !== clause) return false;
  return plan === undefined || ref.plan === undefined || ref.plan === plan;
}

export interface Implements {
  refs: string[];
  task?: string;
}

/**
 * Reads the citation agents put at the end of commit messages (spec §3.5):
 * "Implements: P-2 §3.1, P-2 §4.2 (T-14)". Returns undefined when absent.
 */
export function parseImplements(message: string): Implements | undefined {
  const lines = String(message).split(/\r?\n/).reverse();
  for (const line of lines) {
    const match = /^\s*Implements:\s*(.+?)\s*(?:\((T-\d+(?:\.a\d+)?)\))?\s*$/.exec(line);
    if (!match) continue;
    const refs = match[1]
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter((part) => parseRef(part)?.kind === "clause");
    return { refs, task: match[2] };
  }
  return undefined;
}
