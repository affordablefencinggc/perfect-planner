import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Ledger, MemoryStore, type Actor } from "../ledger/index";
import { Relay } from "../relay/index";
import { installNumberingRules } from "../numbering/index";
import { installClauseRules } from "../lookup/index";
import { AgentService, ToolError, bridgeCall, createAgentMcpServer, directCall, startBridge, TokenStore } from "./index";

const owner: Actor = { kind: "person", id: "owner" };

function setup(options: { approveTests?: boolean } = {}) {
  const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T05:00:00Z") });
  // The sibling modules' rules are on, so every entry the relay and tools write must satisfy them.
  installNumberingRules(ledger);
  installClauseRules(ledger);
  for (const [id, title, clause] of [["T-1", "Invoice id survives reload", "P-1 §2.1"], ["T-2", "Recover accepted email", "P-1 §2.2"]] as const) {
    ledger.append({ actor: owner, type: "task.created", subject: id, summary: title, refs: [clause], data: { title } });
    if (options.approveTests !== false) {
      ledger.append({ actor: owner, type: "test.defined", subject: id, summary: `Test for ${id}`, data: { test: `npm test -- ${id}` } });
      ledger.append({ actor: owner, type: "test.approved", subject: id, summary: `Approved test for ${id}`, data: { test: `npm test -- ${id}` } });
    }
  }
  const tokens = new TokenStore();
  const service = new AgentService({ ledger, tokens });
  const connect = tokens.issue({ role: "connect", person: "owner" });
  const w1 = tokens.issue({ role: "worker", person: "owner", task: "T-1" });
  const w2 = tokens.issue({ role: "worker", person: "owner", task: "T-2" });
  return { ledger, tokens, service, connect, w1, w2 };
}

async function hello(service: AgentService, token: string, name: string, model = "model-x") {
  const res = (await service.call({ token }, "hello", { name, model })) as { agent: string; role: string };
  return { token, agent: res.agent, role: res.role };
}

async function expectCode(promise: Promise<unknown>, code: string, text?: RegExp) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe(code);
  if (text) expect((error as Error).message).toMatch(text);
}

describe("check-in and roles", () => {
  it("makes the first connected agent the main chat and later ones observers", async () => {
    const { service, connect, tokens } = setup();
    expect((await hello(service, connect, "Claude Code")).role).toBe("main");
    expect((await hello(service, connect, "Codex")).role).toBe("observer");
    const helper = tokens.issue({ role: "connect", person: "helper-1" });
    expect((await hello(service, helper, "Helper's agent")).role).toBe("main");
  });

  it("gives a worker token the worker role for its one task, and reconnecting keeps the agent", async () => {
    const { service, w1 } = setup();
    const first = await hello(service, w1, "Worker one");
    expect(first.role).toBe("worker");
    expect((await hello(service, w1, "Worker one")).agent).toBe(first.agent);
  });

  it("refuses bad tokens, missing hello and invalid input", async () => {
    const { service, w1 } = setup();
    await expectCode(service.call({ token: "pp_w_not-a-real-token-at-all" }, "hello", { name: "x" }), "UNAUTHORIZED");
    await expectCode(service.call({ token: w1, agent: "nobody" }, "list_tasks", {}), "UNAUTHORIZED", /hello/);
    const a = await hello(service, w1, "w");
    await expectCode(service.call(a, "claim_task", { task: "14" }), "INVALID", /T-14/);
    await expectCode(service.call(a, "no_such_tool", {}), "NOT_FOUND");
  });

  it("stops an agent from using another agent's id with its own token", async () => {
    const { service, w1, w2 } = setup();
    const a = await hello(service, w1, "w1");
    await expectCode(service.call({ token: w2, agent: a.agent }, "list_tasks", {}), "UNAUTHORIZED");
  });
});

