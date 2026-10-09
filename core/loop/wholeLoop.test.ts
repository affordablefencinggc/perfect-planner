// The whole core loop in one run, on a real git repo and a real ledger file:
// plan -> done-when test (fails first, Jev reviews, person approves) -> worktree
// -> worker checks in over MCP, claims, asks the main chat, commits -> watcher
// -> gate proves in the worktree -> Jev reviews the diff -> merge and verify -> done.
// Jev is the real reviewer and transport with a fake key and a fake fetch; no network.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PERMISSIONS, FileStore, Ledger, LedgerError, verifyChain, type Actor, type EntryType, type LedgerEntry } from "../ledger/index";
import { installNumberingRules } from "../numbering/index";
import { installClauseRules } from "../lookup/index";
import { WorktreeManager } from "../worktrees/manager";
import { git } from "../worktrees/git";
import { commitAll, makeRepo, writeFiles } from "../worktrees/testing";
import { GitWatcher } from "../watcher/index";
import { TestGate, gateRule } from "../gate/index";
import { JevReviewer, MemoryKeyProvider, createJevTransport, type JevRequest } from "../jev/index";
import { Relay } from "../relay/index";
import { AgentService, TokenStore, ToolError, type Caller } from "../mcp/index";

const OWNER: Actor = { kind: "person", id: "owner" };
const FAKE_KEY = "ts_live_FAKE0123456789abcdef";
const JEV_RAN_AS = "jev-2026-09";
const CLAUSE = { ref: "P-1 §2.1", text: "Invoice sending is enabled for every customer." };
const COMMAND = "node check.mjs";
const CHECK = `import { readFileSync } from "node:fs";
if (!readFileSync("feature.txt", "utf8").includes("enabled")) { console.error("invoice sending is off"); process.exit(1); }
console.log("ok");
`;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/**
 * A stand-in for TypeSafe's endpoint. Approves tests and diffs with high
 * confidence; for a "settled" question it picks the option named in
 * `settle` (confident) or is unsure when the question is not listed.
 */
