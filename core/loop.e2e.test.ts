// The whole core loop, end to end, on a real temporary git repository
// (Core Specs §2-§6). Everything is the real cloud module: the strict ledger on
// its file store, numbering and clause rules, the worktree manager with its
// commit-time secret scan, the git watcher, the test gate (which runs every
// test itself), the agent service with per-task tokens, the one-chat relay and
// the Jev reviewer. Only TypeSafe's HTTP endpoint is faked (fetch), and Jev's
// key and the ledger's signing keys sit in in-memory key providers instead of
// the OS key store.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PERMISSIONS, FileStore, Ledger, LedgerError, MemoryKeyProvider as LedgerKeys, hashEntry, isAuthoritative, verifyChain, type Actor, type LedgerEntry } from "./ledger/index";
import { appendNumbered, installNumberingRules } from "./numbering/index";
import { addPlanText, installClauseRules, lookup } from "./lookup/index";
import { WorktreeManager, WORKTREES_ACTOR, GATE_ACTOR, WATCHER_ACTOR, git, runGit, realDir, type WorktreeInfo } from "./worktrees/index";
import { GitWatcher } from "./watcher/index";
import { TestGate, deriveState, gateRule } from "./gate/index";
import { AgentService, TokenStore, ToolError, attemptLabel, foldBoard, type Caller } from "./mcp/index";
import { Relay } from "./relay/index";
import { JevReviewer, MemoryKeyProvider, createJevTransport, type ReviewResult } from "./jev/index";

// ---------- hermetic git (after origin/claude/test-hardening tests/helpers/hermetic-git.mjs) ----------
// No inherited GIT_* routing or config, and a private HOME whose .gitconfig sets a fixed
// identity, no signing and no hooks path, so a developer's or CI runner's git setup cannot
// change what happens here. Child processes (git, hooks, test commands) inherit it.

const savedEnv = { ...process.env };
let hermeticHome = "";

function applyHermeticGitEnv(): void {
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_") && upper !== "GIT_SSL_CAINFO") delete process.env[key];
  }
  hermeticHome = mkdtempSync(path.join(os.tmpdir(), "pp-e2e-home-"));
  mkdirSync(path.join(hermeticHome, "xdg", "git"), { recursive: true });
  writeFileSync(
    path.join(hermeticHome, ".gitconfig"),
    ["[user]", "\tname = Perfect Planner Test", "\temail = tests@perfect-planner.invalid", "[init]", "\tdefaultBranch = main", "[commit]", "\tgpgsign = false", "[tag]", "\tgpgsign = false", "[core]", "\tautocrlf = false", "[advice]", "\tdetachedHead = false", ""].join("\n"),
  );
  process.env.HOME = hermeticHome;
  process.env.USERPROFILE = hermeticHome;
  process.env.XDG_CONFIG_HOME = path.join(hermeticHome, "xdg");
  process.env.GIT_TERMINAL_PROMPT = "0";
}

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}

