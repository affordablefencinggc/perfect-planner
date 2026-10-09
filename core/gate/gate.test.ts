import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore, type Actor } from "../ledger/index";
import { git } from "../worktrees/git";
import { realDir } from "../worktrees/platform";
import { commitAll, makeRepo, memoryLedger, writeFiles } from "../worktrees/testing";
import { TestGate, commandExists, deriveState, gateRule, isConclusiveFailure, nextAttemptId, runTestCommand, scrubbedEnv } from "./index";

const OWNER: Actor = { kind: "person", id: "owner" };
const GATE: Actor = { kind: "system", id: "gate" };
const WORKER: Actor = { kind: "agent", id: "worker-1", model: "test-model" };
const JEV: Actor = { kind: "jev", id: "jev", model: "test-model" };
const SLOW = 60_000;

const CHECK = `import { existsSync, readFileSync } from "node:fs";
const feature = readFileSync("feature.txt", "utf8");
if (!feature.includes("enabled")) { console.error("feature is not enabled"); process.exit(1); }
if (existsSync("kill-switch.txt")) { console.error("kill switch is on"); process.exit(1); }
console.log("ok");
`;
const COMMAND = "node check.mjs";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function setup(taskId = "T-1") {
  const repo = await makeRepo({ "check.mjs": CHECK, "feature.txt": "disabled\n" });
  cleanups.push(repo.cleanup);
  const ledger = await memoryLedger();
  const gate = new TestGate({ ledger, timeoutMs: 30_000 });
  const worktree = path.join(path.dirname(repo.root), `wt-${taskId}`);
  const branch = `pp/${taskId}`;
  const addWorktree = () => git(repo.root, ["worktree", "add", "-q", "-b", branch, worktree, "main"]);
  return { root: repo.root, ledger, gate, worktree, branch, addWorktree };
}

/** define -> a person approves -> baseline fails. */
async function approved(taskId = "T-1") {
  const ctx = await setup(taskId);
  expect(ctx.gate.define(taskId, COMMAND, WORKER).ok).toBe(true);
  expect(ctx.gate.approve(taskId, OWNER, { cwd: ctx.root }).ok).toBe(true);
  expect((await ctx.gate.confirmFailsFirst(taskId, ctx.root)).ok).toBe(true);
  return ctx;
}

/** Jev approves the diff at the branch tip, the owner signs the merge approval, then merges. */
async function reviewAndMerge(ctx: { root: string; gate: TestGate; branch: string }, taskId = "T-1", integrationBranch = "main") {
  const tip = await head(ctx.root, ctx.branch);
  expect(ctx.gate.approveDiff(taskId, JEV, tip).ok).toBe(true);
  expect(ctx.gate.approveMerge(taskId, OWNER, tip).ok).toBe(true);
  return ctx.gate.mergeAndVerify(taskId, { repoRoot: ctx.root, branch: ctx.branch, integrationBranch, actor: OWNER });
}

const types = (ledger: Ledger) => ledger.entries().map((entry) => entry.type);
const head = (cwd: string, ref = "HEAD") => git(cwd, ["rev-parse", ref]);

