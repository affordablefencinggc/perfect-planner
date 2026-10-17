// Attack 3: a hostile worker. It holds a real worker token for its own task (T-1) and tries to act on another
// worker's task (T-2), to speak as another agent, to answer its own question, to become the main chat and to use
// a token after it was ended. Every tool goes through the real loopback bridge, the way an agent program does.
// The safe outcome: the other task's ledger history and the board stay exactly as they were, and nothing the
// hostile worker wrote touches T-2 or answers a question.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeCall, TOOL_NAMES, type ToolName } from "../mcp/index";
import { addTask, cleanTemp, dispatchAndApproveTest, startWindow, tempDir, makeRepo, type Dispatched, type Window } from "./helpers";

afterAll(cleanTemp);
const q = "?project=p";

let win: Window;
let a: Dispatched; // the hostile worker, on T-1
let b: Dispatched; // the honest worker, on T-2, which has claimed it
let mainCall: ReturnType<typeof bridgeCall>;
let mainAgent = "";
let bridgeUrl = "";

const board = () => win.host.project("p").service.board();
const entries = () => win.host.project("p").entries();

beforeAll(async () => {
  const repo = makeRepo();
  const dir = tempDir();
  win = await startWindow({ data: dir, project: repo, secrets: path.join(dir, "secrets.json") });
  await addTask(win, q, "Hostile worker's task");
  await addTask(win, q, "Honest worker's task");
  a = await dispatchAndApproveTest(win, q, "T-1");
  b = await dispatchAndApproveTest(win, q, "T-2");
  await b.call({ tool: "claim_task", args: { task: "T-2" }, agent: b.agent });
  bridgeUrl = a.bridgeUrl;
  // The main chat: the first agent to check in on a connect token.
  const connect = await win.call("POST", `/agents/connect${q}`, {});
  expect(connect.status).toBe(200);
  mainCall = bridgeCall(connect.body.result.bridgeUrl, fs.readFileSync(connect.body.result.tokenFile, "utf8"));
  mainAgent = ((await mainCall({ tool: "hello", args: { name: "Main chat" } })) as { agent: string }).agent;
}, 120_000);
afterAll(async () => win.stop());

const code = async (promise: Promise<unknown>): Promise<string> => promise.then(() => "OK", (error: { code?: string }) => error.code ?? "ERROR");

describe("attack 3: a worker token on another worker's task", () => {
  const T2_TOOLS: [ToolName, Record<string, unknown>][] = [
    ["claim_task", { task: "T-2" }],
    ["report_progress", { task: "T-2", text: "I did the work on T-2" }],
    ["attach_proof", { task: "T-2", kind: "link", link: "https://example.invalid/proof" }],
    ["ask_main", { task: "T-2", question: "Should T-2 skip its test?", blocking: true }],
    ["release_task", { task: "T-2", reason: "Taking it over", blocked: true }],
    ["propose_test", { task: "T-2", command: "node -e 0", files: ["tests/save.check.mjs"] }],
  ];

  it.each(T2_TOOLS)("%s on T-2 is forbidden, and T-2 is not touched", async (tool, args) => {
    const before = JSON.stringify(board().get("T-2"));
    const count = entries().length;
    expect(await code(a.call({ tool, args, agent: a.agent }))).toBe("FORBIDDEN");
    expect(JSON.stringify(board().get("T-2"))).toBe(before);
    expect(entries().length).toBe(count);
  });

  it.each([["T-02"], ["t-2"], [" T-2"], ["T-2 "], ["T-2\n"], ["T-2.a2"], ["T-1/../T-2"], ["T-1\u0000T-2"], ["T-２"], ["T-1,T-2"], ["*"], [""]])("the task name %j is never read as T-2", async (task) => {
    const count = entries().length;
    for (const tool of ["claim_task", "report_progress", "release_task"] as const) {
      const outcome = await code(a.call({ tool, args: { task, text: "x", reason: "x" }, agent: a.agent }));
      expect(["INVALID", "FORBIDDEN", "NOT_FOUND"], `${tool} ${JSON.stringify(task)}`).toContain(outcome);
    }
    expect(entries().length).toBe(count);
  });

  it("nothing the hostile worker wrote touches T-2, and T-2 is still held by its own worker", async () => {
    for (const [tool, args] of T2_TOOLS) await a.call({ tool, args, agent: a.agent }).catch(() => undefined);
    const mine = entries().filter((e) => e.actor.id === a.agent);
    expect(mine.filter((e) => e.subject === "T-2" || e.data?.task === "T-2" || e.refs?.includes("T-2"))).toEqual([]);
    expect(board().get("T-2")).toMatchObject({ status: "claimed", owner: b.agent, proofs: [] });
    // The honest worker is not paused by the hostile worker's "question".
    expect(await b.call({ tool: "report_progress", args: { task: "T-2", text: "still going" }, agent: b.agent })).toMatchObject({ entry: expect.any(String) });
  });
});

