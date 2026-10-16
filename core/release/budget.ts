// Monthly CI and model budget. Spend and budget config both live in the
// ledger; nothing here keeps its own state.
import { Ledger, LedgerError, isAuthoritative } from "../ledger/index";
import type { Actor, EntryType, LedgerEntry } from "../ledger/index";
import { nextNumber } from "../numbering/index";
import type { Cents } from "./types";

export type SpendKind = "ci" | "model";

export interface Cost {
  cents: number;
  kind: SpendKind;
  detail?: string;
}

export interface BudgetConfig {
  monthlyCents: number;
  /** Fraction of the budget at which Jev warns. Default 0.8. */
  warnAt?: number;
}

export interface MonthSpend {
  totalCents: number;
  ciCents: number;
  modelCents: number;
}

export type BudgetState = "ok" | "warning" | "stopped" | "uncapped";

export interface BudgetStatus {
  month: string;
  budgetCents?: number;
  spentCents: number;
  /** spent / budget; 0 when uncapped. */
  ratio: number;
  state: BudgetState;
  remainingCents?: number;
}

export const DEFAULT_WARN_AT = 0.8;

/** "$12.34". Rounds to the nearest cent; negative amounts get a leading "-". */
export function formatCents(cents: Cents | number): string {
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${rounded < 0 ? "-" : ""}$${dollars}.${rest}`;
}

/** The cost recorded on an entry, or undefined when it has none (or it is malformed). */
export function costOf(entry: LedgerEntry): Cost | undefined {
  const cost = entry.data?.cost as Partial<Cost> | undefined;
  if (!cost || typeof cost !== "object") return undefined;
  if (typeof cost.cents !== "number" || !Number.isFinite(cost.cents) || cost.cents < 0) return undefined;
  if (cost.kind !== "ci" && cost.kind !== "model") return undefined;
  const out: Cost = { cents: cost.cents, kind: cost.kind };
  if (typeof cost.detail === "string") out.detail = cost.detail;
  return out;
}

/** "YYYY-MM" (UTC) of a date or ISO string. */
export function monthOf(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return d.toISOString().slice(0, 7);
}

export function monthSpend(entries: readonly LedgerEntry[], month: string): MonthSpend {
  let ci = 0;
  let model = 0;
  for (const entry of entries) {
    if (entry.at.slice(0, 7) !== month) continue;
    const cost = costOf(entry);
    if (!cost) continue;
    if (cost.kind === "ci") ci += cost.cents;
    else model += cost.cents;
  }
  return { totalCents: ci + model, ciCents: ci, modelCents: model };
}

/** Latest budget decision by a person, or undefined (no cap). */
export function currentBudget(entries: readonly LedgerEntry[]): BudgetConfig | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    // Only a person's decision counts, never an agent's or the system's.
    if (entry.type !== "decision.made" || !isAuthoritative(entry, { personOnly: true }) || entry.data?.topic !== "budget") continue;
    const b = entry.data?.budget as Partial<BudgetConfig> | undefined;
    if (!b || typeof b.monthlyCents !== "number" || !(b.monthlyCents > 0)) continue;
    const config: BudgetConfig = { monthlyCents: b.monthlyCents };
    if (typeof b.warnAt === "number") config.warnAt = b.warnAt;
    return config;
  }
  return undefined;
}

export function setBudget(
  ledger: Ledger,
  actor: Actor,
  input: { monthlyCents: number; warnAt?: number; reason: string },
): LedgerEntry {
  if (actor.kind !== "person") {
    throw new LedgerError("RULE", "Only a person can set the budget in Settings");
  }
  if (!Number.isFinite(input.monthlyCents) || input.monthlyCents <= 0) {
    throw new LedgerError("EMPTY_FIELD", "The monthly budget must be more than $0.00");
  }
  const warnAt = input.warnAt ?? DEFAULT_WARN_AT;
  if (!(warnAt > 0 && warnAt < 1)) {
    throw new LedgerError("EMPTY_FIELD", "The warning level must be between 0 and 1");
  }
  const budget: BudgetConfig = { monthlyCents: Math.round(input.monthlyCents), warnAt };
  // A decision takes the next D- number (core/numbering); the topic says what it decides.
  return ledger.append({
    actor,
    type: "decision.made",
    subject: nextNumber(ledger.entries(), "D"),
    summary: `Monthly budget set to ${formatCents(budget.monthlyCents)}`,
    reason: input.reason,
    evidence: [],
    refs: [],
    data: { topic: "budget", budget },
  });
}

export function budgetStatus(entries: readonly LedgerEntry[], now: Date): BudgetStatus {
  const month = monthOf(now);
  const spentCents = monthSpend(entries, month).totalCents;
  const config = currentBudget(entries);
  if (!config) return { month, spentCents, ratio: 0, state: "uncapped" };
  const budgetCents = config.monthlyCents;
  const warnAt = config.warnAt ?? DEFAULT_WARN_AT;
  const ratio = spentCents / budgetCents;
  let state: BudgetState = "ok";
  if (spentCents >= budgetCents) state = "stopped";
  else if (spentCents >= budgetCents * warnAt - 1e-9) state = "warning";
  return { month, budgetCents, spentCents, ratio, state, remainingCents: Math.max(0, budgetCents - spentCents) };
}

/**
 * Records spend on an ordinary entry. `type` defaults to "task.progress"
 * (the ledger has no dedicated spend type); the cost rides in `data.cost`, so
 * any entry type works. Call checkBudget afterwards to raise warnings.
 */
export function recordSpend(
  ledger: Ledger,
  actor: Actor,
  input: { cents: number; kind: SpendKind; subject: string; summary: string; detail?: string; type?: EntryType },
): LedgerEntry {
  if (!Number.isFinite(input.cents) || input.cents < 0) {
    throw new LedgerError("EMPTY_FIELD", "Spend must be zero or more cents");
  }
  const cost: Cost = { cents: Math.round(input.cents), kind: input.kind };
  if (input.detail !== undefined) cost.detail = input.detail;
  return ledger.append({
    actor,
    type: input.type ?? "task.progress",
    subject: input.subject,
    summary: input.summary,
    evidence: [],
    refs: [],
    data: { cost },
  });
}

/**
 * Writes a `budget.warning` when the month crosses the warning level or the
 * cap. One per month, per threshold, per budget amount: calling again writes
 * nothing, but raising the budget and crossing the new level warns again.
 * Returns the status.
 */
export function checkBudget(ledger: Ledger, actor: Actor, now: Date): BudgetStatus {
  const status = budgetStatus(ledger.entries(), now);
  if (status.state !== "warning" && status.state !== "stopped") return status;
  const threshold = status.state === "stopped" ? "stop" : "warn";
  const already = ledger.entries().some(
    (e) =>
      e.type === "budget.warning" &&
      e.data?.month === status.month &&
      e.data?.threshold === threshold &&
      e.data?.budgetCents === status.budgetCents,
  );
  if (already) return status;
  const summary =
    threshold === "stop"
      ? `Monthly budget reached: ${formatCents(status.spentCents)} of ${formatCents(status.budgetCents!)}; new runs are stopped`
      : `Monthly budget at ${Math.floor(status.ratio * 100)}%: ${formatCents(status.spentCents)} of ${formatCents(status.budgetCents!)}`;
  ledger.append({
    actor,
    type: "budget.warning",
    subject: "budget",
    summary,
    evidence: [],
    refs: [],
    data: { month: status.month, threshold, spentCents: status.spentCents, budgetCents: status.budgetCents },
  });
  return status;
}

const NEW_RUN_TYPES: ReadonlySet<EntryType> = new Set<EntryType>(["task.claimed", "worktree.created"]);

/** Refuses new runs (claims, worktrees) once the month is at 100%. Everything else still goes through. */
export function installBudgetRule(ledger: Ledger, options: { now?: () => Date } = {}): void {
  const now = options.now ?? (() => new Date());
  ledger.addRule((draft, l) => {
    if (!NEW_RUN_TYPES.has(draft.type)) return null;
    const status = budgetStatus(l.entries(), now());
    if (status.state !== "stopped") return null;
    return `Monthly budget reached (${formatCents(status.spentCents)} of ${formatCents(status.budgetCents!)}); raise it in Settings to start new runs`;
  });
}