describe("worker tools", () => {
  it("claims, reports and attaches proof, each as a ledger entry naming the agent and model", async () => {
    const { service, ledger, w1 } = setup();
    const a = await hello(service, w1, "Worker one", "claude-x");
    const claimed = (await service.call(a, "claim_task", { task: "T-1" })) as { status: string; entry: string };
    expect(claimed.status).toBe("claimed");
    await service.call(a, "report_progress", { task: "T-1", text: "Wrote the reload test" });
    await service.call(a, "attach_proof", { task: "T-1", kind: "commit", link: "9f3c2e1" });
    const mine = ledger.bySubject("T-1").filter((e) => e.actor.id === a.agent);
    expect(mine.map((e) => e.type)).toEqual(["task.claimed", "task.progress", "task.proof"]);
    expect(mine[0]!.actor).toEqual({ kind: "agent", id: a.agent, model: "claude-x" });
    expect(mine[2]!.evidence).toEqual(["commit:9f3c2e1"]);
    const board = (await service.call(a, "list_tasks", {})) as { tasks: { id: string; status: string; owner: string | null; proofs: unknown[] }[] };
    expect(board.tasks.find((t) => t.id === "T-1")).toMatchObject({ status: "claimed", owner: a.agent });
  });

  it("keeps a worker to its own task and keeps the main chat out of worker tools", async () => {
    const { service, connect, w1 } = setup();
    const a = await hello(service, w1, "w1");
    const main = await hello(service, connect, "main");
    await expectCode(service.call(a, "claim_task", { task: "T-2" }), "FORBIDDEN", /T-1 only/);
    await expectCode(service.call(main, "claim_task", { task: "T-1" }), "FORBIDDEN");
    await expectCode(service.call(a, "answer", { question: "Q-1", text: "x" }), "FORBIDDEN");
    await expectCode(service.call(a, "report_progress", { task: "T-1", text: "before claiming" }), "CONFLICT", /Claim T-1 first/);
  });

  it("refuses proof that looks like a secret", async () => {
    const { service, w1 } = setup();
    const a = await hello(service, w1, "w1");
    await service.call(a, "claim_task", { task: "T-1" });
    await expectCode(service.call(a, "attach_proof", { task: "T-1", kind: "link", link: "https://x.test/?api_key=abcdef1234567890" }), "INVALID", /secret/);
  });

  it("passes the ledger's gate rules back to the agent", async () => {
    const { service, ledger, w1 } = setup({ approveTests: false });
    ledger.addRule((draft, l) =>
      draft.type === "task.claimed" && !l.bySubject(draft.subject).some((e) => e.type === "test.approved") ? `${draft.subject} has no approved test yet` : null,
    );
    const a = await hello(service, w1, "w1");
    await expectCode(service.call(a, "claim_task", { task: "T-1" }), "REFUSED", /no approved test yet/);
  });

  it("releases a task back to the board and revokes the worker's token", async () => {
    const { service, w1 } = setup();
    const a = await hello(service, w1, "w1");
    await service.call(a, "claim_task", { task: "T-1" });
    expect(await service.call(a, "release_task", { task: "T-1", reason: "Needs a schema change first", blocked: true })).toMatchObject({ status: "blocked" });
    await expectCode(service.call(a, "list_tasks", {}), "UNAUTHORIZED");
    expect(service.board().get("T-1")).toMatchObject({ status: "blocked", owner: null });
  });
});

