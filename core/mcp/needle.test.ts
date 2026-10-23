import { describe, expect, it } from "vitest";
import { route, type NeedleInput } from "./needle";
import { TOOL_INFO, TOOL_NAMES, type ToolName } from "./tools";
import type { TaskView } from "./board";

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: "T-1", title: "Invoices", status: "open", owner: null, attempt: 1, clauses: [], dependsOn: [], testApproved: false, proofs: [], lastProgress: null, lastEntry: "L-1", ...over,
});

const worker = (t: Partial<TaskView>, intent = ""): NeedleInput => ({ role: "worker", task: "T-1", tasks: [task(t)], intent });

describe("needle: the board decides when the agent says nothing", () => {
  it("unknown agent -> hello", () => expect(route({ role: "unknown" })[0]!.tool).toBe("hello"));
  it("worker, no approved test -> propose_test", () => expect(route(worker({}))[0]!.tool).toBe("propose_test"));
  it("worker, test approved -> claim_task", () => expect(route(worker({ testApproved: true }))[0]!.tool).toBe("claim_task"));
  it("worker, claimed -> report_progress", () => expect(route(worker({ status: "claimed", testApproved: true }))[0]!.tool).toBe("report_progress"));
  it("worker, claimed with proof -> attach_proof", () =>
    expect(route(worker({ status: "claimed", testApproved: true, proofs: [{ kind: "commit", link: "abc", n: "L-9" }] }))[0]!.tool).toBe("attach_proof"));
  it("worker, blocked -> check_inbox", () => expect(route(worker({ status: "blocked" }))[0]!.tool).toBe("check_inbox"));
  it("main with waiting questions -> check_inbox", () => expect(route({ role: "main", openQuestions: 2 })[0]!.tool).toBe("check_inbox"));
  it("main with none -> list_tasks", () => expect(route({ role: "main" })[0]!.tool).toBe("list_tasks"));
});

const CASES: [NeedleInput["role"], string, ToolName][] = [
  ["unknown", "connect me to the project", "hello"],
  ["main", "show me the board", "list_tasks"],
  ["main", "what is open right now", "list_tasks"],
  ["main", "answer Q-3 with use the new endpoint", "answer"],
  ["main", "reply to Q-12", "answer"],
  ["main", "are there questions waiting", "check_inbox"],
  ["main", "anything new from the workers", "check_inbox"],
  ["main", "what does D-4 say", "lookup"],
  ["main", "look up §2.1", "lookup"],
  ["main", "who cites T-7", "lookup"],
  ["worker", "I want to claim T-1", "claim_task"],
  ["worker", "pick up the task and start working", "claim_task"],
  ["worker", "I wrote the parser and it passes locally", "report_progress"],
  ["worker", "progress update: finished the form", "report_progress"],
  ["worker", "attach the commit as proof", "attach_proof"],
  ["worker", "here is a screenshot as evidence", "attach_proof"],
  ["worker", "I am not sure which currency to use, should I ask", "ask_main"],
  ["worker", "I have a question for the main chat", "ask_main"],
  ["worker", "I cannot continue, give the task back", "release_task"],
  ["worker", "release T-1, it is blocked on the api key", "release_task"],
  ["worker", "write a failing test first", "propose_test"],
  ["worker", "propose the acceptance test", "propose_test"],
  ["worker", "any answer to my question yet", "check_inbox"],
  ["worker", "am I paused", "check_inbox"],
  ["worker", "list the tasks", "list_tasks"],
  ["worker", "what does Q-3 mean", "lookup"],
];

describe("needle: picks the right tool from words", () => {
  for (const [role, intent, expected] of CASES) {
    it(`${role}: "${intent}" -> ${expected}`, () => {
      const input: NeedleInput = role === "worker" ? { role, intent, task: "T-1", tasks: [task({ status: "claimed", testApproved: true })] } : { role, intent, tasks: [] };
      expect(route(input)[0]!.tool).toBe(expected);
    });
  }
  it("is right on at least 95% of the labelled cases", () => {
    let ok = 0;
    for (const [role, intent, expected] of CASES) {
      const input: NeedleInput = role === "worker" ? { role, intent, task: "T-1", tasks: [task({ status: "claimed", testApproved: true })] } : { role, intent, tasks: [] };
      if (route(input)[0]!.tool === expected) ok += 1;
    }
    expect(ok / CASES.length).toBeGreaterThanOrEqual(0.95);
  });
});

