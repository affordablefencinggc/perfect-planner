// What an agent says a stretch of work used. Agents are not trusted with this number: it is checked for
// shape and size here, labelled "reported" wherever it is shown, and never used for any decision.
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Dollars, when the agent knows what it cost. */
  costUsd?: number;
}

export const MAX_TOKENS = 1_000_000_000;
export const MAX_USD = 10_000;

const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : null);

export type UsageRead = { ok: true; usage: Usage } | { ok: false; problem: string };

/** Reads the `usage` an agent sent with report_progress. Anything outside whole numbers 0..1e9 and dollars 0..10,000 is refused whole. */
export function parseUsage(raw: unknown): UsageRead {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "usage must be an object like {inputTokens, outputTokens}." };
  const given = raw as Record<string, unknown>;
  const input = given.inputTokens === undefined ? 0 : count(given.inputTokens);
  const output = given.outputTokens === undefined ? 0 : count(given.outputTokens);
  const cache = given.cacheReadTokens === undefined ? 0 : count(given.cacheReadTokens);
  if (input === null || output === null || cache === null) return { ok: false, problem: `Token counts must be whole numbers from 0 to ${MAX_TOKENS.toLocaleString("en-US")}.` };
  let costUsd: number | undefined;
  if (given.costUsd !== undefined) {
    const usd = given.costUsd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd > MAX_USD) return { ok: false, problem: `costUsd must be a number of dollars from 0 to ${MAX_USD.toLocaleString("en-US")}.` };
    costUsd = Math.round(usd * 1e6) / 1e6;
  }
  if (input + output + cache === 0 && costUsd === undefined) return { ok: false, problem: "usage names no tokens and no cost." };
  return { ok: true, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cache, ...(costUsd !== undefined ? { costUsd } : {}) } };
}

/** A usage already in the ledger, read again defensively (a hand-edited file or an older writer must not poison the totals). */
export function usageFromData(raw: unknown): Usage | null {
  const read = parseUsage(raw);
  return read.ok ? read.usage : null;
}