describe("TestGate", () => {
  it("runs the full happy path and advances the checked-out integration branch", async () => {
    const { root, ledger, gate, worktree, branch, addWorktree } = await setup();
    ledger.addRule(gateRule());

    expect(gate.define("T-1", COMMAND, WORKER, ["P-1 §2"]).ok).toBe(true);
    expect(gate.canStart("T-1").ok).toBe(false);
    const approval = gate.approve("T-1", OWNER, { cwd: root, jevVerdict: "approve", jev: JEV });
    expect(approval.ok).toBe(true);
    expect(gate.canStart("T-1").ok).toBe(false);
    const baseline = await gate.confirmFailsFirst("T-1", root);
    expect(baseline.ok).toBe(true);
    expect(baseline.run?.outputTail).toContain("feature is not enabled");
    expect(gate.canStart("T-1")).toMatchObject({ ok: true });
    ledger.append({ type: "task.claimed", actor: WORKER, subject: "T-1", summary: "Claimed by worker 1" });

    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    const work = await commitAll(worktree, "enable feature");
    ledger.append({ type: "commit.observed", actor: { kind: "system", id: "watcher" }, subject: "T-1", summary: "Commit on pp/T-1", data: { sha: work } });

    const proof = await gate.prove("T-1", worktree);
    expect(proof).toMatchObject({ ok: true, commit: work });
    expect(gate.state("T-1").stage).toBe("proven");

    const before = await head(root, "main");
    expect(gate.approveDiff("T-1", JEV).ok).toBe(true);
    expect(gate.approveMerge("T-1", OWNER).ok).toBe(true);
    const merged = await gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "main", actor: OWNER });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(await head(root, "main")).toBe(merged.mergeCommit);
    expect(await head(root, "main")).not.toBe(before);
    // main's own checkout moved with it, cleanly.
    expect(readFileSync(path.join(root, "feature.txt"), "utf8")).toBe("enabled\n");
    expect(await git(root, ["status", "--porcelain"])).toBe("");
    expect((await git(root, ["rev-list", "--parents", "-n", "1", "main"])).split(" ")).toHaveLength(3);
    // The temporary candidate worktree is gone.
    expect((await git(root, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(2);

    expect(types(ledger)).toEqual([
      "test.defined",
      "review.verdict",
      "test.approved",
      "test.failed",
      "task.claimed",
      "commit.observed",
      "test.passed",
      "review.verdict",
      "review.verdict",
      "test.passed",
      "merge.done",
      "task.done",
    ]);
    const mergePass = ledger.entries()[9]!;
    expect(mergePass.data).toMatchObject({ test: COMMAND, afterMerge: true, phase: "merge", commit: merged.mergeCommit });
    expect(mergePass.evidence).toContain(`commit:${merged.mergeCommit}`);
    const state = gate.state("T-1");
    expect(state).toMatchObject({ stage: "done", merged: { commit: merged.mergeCommit } });
    expect(gate.canStart("T-1").ok).toBe(false);
  }, SLOW);

  it("an agent cannot rewrite its approved test and then finish the task", async () => {
    const { root, ledger, gate, worktree, branch, addWorktree } = await approved();
    ledger.addRule(gateRule());
    await addWorktree();
    // Instead of doing the work, the agent turns the test into one that always passes.
    writeFiles(worktree, { "check.mjs": 'console.log("ok");\n' });
    const cheat = await commitAll(worktree, "simplify the check");
    const proof = await gate.prove("T-1", worktree);
    expect(proof).toMatchObject({ ok: false, reason: expect.stringContaining("check.mjs") });
    expect(proof.ok ? "" : proof.reason).toMatch(/approved test/);
    expect(gate.state("T-1").passedCommits).not.toContain(cheat);
    expect(ledger.entries().filter((entry) => entry.type === "test.passed")).toHaveLength(0);
    const merged = await gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "main", actor: OWNER });
    expect(merged.ok).toBe(false);
    expect(types(ledger)).not.toContain("task.done");
    expect(() => gate.assertCanFinish("T-1", cheat)).toThrow();

    // Putting the test back and doing the real work still finishes normally.
    writeFiles(worktree, { "check.mjs": CHECK, "feature.txt": "enabled\n" });
    await commitAll(worktree, "restore the test and enable the feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    expect((await reviewAndMerge({ root, gate, branch })).ok).toBe(true);
  }, SLOW);

  it("pins the approved test by content hash, ignoring only line endings", async () => {
    const { gate, worktree, addWorktree } = await approved();
    const approval = gate.state("T-1").approval!;
    expect(approval.pins).toEqual({ "check.mjs": expect.stringMatching(/^[0-9a-f]{64}$/) });
    await addWorktree();
    writeFiles(worktree, { "check.mjs": CHECK.replace(/\n/g, "\r\n"), "feature.txt": "enabled\n" });
    await commitAll(worktree, "CRLF checkout of the same test");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
  }, SLOW);

  it("refuses to approve a test whose files it cannot pin, unless they are named", async () => {
    const { root, gate } = await setup();
    gate.define("T-1", 'node -e "process.exit(1)"', WORKER);
    expect(gate.approve("T-1", OWNER, { cwd: root })).toMatchObject({ ok: false, reason: expect.stringContaining("test file") });
    gate.define("T-1", 'node -e "process.exit(1)"', WORKER, [], { files: ["check.mjs"] });
    expect(gate.approve("T-1", OWNER, { cwd: root }).ok).toBe(true);
    expect((await gate.confirmFailsFirst("T-1", root)).ok).toBe(true);
    expect(Object.keys(gate.state("T-1").approval!.pins)).toEqual(["check.mjs"]);
  });

  it("only the gate may write task.done", async () => {
    const { root, ledger, gate, worktree, branch, addWorktree } = await approved();
    ledger.addRule(gateRule());
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    const work = await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    for (const actor of [OWNER, WORKER, { kind: "system", id: "watcher" } as Actor]) {
      // The ledger's own permission table already stops agents; the gate rule stops everyone else.
      expect(() => ledger.append({ type: "task.done", actor, subject: "T-1", summary: "Done", evidence: [`commit:${work}`] })).toThrow(actor.kind === "agent" ? /may not write/ : /only the gate/);
    }
    const merged = await reviewAndMerge({ root, gate, branch });
    expect(merged.ok).toBe(true);
    expect(ledger.entries().at(-1)).toMatchObject({ type: "task.done", actor: { kind: "system", id: "gate" }, data: { approvedBy: OWNER } });
  }, SLOW);

  it("fast-forwards an integration branch that is not checked out with update-ref", async () => {
    const { root, gate, worktree, branch, addWorktree } = await approved();
    await git(root, ["branch", "integration", "main"]);
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    const mainBefore = await head(root, "main");
    const merged = await reviewAndMerge({ root, gate, branch }, "T-1", "integration");
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(await head(root, "integration")).toBe(merged.mergeCommit);
    expect(await head(root, "main")).toBe(mainBefore);
  }, SLOW);

  it("refuses a test that already passes on the current code", async () => {
    const { root, gate, ledger } = await setup();
    gate.define("T-1", 'node -e "process.exit(0)"', WORKER, [], { files: ["check.mjs"] });
    expect(gate.approve("T-1", OWNER, { cwd: root }).ok).toBe(true);
    const baseline = await gate.confirmFailsFirst("T-1", root);
    expect(baseline).toMatchObject({ ok: false, reason: expect.stringContaining("already passes") });
    expect(ledger.entries().at(-1)).toMatchObject({ type: "test.passed", data: { phase: "baseline" } });
    expect(gate.canStart("T-1")).toMatchObject({ ok: false, reason: expect.stringContaining("already passes") });
    expect(gate.state("T-1").stage).toBe("baseline-passes");
  });

  it("never runs an agent's test before a person approves it", async () => {
    const { root, gate, ledger } = await setup();
    expect(gate.approve("T-1", OWNER, { cwd: root }).ok).toBe(false);
    gate.define("T-1", COMMAND, WORKER);
    let ran = false;
    const watched = new TestGate({ ledger, run: async () => { ran = true; throw new Error("must not run"); } });
    expect(await watched.confirmFailsFirst("T-1", root)).toMatchObject({ ok: false, reason: expect.stringContaining("approved by a person") });
    expect(ran).toBe(false);
    expect(gate.approve("T-1", WORKER, { cwd: root })).toMatchObject({ ok: false, reason: expect.stringContaining("Only a person") });
    expect(gate.approve("T-1", JEV, { cwd: root }).ok).toBe(false);
    expect(types(ledger)).toEqual(["test.defined"]);
  });

  it("refuses the first run when the test files changed after approval", async () => {
    const { root, gate, ledger } = await setup();
    gate.define("T-1", COMMAND, WORKER);
    expect(gate.approve("T-1", OWNER, { cwd: root }).ok).toBe(true);
    writeFiles(root, { "check.mjs": "process.exit(1);\n" });
    expect(await gate.confirmFailsFirst("T-1", root)).toMatchObject({ ok: false, reason: expect.stringContaining("check.mjs") });
    expect(ledger.entries().at(-1)?.data).toMatchObject({ conclusive: false, tampered: ["check.mjs"] });
    expect(gate.canStart("T-1").ok).toBe(false);
  });

  it("a redefined test invalidates the earlier approval", async () => {
    const { root, gate } = await approved();
    expect(gate.canStart("T-1").ok).toBe(true);
    gate.define("T-1", "node check.mjs --strict", WORKER);
    expect(gate.canStart("T-1")).toMatchObject({ ok: false, reason: expect.stringContaining("waiting for the owner") });
    expect((await gate.confirmFailsFirst("T-1", root)).ok).toBe(false);
    expect(gate.approve("T-1", OWNER, { cwd: root }).ok).toBe(true);
    expect(gate.canStart("T-1")).toMatchObject({ ok: false, reason: expect.stringContaining("not been run") });
    expect((await gate.confirmFailsFirst("T-1", root)).ok).toBe(true);
    expect(gate.state("T-1").definition?.command).toBe("node check.mjs --strict");
    expect(gate.canStart("T-1").ok).toBe(true);
  });

  it("a failing worktree run goes back with the output; dirty worktrees are refused", async () => {
    const { gate, ledger, worktree, addWorktree } = await approved();
    expect((await gate.prove("T-1", worktree)).ok).toBe(false);
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "still disabled\n" });
    expect(await gate.prove("T-1", worktree)).toMatchObject({ ok: false, reason: expect.stringContaining("Commit or remove") });
    const sha = await commitAll(worktree, "not quite");
    const proof = await gate.prove("T-1", worktree);
    expect(proof.ok).toBe(false);
    if (proof.ok) return;
    expect(proof.output).toContain("feature is not enabled");
    expect(ledger.entries().at(-1)).toMatchObject({ type: "test.failed", data: { phase: "worktree", commit: sha } });
    expect(gate.state("T-1").worktree).toMatchObject({ passed: false, commit: sha });
  });

  it("does not finish when the test passes in the worktree but fails after merge", async () => {
    const { root, ledger, gate, worktree, branch, addWorktree } = await approved();
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    // Meanwhile integration gains a commit that breaks the task's behaviour without touching its files.
    writeFiles(root, { "kill-switch.txt": "on\n" });
    const mainBefore = await commitAll(root, "add kill switch");

    const merged = await reviewAndMerge({ root, gate, branch });
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.output).toContain("kill switch is on");
    expect(await head(root, "main")).toBe(mainBefore);
    expect(await git(root, ["status", "--porcelain"])).toBe("");
    expect(types(ledger)).not.toContain("task.done");
    expect(types(ledger)).not.toContain("merge.done");
    expect(ledger.entries().at(-1)).toMatchObject({ type: "test.failed", data: { phase: "merge", afterMerge: true } });
    expect(gate.state("T-1").merge).toMatchObject({ passed: false });
    expect((await git(root, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(2);
  }, SLOW);

  it("handles a merge conflict without touching integration", async () => {
    const { root, ledger, gate, worktree, branch, addWorktree } = await approved();
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    writeFiles(root, { "feature.txt": "off for now\n" });
    const mainBefore = await commitAll(root, "turn feature off");

    const merged = await reviewAndMerge({ root, gate, branch });
    expect(merged).toMatchObject({ ok: false, reason: expect.stringContaining("Merge conflict") });
    expect(await head(root, "main")).toBe(mainBefore);
    const last = ledger.entries().at(-1)!;
    expect(last).toMatchObject({ type: "test.failed", reason: "Merge conflict in feature.txt" });
    expect(last.evidence).toContain("file:feature.txt");
    expect(types(ledger)).not.toContain("task.done");
    expect((await git(root, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(2);
  }, SLOW);

  it("refuses to merge into a dirty integration checkout", async () => {
    const { root, ledger, gate, worktree, branch, addWorktree } = await approved();
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    const mainBefore = await head(root, "main");
    writeFiles(root, { "check.mjs": `${CHECK}// local edit\n` });
    const merged = await reviewAndMerge({ root, gate, branch });
    expect(merged).toMatchObject({ ok: false, reason: expect.stringContaining("uncommitted changes") });
    expect(await head(root, "main")).toBe(mainBefore);
    expect(types(ledger)).not.toContain("task.done");
  }, SLOW);

  it("refuses to merge a branch whose tip has not passed in the worktree", async () => {
    const { root, gate, worktree, branch, addWorktree } = await approved();
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    writeFiles(worktree, { "extra.txt": "late change\n" });
    await commitAll(worktree, "late change");
    expect(await gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "main", actor: OWNER })).toMatchObject({ ok: false, reason: expect.stringContaining("Run prove first") });
  }, SLOW);

  it("merges only a diff Jev or a person approved at the branch tip, on a person's say-so", async () => {
    const { root, gate, ledger, worktree, branch, addWorktree } = await approved();
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    const work = await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    const merge = (actor: Actor) => gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "main", actor });
    expect(await merge(OWNER)).toMatchObject({ ok: false, reason: expect.stringContaining("not been approved") });
    expect(gate.approveDiff("T-1", WORKER, work)).toMatchObject({ ok: false, reason: expect.stringContaining("Only Jev or a person") });
    expect(gate.approveDiff("T-1", JEV).ok).toBe(true);
    expect(await merge({ kind: "system", id: "anything" })).toMatchObject({ ok: false, reason: expect.stringContaining("A person approves the merge") });
    expect(types(ledger)).not.toContain("merge.done");
    expect(gate.approveMerge("T-1", OWNER, work).ok).toBe(true);
    expect((await merge(OWNER)).ok).toBe(true);
  }, SLOW);

  it("runs the post-merge test with the project's dependencies and leaves them in place", async () => {
    const repo = await makeRepo({ "needs-dep.mjs": 'import { ready } from "pp-fake-dep";\nimport { readFileSync } from "node:fs";\nprocess.exit(ready && readFileSync("feature.txt", "utf8").includes("enabled") ? 0 : 1);\n', "feature.txt": "disabled\n" });
    cleanups.push(repo.cleanup);
    writeFileSync(path.join(repo.root, ".git", "info", "exclude"), "node_modules/\n");
    writeFiles(repo.root, { "node_modules/pp-fake-dep/package.json": '{"name":"pp-fake-dep","type":"module","main":"index.js"}\n', "node_modules/pp-fake-dep/index.js": "export const ready = true;\n" });
    const ledger = await memoryLedger();
    const gate = new TestGate({ ledger, timeoutMs: 30_000 });
    gate.define("T-1", "node needs-dep.mjs", WORKER);
    expect(gate.approve("T-1", OWNER, { cwd: repo.root }).ok).toBe(true);
    expect((await gate.confirmFailsFirst("T-1", repo.root)).ok).toBe(true);
    const worktree = path.join(path.dirname(repo.root), "wt-deps");
    cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
    await git(repo.root, ["worktree", "add", "-q", "-b", "pp/T-1", worktree, "main"]);
    writeFiles(worktree, { "feature.txt": "enabled\n", "node_modules/pp-fake-dep/package.json": '{"name":"pp-fake-dep","type":"module","main":"index.js"}\n', "node_modules/pp-fake-dep/index.js": "export const ready = true;\n" });
    writeFileSync(path.join(worktree, ".gitignore"), "node_modules/\n");
    await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    const merged = await reviewAndMerge({ root: repo.root, gate, branch: "pp/T-1" });
    expect(merged.ok).toBe(true);
    expect(existsSync(path.join(worktree, "node_modules", "pp-fake-dep", "index.js"))).toBe(true);
    expect(existsSync(path.join(repo.root, "node_modules", "pp-fake-dep", "index.js"))).toBe(true);
  }, SLOW);

  it("never lets a worker's own node_modules decide the merge check", async () => {
    const dep = (body: string) => ({ "node_modules/pp-fake-dep/package.json": '{"name":"pp-fake-dep","type":"module","main":"index.js"}\n', "node_modules/pp-fake-dep/index.js": body });
    const repo = await makeRepo({ "needs-dep.mjs": 'import { enabled } from "pp-fake-dep";\nimport { readFileSync } from "node:fs";\nprocess.exit(enabled(readFileSync("feature.txt", "utf8")) ? 0 : 1);\n', "feature.txt": "disabled\n", ".gitignore": "node_modules/\n" });
    cleanups.push(repo.cleanup);
    writeFiles(repo.root, dep('export const enabled = (text) => text.includes("enabled") && !text.includes("disabled");\n'));
    const ledger = await memoryLedger();
    const gate = new TestGate({ ledger, timeoutMs: 30_000 });
    gate.define("T-1", "node needs-dep.mjs", WORKER);
    expect(gate.approve("T-1", OWNER, { cwd: repo.root }).ok).toBe(true);
    expect((await gate.confirmFailsFirst("T-1", repo.root)).ok).toBe(true);
    const worktree = path.join(path.dirname(repo.root), "wt-cheat");
    cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
    await git(repo.root, ["worktree", "add", "-q", "-b", "pp/T-1", worktree, "main"]);
    // The worker leaves the feature off but rewrites its ignored copy of the dependency to always say yes.
    writeFiles(worktree, { ...dep("export const enabled = () => true;\n"), "notes.txt": "no real change\n" });
    await commitAll(worktree, "looks done");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    const merged = await reviewAndMerge({ root: repo.root, gate, branch: "pp/T-1" });
    expect(merged.ok).toBe(false);
    expect(types(ledger)).not.toContain("task.done");
  }, SLOW);

  it("asks a person, not only Jev, to approve a diff that touches package files, configs or test helpers", async () => {
    for (const [file, content] of [["package.json", '{"scripts":{"test":"exit 0"}}\n'], ["vitest.config.mjs", "export default {};\n"], ["tests/helpers/check-helper.mjs", "export const ok = true;\n"]] as const) {
      const ctx = await approved();
      await ctx.addWorktree();
      writeFiles(ctx.worktree, { "feature.txt": "enabled\n", [file]: content });
      const tip = await commitAll(ctx.worktree, `enable feature and touch ${file}`);
      expect((await ctx.gate.prove("T-1", ctx.worktree)).ok).toBe(true);
      expect(ctx.gate.approveDiff("T-1", JEV, tip).ok).toBe(true);
      const merge = () => ctx.gate.mergeAndVerify("T-1", { repoRoot: ctx.root, branch: ctx.branch, integrationBranch: "main", actor: OWNER });
      expect(await merge()).toMatchObject({ ok: false, reason: expect.stringContaining(file) });
      expect(ctx.gate.approveDiff("T-1", OWNER, tip).ok).toBe(true);
      expect(ctx.gate.approveMerge("T-1", OWNER, tip).ok).toBe(true);
      expect((await merge()).ok).toBe(true);
    }
  }, SLOW);

  it("ignores a diff approval an agent writes under Jev's name", async () => {
    const { root, gate, ledger, worktree, branch, addWorktree } = await approved();
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    const tip = await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    // Nothing stops a process with ledger access from claiming to be Jev; the entry is just unsigned.
    ledger.append({ type: "review.verdict", actor: { kind: "jev", id: "jev", model: "test-model" }, subject: "T-1", summary: "Diff approved", evidence: ["scope:diff", "verdict:approve", `commit:${tip}`], data: { scope: "diff", verdict: "approve", commit: tip } });
    const merge = () => gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "main", actor: OWNER });
    expect(await merge()).toMatchObject({ ok: false, reason: expect.stringContaining("not been approved") });
    expect(gate.approveDiff("T-1", JEV, tip).ok).toBe(true);
    expect(ledger.entries().at(-1)).toMatchObject({ type: "review.verdict", actor: { kind: "system", id: "gate" }, data: { reviewer: JEV } });
    expect(gate.approveMerge("T-1", OWNER, tip).ok).toBe(true);
    expect((await merge()).ok).toBe(true);
  }, SLOW);

  it("asks a person when the diff changes a setup file, a script the test runs, or anything the test imports", async () => {
    const files = {
      "check.mjs": 'import { ready } from "./lib/flag.mjs";\nprocess.exit(ready() ? 0 : 1);\n',
      "lib/flag.mjs": 'import { readFileSync } from "node:fs";\nimport { enabled } from "../support/parse.mjs";\nexport const ready = () => enabled(readFileSync("feature.txt", "utf8"));\n',
      "support/parse.mjs": 'export const enabled = (text) => text.trim() === "enabled";\n',
      "package.json": '{"scripts":{"check":"node scripts/run.mjs"}}\n',
      "scripts/run.mjs": "process.exit(0);\n",
      "vitest.setup.mjs": "export {};\n",
      "feature.txt": "disabled\n",
    };
    for (const [file, content] of [["support/parse.mjs", "export const enabled = () => true;\n"], ["lib/flag.mjs", "export const ready = () => true;\n"], ["scripts/run.mjs", "process.exit(1);\n"], ["vitest.setup.mjs", "globalThis.x = 1;\n"]] as const) {
      const repo = await makeRepo(files);
      cleanups.push(repo.cleanup);
      const ledger = await memoryLedger();
      const gate = new TestGate({ ledger, timeoutMs: 30_000 });
      gate.define("T-1", "node check.mjs", WORKER);
      expect(gate.approve("T-1", OWNER, { cwd: repo.root }).ok).toBe(true);
      expect((await gate.confirmFailsFirst("T-1", repo.root)).ok).toBe(true);
      const worktree = path.join(path.dirname(repo.root), `wt-${file.replace(/\W/g, "-")}`);
      cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
      await git(repo.root, ["worktree", "add", "-q", "-b", "pp/T-1", worktree, "main"]);
      writeFiles(worktree, { [file]: content, "feature.txt": "enabled\n" });
      const tip = await commitAll(worktree, `touch ${file}`);
      expect((await gate.prove("T-1", worktree)).ok).toBe(true);
      expect(gate.approveDiff("T-1", JEV, tip).ok).toBe(true);
      const merged = await gate.mergeAndVerify("T-1", { repoRoot: repo.root, branch: "pp/T-1", integrationBranch: "main", actor: OWNER });
      expect(merged).toMatchObject({ ok: false, reason: expect.stringContaining(file) });
    }
  }, SLOW);

  it("merges only on a person's own signed merge approval, never a name passed in", async () => {
    const { root, gate, ledger, worktree, branch, addWorktree } = await approved();
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    const tip = await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    expect(gate.approveDiff("T-1", JEV, tip).ok).toBe(true);
    const merge = () => gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "main", actor: OWNER });
    // Naming the owner is not their approval.
    expect(await merge()).toMatchObject({ ok: false, reason: expect.stringContaining("merge has not been approved") });
    // Nor is an unsigned entry that claims to be theirs, or an agent's.
    ledger.append({ type: "task.progress", actor: WORKER, subject: "T-1", summary: "Merge approved", evidence: ["scope:merge", "verdict:approve", `commit:${tip}`] });
    expect(gate.approveMerge("T-1", WORKER, tip)).toMatchObject({ ok: false, reason: expect.stringContaining("Only a person") });
    expect(gate.approveMerge("T-1", JEV, tip).ok).toBe(false);
    expect(await merge()).toMatchObject({ ok: false });
    expect(gate.approveMerge("T-1", OWNER, tip).ok).toBe(true);
    expect((await merge()).ok).toBe(true);
    expect(ledger.entries().at(-1)).toMatchObject({ type: "task.done", data: { approvedBy: OWNER } });
  }, SLOW);

  it("keeps .perfect-planner/ (ledger, worker tokens) out of commits and refuses a branch that committed it", async () => {
    const { root, gate, worktree, branch, addWorktree } = await approved();
    // After the gate has run, `git add -A` in the main checkout skips the planner folder.
    writeFiles(root, { ".perfect-planner/ledger/2026-10.jsonl": "{}\n", ".perfect-planner/tokens/worker-1": "secret-token\n" });
    await git(root, ["add", "-A"]);
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("");
    await addWorktree();
    // A forced add still lands in the index; prove refuses to count that commit.
    writeFiles(worktree, { "feature.txt": "enabled\n", ".perfect-planner/tokens/worker-1": "secret-token\n" });
    await git(worktree, ["add", "-f", ".perfect-planner/tokens/worker-1"]);
    await commitAll(worktree, "enable feature with a token");
    expect(await gate.prove("T-1", worktree)).toMatchObject({ ok: false, reason: expect.stringContaining(".perfect-planner/tokens/worker-1") });
    // Untracking it at the tip is not enough: it is still in the branch's history.
    await git(worktree, ["rm", "-q", "--cached", ".perfect-planner/tokens/worker-1"]);
    const tip = await commitAll(worktree, "untrack the token");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    expect(gate.approveDiff("T-1", OWNER, tip).ok).toBe(true);
    expect(gate.approveMerge("T-1", OWNER, tip).ok).toBe(true);
    const merged = await gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "main", actor: OWNER });
    expect(merged).toMatchObject({ ok: false, reason: expect.stringContaining(".perfect-planner/tokens/worker-1") });
    expect(await head(root, "main")).not.toBe(tip);
  }, SLOW);

  it("Jev's gaps found after the person approved stop work until Jev clears them", async () => {
    const { gate, ledger, worktree, addWorktree } = await approved();
    expect(gate.canStart("T-1").ok).toBe(true);
    expect(gate.reviewTest("T-1", WORKER, "approve")).toMatchObject({ ok: false, reason: expect.stringContaining("Only Jev") });
    expect(gate.reviewTest("T-1", JEV, ["Misses the kill switch"]).ok).toBe(true);
    expect(gate.canStart("T-1")).toMatchObject({ ok: false, reason: expect.stringContaining("Misses the kill switch") });
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    await commitAll(worktree, "enable feature");
    expect(await gate.prove("T-1", worktree)).toMatchObject({ ok: false, reason: expect.stringContaining("Misses the kill switch") });
    // An unsigned entry claiming Jev's approval does not clear them.
    const definition = gate.state("T-1").definition!.n;
    ledger.append({ type: "review.verdict", actor: JEV, subject: "T-1", summary: "No gaps", evidence: ["scope:test", "verdict:approve", `definition:${definition}`], data: { scope: "test", verdict: "approve", definition } });
    expect(gate.canStart("T-1").ok).toBe(false);
    expect(gate.reviewTest("T-1", JEV, "approve").ok).toBe(true);
    expect(gate.canStart("T-1").ok).toBe(true);
  }, SLOW);

  it("reject can cite the signed rejection already written instead of writing another", async () => {
    const { gate, ledger } = await approved("T-14");
    const other = ledger.append({ type: "review.verdict", actor: GATE, subject: "T-14", summary: "Looks fine", evidence: ["scope:diff", "verdict:approve"], data: { scope: "diff", verdict: "approve" } });
    expect(() => gate.reject("T-14", JEV, "Missing error handling", { verdict: other.n })).toThrow(/not a rejection/);
    const unsigned = ledger.append({ type: "review.verdict", actor: JEV, subject: "T-14", summary: "Diff rejected", evidence: ["scope:diff", "verdict:reject"], data: { scope: "diff", verdict: "reject" } });
    expect(() => gate.reject("T-14", JEV, "Missing error handling", { verdict: unsigned.n })).toThrow(/signed/);
    const verdict = ledger.append({ type: "review.verdict", actor: GATE, subject: "T-14", summary: "Diff rejected", evidence: ["scope:diff", "verdict:reject"], data: { scope: "diff", verdict: "reject" } });
    const before = ledger.entries().length;
    const result = gate.reject("T-14", JEV, "Missing error handling", { verdict: verdict.n });
    expect(result).toMatchObject({ ok: true, newTaskId: "T-14.a2" });
    expect(ledger.entries().length).toBe(before + 1);
    expect(ledger.entries().at(-1)).toMatchObject({ type: "task.reopened", data: { verdict: verdict.n } });
  });

  it("with requireJevTestReview, work waits for Jev's signed approval of the test", async () => {
    const { root, ledger } = await setup();
    const gate = new TestGate({ ledger, timeoutMs: 30_000, requireJevTestReview: true });
    ledger.addRule(gateRule({ requireJevTestReview: true }));
    gate.define("T-1", COMMAND, WORKER);
    expect(gate.approve("T-1", OWNER, { cwd: root }).ok).toBe(true);
    expect((await gate.confirmFailsFirst("T-1", root)).ok).toBe(true);
    expect(gate.canStart("T-1")).toMatchObject({ ok: false, reason: expect.stringContaining("Jev has not reviewed") });
    expect(() => ledger.append({ type: "task.claimed", actor: WORKER, subject: "T-1", summary: "Claimed" })).toThrow(LedgerError);
    expect(gate.reviewTest("T-1", JEV, "approve").ok).toBe(true);
    expect(gate.canStart("T-1").ok).toBe(true);
    // The default keeps Jev optional.
    expect(new TestGate({ ledger }).canStart("T-1").ok).toBe(true);
  });

  it("an unsigned Jev verdict on the test cannot clear the gaps Jev found", async () => {
    const { root, gate, ledger } = await setup();
    gate.define("T-1", COMMAND, WORKER);
    expect(gate.approve("T-1", OWNER, { cwd: root, jevVerdict: ["Misses the kill switch"], jev: JEV }).ok).toBe(false);
    const definition = gate.state("T-1").definition!.n;
    ledger.append({ type: "review.verdict", actor: JEV, subject: "T-1", summary: "No gaps", evidence: ["scope:test", "verdict:approve", `definition:${definition}`], data: { scope: "test", verdict: "approve", definition } });
    expect(gate.approve("T-1", OWNER, { cwd: root })).toMatchObject({ ok: false, reason: expect.stringContaining("open gaps") });
  });

  it("reject bumps the attempt and the new attempt keeps the approved test", async () => {
    const { gate, ledger } = await approved("T-14");
    expect(nextAttemptId("T-14")).toBe("T-14.a2");
    const first = gate.reject("T-14", JEV, ["Missing error handling for empty input"]);
    expect(first).toMatchObject({ ok: true, newTaskId: "T-14.a2" });
    expect(ledger.entries().at(-1)).toMatchObject({ type: "task.reopened", subject: "T-14", reason: "Missing error handling for empty input" });
    expect(gate.state("T-14").stage).toBe("reopened");
    expect(gate.canStart("T-14").ok).toBe(false);
    expect(gate.reject("T-14", JEV, "again").ok).toBe(false);
    expect(gate.canStart("T-14.a2").ok).toBe(true);
    expect(gate.reject("T-14.a2", JEV, "Still missing")).toMatchObject({ ok: true, newTaskId: "T-14.a3" });
    expect(gate.state("T-14.a3")).toMatchObject({ baseId: "T-14", attempt: 3, stage: "baseline-confirmed" });
    expect(() => gate.reject("T-14.a3", JEV, "  ")).toThrow(/notes/);
  });

  it("Jev's gaps refuse approval until a clean verdict", async () => {
    const { root, gate, ledger } = await setup();
    gate.define("T-1", COMMAND, WORKER);
    const gaps = gate.approve("T-1", OWNER, { cwd: root, jevVerdict: ["Does not cover the disabled state", "No check for the kill switch path"], jev: JEV });
    expect(gaps).toMatchObject({ ok: false, reason: expect.stringContaining("Does not cover") });
    expect(types(ledger)).not.toContain("test.approved");
    expect(gate.state("T-1").jev).toMatchObject({ verdict: "gaps", gaps: ["Does not cover the disabled state", "No check for the kill switch path"] });
    expect(gate.approve("T-1", OWNER, { cwd: root })).toMatchObject({ ok: false, reason: expect.stringContaining("open gaps") });
    expect(gate.approve("T-1", OWNER, { cwd: root, jevVerdict: "approve", jev: JEV }).ok).toBe(true);
    await gate.confirmFailsFirst("T-1", root);
    expect(gate.canStart("T-1").ok).toBe(true);
  });

  it("gateRule makes the ledger refuse task.claimed until the test is approved", async () => {
    const { root, ledger, gate } = await setup();
    ledger.addRule(gateRule());
    const claim = () => ledger.append({ type: "task.claimed", actor: WORKER, subject: "T-1", summary: "Claimed by worker 1" });
    expect(claim).toThrow(LedgerError);
    try {
      claim();
    } catch (error) {
      expect((error as LedgerError).code).toBe("RULE");
      expect((error as Error).message).toContain("no done-when test");
    }
    gate.define("T-1", COMMAND, WORKER);
    expect(claim).toThrow(/waiting for the owner/);
    gate.approve("T-1", OWNER, { cwd: root });
    expect(claim).toThrow(/not been run/);
    await gate.confirmFailsFirst("T-1", root);
    expect(claim().type).toBe("task.claimed");
    // Other entry types and non-task subjects are not the rule's business.
    expect(ledger.append({ type: "task.progress", actor: WORKER, subject: "T-2", summary: "Looking around" }).type).toBe("task.progress");
  });

  it("task.done is refused without a pass after the last commit, by the gate and by the ledger", async () => {
    const { ledger, gate, worktree, addWorktree } = await approved();
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    const sha = await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    expect(() => gate.assertCanFinish("T-1", sha)).not.toThrow();
    expect(() => gate.assertCanFinish("T-1", "0".repeat(40))).toThrow(/cannot finish/);
    // A later commit invalidates the pass as far as the ledger is concerned.
    ledger.append({ type: "commit.observed", actor: { kind: "system", id: "watcher" }, subject: "T-1", summary: "Another commit", data: { sha: "f".repeat(40) } });
    try {
      ledger.append({ type: "task.done", actor: OWNER, subject: "T-1", summary: "Done by fiat" });
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerError).code).toBe("DONE_WITHOUT_PASS");
    }
  }, SLOW);

  it("replays to the same state from the ledger alone", async () => {
    const store = new MemoryStore();
    const ledger = await Ledger.open(store);
    const repo = await makeRepo({ "check.mjs": CHECK, "feature.txt": "disabled\n" });
    cleanups.push(repo.cleanup);
    const gate = new TestGate({ ledger });
    gate.define("T-3", COMMAND, WORKER);
    gate.approve("T-3", OWNER, { cwd: repo.root, jevVerdict: "approve", jev: JEV });
    await gate.confirmFailsFirst("T-3", repo.root);
    gate.reject("T-3", JEV, "Wrong approach");
    const before = ["T-3", "T-3.a2"].map((id) => gate.state(id));

    expect(["T-3", "T-3.a2"].map((id) => new TestGate({ ledger }).state(id))).toEqual(before);
    ledger.close();
    const reopened = await Ledger.open(store, { readOnly: true });
    expect(["T-3", "T-3.a2"].map((id) => deriveState(reopened.entries(), id))).toEqual(before);
    expect(before[1]).toMatchObject({ stage: "baseline-confirmed", attempt: 2 });
  });

  it("a timeout, crash or missing command does not count as the required failing run", async () => {
    const { root, ledger, gate } = await setup();
    writeFiles(root, { "hang.mjs": "setInterval(() => {}, 1000);\n" });
    const slow = new TestGate({ ledger, timeoutMs: 1000 });
    expect(slow.define("T-1", "node hang.mjs", WORKER).ok).toBe(true);
    expect(slow.approve("T-1", OWNER, { cwd: root }).ok).toBe(true);
    const timedOut = await slow.confirmFailsFirst("T-1", root);
    expect(timedOut).toMatchObject({ ok: false, reason: expect.stringMatching(/timed out, crashed or could not start/) });
    expect(timedOut.entry?.data).toMatchObject({ conclusive: false });
    expect(gate.state("T-1").baseline).toBeUndefined();
    expect(gate.canStart("T-1").ok).toBe(false);

    expect(gate.define("T-1", "pp-no-such-command-anywhere", WORKER, [], { files: ["check.mjs"] }).ok).toBe(true);
    expect(gate.approve("T-1", OWNER, { cwd: root }).ok).toBe(true);
    expect((await gate.confirmFailsFirst("T-1", root)).ok).toBe(false);
    expect(gate.canStart("T-1").ok).toBe(false);

    // A real failure afterwards is accepted.
    expect(gate.define("T-1", COMMAND, WORKER).ok).toBe(true);
    expect(gate.approve("T-1", OWNER, { cwd: root }).ok).toBe(true);
    expect((await gate.confirmFailsFirst("T-1", root)).ok).toBe(true);
    expect(gate.state("T-1").stage).toBe("baseline-confirmed");
  }, SLOW);

  it("validates input", async () => {
    const { gate } = await setup();
    expect(() => gate.define("task-1", COMMAND, WORKER)).toThrow(/not a task id/);
    expect(() => gate.define("T-1", "   ", WORKER)).toThrow(/runnable command/);
    expect(() => gate.define("T-1", "a\nb", WORKER)).toThrow(/one line/);
    expect(gate.canStart("T-1")).toMatchObject({ ok: false, reason: "T-1 has no done-when test." });
  });
});

