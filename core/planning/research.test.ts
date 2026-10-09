import { describe, it, expect, vi } from "vitest";
import {
  createFirecrawlProvider,
  createMockProvider,
  createSonarProvider,
  parseOptionLines,
  researchQuestion,
  ResearchError,
  withFallback,
  type FetchInitLike,
  type FetchLike,
  type ResearchKeyProvider,
  type ResearchProvider,
  type SecretLike,
} from "./research";
import type { IdeaProfile, PlanningQuestion } from "./types";

const KEY = "sk-test-SECRET-1234";

function secret(value: string): SecretLike {
  return {
    reveal: () => value,
    scrub: (t: string) => t.split(value).join("[redacted]"),
  };
}
const keys = (value: string | null): ResearchKeyProvider => ({
  read: async () => (value === null ? null : secret(value)),
});

interface Captured {
  url: string;
  init: FetchInitLike;
}
function fakeFetch(status: number, body: unknown, calls: Captured[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
}
const fixedNow = () => new Date("2026-10-09T12:00:00Z");

const sonarBody = {
  choices: [
    {
      message: {
        content: [
          "SQLite suits a local-first app; Postgres suits shared data.",
          "OPTION: SQLite | Embedded file database | cost: free | fit: offline single user",
          "OPTION: Postgres | Hosted relational database | cost: $25/mo | fit: many users",
        ].join("\n"),
      },
    },
  ],
  citations: ["https://sqlite.org/whentouse.html", "https://www.postgresql.org/about/"],
  search_results: [{ title: "Appropriate Uses For SQLite", url: "https://sqlite.org/whentouse.html" }],
};

const question: PlanningQuestion = {
  id: "data.store",
  area: "data",
  text: "Where does the data live?",
  why: "Moving data later is expensive.",
  blocking: true,
  options: [
    { id: "sqlite", label: "SQLite", fit: "local first" },
    { id: "postgres", label: "Postgres", fit: "shared" },
  ],
  recommendation: { option: "sqlite", reason: "offline", confidence: 0.7 },
  research: "SQLite vs Postgres for a desktop planner",
};
const profile: IdeaProfile = { idea: "A desktop planner", signals: ["offline"], known: {}, team: "solo" };

describe("Sonar provider", () => {
  it("sends an OpenAI-style request with a Bearer key and parses the answer", async () => {
    const calls: Captured[] = [];
    const p = createSonarProvider({ keys: keys(KEY), fetch: fakeFetch(200, sonarBody, calls), now: fixedNow });
    const r = await p.research({ question: "Which database?", options: ["SQLite", "Postgres"], context: "planner" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.perplexity.ai/chat/completions");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.model).toBe("sonar");
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content).toContain("OPTION: <name> | <summary> | cost: <x> | fit: <y>");
    expect(sent.messages[1].role).toBe("user");
    expect(sent.messages[1].content).toContain("Which database?");
    expect(sent.messages[1].content).toContain("- Postgres");

    expect(r.provider).toBe("sonar");
    expect(r.at).toBe("2026-10-09T12:00:00.000Z");
    expect(r.answer).toBe("SQLite suits a local-first app; Postgres suits shared data.");
    expect(r.sources).toEqual([
      { title: "Appropriate Uses For SQLite", url: "https://sqlite.org/whentouse.html" },
      { title: "www.postgresql.org", url: "https://www.postgresql.org/about/" },
    ]);
    expect(r.compared.map((c) => [c.option, c.summary, c.cost, c.fit])).toEqual([
      ["SQLite", "Embedded file database", "free", "offline single user"],
      ["Postgres", "Hosted relational database", "$25/mo", "many users"],
    ]);
  });

  it("honours model and endpoint overrides", async () => {
    const calls: Captured[] = [];
    const p = createSonarProvider({
      keys: keys(KEY),
      fetch: fakeFetch(200, sonarBody, calls),
      model: "sonar-pro",
      endpoint: "https://example.test/chat",
    });
    await p.research({ question: "q" });
    expect(calls[0].url).toBe("https://example.test/chat");
    expect(JSON.parse(calls[0].init.body).model).toBe("sonar-pro");
  });

  it("parses loose OPTION lines", () => {
    expect(parseOptionLines("- **OPTION:** Supabase | hosted | fit: teams")).toEqual([
      { option: "Supabase", summary: "hosted", fit: "teams", sources: [] },
    ]);
  });

  it("rejects a response with no content as BAD_RESPONSE", async () => {
    const p = createSonarProvider({ keys: keys(KEY), fetch: fakeFetch(200, { choices: [] }) });
    await expect(p.research({ question: "q" })).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
});

describe("Firecrawl provider", () => {
  it("posts query and limit and maps results to sources and compared options", async () => {
    const calls: Captured[] = [];
    const body = {
      success: true,
      data: [
        { title: "SQLite in production", url: "https://a.test/1", description: "SQLite is fast for local apps. ", markdown: "# x" },
        { title: "Managed Postgres pricing", url: "https://b.test/2", description: "Postgres hosting from $25." },
        { title: "Unrelated", url: "https://c.test/3", description: "" },
      ],
    };
    const p = createFirecrawlProvider({ keys: keys(KEY), fetch: fakeFetch(200, body, calls), limit: 3, now: fixedNow });
    const r = await p.research({ question: "Which database?", options: ["SQLite", "Postgres"] });

    expect(calls[0].url).toBe("https://api.firecrawl.dev/v1/search");
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.limit).toBe(3);
    expect(sent.query).toContain("Which database?");

    expect(r.provider).toBe("firecrawl");
    expect(r.answer).toBe("SQLite is fast for local apps.\nPostgres hosting from $25.");
    expect(r.sources.map((s) => s.url)).toEqual(["https://a.test/1", "https://b.test/2", "https://c.test/3"]);
    expect(r.compared[0]).toMatchObject({ option: "SQLite", sources: [{ title: "SQLite in production", url: "https://a.test/1" }] });
    expect(r.compared[1].sources.map((s) => s.url)).toEqual(["https://b.test/2"]);
  });

  it("treats success:false as BAD_RESPONSE", async () => {
    const p = createFirecrawlProvider({ keys: keys(KEY), fetch: fakeFetch(200, { success: false }) });
    await expect(p.research({ question: "q" })).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
});

describe("keys and errors", () => {
  it("NO_KEY when the key provider returns null, and available() is false", async () => {
    const calls: Captured[] = [];
    for (const p of [
      createSonarProvider({ keys: keys(null), fetch: fakeFetch(200, sonarBody, calls) }),
      createFirecrawlProvider({ keys: keys(null), fetch: fakeFetch(200, {}, calls) }),
    ]) {
      expect(await p.available()).toBe(false);
      await expect(p.research({ question: "q" })).rejects.toMatchObject({ code: "NO_KEY" });
    }
    expect(calls).toHaveLength(0);
    expect(await createSonarProvider({ keys: keys(KEY), fetch: fakeFetch(200, {}) }).available()).toBe(true);
  });

  it("HTTP 500 -> ResearchError HTTP with status", async () => {
    const p = createSonarProvider({ keys: keys(KEY), fetch: fakeFetch(500, "x".repeat(1000)) });
    const err = await p.research({ question: "q" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchError);
    expect((err as ResearchError).code).toBe("HTTP");
    expect((err as ResearchError).status).toBe(500);
    expect((err as ResearchError).message).toContain("500");
    expect((err as ResearchError).message.length).toBeLessThan(260);
  });

  it("never leaks the key in errors, results or console output", async () => {
    const logs: string[] = [];
    const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(capture);

    const echo = `{"error":"invalid key ${KEY}","auth":"Bearer ${KEY}"}`;
    const failing = [
      createSonarProvider({ keys: keys(KEY), fetch: fakeFetch(401, echo) }),
      createFirecrawlProvider({ keys: keys(KEY), fetch: fakeFetch(403, echo) }),
      createSonarProvider({
        keys: keys(KEY),
        fetch: async () => {
          throw new Error(`socket closed for ${KEY}`);
        },
      }),
    ];
    for (const p of failing) {
      const err = (await p.research({ question: "q" }).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(ResearchError);
      expect(err.message).not.toContain(KEY);
      expect(String(err.stack)).not.toContain(KEY);
      const rq = await researchQuestion(p, question, profile);
      expect(rq.result).toBeNull();
      expect(JSON.stringify(rq)).not.toContain(KEY);
    }

    // Server echoes the key inside a successful answer too.
    const echoing = createSonarProvider({
      keys: keys(KEY),
      fetch: fakeFetch(200, { choices: [{ message: { content: `your key is ${KEY}\nOPTION: A | ${KEY} | cost: x | fit: y` } }] }),
    });
    const r = await echoing.research({ question: "q", options: ["A"] });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("times out with TIMEOUT using the abort signal", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const p = createSonarProvider({ keys: keys(KEY), fetch: hang, timeoutMs: 20 });
    await expect(p.research({ question: "q" })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("passes a caller abort through to fetch", async () => {
    let seen: AbortSignal | null = null;
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        seen = init.signal;
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const ctl = new AbortController();
    const p = createSonarProvider({ keys: keys(KEY), fetch: hang, timeoutMs: 10000 });
    const pending = p.research({ question: "q" }, ctl.signal);
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    await expect(pending).rejects.toBeInstanceOf(ResearchError);
    expect(seen!.aborted).toBe(true);
    await expect(p.research({ question: "q" }, ctl.signal)).rejects.toBeInstanceOf(ResearchError);
  });
});

describe("withFallback", () => {
  it("skips unavailable and failing providers", async () => {
    const tried: string[] = [];
    const unavailable: ResearchProvider = {
      name: "off",
      available: async () => false,
      research: async () => {
        tried.push("off");
        throw new Error("should not run");
      },
    };
    const failing: ResearchProvider = {
      name: "bad",
      available: async () => true,
      research: async () => {
        tried.push("bad");
        throw new ResearchError("HTTP", "HTTP 500", 500);
      },
    };
    const good = createMockProvider({ q: { answer: "from mock" } });
    const p = withFallback(unavailable, failing, good);
    expect(await p.available()).toBe(true);
    const r = await p.research({ question: "q" });
    expect(r.answer).toBe("from mock");
    expect(tried).toEqual(["bad"]);
  });

  it("throws the last error when all fail, NO_KEY when none available", async () => {
    const none = withFallback(createSonarProvider({ keys: keys(null), fetch: fakeFetch(200, {}) }));
    expect(await none.available()).toBe(false);
    await expect(none.research({ question: "q" })).rejects.toMatchObject({ code: "NO_KEY" });
    const all = withFallback(createSonarProvider({ keys: keys(KEY), fetch: fakeFetch(500, "") }));
    await expect(all.research({ question: "q" })).rejects.toMatchObject({ code: "HTTP" });
  });
});

describe("researchQuestion", () => {
  it("builds the query and attaches sources to the recommendation", async () => {
    const mock = createMockProvider(() => ({ sources: [{ title: "S", url: "https://s.test" }] }));
    const out = await researchQuestion(mock, question, profile);
    expect(mock.calls[0].question).toBe("SQLite vs Postgres for a desktop planner");
    expect(mock.calls[0].options).toEqual(["SQLite", "Postgres"]);
    expect(mock.calls[0].context).toContain("A desktop planner");
    expect(out.result).not.toBeNull();
    expect(out.question.recommendation.sources).toEqual([{ title: "S", url: "https://s.test" }]);
    expect(question.recommendation.sources).toBeUndefined();
  });

  it("falls back to question.text when there is no research query", async () => {
    const mock = createMockProvider();
    await researchQuestion(mock, { ...question, research: undefined }, profile);
    expect(mock.calls[0].question).toBe("Where does the data live?");
  });

  it("survives provider errors and returns the question unchanged", async () => {
    const p = createSonarProvider({ keys: keys(null), fetch: fakeFetch(200, {}) });
    const out = await researchQuestion(p, question, profile);
    expect(out.result).toBeNull();
    expect(out.question).toBe(question);
    expect(out.error).toMatch(/key/i);
  });
});

describe("mock provider", () => {
  it("is deterministic and records calls", async () => {
    const mock = createMockProvider({ "Which DB?": { answer: "SQLite", sources: [{ title: "t", url: "u" }] } });
    const a = await mock.research({ question: "Which DB?", options: ["SQLite"] });
    const b = await mock.research({ question: "Which DB?", options: ["SQLite"] });
    expect(a).toEqual(b);
    expect(a.answer).toBe("SQLite");
    expect(a.compared).toEqual([{ option: "SQLite", summary: "", sources: [] }]);
    const other = await mock.research({ question: "Other" });
    expect(other.answer).toContain("Other");
    expect(mock.calls.map((c) => c.question)).toEqual(["Which DB?", "Which DB?", "Other"]);
    expect(await mock.available()).toBe(true);
  });
});