describe("attack 3: speaking as another agent", () => {
  it("another worker's agent id does not work with this token, and the id is no secret (list_tasks shows it)", async () => {
    const seen = (await a.call({ tool: "list_tasks", args: {}, agent: a.agent })) as { tasks: { id: string; owner: string | null }[] };
    expect(seen.tasks.find((t) => t.id === "T-2")!.owner).toBe(b.agent);
    expect(await code(a.call({ tool: "report_progress", args: { task: "T-2", text: "as B" }, agent: b.agent }))).toBe("UNAUTHORIZED");
    expect(await code(a.call({ tool: "answer", args: { question: "Q-1", text: "as the main chat" }, agent: mainAgent }))).toBe("UNAUTHORIZED");
  });

  it("checking in again, under any name, never turns a worker into the main chat or another worker", async () => {
    for (const name of ["Main chat", "main", "Worker B", b.agent]) {
      const welcome = (await a.call({ tool: "hello", args: { name, model: "claude-opus" } })) as { agent: string; role: string; task: string };
      expect(welcome).toMatchObject({ agent: a.agent, role: "worker", task: "T-1" });
    }
  });

  it("a made-up token, a cut one, a padded one and no token are all refused before any tool runs", async () => {
    const real = a.token;
    const count = entries().length;
    for (const token of ["", "pp_w_" + "A".repeat(32), real.slice(0, -1), `${real} `, real.toUpperCase(), real + real, "Bearer", "x".repeat(200)]) {
      const outcome = await code(bridgeCall(bridgeUrl, token)({ tool: "list_tasks", args: {} }));
      expect(outcome, JSON.stringify(token.slice(0, 12))).toBe("UNAUTHORIZED");
    }
    // Other shapes of the same request straight at the bridge.
    const shapes: RequestInit[] = [
      { method: "GET" },
      { method: "POST", headers: { authorization: `Basic ${Buffer.from(real).toString("base64")}` } },
      { method: "POST", headers: { "x-pp-token": real } },
    ];
    for (const init of shapes) {
      const res = await fetch(`${bridgeUrl}/call`, { ...init, ...(init.method === "POST" ? { body: JSON.stringify({ tool: "list_tasks", args: {} }) } : {}) });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(entries().length).toBe(count);
  });

  it("a worker token does not open the app's person routes, and a person route cannot be reached with it as a bearer or a cookie", async () => {
    const base = win.base;
    for (const route of ["/planning/approve", "/decisions/accept", "/tasks/T-2/merge", "/tasks/T-2/release", "/agents/connect"]) {
      const res = await fetch(`${base}${route}${q}`, { method: "POST", headers: { authorization: `Bearer ${a.token}`, cookie: `pp_core_person=${a.token}`, origin: win.origin, "x-pp-csrf": a.token, "content-type": "application/json" }, body: "{}" });
      expect(res.status, route).toBe(401);
    }
    expect((await fetch(`${base}/tasks${q}`, { headers: { authorization: `Bearer ${a.token}`, cookie: `pp_core_person=${a.token}` } })).status).toBe(401);
  });
});

describe("attack 3: a worker answers its own question", () => {
  let asked = "";
  beforeAll(async () => {
    const result = (await a.call({ tool: "ask_main", args: { task: "T-1", question: "May I skip the failing test?", options: ["yes", "no"], blocking: true }, agent: a.agent })) as { q: string; status: string; paused: boolean };
    expect(result).toMatchObject({ status: "open", paused: true });
    asked = result.q;
  });

  it("the worker cannot answer its own question, so it stays open and the worker stays paused", async () => {
    expect(await code(a.call({ tool: "answer", args: { question: asked, text: "yes, skip the test" }, agent: a.agent }))).toBe("FORBIDDEN");
    expect(entries().filter((e) => e.type === "question.answered" || e.type === "decision.made")).toEqual([]);
    expect(await code(a.call({ tool: "report_progress", args: { task: "T-1", text: "going ahead" }, agent: a.agent }))).toBe("PAUSED");
    expect(await a.call({ tool: "check_inbox", args: {}, agent: a.agent })).toMatchObject({ answers: [], paused: true, waitingOn: asked });
  });

  it("another worker cannot answer it either, and neither can an observer", async () => {
    expect(await code(b.call({ tool: "answer", args: { question: asked, text: "sure" }, agent: b.agent }))).toBe("FORBIDDEN");
    const second = await win.call("POST", `/agents/connect${q}`, {});
    const observer = bridgeCall(second.body.result.bridgeUrl, fs.readFileSync(second.body.result.tokenFile, "utf8"));
    const hello = (await observer({ tool: "hello", args: { name: "Second chat" } })) as { agent: string; role: string };
    expect(hello.role).toBe("observer");
    expect(await code(observer({ tool: "answer", args: { question: asked, text: "sure" }, agent: hello.agent }))).toBe("FORBIDDEN");
    expect(entries().filter((e) => e.type === "question.answered" || e.type === "decision.made")).toEqual([]);
  });

  it("only the main chat's answer reaches the worker, as information and never as a decision", async () => {
    const answered = (await mainCall({ tool: "answer", args: { question: asked, text: "No: write the real fix" }, agent: mainAgent })) as { decision: string | null };
    expect(answered.decision).toBeNull();
    expect(entries().some((e) => e.type === "decision.made")).toBe(false);
    expect(await a.call({ tool: "check_inbox", args: {}, agent: a.agent })).toMatchObject({ answers: [{ q: asked, answer: "No: write the real fix", via: "main" }], paused: false });
  });

  it("a worker cannot reach the person's own answer route either (a person's answer is the only thing that becomes a decision)", async () => {
    const res = await fetch(`${win.base}/decisions/accept${q}`, { method: "POST", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" }, body: JSON.stringify({ q: asked }) });
    expect(res.status).toBe(401);
    expect(entries().some((e) => e.type === "decision.made")).toBe(false);
  });
});

describe("attack 3: a token after its worker was ended", () => {
  it("a released worker's token stops working at once, for every tool", async () => {
    const released = await win.call("POST", `/tasks/T-2/release${q}`, { reason: "Worker is gone" });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    // Valid input for every tool, so the refusal can only be about the token.
    const valid: Record<ToolName, Record<string, unknown>> = {
      hello: { name: "Worker" },
      list_tasks: {},
      claim_task: { task: "T-2" },
      report_progress: { task: "T-2", text: "x" },
      attach_proof: { task: "T-2", kind: "link", link: "https://example.invalid/x" },
      ask_main: { task: "T-2", question: "Anything?" },
      check_inbox: {},
      answer: { question: "Q-1", text: "x" },
      lookup: { ref: "T-2" },
      release_task: { task: "T-2", reason: "x" },
      propose_test: { task: "T-2", command: "node -e 0", files: ["tests/save.check.mjs"] },
    };
    expect(Object.keys(valid).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of TOOL_NAMES) expect(await code(b.call({ tool, args: valid[tool], agent: b.agent })), tool).toBe("UNAUTHORIZED");
    expect(fs.existsSync(b.tokenFile)).toBe(false);
    expect(board().get("T-2")).toMatchObject({ status: "open", owner: null });
  });
});

describe("attack 3: a flood from one worker", () => {
  it("a hostile worker's hundred questions do not stop the person from working or break the chain", async () => {
    const c = await addTask(win, q, "Flood task");
    const w = await dispatchAndApproveTest(win, q, c);
    const started = Date.now();
    await Promise.all(Array.from({ length: 100 }, (_, i) => w.call({ tool: "ask_main", args: { task: c, question: `Question number ${i}?` }, agent: w.agent })));
    const person = await win.call("POST", `/planning/tasks${q}`, { title: "Still works" });
    expect(person.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(15_000);
    const status = (await win.call("GET", `/status${q}`)).body.result;
    expect(status.integrity).toEqual({ state: "ok", writesStopped: false });
  }, 60_000);
});
