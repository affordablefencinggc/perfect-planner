// Every route of the local service, hit with garbage: wrong types, missing bodies, huge and strange strings,
// prototype keys, odd task ids. The route list is read from the source, so a new route is covered the day it
// is written. Rule for every call: a JSON answer inside a few seconds, never a 5xx; afterwards the service
// still answers, the ledger chain verifies and nothing leaked onto Object.prototype.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "../ledger/index";
import { hostCall, startTestHost } from "../host/testing";
// These suites test the host's own logic (concurrency, routes, bridge), which does not change with the OS, and
// Linux CI runs them in full. Windows core CI is already close to its 15-minute limit, so there they are skipped
// unless PP_ATTACK_ALL=1 (set it to run them on a Windows machine).
const runHere = process.platform !== "win32" || process.env.PP_ATTACK_ALL === "1";

const HOST_DIR = path.resolve(__dirname, "../host");
const KEY = "fuzz";

function sourceRoutes(): { method: "GET" | "POST"; route: string }[] {
  const files = [path.join(HOST_DIR, "host.ts"), ...fs.readdirSync(path.join(HOST_DIR, "routes")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => path.join(HOST_DIR, "routes", f))];
  const found = new Map<string, { method: "GET" | "POST"; route: string }>();
  for (const file of files) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/\brouter\.(get|post)\(\s*"(\/[^"]*)"/g)) {
      const method = m[1]!.toUpperCase() as "GET" | "POST";
      found.set(`${method} ${m[2]}`, { method, route: m[2]! });
    }
  }
  return [...found.values()];
}

const STRANGE = [
  "",
  " ",
  "x".repeat(70_000),
  "\u0000nul\u0000",
  "../../../../etc/passwd",
  "..\\..\\..\\windows\\system32",
  "<script>alert(1)</script>",
  "‮evil‬",
  "💥".repeat(500),
  "'; DROP TABLE tasks; --",
  "${process.exit(1)}",
  "T-99999999999999999999",
  "__proto__",
];
const FIELDS = ["root", "id", "task", "title", "text", "name", "test", "commit", "model", "role", "person", "reason", "question", "answer", "idea", "kind", "type", "ref", "q", "path", "folder", "command", "files", "claims", "options", "email", "photo", "template", "choice", "key", "label", "note", "summary", "decision", "version", "from", "to", "n", "limit", "offset"];

function payloads(): unknown[] {
  const out: unknown[] = [undefined, null, [], "text", 0, -1, 1e308, true, {}, [[[[[[[[[[1]]]]]]]]]], JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}')];
  for (const value of [...STRANGE, null, 0, -5, 2 ** 53, 1.5, true, [], {}, [STRANGE[5]], { nested: { deep: STRANGE[4] } }]) {
    out.push(Object.fromEntries(FIELDS.map((f) => [f, value])));
  }
  for (const f of FIELDS) out.push({ [f]: "x".repeat(300_000) });
  return out;
}

const WEIRD_IDS = ["T-1", "T-0", "T-99999999999999999999", "..%2F..%2Fetc", "%00", "x".repeat(2000), "%E2%80%AE", "__proto__", "constructor", "T-1.a2", "Q-1", "D-1"];

let ctx: Awaited<ReturnType<typeof startTestHost>>;
const routes = sourceRoutes();
const problems: string[] = [];
const tally = new Map<string, number>();

beforeAll(async () => {
  if (!runHere) return;
  ctx = await startTestHost();
  // Give the project some real content so routes that read it have something to answer with.
  await hostCall(ctx.base, "POST", `/planning/start?project=${KEY}`, { idea: "A small invoice tool" });
}, 60_000);

