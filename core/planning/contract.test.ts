import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore, GENESIS_PREV, Ledger, LedgerError, MemoryKeyProvider, MemoryStore, hashEntry, type Actor, type LedgerEntry } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import {
  ContractError,
  DEFAULT_SIZE_CAP,
  MAX_CLAUSES,
  approvalContracts,
  baseTaskId,
  contractDigest,
  contractFlags,
  contractOf,
  contractsDigest,
  draftContract,
  normalizeContract,
  summarizeContracts,
  unacceptedFlags,
  widenContract,
  writtenContracts,
  type ContractSpec,
} from "./contract";
import { buildMindMap } from "./mindmap";
import type { RepoIndex } from "./repo";
import { buildRoadmap, roadmapTasks, writeRoadmap } from "./roadmap";
import { installPlanningRules } from "./rules";
import type { PlanningAnswer, Roadmap, RoadmapTask, TaskContract } from "./types";

const person: Actor = { kind: "person", id: "owner" };
const worker: Actor = { kind: "agent", id: "worker-1", model: "test-model" };
const system: Actor = { kind: "system", id: "gate" };

const good = (extra: Partial<TaskContract> = {}): TaskContract => ({
  clauses: ["Build the sign-in form."],
  allowedFiles: ["src/signin/**"],
  doneWhen: "a test renders the form",
  sizeCap: { maxFiles: 4, maxLines: 120 },
  ...extra,
});

const repo = (...files: string[]): RepoIndex => ({ files, truncated: false });

function refusal(fn: () => unknown, code = "RULE"): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    expect((e as LedgerError).code).toBe(code);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

function thrown<T extends Error>(fn: () => unknown, type: new (...args: never[]) => T): T {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(type);
    return e as T;
  }
  throw new Error("expected an error");
}

