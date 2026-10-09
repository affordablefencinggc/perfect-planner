// The wire to TypeSafe Jev (spec §6.1): model jev-latest at
// https://api.typesafe.ai/v1/systemone, the same request shape Looplet uses
// (supabase/functions/_shared/journey-reply-classifier.ts): `state` holds what
// Jev reads, `questions` holds choice questions, and the reply carries
// `answers[name] = { choice, confidence }`.
//
// Unlike Looplet's classifier, reviews FAIL CLOSED: a missing key, a timeout,
// a 429 or a malformed reply is "unavailable", never an approval.
import type { JevKeyProvider } from "./keyProvider";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
}

export interface JevAnswer {
  choice: string;
  confidence: number | null;
  reason?: string;
}

export type JevCallResult =
  | { ok: true; answers: Record<string, JevAnswer>; model: string; cost: number | null; status: number }
  | { ok: false; problem: "no_key" | "request_failed" | "malformed"; detail: string; status?: number };

export interface TransportOptions {
  keys: JevKeyProvider;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

function readAnswers(payload: unknown, names: string[]): Record<string, JevAnswer> | null {
  const answers = (payload as { answers?: Record<string, { choice?: unknown; confidence?: unknown; reason?: unknown; explanation?: unknown }> } | null)?.answers;
  if (!answers || typeof answers !== "object") return null;
  const out: Record<string, JevAnswer> = {};
  for (const name of names) {
    const a = answers[name];
    if (!a || typeof a.choice !== "string") return null;
    const reason = typeof a.reason === "string" ? a.reason : typeof a.explanation === "string" ? a.explanation : undefined;
    out[name] = { choice: a.choice, confidence: typeof a.confidence === "number" ? a.confidence : null, ...(reason ? { reason: reason.slice(0, 500) } : {}) };
  }
  return out;
}

function readCost(payload: unknown): number | null {
  const p = payload as { cost?: unknown; usage?: { cost?: unknown; cost_usd?: unknown; total_cost?: unknown } } | null;
  for (const value of [p?.usage?.cost_usd, p?.usage?.cost, p?.usage?.total_cost, p?.cost]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

export function createJevTransport(options: TransportOptions): (request: JevRequest) => Promise<JevCallResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? JEV_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (request) => {
    const key = await options.keys.read().catch(() => null);
    if (!key) return { ok: false, problem: "no_key", detail: "No Jev key is saved. Add your TypeSafe key in Settings." };
    const names = Object.keys(request.questions);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${key.reveal()}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if ((response.status === 429 || response.status === 529) && attempt < maxAttempts) {
          await sleep(500 * attempt);
          continue;
        }
        if (!response.ok) return { ok: false, problem: "request_failed", status: response.status, detail: `Jev answered ${response.status}.` };
        const payload: unknown = await response.json().catch(() => null);
        const answers = readAnswers(payload, names);
        if (!answers) return { ok: false, problem: "malformed", status: response.status, detail: "Jev's reply did not answer every question." };
        const model = typeof (payload as { model?: unknown })?.model === "string" ? (payload as { model: string }).model : request.model;
        return { ok: true, answers, model, cost: readCost(payload), status: response.status };
      } catch (error) {
        return { ok: false, problem: "request_failed", detail: key.scrub(`Jev could not be reached: ${(error as Error).message}`) };
      }
    }
    return { ok: false, problem: "request_failed", detail: "Jev stayed busy (429) after retrying." };
  };
}