function fakeJev(settle: Record<string, string>) {
  const seen: { auth: string; body: JevRequest }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as JevRequest;
    seen.push({ auth: (init!.headers as Record<string, string>).Authorization!, body });
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const name of Object.keys(body.questions)) {
      if (name === "settled") {
        const wanted = settle[String(body.state.question)];
        const options = Object.keys(body.questions.settled!.criteria);
        const index = wanted ? options.findIndex((o) => body.questions.settled!.criteria[o] === wanted) : -1;
        answers[name] = index >= 0 ? { choice: options[index]!, confidence: 0.95 } : { choice: "not_settled", confidence: 0.4 };
      } else {
        const good: Record<string, string> = { covers_clauses: "all", trivially_passing: "no", weakest_clause: "none", weakens_tests: "no", stays_in_scope: "yes" };
        answers[name] = { choice: good[name]!, confidence: 0.93 };
      }
    }
    return new Response(JSON.stringify({ model: JEV_RAN_AS, answers, usage: { cost_usd: 0.01 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

async function expectTool(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe(code);
}

function expectNotPermitted(write: () => unknown) {
  let error: unknown = null;
  try {
    write();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe("NOT_PERMITTED");
}

describe("the whole core loop", () => {
  it("takes one task from plan to done with a clean ledger chain, enforced permissions and the one-chat relay", async () => {
    // ---------- a project: real repo, ledger file in the repo, every rule on ----------
    const repo = await makeRepo({ "check.mjs": CHECK, "feature.txt": "invoice sending: off\n" });
    cleanups.push(repo.cleanup);
    const root = repo.root;
    const ledger = await Ledger.open(new FileStore(root));
    cleanups.push(() => ledger.close());
    installNumberingRules(ledger);
    installClauseRules(ledger);
    ledger.addRule(gateRule());

    // ---------- Jev: real reviewer and transport, key from the key provider, fake endpoint ----------
    const keys = new MemoryKeyProvider(FAKE_KEY);
    const jevApi = fakeJev({ "Which date format do invoices use?": "ISO 8601" });
    const reviewer = new JevReviewer({ ledger, transport: createJevTransport({ keys, fetchImpl: jevApi.fetchImpl }) });
    reviewer.planClauses = () => [CLAUSE, { ref: "P-1 §2.2", text: "Invoice dates are written as ISO 8601." }];
    const relay = new Relay({ ledger, settled: reviewer });
    cleanups.push(() => relay.dispose());
    const tokens = new TokenStore();
    const service = new AgentService({ ledger, tokens, relay });
    const gate = new TestGate({ ledger, timeoutMs: 30_000 });
    const worktrees = new WorktreeManager({ repoRoot: root, ledger, install: false });
    const watcher = new GitWatcher({ ledger, worktrees: () => worktrees.list() });
    cleanups.push(() => watcher.stop());

    // ---------- 1. the owner plans a task citing a clause ----------
    ledger.append({ actor: OWNER, type: "task.created", subject: "T-1", summary: "Finish invoice sending", refs: [CLAUSE.ref], data: { title: "Finish invoice sending" } });

    // ---------- 2. agents check in; the first one is the main chat ----------
    const mainToken = tokens.issue({ role: "connect", person: "owner" });
    const main = { token: mainToken, agent: ((await service.call({ token: mainToken }, "hello", { name: "Main chat", model: "claude-main" })) as { agent: string; role: string }).agent };
    const workerToken = tokens.issue({ role: "worker", person: "owner", task: "T-1" });
    const workerHello = (await service.call({ token: workerToken }, "hello", { name: "Worker one", model: "claude-worker" })) as { agent: string; role: string };
    expect(workerHello.role).toBe("worker");
    const worker: Caller = { token: workerToken, agent: workerHello.agent };
    const workerActor: Actor = { kind: "agent", id: worker.agent!, model: "claude-worker" };

    // ---------- 3. test first: the worker may not start before the done-when test is approved ----------
    await expectTool(service.call(worker, "claim_task", { task: "T-1" }), "REFUSED");
    expect(gate.define("T-1", COMMAND, workerActor, [CLAUSE.ref]).ok).toBe(true);
    const baseline = await gate.confirmFailsFirst("T-1", root);
    expect(baseline.ok).toBe(true);
    expect(baseline.run?.outputTail).toContain("invoice sending is off");

    const testReview = await reviewer.reviewTest({ task: "T-1", title: "Finish invoice sending", clauses: [CLAUSE], test: { command: COMMAND, source: CHECK }, failsFirst: true, author: workerActor });
    expect(testReview.verdict).toBe("approve");
    // Jev cannot approve the test itself, and neither can the agent that wrote it.
    expectNotPermitted(() => ledger.append({ actor: { kind: "jev", id: "jev", model: JEV_RAN_AS }, type: "test.approved", subject: "T-1", summary: "Jev approving", data: { test: COMMAND } }));
    expectNotPermitted(() => ledger.append({ actor: workerActor, type: "test.approved", subject: "T-1", summary: "Self-approval", data: { test: COMMAND } }));
    expect(gate.canStart("T-1").ok).toBe(false);
    expect(gate.approve("T-1", OWNER, { jevVerdict: "approve", jev: { kind: "jev", id: "jev", model: JEV_RAN_AS } }).ok).toBe(true);
    expect(gate.canStart("T-1").ok).toBe(true);

    // ---------- 4. worktree per task; the worker claims it ----------
    const wt = await worktrees.create({ taskId: "T-1", actor: OWNER, baseRef: "main", claims: ["feature.txt"] });
    expect(wt.branch).toBe("pp/T-1");
    expect(path.relative(root, wt.path).split(path.sep).join("/")).toBe(".perfect-planner/worktrees/T-1");
    expect(await service.call(worker, "claim_task", { task: "T-1" })).toMatchObject({ status: "claimed" });

    // ---------- 5. one chat: questions go to the main chat, settled ones come straight back ----------
    // The plan settles this one: Jev answers, the relay records it (Jev may only write verdicts).
    const settled = (await service.call(worker, "ask_main", { task: "T-1", question: "Which date format do invoices use?", options: ["Locale", "ISO 8601"] })) as { q: string; status: string; answer: string; via: string };
    expect(settled).toMatchObject({ status: "answered", answer: "ISO 8601", via: "settled" });
    const settledEntry = ledger.entries().find((e) => e.type === "question.answered" && e.subject === settled.q)!;
    expect(settledEntry.actor.kind).toBe("system");
    expect(settledEntry.refs.some((r) => ledger.get(r)?.type === "review.verdict")).toBe(true);

    // The plan is silent on this one: it waits for the main chat and pauses only this worker.
    const open = (await service.call(worker, "ask_main", { task: "T-1", question: "Send to archived customers?", options: ["Yes", "No"], blocking: true })) as { q: string; status: string; paused: boolean };
    expect(open).toMatchObject({ status: "open", paused: true });
    await expectTool(service.call(worker, "report_progress", { task: "T-1", text: "carrying on anyway" }), "PAUSED");
    await expectTool(service.call(worker, "answer", { question: open.q, text: "Yes" }), "FORBIDDEN");
    const digest = (await service.call(main, "check_inbox", {})) as { open: number; blocking: number; lines: string[]; autoAnswered: string[] };
    expect(digest).toMatchObject({ open: 1, blocking: 1 });
    expect(digest.lines[0]).toContain(open.q);
    expect(digest.autoAnswered.join("\n")).toContain(settled.q);
    const answered = (await service.call(main, "answer", { question: open.q, text: "No" })) as { decision: string };
    expect(answered.decision).toMatch(/^D-\d+$/);
    const inbox = (await service.call(worker, "check_inbox", {})) as { answers: { q: string; answer: string; decision: string }[]; paused: boolean };
    expect(inbox.paused).toBe(false);
    expect(inbox.answers).toEqual(expect.arrayContaining([expect.objectContaining({ q: open.q, answer: "No", decision: answered.decision, via: "main" })]));
    // Asked again, the decision answers it without the main chat.
    expect(await service.call(worker, "ask_main", { task: "T-1", question: "Send to archived customers?", options: ["No", "Yes"] })).toMatchObject({ status: "answered", answer: "No", via: "decision" });

    // ---------- 6. the worker builds in its worktree; the watcher records the commit ----------
    writeFiles(wt.path, { "feature.txt": "invoice sending: enabled\n" });
    const sha = await commitAll(wt.path, `Enable invoice sending\n\nImplements: ${CLAUSE.ref} (T-1)`);
    await service.call(worker, "report_progress", { task: "T-1", text: "Enabled invoice sending" });
    await service.call(worker, "attach_proof", { task: "T-1", kind: "commit", link: sha });
    // Proof is not done, and an agent cannot declare it.
    expectNotPermitted(() => ledger.append({ actor: workerActor, type: "task.done", subject: "T-1", summary: "Done, trust me" }));
    expectNotPermitted(() => ledger.append({ actor: workerActor, type: "test.passed", subject: "T-1", summary: "It passed", data: { test: COMMAND } }));
    const tick = await watcher.tick();
    expect(tick.errors).toEqual([]);
    const observed = ledger.entries().find((e) => e.type === "commit.observed" && e.subject === "T-1")!;
    expect(observed.data).toMatchObject({ sha, files: ["feature.txt"] });
    expect(observed.refs).toContain(CLAUSE.ref);

    // ---------- 7. the gate proves it in the worktree, Jev reviews the diff, the gate merges ----------
    expect(await gate.prove("T-1", wt.path)).toMatchObject({ ok: true, commit: sha });
    const diff = await git(wt.path, ["diff", wt.baseSha, sha]);
    const diffReview = await reviewer.reviewDiff({ task: "T-1", clauses: [CLAUSE], diff, testOutput: "ok", allowedFiles: ["feature.txt"], author: workerActor });
    expect(diffReview.verdict).toBe("approve");
    const merged = await gate.mergeAndVerify("T-1", { repoRoot: root, branch: wt.branch, integrationBranch: "main", actor: OWNER });
    expect(merged.ok).toBe(true);
    expect(gate.state("T-1").done).toBeTruthy();
    expect(await git(root, ["show", "main:feature.txt"])).toContain("enabled");
    expect(await worktrees.remove("T-1")).toMatchObject({ branchDeleted: true });
    expect(await service.call(worker, "list_tasks", {})).toMatchObject({ tasks: [{ id: "T-1", status: "done", testApproved: true }] });

    // ---------- 8. the ledger tells the whole story, in order, and its chain holds on disk ----------
    const types = ledger.entries().map((e) => e.type);
    const order: EntryType[] = ["task.created", "test.defined", "test.failed", "review.verdict", "test.approved", "worktree.created", "task.claimed", "question.asked", "commit.observed", "test.passed", "merge.done", "task.done", "worktree.removed"];
    let at = -1;
    for (const type of order) {
      const next = types.indexOf(type, at + 1);
      expect(next, `${type} after ${order[order.indexOf(type) - 1] ?? "start"}`).toBeGreaterThan(at);
      at = next;
    }
    const passedAfterMerge = ledger.entries().find((e) => e.type === "test.passed" && (e.data as { afterMerge?: boolean } | undefined)?.afterMerge === true);
    expect(passedAfterMerge).toBeTruthy();

    // Every entry was written by an actor kind allowed to write it.
    const allowed = (e: LedgerEntry) => {
      const table = DEFAULT_PERMISSIONS[e.actor.kind];
      return table === "any" || table.includes(e.type);
    };
    expect(ledger.entries().filter((e) => !allowed(e)).map((e) => `${e.n} ${e.actor.kind} ${e.type}`)).toEqual([]);
    for (const type of ["test.approved", "test.passed", "merge.done", "task.done"]) {
      for (const e of ledger.entries().filter((x) => x.type === type)) expect(["person", "system"], `${e.n} ${type}`).toContain(e.actor.kind);
    }

    // The key reached Jev only as the bearer header, never in a request body or the ledger.
    expect(jevApi.seen.length).toBeGreaterThanOrEqual(3);
    for (const call of jevApi.seen) {
      expect(call.auth).toBe(`Bearer ${FAKE_KEY}`);
      expect(JSON.stringify(call.body)).not.toContain(FAKE_KEY);
    }
    const count = ledger.entries().length;
    expect(JSON.stringify(ledger.entries())).not.toContain(FAKE_KEY);
    expect(verifyChain(ledger.entries())).toEqual({ ok: true });

    // Reopened from disk, read-only: same entries, chain intact.
    const reread = await Ledger.open(new FileStore(root), { readOnly: true });
    cleanups.push(() => reread.close());
    expect(reread.entries().length).toBe(count);
    expect(verifyChain(reread.entries())).toEqual({ ok: true });
    expect(reread.entries().at(-1)!.hash).toBe(ledger.entries().at(-1)!.hash);
  }, 120_000);
});