describe("normalizeContract", () => {
  it("returns the canonical form: trimmed, cleaned, de-duplicated and sorted files", () => {
    const parsed = normalizeContract({
      clauses: ["  Build   it.  "],
      allowedFiles: ["./src/b.ts", "src\\a.ts", "src/b.ts/", "src//c.ts"],
      doneWhen: "  a test\npasses ",
      sizeCap: { maxFiles: 3, maxLines: 90 },
    });
    expect(parsed).toEqual({
      ok: true,
      contract: { clauses: ["Build it."], allowedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"], doneWhen: "a test passes", sizeCap: { maxFiles: 3, maxLines: 90 } },
    });
  });

  it("fills in the default size cap when none is written, and keeps an empty file list (that is flagged, not hidden)", () => {
    const parsed = normalizeContract({ clauses: ["Do it."], allowedFiles: [], doneWhen: "a test" });
    expect(parsed).toMatchObject({ ok: true, contract: { allowedFiles: [], sizeCap: DEFAULT_SIZE_CAP } });
  });

  it.each([
    ["nothing at all", undefined],
    ["null", null],
    ["a list", []],
    ["a string", "src/**"],
    ["no clauses", good({ clauses: [] })],
    ["a blank clause", good({ clauses: ["ok", "   "] })],
    ["a clause that is not text", { ...good(), clauses: [1] }],
    ["files that are not a list", { ...good(), allowedFiles: "src/**" }],
    ["a file path that is not text", { ...good(), allowedFiles: [7] }],
    ["a path outside the project (..)", good({ allowedFiles: ["../secrets.txt"] })],
    ["an absolute path", good({ allowedFiles: ["/etc/passwd"] })],
    ["a drive letter", good({ allowedFiles: ["C:/Windows/x"] })],
    ["the ledger folder", good({ allowedFiles: [".perfect-planner/ledger/**"] })],
    ["the git folder", good({ allowedFiles: [".git/hooks/pre-commit"] })],
    ["the git folder in another case", good({ allowedFiles: [".GIT/config"] })],
    ["a blank test", good({ doneWhen: "  " })],
    ["a size cap of zero files", good({ sizeCap: { maxFiles: 0, maxLines: 10 } })],
    ["a size cap with a fraction", good({ sizeCap: { maxFiles: 2.5, maxLines: 10 } })],
    ["a huge size cap", good({ sizeCap: { maxFiles: 5, maxLines: 1_000_000 } })],
    ["a null size cap", { ...good(), sizeCap: null }],
    ["too many files", good({ allowedFiles: Array.from({ length: 41 }, (_, i) => `src/f${i}.ts`) })],
  ])("refuses %s", (_label, raw) => {
    const parsed = normalizeContract(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem.length).toBeGreaterThan(5);
  });
});

describe("contractDigest", () => {
  it("is the same for the same contract however it is spelled, and changes with every edit", () => {
    const base = good();
    const digest = contractDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(contractDigest(good({ allowedFiles: ["./src/signin/**"] }))).toBe(digest);
    expect(contractDigest(JSON.parse(JSON.stringify(base)))).toBe(digest);
    const edits: Partial<TaskContract>[] = [
      { clauses: ["Build the sign-in form.", "And one more thing."] },
      { clauses: ["Build the sign-up form."] },
      { allowedFiles: ["src/signin/**", "src/extra.ts"] },
      { allowedFiles: ["src/**"] },
      { doneWhen: "a test renders the form twice" },
      { sizeCap: { maxFiles: 5, maxLines: 120 } },
      { sizeCap: { maxFiles: 4, maxLines: 121 } },
    ];
    const seen = new Set([digest]);
    for (const edit of edits) seen.add(contractDigest(good(edit)));
    expect(seen.size).toBe(edits.length + 1);
  });

  it("gives an unusable contract a digest of its own that no good contract has", () => {
    const broken = contractDigest({ ...good(), allowedFiles: ["../x"] });
    expect(broken).toMatch(/^[0-9a-f]{64}$/);
    expect(broken).not.toBe(contractDigest(good()));
  });

  it("contractsDigest depends on every key and every digest", () => {
    const a = contractsDigest({ "K-a": "1", "K-b": "2" });
    expect(contractsDigest({ "K-b": "2", "K-a": "1" })).toBe(a);
    expect(contractsDigest({ "K-a": "1", "K-b": "3" })).not.toBe(a);
    expect(contractsDigest({ "K-a": "1" })).not.toBe(a);
    expect(contractsDigest({ "K-a": "1", "K-c": "2" })).not.toBe(a);
  });
});

describe("contractFlags", () => {
  it("flags a task with no files", () => {
    expect(contractFlags(good({ allowedFiles: [] })).map((f) => f.code)).toEqual(["NO_FILES"]);
    expect(contractFlags(good())).toEqual([]);
  });

  it("flags a list that covers more repo files than the size cap lets one task change", () => {
    const files = Array.from({ length: 6 }, (_, i) => `src/signin/part${i}.ts`);
    const flags = contractFlags(good({ sizeCap: { maxFiles: 4, maxLines: 100 } }), repo(...files, "src/other.ts"));
    expect(flags.map((f) => f.code)).toEqual(["TOO_MANY_FILES"]);
    expect(flags[0]!.message).toContain("6 files");
    expect(flags[0]!.message).toContain("at most 4");
    expect(contractFlags(good({ sizeCap: { maxFiles: 6, maxLines: 100 } }), repo(...files))).toEqual([]);
  });

  it("flags a task with too many things to do", () => {
    const flags = contractFlags(good({ clauses: Array.from({ length: MAX_CLAUSES + 1 }, (_, i) => `Do thing ${i}.`) }));
    expect(flags.map((f) => f.code)).toEqual(["TOO_MANY_CLAUSES"]);
  });
});

describe("draftContract", () => {
  const spec = (label: string, extra: Partial<ContractSpec> = {}): ContractSpec => ({ kind: "component", label, parts: [], doneWhen: "a test passes", ...extra });

  it("guesses the repo files whose names match the task's words, best match first", () => {
    const files = repo(
      "src/components/SignInForm.tsx",
      "src/components/SignInForm.css",
      "src/components/Header.tsx",
      "src/auth/signIn.ts",
      "src/signin/helpers.ts",
      "src/billing/invoice.ts",
      "package.json",
      "README.md",
      "src/signin.test.ts",
    );
    const { contract, flags } = draftContract(spec("Sign-in"), files);
    expect(contract.allowedFiles).toEqual(["src/auth/signIn.ts", "src/components/SignInForm.css", "src/components/SignInForm.tsx"]);
    expect(contract.allowedFiles).not.toContain("package.json");
    expect(contract.allowedFiles).not.toContain("src/signin.test.ts");
    expect(flags).toEqual([]);
    expect(contract.sizeCap).toEqual(DEFAULT_SIZE_CAP);
    expect(contract.clauses.length).toBeGreaterThanOrEqual(2);
    expect(contract.clauses.at(-1)).toMatch(/only the files this contract lists/i);
  });

  it("leaves room for the task's own test: it never lists as many files as the cap", () => {
    const many = repo(...Array.from({ length: 12 }, (_, i) => `src/billing/billing${i}.ts`));
    const { contract, flags } = draftContract(spec("Billing"), many);
    expect(contract.allowedFiles.length).toBeLessThan(contract.sizeCap.maxFiles);
    expect(flags.map((f) => f.code)).toEqual(["TOO_MANY_FILES"]);
    expect(flags[0]!.message).toContain("12 files");
  });

  it("falls back to a new folder named after the task, beside the repo's other code", () => {
    const { contract, flags } = draftContract(spec("Reminders"), repo("app/main.ts", "app/ui/Home.tsx", "docs/readme.md"));
    expect(contract.allowedFiles).toEqual(["app/reminders/**"]);
    expect(flags).toEqual([]);
    expect(draftContract(spec("Reminders")).contract.allowedFiles).toEqual(["src/reminders/**"]);
    expect(draftContract(spec("A very long and winding name for a part of the app that goes on and on")).contract.allowedFiles[0]).toMatch(/^src\/[a-z0-9-]{1,40}\/\*\*$/);
  });

  it("never lists dependency files, planner files or tests, even when their names match", () => {
    const { contract } = draftContract(spec("Package"), repo("package.json", "package-lock.json", ".perfect-planner/package.ts", "src/package.test.ts", "tests/package.ts"));
    expect(contract.allowedFiles).toEqual(["src/package/**"]);
  });

  it("the release task names the changelog and the release notes folder", () => {
    expect(draftContract(spec("Cut the first release", { kind: "release" }), repo("src/a.ts")).contract.allowedFiles).toEqual(["CHANGELOG.md", "docs/release/**"]);
  });

  it("is deterministic and never produces a path the gate would refuse", () => {
    const files = repo("src/a/Zed.ts", "src/b/zed.ts", "src/c/Zed.tsx", "lib/zed.js");
    const first = draftContract(spec("Zed"), files);
    expect(draftContract(spec("Zed"), files)).toEqual(first);
    expect(normalizeContract(first.contract).ok).toBe(true);
  });
});

describe("a roadmap carries a contract on every task", () => {
  const ans = (questionId: string, area: PlanningAnswer["area"], text: string): PlanningAnswer => ({ questionId, area, q: `About ${area}`, choice: "custom", text });
  const answers = [ans("stack.shell", "stack", "Tauri + React"), ans("data.store", "data", "SQLite on the device"), ans("auth.method", "auth", "Email magic link")];

  it("builds a usable contract for every task from the repo's files and the task's words", () => {
    const map = buildMindMap("a habit tracker", answers);
    const roadmap = buildRoadmap(map, { repo: repo("src/db/sqlite.ts", "src/auth/magicLink.ts", "src/App.tsx") });
    const tasks = roadmapTasks(roadmap);
    expect(tasks.length).toBeGreaterThan(2);
    for (const task of tasks) {
      expect(normalizeContract(task.contract).ok, task.key).toBe(true);
      expect(task.contract.doneWhen).toBe(task.doneWhen.replace(/\s+/g, " ").trim());
      expect(task.contractFlags).toBeDefined();
    }
    expect(tasks.at(-1)!.contract.allowedFiles).toEqual(["CHANGELOG.md", "docs/release/**"]);
  });

  it("is the same roadmap, contracts included, every time", () => {
    const map = buildMindMap("a habit tracker", answers);
    const files = repo("src/db/sqlite.ts", "src/auth/magicLink.ts");
    expect(buildRoadmap(map, { repo: files })).toEqual(buildRoadmap(map, { repo: files }));
  });

  it("summarizes the digests and lists the flagged tasks, which stay unaccepted until the person accepts them", () => {
    const flagged = good({ allowedFiles: [] });
    const summary = summarizeContracts([
      { key: "K-a", title: "Build A", contract: good(), flags: [] },
      { key: "K-b", title: "Build B", contract: flagged, flags: contractFlags(flagged) },
    ]);
    expect(summary.tasks).toEqual({ "K-a": contractDigest(good()), "K-b": contractDigest(flagged) });
    expect(summary.digest).toBe(contractsDigest(summary.tasks));
    expect(summary.flagged.map((f) => f.key)).toEqual(["K-b"]);
    expect(unacceptedFlags(summary, []).map((f) => f.key)).toEqual(["K-b"]);
    expect(unacceptedFlags(summary, ["K-a"]).map((f) => f.key)).toEqual(["K-b"]);
    expect(unacceptedFlags(summary, ["K-b"])).toEqual([]);
    // Only a flagged task can be accepted, and only once.
    expect(approvalContracts(summary, ["K-a", "K-b", "K-b", "K-zzz"]).accepted).toEqual(["K-b"]);
  });
});

// ---------- what the ledger says ----------

const task = (key: string, contract: TaskContract, flags = [] as RoadmapTask["contractFlags"]): RoadmapTask => ({
  key,
  title: `Build ${key}`,
  phase: "core",
  owner: "owner",
  doneWhen: "a test passes",
  node: "root",
  change: "feature",
  dependsOn: [],
  contract,
  contractFlags: flags ?? [],
});

const roadmapOf = (...tasks: RoadmapTask[]): Roadmap => ({ phases: [{ id: "core", title: "Core", tasks }] });

async function openLedger(): Promise<Ledger> {
  const ledger = await Ledger.open(new MemoryStore());
  installNumberingRules(ledger);
  installPlanningRules(ledger);
  return ledger;
}

/** What the host does at plan approval: the person signs every contract's digest, then the roadmap is written. */
function approveAndWrite(ledger: Ledger, roadmap: Roadmap, accepted: string[] = [], signed: Roadmap = roadmap): Record<string, string> {
  const summary = summarizeContracts(roadmapTasks(signed).map((t) => ({ key: t.key, title: t.title, contract: t.contract, flags: t.contractFlags ?? [] })));
  appendNumbered(ledger, {
    actor: person,
    type: "plan.approved",
    summary: "Plan approved",
    refs: ["plan"],
    data: { source: "planning", contracts: approvalContracts(summary, accepted) },
  });
  return writeRoadmap(ledger, person, roadmap);
}

describe("contractOf: the contract in force, replayed from the ledger", () => {
  it("is signed when the plan approval signed this task's digest", async () => {
    const ledger = await openLedger();
    const numbers = approveAndWrite(ledger, roadmapOf(task("K-a", good())));
    const view = contractOf(ledger.entries(), numbers["K-a"]!)!;
    expect(view).toMatchObject({ task: "T-1", status: "signed", plan: "P-1", flagsAccepted: false, widened: [] });
    expect(view.problem).toBeUndefined();
    expect(view.contract).toEqual(good());
    expect(view.allowedFiles).toEqual(["src/signin/**"]);
    expect(view.digest).toBe(contractDigest(good()));
  });

  it("gives every attempt of a task the task's contract", async () => {
    const ledger = await openLedger();
    approveAndWrite(ledger, roadmapOf(task("K-a", good())));
    expect(contractOf(ledger.entries(), "T-1.a3")?.task).toBe("T-1");
    expect(baseTaskId("T-12.a2")).toBe("T-12");
    expect(baseTaskId("odd")).toBe("odd");
  });

  it("is null for a task that has no contract, and for a task that does not exist", async () => {
    const ledger = await openLedger();
    appendNumbered(ledger, { actor: person, type: "task.created", summary: "By hand", data: { source: "person", title: "By hand" } });
    expect(contractOf(ledger.entries(), "T-1")).toBeNull();
    expect(contractOf(ledger.entries(), "T-9")).toBeNull();
  });

  it("remembers which flagged tasks the person accepted when they approved", async () => {
    const ledger = await openLedger();
    const empty = good({ allowedFiles: [] });
    const flags = contractFlags(empty);
    const numbers = approveAndWrite(ledger, roadmapOf(task("K-a", good()), task("K-b", empty, flags)), ["K-b"]);
    expect(contractOf(ledger.entries(), numbers["K-b"]!)).toMatchObject({ status: "signed", flagsAccepted: true });
    expect(contractOf(ledger.entries(), numbers["K-b"]!)!.flags).toEqual(flags);
    expect(contractOf(ledger.entries(), numbers["K-a"]!)).toMatchObject({ status: "signed", flagsAccepted: false });
  });

  it("is unsigned when the plan approval signed nothing for it (an approval from before contracts)", async () => {
    const ledger = await openLedger();
    appendNumbered(ledger, { actor: person, type: "plan.approved", summary: "Plan approved", refs: ["plan"], data: { source: "planning" } });
    const numbers = writeRoadmap(ledger, person, roadmapOf(task("K-a", good())));
    const view = contractOf(ledger.entries(), numbers["K-a"]!)!;
    expect(view.status).toBe("unsigned");
    expect(view.problem).toMatch(/did not sign a contract/);
  });

  it("is unsigned when no approval comes before the task, or the approval was not a person's", async () => {
    const ledger = await openLedger();
    const numbers = writeRoadmap(ledger, person, roadmapOf(task("K-a", good())));
    expect(contractOf(ledger.entries(), numbers["K-a"]!)!.status).toBe("unsigned");

    const other = await openLedger();
    const summary = summarizeContracts([{ key: "K-a", title: "A", contract: good(), flags: [] }]);
    appendNumbered(other, { actor: system, type: "plan.approved", summary: "Plan approved", refs: ["plan"], data: { source: "planning", contracts: approvalContracts(summary, []) } });
    const written = writeRoadmap(other, person, roadmapOf(task("K-a", good())));
    expect(contractOf(other.entries(), written["K-a"]!)!.status).toBe("unsigned");
  });

  it("is unsigned when the contract written is not the one the person approved (an edit between approval and writing)", async () => {
    const ledger = await openLedger();
    const approved = roadmapOf(task("K-a", good()));
    const edited = roadmapOf(task("K-a", good({ allowedFiles: ["src/**", "package.json"], sizeCap: { maxFiles: 50, maxLines: 2000 } })));
    const numbers = approveAndWrite(ledger, edited, [], approved);
    const view = contractOf(ledger.entries(), numbers["K-a"]!)!;
    expect(view.status).toBe("unsigned");
    expect(view.problem).toMatch(/not the one you approved with P-1/);
    // What it would allow is shown, but nothing treats an unsigned contract as in force.
    expect(view.contract.allowedFiles).toContain("package.json");
  });

  it("uses the nearest approval before the task, so a later approval cannot sign an earlier task", async () => {
    const ledger = await openLedger();
    const real = roadmapOf(task("K-a", good()));
    const swapped = roadmapOf(task("K-a", good({ allowedFiles: ["**"] })));
    const summary = summarizeContracts(roadmapTasks(real).map((t) => ({ key: t.key, title: t.title, contract: t.contract, flags: [] })));
    // The widened contract is written with no approval of it; a later approval of the real one does not help.
    writeRoadmap(ledger, person, swapped);
    appendNumbered(ledger, { actor: person, type: "plan.approved", summary: "Plan approved", refs: ["plan"], data: { source: "planning", contracts: approvalContracts(summary, []) } });
    expect(contractOf(ledger.entries(), "T-1")!.status).toBe("unsigned");
  });

  it("a person's own task with a contract is signed by their entry; one a non-person wrote is not", async () => {
    const ledger = await openLedger();
    appendNumbered(ledger, { actor: person, type: "task.created", summary: "Mine", data: { source: "person", contract: good(), contractDigest: contractDigest(good()) } });
    expect(contractOf(ledger.entries(), "T-1")).toMatchObject({ status: "signed", allowedFiles: ["src/signin/**"] });
    appendNumbered(ledger, { actor: system, type: "task.created", summary: "System's", data: { source: "person", contract: good(), contractDigest: contractDigest(good()) } });
    expect(contractOf(ledger.entries(), "T-2")).toMatchObject({ status: "unsigned" });
  });

  it("writtenContracts replays the planning contracts by task key", async () => {
    const ledger = await openLedger();
    approveAndWrite(ledger, roadmapOf(task("K-a", good()), task("K-b", good({ allowedFiles: ["lib/**"] }))));
    const written = writtenContracts(ledger.entries());
    expect([...written.keys()]).toEqual(["K-a", "K-b"]);
    expect(written.get("K-b")).toMatchObject({ task: "T-2", contract: { allowedFiles: ["lib/**"] } });
  });
});

describe("the ledger refuses a planning task without a usable contract", () => {
  it("refuses task.created from planning with a missing, broken or mismatched contract, whoever writes it", async () => {
    const ledger = await openLedger();
    const data = (extra: Record<string, unknown>) => ({ source: "planning", key: "K-a", ...extra });
    const write = (d: Record<string, unknown>) => () => appendNumbered(ledger, { actor: person, type: "task.created", summary: "Build A", data: d });
    expect(refusal(write(data({})))).toMatch(/K-a has no usable contract/);
    expect(refusal(write(data({ contract: good({ allowedFiles: ["../x"] }), contractDigest: "x" })))).toMatch(/no usable contract/);
    expect(refusal(write(data({ contract: good(), contractDigest: "0".repeat(64) })))).toMatch(/does not match its digest/);
    expect(refusal(write(data({ contract: good(), contractDigest: contractDigest(good({ allowedFiles: ["src/**"] })) })))).toMatch(/does not match its digest/);
    expect(ledger.entries()).toHaveLength(0);
    // A spike task and a person's own task carry no key, so they are not held to this.
    expect(write({ source: "planning", spike: { question: "Q-1", due: "2999-01-01", risk: "r", owner: "o" } })).toThrow(/spike/);
    expect(write({ source: "person", title: "Mine" })().subject).toBe("T-1");
    expect(write(data({ contract: good(), contractDigest: contractDigest(good()) }))().subject).toBe("T-2");
  });
});

describe("widening a contract", () => {
  async function withTask() {
    const ledger = await openLedger();
    const numbers = approveAndWrite(ledger, roadmapOf(task("K-a", good())));
    return { ledger, id: numbers["K-a"]! };
  }

  it("adds files to the task as the person's own decision, and leaves the signed contract alone", async () => {
    const { ledger, id } = await withTask();
    const result = widenContract(ledger, person, { task: id, files: ["src/shared/**", "./docs/signin.md", "src/shared/**"], reason: "It needs the shared helpers" });
    expect(result).toMatchObject({ decision: "D-1", files: ["docs/signin.md", "src/shared/**"] });
    const view = contractOf(ledger.entries(), id)!;
    expect(view.status).toBe("signed");
    expect(view.contract.allowedFiles).toEqual(["src/signin/**"]);
    expect(view.allowedFiles).toEqual(["docs/signin.md", "src/shared/**", "src/signin/**"]);
    expect(view.widened).toHaveLength(1);
    expect(view.widened[0]).toMatchObject({ decision: "D-1", by: "owner", files: ["docs/signin.md", "src/shared/**"], reason: "It needs the shared helpers" });
    const entry = ledger.entries().find((e) => e.subject === "D-1")!;
    expect(entry.actor.kind).toBe("person");
    expect(entry.refs).toEqual([id]);
    // Widening twice adds up, and an attempt (T-1.a2) shares the task's contract.
    widenContract(ledger, person, { task: `${id}.a2`, files: ["src/more.ts"], reason: "One more", question: "Q-4" });
    expect(contractOf(ledger.entries(), `${id}.a2`)!.allowedFiles).toEqual(["docs/signin.md", "src/more.ts", "src/shared/**", "src/signin/**"]);
    expect(contractOf(ledger.entries(), id)!.widened[1]).toMatchObject({ question: "Q-4" });
  });

  it("is a person's decision only: a worker, the system or an unknown actor can never widen", async () => {
    const { ledger, id } = await withTask();
    for (const actor of [worker, system, { kind: "jev", id: "jev" } as unknown as Actor]) {
      const error = thrown(() => widenContract(ledger, actor, { task: id, files: ["src/**"], reason: "please" }), ContractError);
      expect(error.code).toBe("NOT_PERSON");
      expect(error.message).toMatch(/Only a person can widen a contract/);
    }
    // The ledger refuses the same to anyone who writes the entry directly: an agent may not write a decision
    // at all, and the planning rule stops the system.
    const direct = (actor: Actor) => () =>
      appendNumbered(ledger, { actor, type: "decision.made", summary: "Allow it", reason: "I say so", data: { contract: { op: "widened", task: id, files: ["**"] } } });
    expect(refusal(direct(worker), "NOT_PERMITTED")).toMatch(/decision\.made/);
    expect(refusal(direct(system))).toMatch(/only a person can widen/);
    expect(contractOf(ledger.entries(), id)!.widened).toEqual([]);
    expect(contractOf(ledger.entries(), id)!.allowedFiles).toEqual(["src/signin/**"]);
  });

  it("refuses a widening that names no task, an unknown task, no files, a path it may never allow, or no reason", async () => {
    const { ledger, id } = await withTask();
    const raw = (c: Record<string, unknown>) => () => appendNumbered(ledger, { actor: person, type: "decision.made", summary: "Allow", reason: "r", data: { contract: { op: "widened", ...c } } });
    expect(refusal(raw({ files: ["a.ts"] }))).toMatch(/must name a task/);
    expect(refusal(raw({ task: "T-1.a2", files: ["a.ts"] }))).toMatch(/must name a task like T-3/);
    expect(refusal(raw({ task: "T-77", files: ["a.ts"] }))).toMatch(/T-77 is not a task/);
    expect(refusal(raw({ task: id, files: [] }))).toMatch(/between 1 and/);
    expect(refusal(raw({ task: id, files: ["../x"] }))).toMatch(/cannot allow "..\/x"/);
    expect(refusal(raw({ task: id, files: [".perfect-planner/ledger/2026-10.jsonl"] }))).toMatch(/cannot allow/);
    expect(refusal(raw({ task: id, files: [".git/config"] }))).toMatch(/cannot allow/);
    expect(refusal(raw({ task: id, files: [5] }))).toMatch(/cannot allow/);
    expect(thrown(() => widenContract(ledger, person, { task: id, files: ["a.ts"], reason: "  " }), ContractError).code).toBe("EMPTY");
    expect(thrown(() => widenContract(ledger, person, { task: id, files: [], reason: "r" }), ContractError).code).toBe("BAD_FILES");
    expect(thrown(() => widenContract(ledger, person, { task: id, files: ["/etc"], reason: "r" }), ContractError).code).toBe("BAD_FILES");
    expect(thrown(() => widenContract(ledger, person, { task: "T-9", files: ["a.ts"], reason: "r" }), ContractError).code).toBe("UNKNOWN_TASK");
    expect(contractOf(ledger.entries(), id)!.widened).toEqual([]);
  });

  it("will not widen a task with no contract or a contract that is not signed", async () => {
    const ledger = await openLedger();
    appendNumbered(ledger, { actor: person, type: "task.created", summary: "By hand", data: { source: "person" } });
    expect(thrown(() => widenContract(ledger, person, { task: "T-1", files: ["a.ts"], reason: "r" }), ContractError).code).toBe("NO_CONTRACT");
    writeRoadmap(ledger, person, roadmapOf(task("K-a", good())));
    const error = thrown(() => widenContract(ledger, person, { task: "T-2", files: ["a.ts"], reason: "r" }), ContractError);
    expect(error.code).toBe("UNSIGNED");
  });

  it("ignores a widening that is not a verified person entry (hand-built, or by an agent)", async () => {
    const { ledger, id } = await withTask();
    const real = ledger.entries();
    const hand = (actor: Actor, files: string[]): LedgerEntry =>
      ({ n: "L-009999", at: "2026-10-09T12:00:00Z", actor, type: "decision.made", subject: "D-9", summary: "Allow", evidence: [], refs: [id], prev: "", hash: "", data: { contract: { op: "widened", task: id, files } } }) as LedgerEntry;
    const view = contractOf([...real, hand(person, ["**"]), hand(worker, ["src/other.ts"]), hand(system, ["secrets/**"])], id)!;
    expect(view.widened).toEqual([]);
    expect(view.allowedFiles).toEqual(["src/signin/**"]);
  });

  it("ignores a widening the system signed, in a ledger where the planning rule was not installed", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    installNumberingRules(ledger);
    const numbers = approveAndWrite(ledger, roadmapOf(task("K-a", good())));
    appendNumbered(ledger, { actor: system, type: "decision.made", summary: "Allow it", reason: "r", data: { contract: { op: "widened", task: numbers["K-a"], files: ["**"] } } });
    expect(contractOf(ledger.entries(), numbers["K-a"]!)!.allowedFiles).toEqual(["src/signin/**"]);
  });

  it("ignores a widening for a path it may never allow, even in a verified entry", async () => {
    const { ledger, id } = await withTask();
    appendNumbered(ledger, { actor: person, type: "decision.made", summary: "Allow", reason: "r", data: { note: "plain decision", contract: { op: "something-else", task: id, files: ["x.ts"] } } });
    expect(contractOf(ledger.entries(), id)!.widened).toEqual([]);
  });
});

