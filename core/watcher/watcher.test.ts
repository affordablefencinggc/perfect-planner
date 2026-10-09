import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../worktrees/git";
import { WATCHER_ACTOR, evidenceValue, type LedgerPort } from "../worktrees/ports";
import { commitAll, memoryLedger, writeFiles } from "../worktrees/testing";
import type { WorktreeInfo } from "../worktrees/types";
import { makeTaskRepo, type Fixture } from "./fixtures";
import { GitWatcher } from "./watcher";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function ofType(ledger: LedgerPort, type: string) {
  return ledger.entries().filter((entry) => entry.type === type);
}

function watcherFor(ledger: LedgerPort, list: () => WorktreeInfo[], extra: { stallMs?: number; now?: () => number } = {}): GitWatcher {
  return new GitWatcher({ ledger, worktrees: list, ...extra });
}

describe("GitWatcher commits", { timeout: 60_000 }, () => {
  it("writes commit.observed once per commit with refs, and not again after a restart", async () => {
    fixture = await makeTaskRepo();
    const { "T-1": t1, "T-2": t2 } = fixture.tasks;
    const ledger = await memoryLedger();
    const list = () => [t1, t2];

    writeFiles(t1.path, { "src/a.ts": "1\n" });
    const sha = await commitAll(t1.path, "Add a\n\nImplements: P-2 §3.1 (T-1)");

    const first = watcherFor(ledger, list);
    const r1 = await first.tick();
    expect(r1.errors).toEqual([]);
    expect(r1.observed.map((c) => [c.taskId, c.sha])).toEqual([["T-1", sha]]);
    const [entry] = ofType(ledger, "commit.observed");
    expect(entry).toMatchObject({ actor: WATCHER_ACTOR, subject: "T-1", refs: ["P-2 §3.1"] });
    expect(entry.summary).toContain("Add a");
    expect(evidenceValue(entry, "commit")).toBe(sha);
    expect(entry.evidence).toContain("file:src/a.ts");
    expect(entry.data).toEqual({ sha, files: ["src/a.ts"] });

    expect((await first.tick()).observed).toEqual([]);

    // Restart: a new watcher on the same ledger must not repeat the entry.
    const second = watcherFor(ledger, list);
    expect((await second.tick()).observed).toEqual([]);
    writeFiles(t1.path, { "src/b.ts": "2\n" });
    const next = await commitAll(t1.path, "Add b");
    const r3 = await second.tick();
    expect(r3.observed.map((c) => c.sha)).toEqual([next]);
    expect(r3.observed[0].refs).toEqual([]);
    expect(ofType(ledger, "commit.observed")).toHaveLength(2);
  });
});

describe("GitWatcher collisions", { timeout: 60_000 }, () => {
  it("logs the acceptance collision once when one side is only uncommitted, then resolves it", async () => {
    fixture = await makeTaskRepo();
    const { "T-1": t1, "T-2": t2 } = fixture.tasks;
    const ledger = await memoryLedger();
    const watcher = watcherFor(ledger, () => [t1, t2]);

    writeFiles(t1.path, { "src/shared.ts": "export const a = 10;\n" });
    await commitAll(t1.path, "T-1 edits shared");
    writeFiles(t2.path, { "src/shared.ts": "export const a = 20;\n", "src/other.ts": "x\n" });

    const r1 = await watcher.tick();
    expect(r1.collisions).toEqual([{ tasks: ["T-1", "T-2"], files: ["src/shared.ts"] }]);
    expect((await watcher.tick()).collisions).toEqual([]);
    expect((await watcherFor(ledger, () => [t1, t2]).tick()).collisions).toEqual([]);

    const detected = ofType(ledger, "collision.detected");
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ actor: WATCHER_ACTOR, subject: "T-1+T-2" });
    expect(detected[0].evidence).toEqual(["task:T-1", "task:T-2", "file:src/shared.ts"]);
    expect(detected[0].summary).toBe("T-1 and T-2 both changed src/shared.ts");

    // T-2 backs out its edit: the collision resolves, once.
    await git(t2.path, ["checkout", "--", "src/shared.ts"]);
    const r2 = await watcher.tick();
    expect(r2.resolved).toEqual([{ tasks: ["T-1", "T-2"], files: ["src/shared.ts"] }]);
    expect(r2.active).toEqual([]);
    expect((await watcher.tick()).resolved).toEqual([]);
    expect(ofType(ledger, "collision.resolved")).toHaveLength(1);

    // A fresh watcher sees the resolution in the ledger and stays quiet.
    const restarted = await watcherFor(ledger, () => [t1, t2]).tick();
    expect(restarted.collisions).toEqual([]);
    expect(restarted.resolved).toEqual([]);
  });

  it("writes a new collision.detected when the shared file set changes", async () => {
    fixture = await makeTaskRepo();
    const { "T-1": t1, "T-2": t2 } = fixture.tasks;
    const ledger = await memoryLedger();
    const watcher = watcherFor(ledger, () => [t1, t2]);
    writeFiles(t1.path, { "src/shared.ts": "1\n", "src/other.ts": "1\n" });
    writeFiles(t2.path, { "src/shared.ts": "2\n" });
    await watcher.tick();
    writeFiles(t2.path, { "src/other.ts": "2\n" });
    const r = await watcher.tick();
    expect(r.collisions).toEqual([{ tasks: ["T-1", "T-2"], files: ["src/other.ts", "src/shared.ts"] }]);
    expect(ofType(ledger, "collision.detected")).toHaveLength(2);
  });

  it("collides on a case-only path difference", async () => {
    fixture = await makeTaskRepo();
    const { "T-1": t1, "T-2": t2 } = fixture.tasks;
    const ledger = await memoryLedger();
    writeFiles(t1.path, { "docs/Notes.md": "one\n" });
    writeFiles(t2.path, { "docs/notes.md": "two\n" });
    const r = await watcherFor(ledger, () => [t1, t2]).tick();
    expect(r.collisions).toEqual([{ tasks: ["T-1", "T-2"], files: ["docs/Notes.md", "docs/notes.md"] }]);
    expect(ofType(ledger, "collision.detected")).toHaveLength(1);
  });

  it("resolves an open collision when a task's worktree is removed from the list", async () => {
    fixture = await makeTaskRepo();
    const { "T-1": t1, "T-2": t2 } = fixture.tasks;
    const ledger = await memoryLedger();
    let list = [t1, t2];
    const watcher = watcherFor(ledger, () => list);
    writeFiles(t1.path, { "src/shared.ts": "1\n" });
    writeFiles(t2.path, { "src/shared.ts": "2\n" });
    expect((await watcher.tick()).collisions).toHaveLength(1);
    list = [t1];
    const r = await watcher.tick();
    expect(r.resolved).toHaveLength(1);
    expect(ofType(ledger, "collision.resolved")[0].summary).toContain("T-2 has no worktree");
  });
});

