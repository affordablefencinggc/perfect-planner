// Live research for planning questions: compare the options with cost and fit,
// and back the recommendation with sources. Research is advisory only: if it
// fails, planning carries on without it.
//
// Keys come only through a ResearchKeyProvider (a keychain entry such as
// "PerfectPlanner/SonarKey"), never from the environment. A key is revealed
// once per request to build the Authorization header and is scrubbed from any
// text that leaves this module (errors, results).
import type { IdeaProfile, PlanningQuestion, Source } from "./types";

// ---------- Keys ----------

/** Structurally compatible with the Jev SecretKey. */
export interface SecretLike {
  reveal(): string;
  scrub(text: string): string;
}

/** Structurally compatible with the Jev JevKeyProvider. */
export interface ResearchKeyProvider {
  read(): Promise<SecretLike | null>;
}

// ---------- Shapes ----------

export interface ResearchQuery {
  question: string;
  options?: string[];
  context?: string;
}

export interface ComparedOption {
  option: string;
  summary: string;
  cost?: string;
  fit?: string;
  sources: Source[];
}

export interface ResearchResult {
  provider: string;
  answer: string;
  sources: Source[];
  compared: ComparedOption[];
  at: string;
}

export interface ResearchProvider {
  readonly name: string;
  available(): Promise<boolean>;
  research(query: ResearchQuery, signal?: AbortSignal): Promise<ResearchResult>;
}

export type ResearchErrorCode = "NO_KEY" | "HTTP" | "BAD_RESPONSE" | "TIMEOUT";

export class ResearchError extends Error {
  readonly code: ResearchErrorCode;
  readonly status?: number;
  constructor(code: ResearchErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** The minimal slice of fetch this module uses, so tests can inject a fake. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}
export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

// ---------- Shared plumbing ----------

const BODY_EXCERPT = 200;

function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== "function") {
    return async () => {
      throw new ResearchError("BAD_RESPONSE", "fetch is not available in this runtime");
    };
  }
  return f as FetchLike;
}

