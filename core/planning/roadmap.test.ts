import { describe, it, expect } from "vitest";
import { Ledger, MemoryStore } from "../ledger/index";
import type { Actor, LedgerEntry } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import { buildMindMap, linkNodes } from "./mindmap";
import { contractDigest } from "./contract";
import { FINAL_TASK_KEY, OWN_TASK_SOURCE, buildRoadmap, droppedRoadmapTasks, ownTasks, roadmapTasks, writeRoadmap } from "./roadmap";
import type { Area, PlanningAnswer, Roadmap } from "./types";

const ans = (area: Area, slug: string, text: string, extra: Partial<PlanningAnswer> = {}): PlanningAnswer => ({
  questionId: `${area}.${slug}`,
  area,
  q: `Question about ${area}`,
  choice: "custom",
  text,
  ...extra,
});

const ANSWERS: PlanningAnswer[] = [
  ans("stack", "shell", "Tauri + React"),
  ans("data", "store", "SQLite on the device"),
  ans("auth", "method", "Email magic link"),
  ans("money", "payments", "Stripe"),
  ans("ai", "provider", "Jev"),
  ans("offline", "mode", "Offline-first"),
  ans("scale", "users", "Hundreds", { spike: { task: "T-9", due: "2026-11-01", risk: "unknown load" } }),
  ans("testing", "suite", "Vitest"),
  ans("platforms", "targets", "Desktop and web"),
];

// task.created comes from a person or the system, never an agent (ledger "Who may write what").
const actor: Actor = { kind: "person", id: "looplet-spare" };
const map = buildMindMap("A planner", ANSWERS);

describe("buildRoadmap", () => {
  const roadmap = buildRoadmap(map, { owner: "dan" });
  const tasks = roadmapTasks(roadmap);
  const byKey = new Map(tasks.map((t) => [t.key, t]));

  it("keeps the five phases in order", () => {
    expect(roadmap.phases.map((p) => p.id)).toEqual(["foundation", "core", "integrations", "hardening", "release"]);
  });

  it("puts nodes in the right phases", () => {
    expect(byKey.get("K-component-app-shell")!.phase).toBe("foundation");
    expect(byKey.get("K-data-data-store")!.phase).toBe("foundation");
    expect(byKey.get("K-component-sign-in")!.phase).toBe("foundation");
    expect(byKey.get("K-component-web-screens")!.phase).toBe("core");
    expect(byKey.get("K-component-sync-engine")!.phase).toBe("core");
    expect(byKey.get("K-integration-payments")!.phase).toBe("integrations");
    expect(byKey.get("K-risk-edit-conflicts")!.phase).toBe("hardening");
    expect(byKey.get("K-risk-open-scale-users")!.phase).toBe("hardening");
    expect(byKey.get("K-component-test-suite")!.phase).toBe("release");
    expect(roadmap.phases.at(-1)!.tasks.at(-1)!.title).toBe("Cut the first release");
  });

  it("gives every task an owner, a testable done-when and a change kind", () => {
    for (const t of tasks) {
      expect(t.owner).toBe("dan");
      expect(t.doneWhen.length).toBeGreaterThan(20);
      expect(t.doneWhen).toMatch(/npm test|a test /);
      expect(["feature", "fix"]).toContain(t.change);
    }
    expect(byKey.get("K-risk-edit-conflicts")!.change).toBe("fix");
    expect(byKey.get("K-integration-payments")!.change).toBe("feature");
    expect(buildRoadmap(map).phases[0]!.tasks[0]!.owner).toBe("unassigned");
  });

  it("only depends on earlier tasks, so it is acyclic", () => {
    const index = new Map(tasks.map((t, i) => [t.key, i]));
    for (const t of tasks) for (const d of t.dependsOn) expect(index.get(d)!).toBeLessThan(index.get(t.key)!);
    expect(byKey.get("K-screen-sign-in-screen")!.dependsOn).toContain("K-component-sign-in");
    expect(byKey.get("K-integration-payments")!.dependsOn).toContain("K-component-app-shell");
    expect(byKey.get(FINAL_TASK_KEY)!.dependsOn).toHaveLength(tasks.length - 1);
  });

  it("follows cross-links to foundation tasks", () => {
    const linked = buildRoadmap(linkNodes(map, "integration-payments", "component-sign-in"));
    const payments = roadmapTasks(linked).find((t) => t.key === "K-integration-payments")!;
    expect(payments.dependsOn).toContain("K-component-sign-in");
  });

  it("is deterministic and keeps empty phases", () => {
    expect(buildRoadmap(map, { owner: "dan" })).toEqual(roadmap);
    const empty = buildRoadmap(buildMindMap("x", []));
    expect(empty.phases).toHaveLength(5);
    expect(empty.phases.slice(0, 4).every((p) => p.tasks.length === 0)).toBe(true);
    expect(empty.phases[4]!.tasks.map((t) => t.key)).toEqual([FINAL_TASK_KEY]);
  });
});