afterAll(async () => {
  if (!runHere) return;
  console.log(`abilities: ${routes.length} routes, answers: ${[...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (problems.length) console.log(`abilities: ${problems.length} problems\n${problems.slice(0, 60).join("\n")}`);
  await ctx.stop();
});

async function hit(method: "GET" | "POST", route: string, body?: unknown, rawQuery = "") {
  const url = `${route}${route.includes("?") ? "&" : "?"}project=${KEY}${rawQuery}`;
  const started = Date.now();
  let status = 0;
  let json: any;
  try {
    const res = await Promise.race([
      hostCall(ctx.base, method, url, body),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in 15 s")), 15_000)),
    ]);
    status = res.status;
    json = res.body;
  } catch (error) {
    const message = String((error as Error).message);
    problems.push(`${method} ${route} ${JSON.stringify(body)?.slice(0, 80)} -> ${message}`);
    return;
  }
  const ms = Date.now() - started;
  const tag = `${status}${json?.code ? " " + json.code : ""}`;
  tally.set(tag, (tally.get(tag) ?? 0) + 1);
  const bad = status >= 500 || typeof json?.ok !== "boolean" || ms > 8_000;
  if (bad) problems.push(`${method} ${route} ${JSON.stringify(body)?.slice(0, 80)} -> ${status} ${json?.code} ${String(json?.message ?? "").slice(0, 100)} (${ms} ms)`);
}

describe.skipIf(!runHere)("every route survives garbage", () => {
  it("the route list was found in the source", () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it("POST routes: strange bodies", async () => {
    const bodies = payloads();
    for (const r of routes.filter((x) => x.method === "POST" && !/session\/claim|owner\/start|keys\/rotate|people\/claim|agents\/revoke/.test(x.route) && !x.route.includes(":"))) {
      for (const body of bodies) await hit("POST", r.route, body);
    }
  }, 600_000);

  it("routes that name a task or person in the path: strange ids", async () => {
    const bodies = [{}, null, { text: "x", reason: "x", commit: "abc", test: "abc", person: "x", role: "x" }, Object.fromEntries(FIELDS.map((f) => [f, STRANGE[4]]))];
    for (const r of routes.filter((x) => x.route.includes(":"))) {
      for (const id of WEIRD_IDS) {
        const route = r.route.replace(/:[a-zA-Z]+/g, id);
        if (r.method === "GET") await hit("GET", route);
        else for (const body of bodies) await hit("POST", route, body);
      }
    }
  }, 600_000);

  it("GET routes: strange queries", async () => {
    for (const r of routes.filter((x) => x.method === "GET" && !x.route.includes(":"))) {
      await hit("GET", r.route);
      for (const value of STRANGE) {
        for (const name of ["ref", "q", "limit", "offset", "root", "task", "id", "kind", "since"]) await hit("GET", r.route, undefined, `&${name}=${encodeURIComponent(value.slice(0, 5000))}`);
      }
    }
  }, 600_000);

  it("an oversize body gets a plain 413, and the service keeps answering", async () => {
    const big = await hostCall(ctx.base, "POST", `/planning/start?project=${KEY}`, { idea: "x".repeat(900_000) });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe("TOO_LARGE");
    expect((await hostCall(ctx.base, "GET", `/summary?project=${KEY}`)).status).toBe(200);
  }, 60_000);

  it("wrong method, unknown routes and mangled paths are refused cleanly", async () => {
    for (const p of ["/nope", "/tasks/../../x", "/%00", "/tasks//dispatch", "/" + "a".repeat(5000), "/tasks/%zz/dispatch"]) {
      for (const method of ["GET", "POST"] as const) {
        const res = await fetch(`${ctx.base}${p}?project=${KEY}`, { method }).catch(() => undefined);
        if (res && res.status >= 500) problems.push(`${method} ${p} -> ${res.status}`);
      }
    }
    const put = await fetch(`${ctx.base}/tasks`, { method: "PUT" }).catch(() => undefined);
    if (put && put.status >= 500) problems.push(`PUT /tasks -> ${put.status}`);
  }, 120_000);

  it("after all of that: no 5xx or hang was seen, the service answers, the chain verifies, nothing leaked onto Object.prototype", async () => {
    expect(problems).toEqual([]);
    expect(({} as any).polluted).toBeUndefined();
    expect((Object.prototype as any).polluted).toBeUndefined();
    const summary = await hostCall(ctx.base, "GET", `/summary?project=${KEY}`);
    expect(summary.status).toBe(200);
    const entries = ctx.host.project(KEY).entries();
    expect(verifyChain(entries as any).ok ?? true).toBe(true);
  });
});