describe("GitWatcher stalls and failures", { timeout: 60_000 }, () => {
  it("reports a task stalled after stallMs without commits or file changes", async () => {
    fixture = await makeTaskRepo();
    const { "T-1": t1, "T-2": t2 } = fixture.tasks;
    const ledger = await memoryLedger();
    let clock = 1_000_000;
    const watcher = watcherFor(ledger, () => [t1, t2], { stallMs: 60_000, now: () => clock });

    expect((await watcher.tick()).stalled).toEqual([]);
    clock += 30_000;
    writeFiles(t2.path, { "src/new.ts": "1\n" });
    expect((await watcher.tick()).stalled).toEqual([]);
    clock += 30_000;
    // T-1 has been idle for 60s; T-2 moved 30s ago.
    expect((await watcher.tick()).stalled).toEqual([{ taskId: "T-1", since: 1_000_000, idleMs: 60_000 }]);

    writeFiles(t1.path, { "src/a.ts": "1\n" });
    await commitAll(t1.path, "progress");
    clock += 31_000;
    const r = await watcher.tick();
    expect(r.stalled.map((s) => s.taskId)).toEqual(["T-2"]);
    expect(ledger.entries().filter((e) => e.type.includes("stall"))).toEqual([]);
  });

  it("reports a vanished worktree without failing the tick or resolving its collisions", async () => {
    fixture = await makeTaskRepo(["T-1", "T-2", "T-3"]);
    const { "T-1": t1, "T-2": t2, "T-3": t3 } = fixture.tasks;
    const ledger = await memoryLedger();
    const ghost: WorktreeInfo = { ...t3, taskId: "T-9", path: path.join(path.dirname(fixture.root), "never-existed") };
    const watcher = watcherFor(ledger, () => [t1, t2, t3, ghost]);

    writeFiles(t1.path, { "src/shared.ts": "1\n" });
    writeFiles(t2.path, { "src/shared.ts": "2\n" });
    const r1 = await watcher.tick();
    expect(r1.collisions).toHaveLength(1);
    expect(r1.errors.map((e) => e.taskId)).toEqual(["T-9"]);

    rmSync(t2.path, { recursive: true, force: true });
    writeFiles(t3.path, { "src/x.ts": "1\n" });
    await commitAll(t3.path, "T-3 keeps working");
    const r2 = await watcher.tick();
    expect(r2.errors.map((e) => e.taskId).sort()).toEqual(["T-2", "T-9"]);
    expect(r2.observed.map((c) => c.taskId)).toEqual(["T-3"]);
    expect(r2.resolved).toEqual([]);
    expect(r2.active).toHaveLength(1);
  });

  it("does not write when the ledger cannot be read, and retries later", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    const t1 = fixture.tasks["T-1"];
    writeFiles(t1.path, { "a.ts": "1\n" });
    await commitAll(t1.path, "work");
    const real = await memoryLedger();
    let broken = true;
    const ledger: LedgerPort = {
      append: (entry) => real.append(entry),
      entries: () => {
        if (broken) throw new Error("disk gone");
        return real.entries();
      },
      bySubject: (subject) => real.bySubject(subject),
    };
    const watcher = watcherFor(ledger, () => [t1]);
    const r1 = await watcher.tick();
    expect(r1.errors[0].message).toContain("disk gone");
    expect(real.entries()).toEqual([]);
    broken = false;
    expect((await watcher.tick()).observed).toHaveLength(1);
  });
});

describe("GitWatcher timer", { timeout: 60_000 }, () => {
  it("shares one in-flight tick and stops cleanly", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    const t1 = fixture.tasks["T-1"];
    let calls = 0;
    const watcher = new GitWatcher({
      ledger: await memoryLedger(),
      worktrees: () => {
        calls += 1;
        return [t1];
      },
    });
    const [a, b] = await Promise.all([watcher.tick(), watcher.tick()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);

    watcher.start(5);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await watcher.stop();
    const after = calls;
    expect(after).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(after);
  });
});