describe("runTestCommand", () => {
  const scratch = () => {
    const dir = realDir(mkdtempSync(path.join(os.tmpdir(), "pp-gate-run-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
    return dir;
  };

  it("reports pass, failure and the exit code", async () => {
    const dir = scratch();
    expect(await runTestCommand('node -e "console.log(42)"', dir)).toMatchObject({ passed: true, exitCode: 0, timedOut: false, outputTail: expect.stringContaining("42") });
    expect(await runTestCommand('node -e "console.error(7); process.exit(3)"', dir)).toMatchObject({ passed: false, exitCode: 3, outputTail: expect.stringContaining("7") });
  });

  it("runs tests with an allow-listed environment, so keys in the user's shell never reach them", async () => {
    const dir = scratch();
    const key = ["sk", "test", "x".repeat(24)].join("-");
    process.env.PP_GATE_TEST_API_KEY = key;
    process.env.ANTHROPIC_API_KEY ??= key;
    try {
      writeFileSync(path.join(dir, "env.mjs"), "console.log(JSON.stringify(Object.keys(process.env)));\nconsole.log(process.env.PP_GATE_TEST_API_KEY ?? 'absent');\nconsole.log(process.env.EXTRA ?? 'no-extra');\n");
      const result = await runTestCommand("node env.mjs", dir, { env: { EXTRA: "given" } });
      expect(result.passed).toBe(true);
      expect(result.outputTail).not.toContain(key);
      expect(result.outputTail).toContain("absent");
      expect(result.outputTail).toContain("given");
      const keys = JSON.parse(result.outputTail.split(/\r?\n/)[0]!) as string[];
      expect(keys.some((name) => /API_KEY|TOKEN|SECRET/i.test(name))).toBe(false);
    } finally {
      delete process.env.PP_GATE_TEST_API_KEY;
      if (process.env.ANTHROPIC_API_KEY === key) delete process.env.ANTHROPIC_API_KEY;
    }
    expect(scrubbedEnv({ Path: "C:\\bin", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", HOME: "/h", GIT_DIR: "/x" })).toEqual({ Path: "C:\\bin", HOME: "/h" });
  });

  it("only a clean non-zero exit is a conclusive failure", () => {
    const base = { passed: false, timedOut: false, durationMs: 1, outputTail: "" };
    expect(isConclusiveFailure({ ...base, exitCode: 1 })).toBe(true);
    expect(isConclusiveFailure({ ...base, exitCode: null })).toBe(false);
    expect(isConclusiveFailure({ ...base, exitCode: null, timedOut: true })).toBe(false);
    expect(isConclusiveFailure({ ...base, exitCode: process.platform === "win32" ? 9009 : 127 })).toBe(false);
    expect(isConclusiveFailure({ ...base, passed: true, exitCode: 0 })).toBe(false);
  });

  it("finds a missing program before running it, whatever language the shell speaks", async () => {
    const dir = scratch();
    const env = scrubbedEnv(process.env);
    expect(commandExists("pp-no-such-command-anywhere --run", dir, env)).toBe(false);
    expect(commandExists("./missing-script.sh", dir, env)).toBe(false);
    expect(commandExists('node -e "1"', dir, env)).toBe(true);
    expect(commandExists("echo hi && exit 1", dir, env)).toBe(true);
    expect(commandExists("node env.mjs", dir, { ...env, PATH: "", Path: "" })).toBe(false);
    const result = await runTestCommand("pp-no-such-command-anywhere", dir);
    expect(result).toMatchObject({ passed: false, exitCode: null, outputTail: expect.stringContaining("command not found") });
    expect(isConclusiveFailure(result)).toBe(false);
  });

  it("keeps only the last ~4 KB of output", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "noisy.mjs"), `for (let i = 0; i < 2000; i++) console.log("line " + i);\nconsole.log("THE END");\n`);
    const result = await runTestCommand("node noisy.mjs", dir);
    expect(result.passed).toBe(true);
    expect(result.outputTail.length).toBeLessThanOrEqual(4096);
    expect(result.outputTail).toContain("THE END");
    expect(result.outputTail).not.toContain("line 0\n");
  });

  it("kills the whole process tree on timeout", async () => {
    const dir = scratch();
    const pidFile = path.join(dir, "grandchild.pid");
    writeFileSync(
      path.join(dir, "hang.mjs"),
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.argv[2], String(child.pid));
console.log("started");
setInterval(() => {}, 1000);
`,
    );
    const started = Date.now();
    const result = await runTestCommand(`node hang.mjs "${pidFile}"`, dir, { timeoutMs: 1500 });
    expect(result).toMatchObject({ passed: false, timedOut: true, exitCode: null });
    expect(result.outputTail).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive()).toBe(false);
  }, SLOW);
});