// ---------- the ledger file on disk ----------

describe("editing the ledger file directly", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  const keys = new MemoryKeyProvider();
  const clock = () => {
    let t = Date.parse("2026-10-09T02:00:00Z");
    return () => new Date((t += 1000));
  };

  function seed(): { root: string; id: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-contract-"));
    roots.push(root);
    const ledger = Ledger.openSync(new FileStore(root), { keys, now: clock() });
    installNumberingRules(ledger);
    installPlanningRules(ledger);
    const numbers = approveAndWrite(ledger, roadmapOf(task("K-a", good())));
    widenContract(ledger, person, { task: numbers["K-a"]!, files: ["src/shared/**"], reason: "Shared helpers" });
    ledger.close();
    return { root, id: numbers["K-a"]! };
  }

  const file = (root: string) => {
    const dir = path.join(root, ".perfect-planner", "ledger");
    return path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith(".jsonl"))!);
  };

  function rewrite(root: string, change: (entries: LedgerEntry[]) => void, rechain: boolean): void {
    const entries = fs.readFileSync(file(root), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
    change(entries);
    if (rechain) {
      let prev = GENESIS_PREV;
      for (const entry of entries) {
        entry.prev = prev;
        entry.hash = hashEntry(entry);
        prev = entry.hash;
      }
      const last = entries.at(-1)!;
      fs.writeFileSync(path.join(root, ".perfect-planner", "ledger", "HEAD"), JSON.stringify({ n: last.n, hash: last.hash }));
    }
    fs.writeFileSync(file(root), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  const reopen = (root: string) => Ledger.openSync(new FileStore(root), { keys, readOnly: true });
  const taskEntry = (entries: LedgerEntry[]) => entries.find((e) => e.type === "task.created")!;

  it("reads back as signed when nobody touched it", () => {
    const { root, id } = seed();
    const ledger = reopen(root);
    expect(ledger.status.ok).toBe(true);
    expect(contractOf(ledger.entries(), id)).toMatchObject({ status: "signed", allowedFiles: ["src/shared/**", "src/signin/**"] });
  });

  it("an edited contract (files opened to everything, digest fixed to match) is unsigned, not 'no contract'", () => {
    for (const rechain of [false, true]) {
      const { root, id } = seed();
      rewrite(
        root,
        (entries) => {
          const e = taskEntry(entries);
          const wide = good({ allowedFiles: ["**"], sizeCap: { maxFiles: 50, maxLines: 2000 } });
          e.data = { ...e.data, contract: wide, contractDigest: contractDigest(wide) };
        },
        rechain,
      );
      const ledger = reopen(root);
      expect(ledger.status.ok).toBe(false);
      const view = contractOf(ledger.entries(), id)!;
      expect(view, "must not read as 'no contract'").not.toBeNull();
      expect(view.status).toBe("unsigned");
      expect(view.problem).toMatch(/signature check/);
    }
  });

  it("an edit that removes the contract altogether is unsigned too", () => {
    const { root, id } = seed();
    rewrite(
      root,
      (entries) => {
        const data = { ...taskEntry(entries).data };
        delete data.contract;
        delete data.contractDigest;
        taskEntry(entries).data = data;
      },
      true,
    );
    expect(contractOf(reopen(root).entries(), id)).toMatchObject({ status: "unsigned" });
  });

  it("a worker's line rewritten as the owner's widening does not widen anything", () => {
    const { root, id } = seed();
    const ledger = Ledger.openSync(new FileStore(root), { keys, now: clock() });
    ledger.append({ actor: worker, type: "question.asked", subject: "Q-1", summary: "May I change package.json?", refs: [id], data: { task: id, question: "May I change package.json?", options: [] } });
    ledger.close();
    rewrite(
      root,
      (entries) => {
        const e = entries.at(-1)!;
        e.actor = { ...person };
        e.type = "decision.made";
        e.subject = "D-9";
        e.data = { contract: { op: "widened", task: id, files: ["package.json", "**"] } };
      },
      true,
    );
    const view = contractOf(reopen(root).entries(), id)!;
    expect(view.allowedFiles).toEqual(["src/shared/**", "src/signin/**"]);
    expect(view.allowedFiles).not.toContain("package.json");
  });

  it("an appended line that claims to be the owner's widening does not widen anything", () => {
    const { root, id } = seed();
    const lines = fs.readFileSync(file(root), "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines.at(-1)!) as LedgerEntry;
    const forged = { ...last, n: "L-000099", subject: "D-99", actor: { ...person }, prev: last.hash, data: { contract: { op: "widened", task: id, files: ["**"] } } } as LedgerEntry;
    forged.hash = hashEntry(forged);
    fs.appendFileSync(file(root), JSON.stringify(forged) + "\n");
    const ledger = reopen(root);
    expect(ledger.status.ok).toBe(false);
    expect(contractOf(ledger.entries(), id)!.allowedFiles).toEqual(["src/shared/**", "src/signin/**"]);
  });
});