function isoNow(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

/**
 * POST JSON with a Bearer key, a timeout and the caller's abort signal.
 * Every error message is scrubbed with the key before it is thrown.
 */
async function postJson(
  fetchFn: FetchLike,
  url: string,
  key: SecretLike,
  payload: unknown,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new ResearchError("TIMEOUT", `${label} request was cancelled`);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let res: FetchResponseLike;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${key.reveal()}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) throw new ResearchError("TIMEOUT", `${label} did not answer within ${timeoutMs} ms`);
      if (signal?.aborted) throw new ResearchError("TIMEOUT", `${label} request was cancelled`);
      if (err instanceof ResearchError) throw new ResearchError(err.code, key.scrub(err.message), err.status);
      const msg = err instanceof Error ? err.message : String(err);
      throw new ResearchError("BAD_RESPONSE", key.scrub(`${label} request failed: ${msg}`));
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (timedOut) throw new ResearchError("TIMEOUT", `${label} did not answer within ${timeoutMs} ms`);
      const msg = err instanceof Error ? err.message : String(err);
      throw new ResearchError("BAD_RESPONSE", key.scrub(`${label} response could not be read: ${msg}`));
    }
    if (!res.ok) {
      // Scrub first, then cut, so a key straddling the cut cannot leak a prefix.
      const excerpt = key.scrub(text).slice(0, BODY_EXCERPT).replace(/\s+/g, " ").trim();
      throw new ResearchError(
        "HTTP",
        `${label} returned HTTP ${res.status}${excerpt ? `: ${excerpt}` : ""}`,
        res.status,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ResearchError("BAD_RESPONSE", `${label} returned a response that is not JSON`);
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function requireKey(keys: ResearchKeyProvider, label: string): Promise<SecretLike> {
  let key: SecretLike | null;
  try {
    key = await keys.read();
  } catch {
    key = null;
  }
  if (!key || !key.reveal()) throw new ResearchError("NO_KEY", `No ${label} key is set`);
  return key;
}

async function hasKey(keys: ResearchKeyProvider): Promise<boolean> {
  try {
    const key = await keys.read();
    return !!key && key.reveal().length > 0;
  } catch {
    return false;
  }
}

function scrubResult(result: ResearchResult, key: SecretLike): ResearchResult {
  return JSON.parse(key.scrub(JSON.stringify(result))) as ResearchResult;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of sources) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

function hostTitle(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---------- Sonar (Perplexity) ----------

export interface SonarOptions {
  keys: ResearchKeyProvider;
  fetch?: FetchLike;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export const SONAR_SYSTEM_PROMPT = [
  "You are a research assistant helping plan a software project.",
  "Compare the given options concisely, with rough monthly cost and when each fits.",
  "Start with a two or three sentence overall answer.",
  "Then write one line per option, exactly in this format:",
  "OPTION: <name> | <summary> | cost: <x> | fit: <y>",
  "Use the option names as given. Do not add other options.",
].join("\n");

function buildUserPrompt(query: ResearchQuery): string {
  const parts = [`Question: ${query.question}`];
  if (query.options?.length) parts.push(`Options:\n${query.options.map((o) => `- ${o}`).join("\n")}`);
  if (query.context) parts.push(`Context: ${query.context}`);
  return parts.join("\n\n");
}

const OPTION_LINE = /^\s*(?:[-*]\s*)?\**OPTION\**\s*:\s*(.+)$/i;

/** Parse "OPTION: name | summary | cost: x | fit: y" lines. */
export function parseOptionLines(content: string): ComparedOption[] {
  const out: ComparedOption[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = OPTION_LINE.exec(line);
    if (!m) continue;
    const cells = m[1].split("|").map((c) => c.trim());
    const option = cells[0]?.replace(/\*+/g, "").trim();
    if (!option) continue;
    const item: ComparedOption = { option, summary: "", sources: [] };
    const summary: string[] = [];
    for (const cell of cells.slice(1)) {
      const kv = /^(cost|fit)\s*:\s*(.*)$/i.exec(cell);
      if (kv) {
        const value = kv[2].trim();
        if (value) {
          if (kv[1].toLowerCase() === "cost") item.cost = value;
          else item.fit = value;
        }
      } else if (cell) summary.push(cell);
    }
    item.summary = summary.join(" | ");
    out.push(item);
  }
  return out;
}

function stripOptionLines(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((l) => !OPTION_LINE.test(l))
    .join("\n")
    .trim();
}

export function createSonarProvider(opts: SonarOptions): ResearchProvider {
  const model = opts.model ?? "sonar";
  const endpoint = opts.endpoint ?? "https://api.perplexity.ai/chat/completions";
  const timeoutMs = opts.timeoutMs ?? 20000;
  const fetchFn = opts.fetch ?? defaultFetch();
  const name = "sonar";
  return {
    name,
    available: () => hasKey(opts.keys),
    async research(query, signal) {
      const key = await requireKey(opts.keys, "Sonar");
      const body = await postJson(
        fetchFn,
        endpoint,
        key,
        {
          model,
          messages: [
            { role: "system", content: SONAR_SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(query) },
          ],
        },
        timeoutMs,
        "Sonar",
        signal,
      );
      if (!isRecord(body) || !Array.isArray(body.choices)) {
        throw new ResearchError("BAD_RESPONSE", "Sonar response has no choices");
      }
      const first = body.choices[0];
      const content =
        isRecord(first) && isRecord(first.message) && typeof first.message.content === "string"
          ? first.message.content
          : null;
      if (content === null) throw new ResearchError("BAD_RESPONSE", "Sonar response has no message content");

      const sources: Source[] = [];
      if (Array.isArray(body.search_results)) {
        for (const r of body.search_results) {
          if (isRecord(r) && typeof r.url === "string") {
            sources.push({ title: typeof r.title === "string" && r.title ? r.title : hostTitle(r.url), url: r.url });
          }
        }
      }
      if (Array.isArray(body.citations)) {
        for (const c of body.citations) {
          if (typeof c === "string") sources.push({ title: hostTitle(c), url: c });
        }
      }
      const all = dedupeSources(sources);
      const compared = parseOptionLines(content).map((c) => ({ ...c, sources: all }));
      const answer = stripOptionLines(content) || content.trim();
      return scrubResult({ provider: name, answer, sources: all, compared, at: isoNow(opts.now) }, key);
    },
  };
}

// ---------- Firecrawl search ----------

export interface FirecrawlOptions {
  keys: ResearchKeyProvider;
  fetch?: FetchLike;
  endpoint?: string;
  limit?: number;
  timeoutMs?: number;
  now?: () => Date;
}

function buildSearchQuery(query: ResearchQuery): string {
  const opts = query.options?.length ? ` ${query.options.join(" vs ")}` : "";
  return `${query.question}${opts}`.trim();
}

export function createFirecrawlProvider(opts: FirecrawlOptions): ResearchProvider {
  const endpoint = opts.endpoint ?? "https://api.firecrawl.dev/v1/search";
  const limit = opts.limit ?? 5;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const fetchFn = opts.fetch ?? defaultFetch();
  const name = "firecrawl";
  return {
    name,
    available: () => hasKey(opts.keys),
    async research(query, signal) {
      const key = await requireKey(opts.keys, "Firecrawl");
      const body = await postJson(
        fetchFn,
        endpoint,
        key,
        { query: buildSearchQuery(query), limit },
        timeoutMs,
        "Firecrawl",
        signal,
      );
      if (!isRecord(body) || body.success === false || !Array.isArray(body.data)) {
        throw new ResearchError("BAD_RESPONSE", "Firecrawl response has no results");
      }
      const items: { title: string; url: string; description: string }[] = [];
      for (const d of body.data) {
        if (!isRecord(d) || typeof d.url !== "string") continue;
        items.push({
          title: typeof d.title === "string" && d.title ? d.title : hostTitle(d.url),
          url: d.url,
          description: typeof d.description === "string" ? d.description.trim() : "",
        });
      }
      const sources = dedupeSources(items.map((i) => ({ title: i.title, url: i.url })));
      const answer = items
        .map((i) => i.description)
        .filter(Boolean)
        .join("\n")
        .trim();
      const compared: ComparedOption[] = (query.options ?? []).map((option) => {
        const needle = option.toLowerCase();
        const hits = items.filter(
          (i) => i.title.toLowerCase().includes(needle) || i.description.toLowerCase().includes(needle),
        );
        return {
          option,
          summary: hits.map((h) => h.description).filter(Boolean).join(" ").trim(),
          sources: dedupeSources(hits.map((h) => ({ title: h.title, url: h.url }))),
        };
      });
      return scrubResult({ provider: name, answer, sources, compared, at: isoNow(opts.now) }, key);
    },
  };
}

// ---------- Mock ----------

export interface MockProvider extends ResearchProvider {
  readonly calls: ResearchQuery[];
}

export type MockFixtures =
  | Record<string, Partial<ResearchResult>>
  | ((q: ResearchQuery) => Partial<ResearchResult>);

/** Deterministic provider for tests and offline previews. Records every query. */
export function createMockProvider(fixtures?: MockFixtures, name = "mock"): MockProvider {
  const calls: ResearchQuery[] = [];
  return {
    name,
    calls,
    available: async () => true,
    async research(query) {
      calls.push({ ...query, options: query.options ? [...query.options] : undefined });
      const fixture =
        typeof fixtures === "function" ? fixtures(query) : fixtures ? fixtures[query.question] ?? {} : {};
      const options = query.options ?? [];
      return {
        provider: fixture.provider ?? name,
        answer: fixture.answer ?? `Offline preview: no live research for "${query.question}".`,
        sources: fixture.sources ?? [],
        compared:
          fixture.compared ?? options.map((option) => ({ option, summary: "", sources: [] as Source[] })),
        at: fixture.at ?? "1970-01-01T00:00:00.000Z",
      };
    },
  };
}

// ---------- Fallback ----------

/** A provider that tries each available provider in order and returns the first success. */
export function withFallback(...providers: ResearchProvider[]): ResearchProvider {
  return {
    name: `fallback(${providers.map((p) => p.name).join(",")})`,
    async available() {
      for (const p of providers) if (await p.available().catch(() => false)) return true;
      return false;
    },
    async research(query, signal) {
      let lastError: unknown = null;
      for (const p of providers) {
        if (signal?.aborted) break;
        if (!(await p.available().catch(() => false))) continue;
        try {
          return await p.research(query, signal);
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError instanceof ResearchError) throw lastError;
      if (lastError) throw new ResearchError("BAD_RESPONSE", lastError instanceof Error ? lastError.message : String(lastError));
      throw new ResearchError("NO_KEY", "No research provider is available");
    },
  };
}

// ---------- Planning glue ----------

export interface ResearchedQuestion {
  question: PlanningQuestion;
  result: ResearchResult | null;
  error?: string;
}

export function buildQuery(question: PlanningQuestion, profile: IdeaProfile): ResearchQuery {
  const context = [`Project idea: ${profile.idea}`];
  if (profile.signals.length) context.push(`Signals: ${profile.signals.join(", ")}`);
  context.push(`Team: ${profile.team}`);
  return {
    question: question.research ?? question.text,
    options: question.options.map((o) => o.label),
    context: context.join("\n"),
  };
}

/**
 * Research one planning question. Never throws: on failure the question comes
 * back unchanged with result null and a (key-free) error message.
 */
export async function researchQuestion(
  provider: ResearchProvider,
  question: PlanningQuestion,
  profile: IdeaProfile,
  signal?: AbortSignal,
): Promise<ResearchedQuestion> {
  try {
    const result = await provider.research(buildQuery(question, profile), signal);
    const sources = dedupeSources([...(question.recommendation.sources ?? []), ...result.sources]);
    return {
      question: { ...question, recommendation: { ...question.recommendation, sources } },
      result,
    };
  } catch (err) {
    // Provider errors are already scrubbed; never include anything beyond the message.
    const error = err instanceof Error ? err.message : "Research failed";
    return { question, result: null, error };
  }
}