describe("writeRoadmap", () => {
  it("writes task.created entries numbered T-1.. with dependsOn mapped", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    installNumberingRules(ledger);
    const roadmap = buildRoadmap(map, { owner: "dan" });
    const tasks = roadmapTasks(roadmap);
    const numbers = writeRoadmap(ledger, actor, roadmap);
    const created = ledger.entries().filter((e) => e.type === "task.created");
    expect(created).toHaveLength(tasks.length);
    expect(created.map((e) => e.subject)).toEqual(tasks.map((_, i) => `T-${i + 1}`));
    expect(numbers[tasks[0]!.key]).toBe("T-1");
    expect(numbers[FINAL_TASK_KEY]).toBe(`T-${tasks.length}`);

    const signInScreen = created.find((e) => e.data?.key === "K-screen-sign-in-screen")!;
    expect(signInScreen.summary).toBe("Build the Sign-in screen");
    expect(signInScreen.refs).toEqual([]);
    expect(signInScreen.data).toMatchObject({
      change: "feature",
      phase: "foundation",
      owner: "dan",
      node: "screen-sign-in-screen",
      source: "planning",
      dependsOn: [numbers["K-component-sign-in"]],
    });
    expect(typeof signInScreen.data!.doneWhen).toBe("string");
    for (const e of created) for (const d of e.data!.dependsOn as string[]) expect(d).toMatch(/^T-\d+$/);
  });

  it("continues numbering after existing tasks", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    installNumberingRules(ledger);
    ledger.append({ actor, type: "task.created", subject: "T-1", summary: "Existing task", data: { change: "fix" } });
    const numbers = writeRoadmap(ledger, actor, buildRoadmap(buildMindMap("x", [])));
    expect(numbers[FINAL_TASK_KEY]).toBe("T-2");
  });

  it("writes nothing for an empty roadmap", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    const empty: Roadmap = { phases: [{ id: "foundation", title: "Foundation", tasks: [] }] };
    expect(writeRoadmap(ledger, actor, empty)).toEqual({});
    expect(ledger.entries()).toHaveLength(0);
  });

  it("writes dependencies first and refuses unknown dependencies before writing", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    const task = (key: string, dependsOn: string[]) => ({
      key, title: key, phase: "core" as const, owner: "o", doneWhen: "a test proves it", node: "root", change: "feature" as const, dependsOn,
      contract: { clauses: ["Do the one thing."], allowedFiles: [`src/${key}.ts`], doneWhen: "a test proves it", sizeCap: { maxFiles: 3, maxLines: 100 } },
    });
    const swapped: Roadmap = { phases: [{ id: "core", title: "Core", tasks: [task("K-b", ["K-a"]), task("K-a", [])] }] };
    expect(writeRoadmap(ledger, actor, swapped)).toEqual({ "K-a": "T-1", "K-b": "T-2" });
    const bad: Roadmap = { phases: [{ id: "core", title: "Core", tasks: [task("K-c", ["K-missing"])] }] };
    expect(() => writeRoadmap(ledger, actor, bad)).toThrow(/unknown/);
    expect(ledger.entries()).toHaveLength(2);
  });

  it("refuses a task with no usable contract before writing anything", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    const good = { clauses: ["Do the one thing."], allowedFiles: ["src/a.ts"], doneWhen: "a test proves it", sizeCap: { maxFiles: 3, maxLines: 100 } };
    const task = (key: string, contract: unknown) => ({
      key, title: key, phase: "core" as const, owner: "o", doneWhen: "x", node: "root", change: "feature" as const, dependsOn: [], contract: contract as typeof good,
    });
    for (const broken of [undefined, null, { ...good, clauses: [] }, { ...good, doneWhen: " " }, { ...good, allowedFiles: ["../outside"] }, { ...good, allowedFiles: [".perfect-planner/**"] }, { ...good, sizeCap: { maxFiles: 0, maxLines: 5 } }]) {
      const roadmap: Roadmap = { phases: [{ id: "core", title: "Core", tasks: [task("K-a", good), task("K-b", broken)] }] };
      expect(() => writeRoadmap(ledger, actor, roadmap)).toThrow(/K-b has no usable contract/);
    }
    expect(ledger.entries()).toHaveLength(0);
  });

  it("writes each task's contract and its digest into the task.created entry", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    const roadmap = buildRoadmap(buildMindMap("a habit tracker", []));
    writeRoadmap(ledger, actor, roadmap);
    const tasks = roadmapTasks(roadmap);
    const created = ledger.entries().filter((e) => e.type === "task.created");
    expect(created).toHaveLength(tasks.length);
    for (const e of created) {
      const task = tasks.find((t) => t.key === e.data!.key)!;
      expect(e.data!.contract).toEqual(task.contract);
      expect(e.data!.contractDigest).toBe(contractDigest(task.contract));
    }
  });
});

