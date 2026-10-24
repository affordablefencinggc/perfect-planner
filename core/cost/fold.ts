// What the work cost, as a pure fold over the ledger. Three kinds of number, never mixed up:
//   reported  - an agent said so in report_progress (self-reported, not checked)
//   measured  - Jev's own review cost, in an entry the app signed
//   estimated - tokens times a price the person set, or Jev's per-call estimate when Jev did not say
// A stretch of work with none of these shows no cost at all, never $0.
import { isAuthoritative, type LedgerEntry } from "../ledger/index";
import type { Price, Prices } from "./prices";
import { usageFromData } from "./usage";

export interface Amount {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reportedUsd: number;
  measuredUsd: number;
  estimatedUsd: number;
  /** Tokens that have no dollar figure: nothing reported and no price set for the model. */
  unpricedTokens: number;
  /** Total of the three dollar kinds. */
  usd: number;
}

export interface CostRow extends Amount {
  key: string;
}

export interface CostRun extends CostRow {
  task: string;
  worker: string;
  model: string;
}

export interface CostView {
  project: Amount;
  byRepo: CostRow[];
  byTask: (CostRow & { repo: string; runs: CostRun[] })[];
  byModel: CostRow[];
  /** Entries left out because their numbers were impossible. */
  ignored: number;
}

const blank = (): Amount => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reportedUsd: 0, measuredUsd: 0, estimatedUsd: 0, unpricedTokens: 0, usd: 0 });
const round = (n: number) => Math.round(n * 1e6) / 1e6;

function add(into: Amount, from: Amount): void {
  into.calls += from.calls;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.reportedUsd = round(into.reportedUsd + from.reportedUsd);
  into.measuredUsd = round(into.measuredUsd + from.measuredUsd);
  into.estimatedUsd = round(into.estimatedUsd + from.estimatedUsd);
  into.unpricedTokens += from.unpricedTokens;
  into.usd = round(into.reportedUsd + into.measuredUsd + into.estimatedUsd);
}

function estimate(price: Price | undefined, input: number, output: number): number | null {
  return price ? round((input * price.inputPerMillion + output * price.outputPerMillion) / 1e6) : null;
}

/** "T-14.a2" and "T-14" are one task. */
const taskOf = (subject: string) => /^(T-\d+)(?:\.a\d+)?$/.exec(subject)?.[1] ?? null;

export function costView(entries: readonly LedgerEntry[], tasks: ReadonlyMap<string, { repo: string | null }>, prices: Prices, primary = "main"): CostView {
  const runs = new Map<string, CostRun>();
  const models = new Map<string, CostRow>();
  let ignored = 0;

  const run = (label: string, worker: string, model: string): CostRun => {
    const key = `${label}\u0000${worker}\u0000${model}`;
    let found = runs.get(key);
    if (!found) {
      found = { key, task: label, worker, model, ...blank() };
      runs.set(key, found);
    }
    return found;
  };

  for (const entry of entries) {
    const label = entry.subject;
    const task = taskOf(label);
    if (!task || !tasks.has(task)) continue;
    let amount: Amount | null = null;
    let worker = entry.actor?.id ?? "unknown";
    // The model is what the agent said about itself ("unverified:" in the ledger): a price is looked up by that name.
    let model = (entry.actor?.model ?? "unknown").replace(/^unverified:/, "");
    if (entry.type === "task.progress" && entry.actor?.kind === "agent" && entry.data && "usage" in entry.data) {
      const usage = usageFromData(entry.data.usage);
      if (!usage) {
        ignored += 1;
        continue;
      }
      amount = { ...blank(), calls: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens };
      if (usage.costUsd !== undefined) amount.reportedUsd = usage.costUsd;
      else {
        const dollars = estimate(prices.get(model), usage.inputTokens, usage.outputTokens);
        if (dollars === null) amount.unpricedTokens = usage.inputTokens + usage.outputTokens;
        else amount.estimatedUsd = dollars;
      }
    } else if (entry.type === "review.verdict" && isAuthoritative(entry) && typeof entry.data?.cost === "number" && entry.data.jevModel) {
      const cost = entry.data.cost;
      if (!Number.isFinite(cost) || cost < 0 || cost > 10_000) {
        ignored += 1;
        continue;
      }
      amount = { ...blank(), calls: 1 };
      if (entry.data.costEstimated === true) amount.estimatedUsd = round(cost);
      else amount.measuredUsd = round(cost);
      worker = "jev";
      model = typeof entry.data.jevModel === "string" ? entry.data.jevModel.slice(0, 80) : "jev";
    }
    if (!amount) continue;
    amount.usd = round(amount.reportedUsd + amount.measuredUsd + amount.estimatedUsd);
    add(run(label, worker, model), amount);
    let byModel = models.get(model);
    if (!byModel) models.set(model, (byModel = { key: model, ...blank() }));
    add(byModel, amount);
  }

  const project = blank();
  const perTask = new Map<string, CostRow & { repo: string; runs: CostRun[] }>();
  const perRepo = new Map<string, CostRow>();
  for (const r of runs.values()) {
    const id = taskOf(r.task)!;
    const repo = tasks.get(id)?.repo ?? primary;
    let t = perTask.get(id);
    if (!t) perTask.set(id, (t = { key: id, repo, runs: [], ...blank() }));
    t.runs.push(r);
    add(t, r);
    let rr = perRepo.get(repo);
    if (!rr) perRepo.set(repo, (rr = { key: repo, ...blank() }));
    add(rr, r);
    add(project, r);
  }
  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key, "en", { numeric: true });
  return {
    project,
    byRepo: [...perRepo.values()].sort(byKey),
    byTask: [...perTask.values()].sort(byKey),
    byModel: [...models.values()].sort(byKey),
    ignored,
  };
}
