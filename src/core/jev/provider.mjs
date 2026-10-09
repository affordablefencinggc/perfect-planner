// TypeSafe System One client for Jev reviews.
//
// Contract (docs.typesafe.ai/api, read 2026-10-09):
//   POST {baseUrl}{path}  default https://api.typesafe.ai/v1/systemone
//   Authorization: Bearer <key>, Content-Type: application/json
//   body { state, model: "jev-latest", questions: { id: { type: noul|choice|score, instructions, criteria } } }
//   200  { model, answers: { id: { type, noul | choice+probabilities+confidence | score+legend+probabilities+confidence } }, usage: { input_tokens, output_tokens } }
//   401 bad key, 422 validation, 429 rate limited, 529 overloaded.
// Pricing (docs.typesafe.ai/models): $0.042 per million input tokens, output free.
// The response carries no cost field, so cost is computed from usage and the
// configurable price. Base URL, path and price come from settings.

export const TYPESAFE_DEFAULTS = Object.freeze({
  provider: "TypeSafe",
  baseUrl: "https://api.typesafe.ai",
  path: "/v1/systemone",
  model: "jev-latest",
  pricePerMillionInputTokens: 0.042,
  timeoutMs: 30_000,
  retries: 2,
});

export class ProviderError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
}

function endpoint(baseUrl, path) {
  let url;
  try { url = new URL(`${String(baseUrl).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`); } catch { throw new ProviderError("PROVIDER_CONFIG", "The TypeSafe base URL or path is not a valid URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ProviderError("PROVIDER_CONFIG", "The TypeSafe endpoint must use https (plain http is allowed only for localhost).");
  }
  if (url.username || url.password) throw new ProviderError("PROVIDER_CONFIG", "The TypeSafe endpoint must not embed credentials.");
  return url;
}

function validateAnswers(questions, body) {
  if (!body || typeof body !== "object" || typeof body.answers !== "object" || body.answers === null) {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "TypeSafe returned a response without answers.");
  }
  for (const [id, question] of Object.entries(questions)) {
    const answer = body.answers[id];
    if (!answer || answer.type !== question.type) throw new ProviderError("PROVIDER_BAD_RESPONSE", `TypeSafe did not answer question ${id}.`);
    if (question.type === "noul" && !(Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1)) throw new ProviderError("PROVIDER_BAD_RESPONSE", `Noul answer ${id} is not a probability.`);
    if (question.type === "choice" && (!(answer.choice in question.criteria) || !Number.isFinite(answer.confidence))) throw new ProviderError("PROVIDER_BAD_RESPONSE", `Choice answer ${id} is not one of the offered options.`);
    if (question.type === "score" && (!Number.isFinite(answer.score) || !Number.isFinite(answer.confidence))) throw new ProviderError("PROVIDER_BAD_RESPONSE", `Score answer ${id} is malformed.`);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * createTypeSafeProvider({ getApiKey, settings, fetchImpl })
 *   getApiKey: async () => string|null  (use keychain.providerKeySource())
 *   settings:  { baseUrl?, path?, pricePerMillionInputTokens?, timeoutMs?, retries? }
 * Returns { name, evaluate({ model, state, questions }) -> { model, answers, usage, cost } }.
 */
export function createTypeSafeProvider({ getApiKey, settings = {}, fetchImpl = globalThis.fetch, sleep = wait } = {}) {
  if (typeof getApiKey !== "function") throw new ProviderError("PROVIDER_CONFIG", "createTypeSafeProvider needs a getApiKey function backed by the OS keychain.");
  const config = { ...TYPESAFE_DEFAULTS, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined && v !== null)) };
  const url = endpoint(config.baseUrl, config.path);
  const price = Number(config.pricePerMillionInputTokens);
  if (!Number.isFinite(price) || price < 0) throw new ProviderError("PROVIDER_CONFIG", "The TypeSafe price per million input tokens must be a non-negative number.");

  async function evaluate({ model = config.model, state, questions }) {
    if (!questions || !Object.keys(questions).length) throw new ProviderError("PROVIDER_INVALID_REQUEST", "At least one question is required.");
    const key = await getApiKey();
    if (!key) throw new ProviderError("PROVIDER_NO_KEY", "No TypeSafe Jev API key is stored. Add it in Settings.");
    const body = JSON.stringify({ state, model, questions });
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (attempt < config.retries) { await sleep(500 * 2 ** attempt); continue; }
        throw new ProviderError(error?.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE", "TypeSafe could not be reached.");
      }
      clearTimeout(timer);
      if (response.status === 429 || response.status === 529) {
        if (attempt < config.retries) { await sleep(1000 * 2 ** attempt); continue; }
        throw new ProviderError("PROVIDER_BUSY", `TypeSafe is busy (HTTP ${response.status}).`, response.status);
      }
      if (response.status === 401) throw new ProviderError("PROVIDER_AUTH", "TypeSafe rejected the stored API key (HTTP 401).", 401);
      if (response.status === 422) {
        let detail = "";
        try { detail = JSON.stringify((await response.json())?.detail ?? "").slice(0, 300); } catch { /* no body */ }
        throw new ProviderError("PROVIDER_INVALID_REQUEST", `TypeSafe refused the request (HTTP 422) ${detail}`.trim(), 422);
      }
      if (!response.ok) throw new ProviderError("PROVIDER_FAILED", `TypeSafe returned HTTP ${response.status}.`, response.status);
      let parsed;
      try { parsed = await response.json(); } catch { throw new ProviderError("PROVIDER_BAD_RESPONSE", "TypeSafe returned a body that is not JSON."); }
      validateAnswers(questions, parsed);
      const inputTokens = Number(parsed.usage?.input_tokens);
      if (!Number.isFinite(inputTokens) || inputTokens < 0) throw new ProviderError("PROVIDER_BAD_RESPONSE", "TypeSafe returned no usage, so the cost is unknown.");
      return {
        model: String(parsed.model ?? model),
        answers: parsed.answers,
        usage: { input_tokens: inputTokens, output_tokens: Number(parsed.usage?.output_tokens) || 0 },
        cost: (inputTokens * price) / 1_000_000,
      };
    }
  }

  /** Cost estimate before a call (about 4 characters per token). */
  function estimateCost({ state, questions }) {
    const chars = JSON.stringify({ state, questions }).length;
    return (Math.ceil(chars / 4) * price) / 1_000_000;
  }

  return Object.freeze({ name: config.provider, endpoint: url.href, evaluate, estimateCost });
}