describe("the one-chat relay through the tools", () => {
  it("routes a worker's question to the main chat and the answer back to that worker", async () => {
    const { service, ledger, connect, w1, w2 } = setup();
    const main = await hello(service, connect, "main");
    const a = await hello(service, w1, "w1");
    const b = await hello(service, w2, "w2");
    const asked = (await service.call(a, "ask_main", { task: "T-1", question: "Use ISO dates in the invoice id?", options: ["ISO", "Locale"] })) as { q: string; status: string };
    expect(asked).toMatchObject({ q: "Q-1", status: "open" });

    const digest = (await service.call(main, "check_inbox", {})) as { open: number; lines: string[] };
    expect(digest.open).toBe(1);
    expect(digest.lines[0]).toContain("Q-1 (T-1) Use ISO dates");

    const answered = (await service.call(main, "answer", { question: "Q-1", text: "ISO" })) as { decision: string; worker: string };
    expect(answered).toMatchObject({ decision: "D-1", worker: a.agent });
    expect(await service.call(b, "check_inbox", {})).toMatchObject({ answers: [] });
    expect(await service.call(a, "check_inbox", {})).toMatchObject({ answers: [{ q: "Q-1", answer: "ISO", decision: "D-1" }], paused: false });
    expect(await service.call(a, "check_inbox", {})).toMatchObject({ answers: [] });

    // The same question from another worker is answered from D-1 at once.
    const again = await service.call(b, "ask_main", { task: "T-2", question: "use iso dates in the invoice ID", options: ["Locale", "ISO"] });
    expect(again).toMatchObject({ q: "Q-2", status: "answered", answer: "ISO", decision: "D-1", via: "decision" });
    expect(ledger.entries().filter((e) => e.type === "decision.made")).toHaveLength(1);
    expect((await service.call(main, "check_inbox", {})) as { autoAnswered: string[] }).toMatchObject({ open: 0, autoAnswered: [expect.stringContaining("Q-2 (T-2) answered from D-1")] });
  });

  it("pauses only the worker with a blocking question, and wait_seconds returns the answer in the same call", async () => {
    const { service, connect, w1, w2 } = setup();
    const main = await hello(service, connect, "main");
    const a = await hello(service, w1, "w1");
    const b = await hello(service, w2, "w2");
    await service.call(a, "claim_task", { task: "T-1" });
    await service.call(b, "claim_task", { task: "T-2" });

    const waiting = service.call(a, "ask_main", { task: "T-1", question: "Which PDF library?", blocking: true, wait_seconds: 5 });
    await new Promise((r) => setTimeout(r, 10));
    await expectCode(service.call(a, "report_progress", { task: "T-1", text: "still going" }), "PAUSED", /Q-1/);
    await service.call(b, "report_progress", { task: "T-2", text: "unaffected" });
    await service.call(main, "answer", { question: "Q-1", text: "pdf-lib" });
    expect(await waiting).toMatchObject({ q: "Q-1", status: "answered", answer: "pdf-lib" });
    await service.call(a, "report_progress", { task: "T-1", text: "unpaused" });
  });

  it("returns at once with paused when a blocking question has no wait", async () => {
    const { service, w1 } = setup();
    const a = await hello(service, w1, "w1");
    expect(await service.call(a, "ask_main", { task: "T-1", question: "Blocking?", blocking: true })).toMatchObject({ status: "open", paused: true });
    expect(await service.call(a, "check_inbox", {})).toMatchObject({ paused: true, waitingOn: "Q-1" });
  });

  it("pause all stops every worker with one entry per active task, and resume restores them", async () => {
    const { service, ledger, w1, w2 } = setup();
    const a = await hello(service, w1, "w1");
    const b = await hello(service, w2, "w2");
    await service.call(a, "claim_task", { task: "T-1" });
    await service.call(b, "claim_task", { task: "T-2" });
    service.pauseAll(owner, "Lunch");
    expect(ledger.entries().filter((e) => e.data?.pauseAll === true).map((e) => e.subject)).toEqual(["T-1", "T-2"]);
    await expectCode(service.call(b, "report_progress", { task: "T-2", text: "x" }), "PAUSED", /Lunch/);
    service.resumeAll(owner);
    expect(service.board().get("T-1")?.status).toBe("claimed");
    await service.call(b, "report_progress", { task: "T-2", text: "back" });
  });
});