describe("needle: never offers a tool the caller is refused", () => {
  it("never offers a main-only tool to a worker, or a worker-only tool to main", () => {
    for (const intent of ["", "answer Q-1", "claim T-1", "attach proof", "release", "anything"]) {
      for (const c of route({ role: "worker", intent, task: "T-1", tasks: [task()] }, 11)) expect(TOOL_INFO[c.tool].caller).not.toBe("main");
      for (const c of route({ role: "main", intent }, 11)) expect(TOOL_INFO[c.tool].caller).not.toBe("worker");
    }
  });
  it("an observer only gets read-only tools", () => {
    for (const c of route({ role: "observer", intent: "claim T-1 and answer Q-1" }, 11)) expect(TOOL_INFO[c.tool].readOnly).toBe(true);
  });
  it("hello is only offered before check-in", () => {
    for (const role of ["worker", "main", "observer"] as const) expect(route({ role }, 11).map((c) => c.tool)).not.toContain("hello");
  });
});

describe("needle: arguments and scores", () => {
  it("fills in the task and question numbers it can see", () => {
    expect(route({ role: "main", intent: "answer Q-3 now" })[0]).toMatchObject({ tool: "answer", args: { question: "Q-3" } });
    expect(route({ role: "worker", task: "T-5", tasks: [task({ id: "T-5", testApproved: true })], intent: "claim it" })[0]).toMatchObject({ tool: "claim_task", args: { task: "T-5" } });
    expect(route({ role: "main", intent: "what does D-4 say" })[0]).toMatchObject({ tool: "lookup", args: { ref: "D-4" } });
  });
  it("scores sum to 1 and are in order", () => {
    const out = route(worker({}, "write a test"), 3);
    expect(out.reduce((s, c) => s + c.score, 0)).toBeGreaterThan(0.99);
    expect(out.reduce((s, c) => s + c.score, 0)).toBeLessThan(1.01);
    expect(out[0]!.score).toBeGreaterThanOrEqual(out[1]!.score);
  });
  it("survives hostile input", () => {
    for (const intent of ["", " ", "\u0000".repeat(50), "x".repeat(200_000), "constructor __proto__ toString", "T-".repeat(5000), "§".repeat(3000)]) {
      const out = route({ role: "worker", intent, task: "constructor", tasks: [task()] });
      expect(out.length).toBeGreaterThan(0);
      expect(TOOL_NAMES).toContain(out[0]!.tool);
    }
  });
});

describe("needle: at scale (4 repos x 3 ledgers x 10 agents)", () => {
  const board = (seed: number) => Array.from({ length: 200 }, (_, i) => task({ id: `T-${i + 1}`, status: (i + seed) % 4 === 0 ? "done" : (i + seed) % 4 === 1 ? "claimed" : "open", testApproved: (i + seed) % 3 === 0 }));
  const intents = ["", "claim it", "progress: wrote the form", "attach a screenshot", "I have a question", "give it back", "any answer yet"];

  it("120 agents on 12 ledgers, 200 calls each, in well under a second", () => {
    const ledgers = Array.from({ length: 12 }, (_, l) => board(l));
    const started = performance.now();
    let calls = 0;
    for (let l = 0; l < ledgers.length; l += 1) {
      for (let agent = 0; agent < 10; agent += 1) {
        for (let i = 0; i < 200; i += 1) {
          const t = ledgers[l]![(agent * 7 + i) % 200]!;
          route({ role: "worker", task: t.id, tasks: ledgers[l]!, intent: intents[i % intents.length]! });
          calls += 1;
        }
      }
    }
    expect(calls).toBe(24_000);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("two ledgers on one repo reuse the same task numbers and never see each other", () => {
    const a = [task({ id: "T-1", status: "open", testApproved: false })];
    const b = [task({ id: "T-1", status: "open", testApproved: true })];
    expect(route({ role: "worker", task: "T-1", tasks: a })[0]!.tool).toBe("propose_test");
    expect(route({ role: "worker", task: "T-1", tasks: b })[0]!.tool).toBe("claim_task");
    expect(route({ role: "worker", task: "T-1", tasks: a })[0]!.tool).toBe("propose_test");
  });
});
