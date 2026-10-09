import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore, type Actor } from "../ledger/index";
import { git } from "../worktrees/git";
import { realDir } from "../worktrees/platform";
import { commitAll, makeRepo, memoryLedger, writeFiles } from "../worktrees/testing";
import { TestGate, deriveState, gateRule, nextAttemptId, runTestCommand } from "./index";

const OWNER: Actor = { kind: "person", id: "owner" };
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

/** define -> baseline fails -> approve. */
async function approved(taskId = "T-1") {
  const ctx = await setup(taskId);
  expect(ctx.gate.define(taskId, COMMAND, WORKER).ok).toBe(true);
  expect((await ctx.gate.confirmFailsFirst(taskId, ctx.root)).ok).toBe(true);
  expect(ctx.gate.approve(taskId, OWNER).ok).toBe(true);
  return ctx;
}

const types = (ledger: Ledger) => ledger.entries().map((entry) => entry.type);
const head = (cwd: string, ref = "HEAD") => git(cwd, ["rev-parse", ref]);

describe("TestGate", () => {
  it("runs the full happy path and advances the checked-out integration branch", async () => {
    const { root, ledger, gate, worktree, branch, addWorktree } = await setup();
    ledger.addRule(gateRule());

    expect(gate.define("T-1", COMMAND, WORKER, ["P-1 §2"]).ok).toBe(true);
    expect(gate.canStart("T-1").ok).toBe(false);
    const baseline = await gate.confirmFailsFirst("T-1", root);
    expect(baseline.ok).toBe(true);
    expect(baseline.run?.outputTail).toContain("feature is not enabled");
    const approval = gate.approve("T-1", OWNER, { jevVerdict: "approve", jev: JEV });
    expect(approval.ok).toBe(true);
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
      "test.failed",
      "review.verdict",
      "test.approved",
      "task.claimed",
      "commit.observed",
      "test.passed",
      "test.passed",
      "merge.done",
      "task.done",
    ]);
    const mergePass = ledger.entries()[7]!;
    expect(mergePass.data).toMatchObject({ test: COMMAND, afterMerge: true, phase: "merge", commit: merged.mergeCommit });
    expect(mergePass.evidence).toContain(`commit:${merged.mergeCommit}`);
    const state = gate.state("T-1");
    expect(state).toMatchObject({ stage: "done", merged: { commit: merged.mergeCommit } });
    expect(gate.canStart("T-1").ok).toBe(false);
  }, SLOW);

  it("fast-forwards an integration branch that is not checked out with update-ref", async () => {
    const { root, gate, worktree, branch, addWorktree } = await approved();
    await git(root, ["branch", "integration", "main"]);
    await addWorktree();
    writeFiles(worktree, { "feature.txt": "enabled\n" });
    await commitAll(worktree, "enable feature");
    expect((await gate.prove("T-1", worktree)).ok).toBe(true);
    const mainBefore = await head(root, "main");
    const merged = await gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "integration", actor: OWNER });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(await head(root, "integration")).toBe(merged.mergeCommit);
    expect(await head(root, "main")).toBe(mainBefore);
  }, SLOW);

  it("refuses a test that already passes on the current code", async () => {
    const { root, gate, ledger } = await setup();
    gate.define("T-1", 'node -e "process.exit(0)"', WORKER);
    const baseline = await gate.confirmFailsFirst("T-1", root);
    expect(baseline.ok).toBe(false);
    expect(ledger.entries().at(-1)).toMatchObject({ type: "test.passed", data: { phase: "baseline" } });
    expect(gate.approve("T-1", OWNER)).toMatchObject({ ok: false, reason: expect.stringContaining("proves nothing") });
    expect(gate.canStart("T-1").ok).toBe(false);
    expect(gate.state("T-1").stage).toBe("baseline-passes");
  });

  it("refuses approval before the baseline run", async () => {
    const { gate, ledger } = await setup();
    expect(gate.approve("T-1", OWNER).ok).toBe(false);
    gate.define("T-1", COMMAND, WORKER);
    expect(gate.approve("T-1", OWNER)).toMatchObject({ ok: false, reason: expect.stringContaining("current code first") });
    expect(types(ledger)).toEqual(["test.defined"]);
  });

  it("a redefined test invalidates the earlier approval", async () => {
    const { root, gate } = await approved();
    expect(gate.canStart("T-1").ok).toBe(true);
    gate.define("T-1", "node check.mjs --strict", WORKER);
    expect(gate.canStart("T-1")).toMatchObject({ ok: false, reason: expect.stringContaining("not been run") });
    expect(gate.approve("T-1", OWNER).ok).toBe(false);
    expect((await gate.confirmFailsFirst("T-1", root)).ok).toBe(true);
    expect(gate.canStart("T-1").ok).toBe(false);
    expect(gate.approve("T-1", OWNER).ok).toBe(true);
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

    const merged = await gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "main", actor: OWNER });
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

    const merged = await gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "main", actor: OWNER });
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
    const merged = await gate.mergeAndVerify("T-1", { repoRoot: root, branch, integrationBranch: "main", actor: OWNER });
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
    expect(gate.state("T-14.a3")).toMatchObject({ baseId: "T-14", attempt: 3, stage: "approved" });
    expect(() => gate.reject("T-14.a3", JEV, "  ")).toThrow(/notes/);
  });

  it("Jev's gaps refuse approval until a clean verdict", async () => {
    const { root, gate, ledger } = await setup();
    gate.define("T-1", COMMAND, WORKER);
    await gate.confirmFailsFirst("T-1", root);
    const gaps = gate.approve("T-1", OWNER, { jevVerdict: ["Does not cover the disabled state", "No check for the kill switch path"], jev: JEV });
    expect(gaps).toMatchObject({ ok: false, reason: expect.stringContaining("Does not cover") });
    expect(types(ledger)).not.toContain("test.approved");
    expect(gate.state("T-1").jev).toMatchObject({ verdict: "gaps", gaps: ["Does not cover the disabled state", "No check for the kill switch path"] });
    expect(gate.approve("T-1", OWNER)).toMatchObject({ ok: false, reason: expect.stringContaining("open gaps") });
    expect(gate.approve("T-1", OWNER, { jevVerdict: "approve", jev: JEV }).ok).toBe(true);
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
    await gate.confirmFailsFirst("T-1", root);
    expect(claim).toThrow(/waiting for the owner/);
    gate.approve("T-1", OWNER);
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
    await gate.confirmFailsFirst("T-3", repo.root);
    gate.approve("T-3", OWNER, { jevVerdict: "approve", jev: JEV });
    gate.reject("T-3", JEV, "Wrong approach");
    const before = ["T-3", "T-3.a2"].map((id) => gate.state(id));

    expect(["T-3", "T-3.a2"].map((id) => new TestGate({ ledger }).state(id))).toEqual(before);
    ledger.close();
    const reopened = await Ledger.open(store, { readOnly: true });
    expect(["T-3", "T-3.a2"].map((id) => deriveState(reopened.entries(), id))).toEqual(before);
    expect(before[1]).toMatchObject({ stage: "approved", attempt: 2 });
  });

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
