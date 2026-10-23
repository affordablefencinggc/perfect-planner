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

// A 500 is usually the same answer again, so it is not retried; the busy and gateway codes usually clear.
const RETRY_STATUS = new Set([429, 502, 503, 504, 529]);
const MAX_RETRY_AFTER_MS = 10_000;

/** Retry-After in seconds or as a date, capped so a hostile or broken server cannot stall a review. */
function retryDelay(response: Response, attempt: number, now: () => number): number {
  const header = response.headers?.get?.("retry-after");
  const seconds = header && /^\d+(\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : header ? Date.parse(header) - now() : NaN;
  const wanted = Number.isFinite(seconds) ? seconds : 500 * attempt;
  return Math.min(Math.max(wanted, 0), MAX_RETRY_AFTER_MS);
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
    let lastStatus: number | undefined;
    let lastDetail = "Jev stayed busy after retrying.";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${key.reveal()}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = (error as Error).name === "TimeoutError" || (error as Error).name === "AbortError";
        lastDetail = timedOut ? `Jev did not answer in ${Math.round(timeoutMs / 1000)} s.` : key.scrub(`Jev could not be reached: ${(error as Error).message}`);
        lastStatus = undefined;
        // A reset or refused connection is retried like a 503; a timeout is not (a second wait would double the person's).
        if (attempt < maxAttempts && !timedOut) {
          await sleep(500 * attempt);
          continue;
        }
        return { ok: false, problem: "request_failed", detail: lastDetail };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, problem: "request_failed", status: response.status, detail: `Jev rejected the key (${response.status}). Check it in Settings.` };
      }
      if (RETRY_STATUS.has(response.status)) {
        lastStatus = response.status;
        lastDetail = response.status === 429 ? "Jev stayed busy (429) after retrying." : `Jev had a problem (${response.status}) and kept having it after retrying.`;
        if (attempt < maxAttempts) {
          await sleep(retryDelay(response, attempt, Date.now));
          continue;
        }
        return { ok: false, problem: "request_failed", status: response.status, detail: lastDetail };
      }
      if (!response.ok) return { ok: false, problem: "request_failed", status: response.status, detail: `Jev answered ${response.status}.` };
      const payload: unknown = await response.json().catch(() => null);
      const answers = readAnswers(payload, names);
      if (!answers) return { ok: false, problem: "malformed", status: response.status, detail: "Jev's reply did not answer every question." };
      const model = typeof (payload as { model?: unknown })?.model === "string" ? (payload as { model: string }).model : request.model;
      return { ok: true, answers, model, cost: readCost(payload), status: response.status };
    }
    return { ok: false, problem: "request_failed", ...(lastStatus ? { status: lastStatus } : {}), detail: lastDetail };
  };
}