describe("lookup", () => {
  it("returns a clause, the tasks that cite it and their commits, and questions with their decision", async () => {
    const { service, ledger, connect, w1 } = setup();
    ledger.append({ actor: owner, type: "clause.added", subject: "§1", summary: "Scope", data: { clause: "1", kind: "heading", text: "Scope" } });
    ledger.append({ actor: owner, type: "clause.added", subject: "§2", summary: "Invoice sending", data: { clause: "2", kind: "heading", text: "Invoice sending" } });
    ledger.append({ actor: owner, type: "clause.added", subject: "§2.1", summary: "Invoice id survives reload", data: { clause: "2.1", kind: "paragraph", text: "A new invoice keeps its id after a reload." } });
    ledger.append({ actor: owner, type: "plan.approved", subject: "P-1", summary: "Invoice plan approved" });
    ledger.append({ actor: { kind: "system", id: "watcher" }, type: "commit.observed", subject: "T-1", summary: "Commit 9f3c2e1", refs: ["P-1 §2.1"], data: { sha: "9f3c2e1" } });
    const main = await hello(service, connect, "main");
    const found = (await service.call(main, "lookup", { ref: "P-1 §2.1" })) as { found: boolean; text: string; tasks: string[]; commits: string[] };
    expect(found).toMatchObject({ found: true, text: "A new invoice keeps its id after a reload.", tasks: ["T-1"], commits: ["9f3c2e1"] });

    const a = await hello(service, w1, "w1");
    await service.call(a, "ask_main", { task: "T-1", question: "ISO dates?" });
    await service.call(main, "answer", { question: "Q-1", text: "Yes" });
    expect(await service.call(main, "lookup", { ref: "Q-1" })).toMatchObject({ found: true, kind: "question", status: "answered", text: "ISO dates?" });
    expect(await service.call(main, "lookup", { ref: "nonsense" })).toMatchObject({ found: false, problem: expect.stringContaining("not a reference") });
  });
});

describe("replay", () => {
  it("a fresh relay on the same ledger rebuilds open questions and decisions", async () => {
    const { service, ledger, connect, w1 } = setup();
    const main = await hello(service, connect, "main");
    const a = await hello(service, w1, "w1");
    await service.call(a, "ask_main", { task: "T-1", question: "First?" });
    await service.call(main, "answer", { question: "Q-1", text: "Yes" });
    await service.call(a, "ask_main", { task: "T-1", question: "Second?" });
    const fresh = new Relay({ ledger });
    expect(fresh.digest("owner").lines).toEqual(["Q-2 (T-1) Second?"]);
    expect((await fresh.ask({ kind: "agent", id: "x", model: "m" }, "owner", { task: "T-1", question: "first" })).decision).toBe("D-1");
  });
});

describe("transports", () => {
  it("serves the tools over MCP and remembers the agent after hello", async () => {
    const { service, w1 } = setup();
    const server = createAgentMcpServer(directCall(service, w1));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["answer", "ask_main", "attach_proof", "check_inbox", "claim_task", "hello", "list_tasks", "lookup", "release_task", "report_progress"]);
    await client.callTool({ name: "hello", arguments: { name: "mcp worker", model: "m" } });
    const claimed = await client.callTool({ name: "claim_task", arguments: { task: "T-1" } });
    expect(claimed.isError).toBeFalsy();
    const refused = await client.callTool({ name: "claim_task", arguments: { task: "T-2" } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("FORBIDDEN");
    await client.close();
  });

  it("serves the tools over the loopback bridge with a bearer token", async () => {
    const { service, w1 } = setup();
    const bridge = await startBridge(service);
    try {
      expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const call = bridgeCall(bridge.url, w1);
      const { agent } = (await call({ tool: "hello", args: { name: "bridge worker", model: "m" } })) as { agent: string };
      expect(await call({ tool: "claim_task", args: { task: "T-1" }, agent })).toMatchObject({ status: "claimed" });
      await expect(bridgeCall(bridge.url, "pp_w_wrong-token-wrong-token")({ tool: "list_tasks", args: {}, agent })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const raw = await fetch(`${bridge.url}/call`, { method: "POST", headers: { authorization: `Bearer ${w1}` }, body: "{not json" });
      expect(raw.status).toBe(400);
    } finally {
      await bridge.close();
    }
  });
});