describe("roadmap readers trust only a verified person entry", () => {
  const forged = (n: number, partial: Partial<LedgerEntry>): LedgerEntry =>
    ({ n: `L-${String(n).padStart(6, "0")}`, at: "2026-10-09T12:00:00Z", evidence: [], refs: [], prev: "", hash: "", summary: "x", subject: "", ...partial }) as LedgerEntry;

  it("ignores an unsigned person entry or an agent entry when listing the person's own tasks", () => {
    const entries = [
      forged(1, { type: "task.created", subject: "T-1", actor: { kind: "person", id: "looplet-spare" }, data: { source: OWN_TASK_SOURCE, title: "Forged", phase: "core" } }),
      forged(2, { type: "task.created", subject: "T-2", actor: { kind: "agent", id: "claude-code", model: "m" }, data: { source: OWN_TASK_SOURCE, title: "Agent", phase: "core" } }),
    ];
    expect(ownTasks(entries)).toEqual([]);
  });

  it("ignores an unsigned person or agent decision that drops a roadmap task", () => {
    const entries = [
      forged(1, { type: "decision.made", subject: "D-1", actor: { kind: "person", id: "looplet-spare" }, data: { roadmap: { drop: "K-a" } } }),
      forged(2, { type: "decision.made", subject: "D-2", actor: { kind: "agent", id: "claude-code", model: "m" }, data: { roadmap: { drop: "K-b" } } }),
    ];
    expect(droppedRoadmapTasks(entries).size).toBe(0);
  });

  it("takes a person's signed entries written through the ledger", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    const person: Actor = { kind: "person", id: "looplet-spare" };
    appendNumbered(ledger, { actor: person, type: "task.created", summary: "Mine", data: { source: OWN_TASK_SOURCE, title: "Mine", phase: "core", change: "feature" } });
    appendNumbered(ledger, { actor: person, type: "decision.made", summary: "Drop K-a", reason: "Not needed", data: { roadmap: { drop: "K-a", title: "A" } } });
    expect(ownTasks(ledger.entries()).map((t) => t.title)).toEqual(["Mine"]);
    expect([...droppedRoadmapTasks(ledger.entries()).keys()]).toEqual(["K-a"]);
  });
});