/** Windows keeps handles open briefly (git, antivirus, indexers): retry EPERM/EBUSY/ENOTEMPTY. */
async function removeWithRetry(dir: string): Promise<void> {
  if (!dir) return;
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 20 || !["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

// ---------- the project under test ----------

// Built at runtime so no credential-shaped literal sits in this source file.
const PLANTED_KEY = "AKIA" + "0".repeat(16);
const JEV_KEY = ["ts", "e2e", "loop", "0123456789abcdef"].join("_");

const PLAN = `# Plans

## Save

Plans save to the local store.

## Load

Plans load on start and report a missing plan.

## Export

Plans export as markdown.
`;

const REGISTRY = ["export const features = {", "  save: false,", "  // -", "  // -", "  // -", "  load: false,", "  // -", "  // -", "  // -", "  exportPlan: false,", "};", ""].join("\n");

function checkScript(file: string, fn: string, expected: string): string {
  return `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const file = path.resolve(${JSON.stringify(file)});
if (!fs.existsSync(file)) { console.error(${JSON.stringify(`${file} is missing`)}); process.exit(1); }
const mod = await import(pathToFileURL(file).href);
const got = mod.${fn}("plan");
if (got !== ${JSON.stringify(expected)}) { console.error("unexpected " + got); process.exit(1); }
console.log("ok");
`;
}

const SPECS = {
  "T-1": { title: "Save plans", clause: "P-1 §1", check: "checks/t1.mjs" },
  "T-2": { title: "Load plans", clause: "P-1 §2", check: "checks/t2.mjs" },
  "T-3": { title: "Export plans", clause: "P-1 §3", check: "checks/t3.mjs" },
} as const;
type TaskId = keyof typeof SPECS;
const TASKS = Object.keys(SPECS) as TaskId[];

function write(root: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, ...name.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
}

async function commit(cwd: string, message: string): Promise<{ code: number; stderr: string }> {
  await git(cwd, ["add", "-A"]);
  return runGit(cwd, ["commit", "-q", "-m", message]);
}

/** A fake TypeSafe System One endpoint: approves every test, rejects the diffs of `rejectDiff`, never settles a question. */
function fakeTypeSafe(rejectDiff: Set<string>) {
  const calls: { kind: "test" | "diff" | "question"; task: string; authorization: string }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const names = Object.keys(body.questions);
    const authorization = String((init?.headers as Record<string, string>).Authorization);
    let answers: Record<string, { choice: string; confidence: number; reason?: string }>;
    if (names.includes("settled")) {
      calls.push({ kind: "question", task: String(body.state.task), authorization });
      answers = { settled: { choice: "not_settled", confidence: 0.9 } };
    } else if (names.includes("weakens_tests")) {
      const task = String(body.state.task.id);
      const reject = rejectDiff.has(task);
      calls.push({ kind: "diff", task, authorization });
      answers = {
        covers_clauses: reject ? { choice: "some", confidence: 0.9, reason: "load() does not return null for a missing plan, as the answer to Q-1 says" } : { choice: "all", confidence: 0.93 },
        weakens_tests: { choice: "no", confidence: 0.95 },
        stays_in_scope: { choice: "yes", confidence: 0.92 },
      };
    } else {
      calls.push({ kind: "test", task: String(body.state.task.id), authorization });
      answers = { covers_clauses: { choice: "all", confidence: 0.95 }, trivially_passing: { choice: "no", confidence: 0.94 }, weakest_clause: { choice: "none", confidence: 0.9 } };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { cost_usd: 0.01 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function expectToolError(promise: Promise<unknown>, code: string, message?: RegExp): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error, `expected ToolError ${code}`).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe(code);
  if (message) expect((error as ToolError).message).toMatch(message);
  return error as ToolError;
}

function expectLedgerError(fn: () => unknown, code: string, message?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected LedgerError ${code}`).toBeInstanceOf(LedgerError);
  expect((caught as LedgerError).code).toBe(code);
  if (message) expect((caught as LedgerError).message).toMatch(message);
}

// ---------- the loop ----------

const owner: Actor = { kind: "person", id: "owner" };
const jevActor: Actor = { kind: "jev", id: "jev", model: "jev-1.13.0" };

let parent = "";
let root = "";

beforeAll(async () => {
  applyHermeticGitEnv();
  parent = realDir(mkdtempSync(path.join(os.tmpdir(), "pp-e2e-")));
  root = path.join(parent, "repo");
  mkdirSync(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Perfect Planner Test"]);
  await git(root, ["config", "user.email", "tests@perfect-planner.invalid"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  write(root, {
    ".gitignore": "node_modules/\n.perfect-planner/\n",
    "src/registry.js": REGISTRY,
    "checks/t1.mjs": checkScript("src/save.js", "save", "saved:plan"),
    "checks/t2.mjs": checkScript("src/load.js", "load", "loaded:plan"),
    "checks/t3.mjs": checkScript("src/export.js", "exportPlan", "# plan"),
  });
  await commit(root, "Initial app with acceptance checks");
});

afterAll(async () => {
  try {
    if (root) await runGit(root, ["worktree", "prune"]);
  } finally {
    await removeWithRetry(parent);
    await removeWithRetry(hermeticHome);
    restoreEnv();
  }
});

describe("the whole core loop", () => {
  it("runs plan to merged, reviewed, proven work on a real repo and replays to the same board", async () => {
    const steps: string[] = [];
    const step = (name: string) => steps.push(name);

    // The real ledger on its file store, signing person and system entries with this device's keys,
    // with the numbering, clause and gate rules installed.
    const signing = new LedgerKeys();
    let ledger = Ledger.openSync(new FileStore(root), { keys: signing });
    installNumberingRules(ledger);
    installClauseRules(ledger);
    ledger.addRule(gateRule());
    const entries = () => ledger.entries();
    const last = () => ledger.last()!;

    // ---- 1. Plan P-1, its clauses numbered from the markdown, approved by the owner.
    addPlanText(ledger, owner, PLAN);
    const plan = appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Save, load and export plans" });
    expect(plan.subject).toBe("P-1");
    expect(lookup(entries(), "P-1 §1").text).toBe("Save");
    expect(lookup(entries(), "P-1 §2.1").text).toBe("Plans load on start and report a missing plan.");
    step("plan P-1 approved with numbered clauses");

    // ---- 2. Three tasks, each citing a clause.
    for (const id of TASKS) {
      const created = appendNumbered(ledger, { actor: owner, type: "task.created", summary: SPECS[id].title, refs: [SPECS[id].clause], data: { title: SPECS[id].title } });
      expect(created.subject).toBe(id);
    }
    step("T-1, T-2, T-3 created, citing P-1 §1, §2, §3");

    // The agent side: tokens, the service, Jev as the relay's settled-answer source. The owner sets each
    // agent's model on its token; a model an agent only declares is recorded as unverified (PR #7).
    const keys = new MemoryKeyProvider(JEV_KEY);
    const typesafe = fakeTypeSafe(new Set(["T-2"]));
    const jev = new JevReviewer({ ledger, transport: createJevTransport({ keys, fetchImpl: typesafe.fetchImpl }) });
    jev.planClauses = () => [...TASKS.map((id) => ({ ref: SPECS[id].clause, text: lookup(entries(), SPECS[id].clause).text! }))];
    const tokens = new TokenStore();
    const service = new AgentService({ ledger, tokens, relay: new Relay({ ledger, settled: jev }) });
    const hello = async (token: string, name: string, model: string): Promise<Caller & { agent: string; role: string }> => {
      const welcome = (await service.call({ token }, "hello", { name, model })) as { agent: string; role: string };
      return { token, agent: welcome.agent, role: welcome.role };
    };
    const main = await hello(tokens.issue({ role: "connect", person: "owner", model: "planner-model" }), "Main chat", "planner-model");
    expect(main.role).toBe("main");
    const mainActor: Actor = { kind: "agent", id: main.agent, model: "planner-model" };

    // ---- 3. Tests defined (by the main chat), approved by the owner with their files pinned (PR #6),
    //         confirmed FAILING by the gate exactly as approved, then reviewed by Jev.
    const gate = new TestGate({ ledger, timeoutMs: 60_000 });
    const clausesOf = (id: TaskId) => [{ ref: SPECS[id].clause, text: lookup(entries(), SPECS[id].clause).text! }];
    const command = (id: TaskId) => `node ${SPECS[id].check}`;
    const workerA = await hello(tokens.issue({ role: "worker", person: "owner", task: "T-1", model: "builder-a" }), "Worker A", "builder-a");
    for (const id of TASKS) {
      const defined = gate.define(id, command(id), mainActor, [SPECS[id].clause], { files: [SPECS[id].check] });
      expect(defined.ok).toBe(true);
      if (id === "T-1") await expectToolError(service.call(workerA, "claim_task", { task: "T-1" }), "REFUSED", /waiting for the owner's approval/);
      const approved = gate.approve(id, owner, { cwd: root });
      expect(approved.ok, `${id} approval: ${approved.ok ? "" : approved.reason}`).toBe(true);
      if (approved.ok) {
        expect(approved.entry).toMatchObject({ type: "test.approved", actor: owner });
        expect(approved.entry.evidence).toContain(`pin:${SPECS[id].check}=${(approved.entry.data?.pins as Record<string, string>)[SPECS[id].check]}`);
      }
      const first = await gate.confirmFailsFirst(id, root);
      expect(first.ok, `${id} must fail on the current code`).toBe(true);
      expect(first.entry).toMatchObject({ type: "test.failed", actor: GATE_ACTOR, data: { phase: "baseline" } });
      const review = await jev.reviewTest({
        task: id,
        title: SPECS[id].title,
        clauses: clausesOf(id),
        test: { command: command(id), source: readFileSync(path.join(root, ...SPECS[id].check.split("/")), "utf8") },
        failsFirst: true,
        author: mainActor,
        definition: defined.ok ? defined.entry.n : undefined,
      });
      expect(review.verdict, `${id} test review`).toBe("approve");
      // Jev holds no signing key: the app writes the verdict as the system, signed, and names Jev as reviewer.
      const verdictEntry = ledger.get(review.entry!)!;
      expect(verdictEntry).toMatchObject({ type: "review.verdict", actor: { kind: "system" }, data: { reviewer: { kind: "jev", model: "jev-1.13.0" } } });
      expect(isAuthoritative(verdictEntry)).toBe(true);
      // The gate sees Jev's verdict on the current definition.
      expect(gate.state(id).jev).toMatchObject({ n: review.entry, verdict: "approve" });
      expect(gate.state(id).stage).toBe("baseline-confirmed");
    }
    // A verdict that merely names Jev as its actor is unsigned: the gate neither counts its gaps nor its approval.
    const forged = ledger.append({
      actor: jevActor,
      type: "review.verdict",
      subject: "T-1",
      summary: "Forged gaps on T-1's test",
      evidence: ["scope:test", "verdict:gaps", `definition:${gate.state("T-1").definition!.n}`, "gap:forged"],
    });
    expect(isAuthoritative(forged)).toBe(false);
    expect(gate.state("T-1").jev).toMatchObject({ verdict: "approve" });
    expect(gate.state("T-1").jev!.n).not.toBe(forged.n);
    // Signed Jev gaps found after the owner's approval stop work (PR #6); forged ones do not.
    expect(gate.canStart("T-1").ok).toBe(true);
    step("tests defined; claim before approval refused; owner approved each test with its file pinned");
    step("gate confirmed each approved test fails first");
    step("Jev reviewed each test (approve, signed by the app), visible to the gate; a forged Jev verdict did not count");

    // The other workers check in with per-task tokens.
    const workerB = await hello(tokens.issue({ role: "worker", person: "owner", task: "T-2", model: "builder-b" }), "Worker B", "builder-b");
    const workerC = await hello(tokens.issue({ role: "worker", person: "owner", task: "T-3", model: "builder-c" }), "Worker C", "builder-c");
    expect([workerA.role, workerB.role, workerC.role]).toEqual(["worker", "worker", "worker"]);
    const builder = (worker: { agent: string }, model: string): Actor => ({ kind: "agent", id: worker.agent, model });

    // ---- 4. (Approval moved into step 3: PR #6 pins the approved test files before the fails-first run.)

    // ---- 5. One worktree per task, launched by the system, with no file list typed by anyone.
    const worktrees = new WorktreeManager({ repoRoot: root, ledger, install: false });
    const launched = {} as Record<TaskId, WorktreeInfo>;
    for (const id of TASKS) {
      launched[id] = await worktrees.create({ taskId: id, actor: WORKTREES_ACTOR, baseRef: "main" });
      expect(launched[id]).toMatchObject({ branch: `pp/${id}`, claims: [] });
      expect(last()).toMatchObject({ type: "worktree.created", subject: id, actor: WORKTREES_ACTOR });
    }
    const wt = (id: TaskId) => launched[id].path;
    step("worktrees launched (pp/T-1, pp/T-2, pp/T-3)");

    // ---- 6. Two workers claim through their tokens; a token covers only its own task.
    expect(await service.call(workerA, "claim_task", { task: "T-1" })).toMatchObject({ task: "T-1", status: "claimed" });
    expect(await service.call(workerB, "claim_task", { task: "T-2" })).toMatchObject({ task: "T-2", status: "claimed" });
    await expectToolError(service.call(workerA, "claim_task", { task: "T-2" }), "FORBIDDEN");
    await expectToolError(service.call(workerC, "report_progress", { task: "T-1", text: "not mine" }), "FORBIDDEN");
    expect(await service.call(workerC, "claim_task", { task: "T-3" })).toMatchObject({ status: "claimed" });
    expect(service.board().get("T-1")).toMatchObject({ status: "claimed", owner: workerA.agent, testApproved: true });
    expect(ledger.bySubject("T-1").find((e) => e.type === "task.claimed")!.actor).toEqual(builder(workerA, "builder-a"));
    step("workers claimed T-1 and T-2 (and T-3) with their own tokens");

    // ---- 7. Worker B asks a blocking question; Jev cannot settle it from the plan; the main chat answers; it routes back by Q number.
    const asked = (await service.call(workerB, "ask_main", { task: "T-2", question: "Should load() throw or return null for a missing plan?", options: ["throw", "return null"], blocking: true })) as { q: string; status: string; paused: boolean };
    expect(asked).toMatchObject({ q: "Q-1", status: "open", paused: true });
    expect(typesafe.calls.filter((c) => c.kind === "question")).toHaveLength(1);
    await expectToolError(service.call(workerB, "report_progress", { task: "T-2", text: "keeps going" }), "PAUSED", /Q-1/);
    expect(await service.call(workerA, "report_progress", { task: "T-1", text: "not blocked by B's question" })).toMatchObject({ entry: expect.any(String) });
    const digest = (await service.call(main, "check_inbox", {})) as { open: number; blocking: number; lines: string[] };
    expect(digest).toMatchObject({ open: 1, blocking: 1 });
    expect(digest.lines[0]).toMatch(/^Q-1 \(T-2, blocking\)/);
    await expectToolError(service.call(workerA, "answer", { question: "Q-1", text: "throw" }), "FORBIDDEN");
    const answered = (await service.call(main, "answer", { question: "Q-1", text: "return null" })) as { q: string; decision: string; worker: string };
    // The main chat is an agent: its answer reaches the worker as information, never as a decision (PR #7).
    expect(answered).toEqual({ q: "Q-1", decision: null, worker: workerB.agent });
    expect(entries().some((e) => e.type === "decision.made")).toBe(false);
    expect(await service.call(workerA, "check_inbox", {})).toMatchObject({ answers: [], paused: false });
    expect(await service.call(workerB, "check_inbox", {})).toMatchObject({ answers: [{ q: "Q-1", answer: "return null", via: "main" }], paused: false });
    expect(lookup(entries(), "Q-1")).toMatchObject({ status: "answered", tasks: ["T-2"] });
    step("blocking Q-1 answered by the main chat (information, not a decision) and routed back to worker B only");

    // ---- 8. Work in the worktrees. T-1 and T-2 both change src/registry.js.
    write(wt("T-1"), { "src/save.js": 'export function save(plan) { return "saved:" + plan; }\n', "src/registry.js": REGISTRY.replace("save: false", "save: true") });
    expect((await commit(wt("T-1"), "Save plans\n\nImplements: P-1 §1 (T-1)")).code).toBe(0);
    write(wt("T-2"), { "src/load.js": 'export function load(plan) { return "loaded:" + plan; }\n', "src/registry.js": REGISTRY.replace("load: false", "load: true") });
    expect((await commit(wt("T-2"), "Load plans\n\nImplements: P-1 §2 (T-2)")).code).toBe(0);
    expect(await service.call(workerB, "report_progress", { task: "T-2", text: "load() written and registered" })).toMatchObject({ entry: expect.any(String) });

    // ---- 9. A planted fake key is blocked at commit by the worktree's secret scan.
    write(wt("T-3"), { "src/config.js": `export const awsKey = "${PLANTED_KEY}";\n` });
    const blocked = await commit(wt("T-3"), "Add config");
    expect(blocked.code, "the secret scan must block the commit").not.toBe(0);
    expect(blocked.stderr).toMatch(/aws-access-key/);
    expect(blocked.stderr).not.toContain(PLANTED_KEY);
    await git(wt("T-3"), ["rm", "-q", "--cached", "src/config.js"]);
    rmSync(path.join(wt("T-3"), "src", "config.js"));
    write(wt("T-3"), { "src/export.js": 'export function exportPlan(plan) { return "# " + plan; }\n' });
    expect((await commit(wt("T-3"), "Export plans\n\nImplements: P-1 §3 (T-3)")).code).toBe(0);
    step("planted AKIA key blocked at commit; clean commit went through");

    // ---- 10. The watcher reads git: commits observed, and the shared file found without any typed list.
    const watcher = new GitWatcher({ ledger, worktrees: () => worktrees.list() });
    const tick = await watcher.tick();
    expect(tick.errors).toEqual([]);
    expect(tick.observed.map((c) => c.taskId)).toEqual(["T-1", "T-2", "T-3"]);
    expect(tick.collisions).toEqual([{ tasks: ["T-1", "T-2"], files: ["src/registry.js"] }]);
    const collision = entries().filter((e) => e.type === "collision.detected");
    expect(collision).toHaveLength(1);
    expect(collision[0]).toMatchObject({ subject: "T-1+T-2", actor: WATCHER_ACTOR });
    expect(collision[0].evidence).toEqual(["task:T-1", "task:T-2", "file:src/registry.js"]);
    expect((await worktrees.list()).every((info) => info.claims.length === 0)).toBe(true);
    const observed = (id: TaskId) => entries().filter((e) => e.type === "commit.observed" && e.subject === id);
    expect(observed("T-1").map((e) => e.data?.files)).toEqual([["src/registry.js", "src/save.js"]]);
    expect(observed("T-3")).toHaveLength(1);
    expect(observed("T-3")[0].data?.files).toEqual(["src/export.js"]);
    expect(observed("T-1")[0]).toMatchObject({ actor: WATCHER_ACTOR, refs: ["P-1 §1"] });
    const second = await watcher.tick();
    expect([second.observed, second.collisions, second.errors]).toEqual([[], [], []]);
    step("watcher observed 3 commits and wrote collision.detected T-1+T-2 on src/registry.js");

    // ---- 11. task.done is refused while a task's test has never passed.
    expectLedgerError(() => ledger.append({ actor: owner, type: "task.done", subject: "T-3", summary: "Finish without a passing run" }), "DONE_WITHOUT_PASS", /no passing run/);
    // ...and an agent may never write a test result at all.
    expectLedgerError(
      () => ledger.append({ actor: builder(workerC, "builder-c"), type: "test.passed", subject: "T-3", summary: "Trust me, it passes", data: { test: command("T-3"), phase: "worktree" } }),
      "NOT_PERMITTED",
      /agent .* may not write test\.passed/,
    );
    step("task.done refused for T-3 before its test ever passed; agent test.passed refused NOT_PERMITTED");

    // ---- 12. Workers attach proof; the gate runs each approved test itself in the worktree.
    const proven = {} as Record<TaskId, { commit: string; output: string }>;
    for (const [id, worker] of [["T-1", workerA], ["T-2", workerB], ["T-3", workerC]] as const) {
      const head = await git(wt(id), ["rev-parse", "HEAD"]);
      expect(await service.call(worker, "attach_proof", { task: id, kind: "commit", link: head })).toMatchObject({ note: expect.stringMatching(/approved test/) });
      const run = await gate.prove(id, wt(id));
      expect(run.ok, `${id} passes in its worktree`).toBe(true);
      expect(run.entry).toMatchObject({ type: "test.passed", actor: GATE_ACTOR, data: { phase: "worktree", commit: head } });
      proven[id] = { commit: head, output: run.run?.outputTail ?? "" };
    }
    step("gate ran each approved test itself in its worktree (3 passes)");

    // ---- 13. Jev reviews each diff. T-2 is rejected and reopened as T-2.a2.
    const verdicts = {} as Record<TaskId, ReviewResult>;
    const models = { "T-1": [workerA, "builder-a"], "T-2": [workerB, "builder-b"], "T-3": [workerC, "builder-c"] } as const;
    for (const id of TASKS) {
      verdicts[id] = await jev.reviewDiff({
        task: id,
        clauses: clausesOf(id),
        diff: await git(root, ["diff", "--no-color", `main...pp/${id}`]),
        testOutput: proven[id].output,
        allowedFiles: [],
        author: builder(models[id][0], models[id][1]),
        attempt: 1,
        commit: proven[id].commit,
      });
    }
    expect([verdicts["T-1"].verdict, verdicts["T-2"].verdict, verdicts["T-3"].verdict]).toEqual(["approve", "reject", "approve"]);
    // Jev's signed diff approval is what the merge gate reads (PR #7 writes it, PR #6 counts it), pinned to the reviewed commit.
    for (const id of ["T-1", "T-3"] as const) {
      expect(gate.state(id).diffApproval).toMatchObject({ n: verdicts[id].entry, commit: proven[id].commit, reviewer: { kind: "jev" }, byPerson: false });
    }
    const rejected = gate.reject("T-2", jevActor, verdicts["T-2"].notes as string[], { verdict: verdicts["T-2"].entry });
    expect(rejected).toMatchObject({ ok: true, newTaskId: "T-2.a2" });
    expect(last()).toMatchObject({ type: "task.reopened", subject: "T-2", actor: GATE_ACTOR, data: { attempt: "T-2.a2", verdict: verdicts["T-2"].entry } });
    const t2 = service.board().get("T-2")!;
    expect(t2).toMatchObject({ status: "open", owner: null, attempt: 2 });
    expect(attemptLabel(t2)).toBe("T-2.a2");
    expect(lookup(entries(), "T-2").ref).toBe("T-2.a2");
    step("Jev rejected the T-2 diff; T-2 reopened as T-2.a2 (T-1, T-3 approved)");

    // ---- 14. Approved work merges; the gate reruns the test after the merge before task.done.
    // Naming the owner is not their approval: without their own signed merge approval the gate refuses.
    expect(await gate.mergeAndVerify("T-1", { repoRoot: root, branch: "pp/T-1", integrationBranch: "main", actor: owner })).toMatchObject({ ok: false, reason: expect.stringMatching(/not been approved by a person/) });
    for (const id of ["T-1", "T-3"] as const) {
      const mergeApproval = gate.approveMerge(id, owner);
      expect(mergeApproval).toMatchObject({ ok: true, entry: { type: "review.verdict", actor: owner, evidence: ["scope:merge", "verdict:approve", `commit:${proven[id].commit}`] } });
      const merged = await gate.mergeAndVerify(id, { repoRoot: root, branch: `pp/${id}`, integrationBranch: "main", actor: owner });
      expect(merged.ok, `${id} merge: ${merged.ok ? "" : merged.reason}`).toBe(true);
      expect(merged.entries.map((e) => e.type)).toEqual(["test.passed", "merge.done", "task.done"]);
      expect(merged.entries[0]).toMatchObject({ actor: GATE_ACTOR, data: { phase: "merge", afterMerge: true } });
      // Only the gate writes task.done (PR #6), after the approved test passed on the merged code.
      expect(merged.entries[2]).toMatchObject({ actor: GATE_ACTOR, subject: id });
      expect(await git(root, ["rev-parse", "main"])).toBe(merged.ok ? merged.mergeCommit : "");
      expect(gate.state(id).stage).toBe("done");
      expect(service.board().get(id)!.status).toBe("done");
      expect(await worktrees.remove(id)).toMatchObject({ branchDeleted: true });
    }
    expect(await git(root, ["show", "main:src/registry.js"])).toBe(REGISTRY.replace("save: false", "save: true").trimEnd());
    expect(await git(root, ["show", "main:src/export.js"])).toContain("exportPlan");
    const refused = await gate.mergeAndVerify("T-2", { repoRoot: root, branch: "pp/T-2", integrationBranch: "main", actor: owner });
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/reopened as T-2\.a2/) });
    expect(await git(root, ["show", "main:src/registry.js"])).not.toContain("load: true");
    const afterMerge = await watcher.tick();
    expect(afterMerge.resolved).toEqual([{ tasks: ["T-1", "T-2"], files: ["src/registry.js"] }]);
    step("T-1 and T-3 merged, test rerun after merge, task.done; T-2 merge refused");

    // ---- 15. Worker B picks up attempt 2 with the same token; done is refused until its test passes again.
    expect(await service.call(workerB, "claim_task", { task: "T-2" })).toMatchObject({ task: "T-2.a2", status: "claimed" });
    expect(last()).toMatchObject({ type: "task.claimed", subject: "T-2.a2", actor: builder(workerB, "builder-b") });
    expect(service.board().get("T-2")).toMatchObject({ status: "claimed", owner: workerB.agent, attempt: 2 });
    expect(await service.call(workerB, "report_progress", { task: "T-2", text: "returning null for a missing plan" })).toMatchObject({ entry: expect.any(String) });
    expectLedgerError(() => ledger.append({ actor: owner, type: "task.done", subject: "T-2.a2", summary: "Finish attempt 2 without a pass" }), "DONE_WITHOUT_PASS");
    step("T-2.a2 reclaimed by worker B; task.done refused without a pass for the attempt");

    // ---- 16. lookup("P-1 §1") returns the clause, its task and its commit.
    const found = (await service.call(main, "lookup", { ref: "P-1 §1" })) as ReturnType<typeof lookup>;
    expect(found).toMatchObject({ found: true, kind: "clause", text: "Save", status: "active", tasks: ["T-1"], commits: [proven["T-1"].commit] });
    expect(found.history.map((e) => e.type)).toEqual(["clause.added"]);
    expect(lookup(entries(), "P-1 §2")).toMatchObject({ text: "Load", tasks: ["T-2"], commits: [proven["T-2"].commit] });
    step("lookup(P-1 §1) returned the clause with T-1 and its commit");

    // Nothing secret reached the ledger, and every Jev call carried the key from the provider.
    const allText = JSON.stringify(entries());
    expect(allText).not.toContain(PLANTED_KEY);
    expect(allText).not.toContain(JEV_KEY);
    expect(typesafe.calls.map((c) => c.kind)).toEqual(["test", "test", "test", "question", "diff", "diff", "diff"]);
    expect(typesafe.calls.every((c) => c.authorization === `Bearer ${JEV_KEY}`)).toBe(true);

    // Every entry was written by the kind of actor the spec allows.
    const kindOf = new Map<string, Set<string>>();
    for (const e of entries()) kindOf.set(e.type, (kindOf.get(e.type) ?? new Set()).add(e.actor.kind));
    expect([...kindOf.get("task.claimed")!]).toEqual(["agent"]);
    expect([...kindOf.get("question.asked")!]).toEqual(["agent"]);
    expect([...kindOf.get("test.approved")!]).toEqual(["person"]);
    // Every Jev verdict is signed by the app; the one jev-actor entry is the forgery from step 3.
    expect(entries().filter((e) => e.type === "review.verdict" && e.actor.kind === "jev").map((e) => e.summary)).toEqual(["Forged gaps on T-1's test"]);
    expect(entries().filter((e) => e.type === "review.verdict" && e.actor.kind === "system").every((e) => isAuthoritative(e) && (e.data?.reviewer as Actor | undefined)?.kind === "jev")).toBe(true);
    for (const type of ["test.passed", "test.failed", "commit.observed", "collision.detected", "collision.resolved", "worktree.created", "task.reopened"]) {
      expect([...kindOf.get(type)!], type).toEqual(["system"]);
    }
    // And nothing slipped past PR #4's table: every entry's actor kind may write its type, and only a person or the system finishes work.
    const allowed = (e: LedgerEntry) => {
      const table = DEFAULT_PERMISSIONS[e.actor.kind];
      return table === "any" || table.includes(e.type);
    };
    expect(entries().filter((e) => !allowed(e)).map((e) => `${e.n} ${e.actor.kind} ${e.type}`)).toEqual([]);
    for (const type of ["test.approved", "test.passed", "merge.done", "task.done", "task.reopened"]) {
      for (const kind of kindOf.get(type) ?? []) expect(["person", "system"], type).toContain(kind);
    }

    // ---- 17. Replay: the ledger alone rebuilds the identical board, also from disk, and the chain verifies.
    await watcher.stop();
    const liveBoard = service.board();
    const liveGate = ["T-1", "T-2", "T-2.a2", "T-3"].map((id) => gate.state(id));
    const liveLookup = lookup(entries(), "P-1 §1");
    const liveEntries: LedgerEntry[] = JSON.parse(JSON.stringify(entries()));
    expect(foldBoard(entries())).toEqual(liveBoard);
    expect(verifyChain(entries())).toEqual({ ok: true });
    ledger.close();

    ledger = Ledger.openSync(new FileStore(root), { readOnly: true, keys: signing });
    expect(ledger.status).toMatchObject({ ok: true, entries: liveEntries.length });
    expect(JSON.parse(JSON.stringify(ledger.entries()))).toEqual(liveEntries);
    expect(foldBoard(ledger.entries())).toEqual(liveBoard);
    expect(["T-1", "T-2", "T-2.a2", "T-3"].map((id) => deriveState(ledger.entries(), id))).toEqual(liveGate);
    expect(lookup(ledger.entries(), "P-1 §1")).toEqual(liveLookup);
    expect(verifyChain(ledger.entries())).toEqual({ ok: true });
    ledger.close();
    step("replayed ledger from disk rebuilt the identical board; chain verifies");

    // ---- 18. Someone with file access writes a forged task.done for T-2.a2 straight into the ledger file,
    //          correctly chained (hashes are public) but unsigned. It must not finish the task or stop re-dispatch.
    const ledgerDir = path.join(root, ".perfect-planner", "ledger");
    const ledgerFile = path.join(ledgerDir, readdirSync(ledgerDir).find((name) => name.endsWith(".jsonl"))!);
    const tip = liveEntries[liveEntries.length - 1];
    const forgedDone = { ...tip, n: `L-${String(Number(tip.n.slice(2)) + 1).padStart(6, "0")}`, prev: tip.hash, actor: GATE_ACTOR, type: "task.done", subject: "T-2.a2", summary: "T-2.a2 done", reason: undefined, refs: [], evidence: [`commit:${proven["T-2"].commit}`], data: { commit: proven["T-2"].commit } } as LedgerEntry;
    delete (forgedDone as Partial<LedgerEntry>).reason;
    forgedDone.hash = hashEntry(forgedDone);
    appendFileSync(ledgerFile, JSON.stringify(forgedDone) + "\n");
    writeFileSync(path.join(ledgerDir, "HEAD"), JSON.stringify({ n: forgedDone.n, hash: forgedDone.hash }));

    ledger = Ledger.openSync(new FileStore(root), { keys: signing });
    installNumberingRules(ledger);
    installClauseRules(ledger);
    ledger.addRule(gateRule());
    const forgedOnDisk = ledger.get(forgedDone.n)!;
    expect(forgedOnDisk).toMatchObject({ type: "task.done", subject: "T-2.a2" });
    expect(isAuthoritative(forgedOnDisk)).toBe(false);
    // Nothing reads it as done: not the board, not the gate.
    expect(foldBoard(ledger.entries()).get("T-2")).toMatchObject({ status: "claimed", owner: workerB.agent, attempt: 2 });
    expect(deriveState(ledger.entries(), "T-2.a2").stage).toBe(liveGate[2].stage);
    expect(liveGate[2].stage).not.toBe("done");
    expect(deriveState(ledger.entries(), "T-2.a2").done).toBeUndefined();
    // The ledger stops every write until a person has seen the break (PR #4), then work resumes.
    expect(ledger.status).toMatchObject({ ok: false, brokenAt: forgedDone.n, problem: "signature" });
    expectLedgerError(() => ledger.append({ actor: GATE_ACTOR, type: "task.reopened", subject: "T-2.a2", summary: "x", data: { attempt: "T-2.a3" } }), "CHAIN_BROKEN");
    ledger.acknowledgeBreak(owner, "That task.done was not written by Perfect Planner");
    expect(ledger.status).toMatchObject({ ok: true, acknowledged: [forgedDone.n] });
    expect(isAuthoritative(ledger.get(forgedDone.n)!)).toBe(false);
    // Re-dispatch: worker B (same token, so same agent after the restart) releases T-2; a new worker claims attempt 2.
    const restarted = new AgentService({ ledger, tokens, relay: new Relay({ ledger }) });
    const workerBAgain = { token: workerB.token, agent: ((await restarted.call({ token: workerB.token }, "hello", { name: "Worker B", model: "builder-b" })) as { agent: string }).agent };
    expect(workerBAgain.agent).toBe(workerB.agent);
    expect(await restarted.call(workerBAgain, "release_task", { task: "T-2", reason: "Handing attempt 2 over" })).toMatchObject({ status: "open" });
    const workerDToken = tokens.issue({ role: "worker", person: "owner", task: "T-2", model: "builder-d" });
    const workerD = { token: workerDToken, agent: ((await restarted.call({ token: workerDToken }, "hello", { name: "Worker D", model: "builder-d" })) as { agent: string }).agent };
    expect(await restarted.call(workerD, "claim_task", { task: "T-2" })).toMatchObject({ task: "T-2.a2", status: "claimed" });
    expect(restarted.board().get("T-2")).toMatchObject({ status: "claimed", owner: workerD.agent, attempt: 2 });
    ledger.close();
    step("forged task.done on disk: not done on board or gate; writes paused until the owner acknowledged; T-2.a2 re-dispatched to worker D");

    // Remaining worktrees hold unmerged work; leave them for the temp cleanup.
    expect((await worktrees.list()).map((info) => info.taskId)).toEqual(["T-2"]);
    console.log(`whole loop: ${steps.length} steps\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
  }, 600_000);
});
