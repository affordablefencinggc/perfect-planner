// The person's own prices, per million tokens, by model name. There is no built-in list: prices change, and
// a guessed number would look like a fact. Kept in a file beside the ledger; only the person's window writes it.
import fs from "node:fs";
import path from "node:path";

export interface Price {
  inputPerMillion: number;
  outputPerMillion: number;
}
/** A Map, so a model called "__proto__" or "constructor" is just a name. */
export type Prices = ReadonlyMap<string, Price>;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const MAX_PRICE = 100_000;
export const MAX_MODELS = 50;

export function pricesFile(projectRoot: string): string {
  return path.join(projectRoot, ".perfect-planner", "prices.json");
}

const dollars = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE ? value : null);

/** Checks a prices body. Returns the prices, or what is wrong in plain words. */
export function parsePrices(raw: unknown): { ok: true; prices: Map<string, Price> } | { ok: false; problem: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "Prices are an object of model names." };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_MODELS) return { ok: false, problem: `At most ${MAX_MODELS} models.` };
  const prices = new Map<string, Price>();
  for (const [model, value] of entries) {
    if (!MODEL.test(model)) return { ok: false, problem: `"${model.slice(0, 40)}" is not a model name (letters, digits and . _ : / -).` };
    const v = value as { inputPerMillion?: unknown; outputPerMillion?: unknown } | null;
    const input = dollars(v?.inputPerMillion);
    const output = dollars(v?.outputPerMillion);
    if (input === null || output === null) return { ok: false, problem: `${model}: give inputPerMillion and outputPerMillion as dollars from 0 to ${MAX_PRICE.toLocaleString("en-US")}.` };
    prices.set(model, { inputPerMillion: input, outputPerMillion: output });
  }
  return { ok: true, prices };
}

export function readPrices(projectRoot: string): Map<string, Price> {
  try {
    const read = parsePrices(JSON.parse(fs.readFileSync(pricesFile(projectRoot), "utf8")));
    return read.ok ? read.prices : new Map();
  } catch {
    return new Map();
  }
}

export function writePrices(projectRoot: string, prices: ReadonlyMap<string, Price>): void {
  const file = pricesFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(prices), null, 2)}\n`);
  fs.renameSync(tmp, file);
}
