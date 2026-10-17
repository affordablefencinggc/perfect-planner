// Registry against git against disk, recreating a deleted folder, and the safe sweep (lane L10).
// Every attack here is one a person or a stray program can really do to the folders: delete one by hand,
// delete the whole .perfect-planner folder, leave work in one, leave commits in one, edit the registry.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ledger } from "../ledger/index";
import { git, runGit } from "./git";
import { type FolderClass, WorktreeManager } from "./manager";
import { commitAll, makeRepo, memoryLedger, workerGit, writeFiles } from "./testing";
import type { WorktreeInfo } from "./types";

const person = { kind: "person", id: "owner" } as const;
const SLOW = 60_000;
const finished = (): FolderClass => "finished";

describe("keeping the registry, git and the disk in step", () => {
  let repo: { root: string; cleanup: () => void };
  let ledger: Ledger;
  let manager: WorktreeManager;

  beforeEach(async () => {
    repo = await makeRepo({ "README.md": "hello\n", "src/app.ts": "export const a = 1;\n" });
    ledger = await memoryLedger();
    manager = new WorktreeManager({ repoRoot: repo.root, ledger, install: false, maxParallel: 4, ports: [43200, 43299] });
  });
  afterEach(() => repo.cleanup());

  const branches = async () => (await git(repo.root, ["branch", "--list", "pp/*"])).split(/\r?\n/).map((line) => line.replace(/^[*+ ]+/, "").trim()).filter(Boolean).sort();
  /** A task folder with one committed change on its branch (not merged anywhere). */
  async function withCommit(taskId: string, file = "change.txt"): Promise<WorktreeInfo> {
    const info = await manager.create({ taskId, actor: person });
    writeFiles(info.path, { [file]: `work of ${taskId}\n` });
    await commitAll(info.path, `work of ${taskId}`);
    return info;
  }

  describe("reconcileWithDisk", () => {
    it("tells ok, missing, gone and unlinked apart, and lists pp worktrees the registry does not know", async () => {
      const ok = await manager.create({ taskId: "T-1", actor: person });
      const missing = await withCommit("T-2");
      const gone = await manager.create({ taskId: "T-3", actor: person });
      const unlinked = await manager.create({ taskId: "T-4", actor: person });
      await git(repo.root, ["worktree", "add", "-b", "pp/T-9", path.join(repo.root, ".perfect-planner", "worktrees", "T-9")]);
      rmSync(missing.path, { recursive: true, force: true });
      rmSync(gone.path, { recursive: true, force: true });
      await git(repo.root, ["worktree", "prune"]);
      await git(repo.root, ["branch", "-D", "pp/T-3"]);
      rmSync(path.join(repo.root, ".git", "worktrees", "T-4"), { recursive: true, force: true });
      const before = await branches();

      const result = await manager.reconcileWithDisk();
      expect(Object.fromEntries(result.folders.map((f) => [f.taskId, f.state]))).toEqual({ "T-1": "ok", "T-2": "missing", "T-3": "gone", "T-4": "unlinked" });
      expect(result.folders.find((f) => f.taskId === "T-2")?.note).toMatch(/deleted outside Perfect Planner.*pp\/T-2/);
      expect(result.untracked.map((u) => u.name)).toEqual(["T-9"]);
      expect(result.forgotten).toEqual([]);
      // Looking changes nothing: same records, same branches, the unlinked folder untouched.
      expect((await manager.list()).map((i) => i.taskId)).toEqual(["T-1", "T-2", "T-3", "T-4"]);
      expect(await branches()).toEqual(before);
      expect(existsSync(unlinked.path)).toBe(true);
      expect(existsSync(ok.path)).toBe(true);
    }, SLOW);

    it("with forget, drops only the record whose folder and branch are both gone, and writes it to the ledger", async () => {
      const gone = await manager.create({ taskId: "T-3", actor: person });
      await withCommit("T-2").then((info) => rmSync(info.path, { recursive: true, force: true }));
      rmSync(gone.path, { recursive: true, force: true });
      await git(repo.root, ["worktree", "prune"]);
      await git(repo.root, ["branch", "-D", "pp/T-3"]);
      // Pruning above also dropped T-2's git entry; its branch is still there.
      const result = await manager.reconcileWithDisk({ forget: true });
      expect(result.forgotten).toEqual(["T-3"]);
      expect((await manager.list()).map((i) => i.taskId)).toEqual(["T-2"]);
      expect(ledger.entries().at(-1)).toMatchObject({ type: "worktree.removed", subject: "T-3", data: { forgotten: true, branchDeleted: false } });
      expect(await branches()).toEqual(["pp/T-2"]);
    }, SLOW);

    it("survives the whole .perfect-planner folder being deleted: every folder reads as missing, no branch is lost", async () => {
      const a = await withCommit("T-1");
      const b = await withCommit("T-2");
      rmSync(path.join(repo.root, ".perfect-planner"), { recursive: true, force: true });
      const result = await manager.reconcileWithDisk({ forget: true });
      expect(result.folders.map((f) => f.state)).toEqual(["missing", "missing"]);
      expect(result.forgotten).toEqual([]);
      expect(await branches()).toEqual(["pp/T-1", "pp/T-2"]);
      // And both come back, with their commits.
      for (const info of [a, b]) {
        const back = await manager.recreate(info.taskId, person);
        expect(existsSync(path.join(back.info.path, "change.txt"))).toBe(true);
        expect(await git(back.info.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(info.branch);
      }
      expect((await manager.reconcileWithDisk()).folders.map((f) => f.state)).toEqual(["ok", "ok"]);
    }, SLOW);

    it("a registry edited to point outside the worktree folder is 'unlinked': never recreated into, swept or removed", async () => {
      const info = await withCommit("T-1");
      const outside = path.join(os.tmpdir(), `pp-outside-${Date.now()}`);
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, "precious.txt"), "mine\n");
      const registryFile = path.join(repo.root, ".git", "perfect-planner", "worktrees.json");
      const doc = JSON.parse(readFileSync(registryFile, "utf8"));
      doc.worktrees[0].path = outside;
      writeFileSync(registryFile, JSON.stringify(doc));
      try {
        expect((await manager.reconcileWithDisk()).folders[0]).toMatchObject({ state: "unlinked", note: expect.stringMatching(/outside its own worktree folder/) });
        await expect(manager.recreate("T-1", person)).rejects.toThrow(/outside its own worktree folder/);
        const swept = await manager.sweep({ classify: finished });
        expect(swept.removed).toEqual([]);
        await expect(manager.removeChecked("T-1", person, () => ({}))).rejects.toThrow(/outside its own worktree folder/);
        expect(readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("mine\n");
        expect(existsSync(info.path)).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    }, SLOW);
  });

  describe("recreate", () => {
    it("brings a deleted folder back from its branch with every commit, a fresh secret-scan hook, and never touches the branch", async () => {
      const info = await withCommit("T-1");
      const tip = await git(info.path, ["rev-parse", "HEAD"]);
      // Staged-but-uncommitted work in a deleted folder is gone with the folder; committed work is not.
      rmSync(info.path, { recursive: true, force: true });
      const before = await branches();
      const result = await manager.recreate("T-1", person);
      expect(result.info.path).toBe(info.path);
      expect(await git(info.path, ["rev-parse", "HEAD"])).toBe(tip);
      expect(readFileSync(path.join(info.path, "change.txt"), "utf8")).toBe("work of T-1\n");
      expect(await git(info.path, ["config", "--worktree", "core.hooksPath"])).toContain("perfect-planner");
      expect(await branches()).toEqual(before);
      expect(ledger.entries().at(-1)).toMatchObject({ type: "worktree.created", subject: "T-1", data: { recreated: true, branch: "pp/T-1" } });
      expect((await manager.reconcileWithDisk()).folders[0].state).toBe("ok");
    }, SLOW);

    it("refuses when the folder is already there, when the record is unlinked, when the branch is gone, and when another folder holds the branch", async () => {
      const info = await manager.create({ taskId: "T-1", actor: person });
      await expect(manager.recreate("T-1", person)).rejects.toThrow(/already there/);
      await expect(manager.recreate("T-77", person)).rejects.toThrow(/no worktree record/);
      // Folder gone and the same branch checked out somewhere else (a person's own worktree): never two folders on one branch.
      rmSync(info.path, { recursive: true, force: true });
      const elsewhere = path.join(path.dirname(repo.root), "elsewhere");
      expect((await runGit(repo.root, ["worktree", "add", "--force", elsewhere, "pp/T-1"])).code).toBe(0);
      await expect(manager.recreate("T-1", person)).rejects.toThrow(/already checked out/);
      expect(existsSync(info.path)).toBe(false);
      await git(repo.root, ["worktree", "remove", "--force", elsewhere]);
      // Branch deleted too: nothing to recreate.
      await git(repo.root, ["worktree", "prune"]);
      await git(repo.root, ["branch", "-D", "pp/T-1"]);
      await expect(manager.recreate("T-1", person)).rejects.toThrow(/both deleted/);
    }, SLOW);

    it("when setting the folder up fails, the fresh checkout is taken away again and the branch and its commit are exactly as they were", async () => {
      const info = await withCommit("T-1");
      const tip = await git(info.path, ["rev-parse", "HEAD"]);
      rmSync(info.path, { recursive: true, force: true });
      const failing = new WorktreeManager({ repoRoot: repo.root, ledger, install: async () => { throw new Error("install exploded"); }, ports: [43200, 43299] });
      await expect(failing.recreate("T-1", person)).rejects.toThrow(/install exploded/);
      expect(existsSync(info.path)).toBe(false);
      expect(await git(repo.root, ["rev-parse", "pp/T-1"])).toBe(tip);
      expect((await manager.reconcileWithDisk()).folders[0].state).toBe("missing");
      // And a later try with a working install succeeds.
      await manager.recreate("T-1", person);
      expect(existsSync(path.join(info.path, "change.txt"))).toBe(true);
    }, SLOW);

    it("a ledger that refuses the entry (month's budget) does not undo the folder; the note says why", async () => {
      const info = await withCommit("T-1");
      rmSync(info.path, { recursive: true, force: true });
      ledger.addRule((draft) => (draft.type === "worktree.created" ? "Monthly budget reached" : null));
      const result = await manager.recreate("T-1", person);
      expect(result.ledgerNote).toMatch(/Monthly budget/);
      expect(existsSync(path.join(info.path, "change.txt"))).toBe(true);
    }, SLOW);
  });

  describe("sweep", () => {
    it("removes a finished folder with nothing to lose, deleting only its fully merged branch", async () => {
      const info = await withCommit("T-1");
      await git(repo.root, ["merge", "-q", "--ff-only", info.branch]);
      const result = await manager.sweep({ classify: finished });
      expect(result.removed).toMatchObject([{ taskId: "T-1", branchDeleted: true }]);
      expect(existsSync(info.path)).toBe(false);
      expect(await branches()).toEqual([]);
      expect(ledger.entries().at(-1)).toMatchObject({ type: "worktree.removed", subject: "T-1", data: { branchDeleted: true } });
    }, SLOW);

    it("never removes a dirty folder: uncommitted change, untracked file, staged change, or ignored work", async () => {
      writeFiles(repo.root, { ".gitignore": "*.local.md\n" });
      await commitAll(repo.root, "ignore local notes");
      const a = await manager.create({ taskId: "T-1", actor: person });
      const b = await manager.create({ taskId: "T-2", actor: person });
      const c = await manager.create({ taskId: "T-3", actor: person });
      const d = await manager.create({ taskId: "T-4", actor: person });
      writeFiles(a.path, { "src/app.ts": "export const a = 2;\n" });
      writeFiles(b.path, { "scratch.txt": "untracked\n" });
      writeFiles(c.path, { "staged.txt": "staged\n" });
      await git(c.path, ["add", "staged.txt"]);
      writeFiles(d.path, { "ideas.local.md": "ignored but mine\n" });
      const result = await manager.sweep({ classify: finished });
      expect(result.removed).toEqual([]);
      expect(result.kept.map((k) => k.taskId)).toEqual(["T-1", "T-2", "T-3", "T-4"]);
      for (const kept of result.kept) {
        expect(kept.removable, kept.taskId).toBe(false);
        expect(kept.why.join(" "), kept.taskId).toMatch(/uncommitted|ignored files/);
      }
      expect(readFileSync(path.join(a.path, "src/app.ts"), "utf8")).toBe("export const a = 2;\n");
      expect(existsSync(path.join(b.path, "scratch.txt"))).toBe(true);
      expect(existsSync(path.join(c.path, "staged.txt"))).toBe(true);
      expect(existsSync(path.join(d.path, "ideas.local.md"))).toBe(true);
    }, SLOW);

    it("never removes a folder with commits that are neither merged nor pushed, even a commit on a detached HEAD no branch holds", async () => {
      const a = await withCommit("T-1");
      const b = await manager.create({ taskId: "T-2", actor: person });
      workerGit(b.path, ["checkout", "-q", "--detach"]);
      writeFiles(b.path, { "lost.txt": "only here\n" });
      workerGit(b.path, ["-c", "user.name=w", "-c", "user.email=w@w.invalid", "add", "-A"]);
      workerGit(b.path, ["-c", "user.name=w", "-c", "user.email=w@w.invalid", "commit", "-q", "-m", "detached work"]);
      const result = await manager.sweep({ classify: finished });
      expect(result.removed).toEqual([]);
      const byTask = Object.fromEntries(result.kept.map((k) => [k.taskId, k]));
      expect(byTask["T-1"].why.join(" ")).toMatch(/1 commit not merged into main or pushed anywhere/);
      expect(byTask["T-1"].removable).toBe(true);
      // The detached commit is on no branch: the person cannot choose past that one either.
      expect(byTask["T-2"].why.join(" ")).toMatch(/not merged into main or pushed|not on any branch/);
      expect(byTask["T-2"].why.join(" ")).toMatch(/not on any branch/);
      expect(byTask["T-2"].removable).toBe(false);
      expect(existsSync(path.join(a.path, "change.txt"))).toBe(true);
      expect(existsSync(path.join(b.path, "lost.txt"))).toBe(true);
    }, SLOW);

    it("removes a folder whose commits are on a remote, keeping the unmerged branch", async () => {
      const info = await withCommit("T-1");
      const remote = path.join(path.dirname(repo.root), "remote.git");
      await git(path.dirname(repo.root), ["init", "-q", "--bare", remote]);
      await git(repo.root, ["remote", "add", "origin", remote]);
      expect(workerGit(repo.root, ["push", "-q", "origin", "pp/T-1"]).code).toBe(0);
      const tip = await git(repo.root, ["rev-parse", "pp/T-1"]);
      const result = await manager.sweep({ classify: finished });
      expect(result.removed).toMatchObject([{ taskId: "T-1", branchDeleted: false }]);
      expect(existsSync(info.path)).toBe(false);
      expect(await git(repo.root, ["rev-parse", "pp/T-1"])).toBe(tip);
    }, SLOW);

    it("a commit made after the push is no longer safe, and the folder stays", async () => {
      const info = await withCommit("T-1");
      const remote = path.join(path.dirname(repo.root), "remote2.git");
      await git(path.dirname(repo.root), ["init", "-q", "--bare", remote]);
      await git(repo.root, ["remote", "add", "origin", remote]);
      expect(workerGit(repo.root, ["push", "-q", "origin", "pp/T-1"]).code).toBe(0);
      writeFiles(info.path, { "later.txt": "after the push\n" });
      await commitAll(info.path, "after the push");
      const result = await manager.sweep({ classify: finished });
      expect(result.removed).toEqual([]);
      expect(result.kept[0].why.join(" ")).toMatch(/1 commit not merged into main or pushed/);
    }, SLOW);

    it("leaves active folders alone and unlisted, lists unclear ones with their owner, size and reason, and removes nothing on a dry run", async () => {
      const merged = await withCommit("T-1");
      await git(repo.root, ["merge", "-q", "--ff-only", merged.branch]);
      const active = await manager.create({ taskId: "T-2", actor: person });
      const unclear = await manager.create({ taskId: "T-3", actor: { kind: "agent", id: "worker-7" } });
      const classify = (info: WorktreeInfo): FolderClass => (info.taskId === "T-1" ? "finished" : info.taskId === "T-2" ? "active" : { keep: "Nobody holds T-3." });
      const dry = await manager.sweep({ classify, dryRun: true });
      expect(dry.removed).toEqual([]);
      expect(existsSync(merged.path)).toBe(true);
      expect(dry.kept.map((k) => k.taskId)).toEqual(["T-1", "T-3"]);
      expect(dry.kept[0].why[0]).toMatch(/nothing in it would be lost/);
      const t3 = dry.kept[1];
      expect(t3).toMatchObject({ launchedBy: "worker-7", state: "ok" });
      expect(t3.sizeBytes).toBeGreaterThan(0);
      expect(t3.why[0]).toBe("Nobody holds T-3.");
      const real = await manager.sweep({ classify });
      expect(real.removed.map((r) => r.taskId)).toEqual(["T-1"]);
      expect(existsSync(active.path)).toBe(true);
      expect(existsSync(unclear.path)).toBe(true);
    }, SLOW);

    it("a released task's folder goes only once its branch is merged, because the branch goes with it and a branch is used once", async () => {
      const info = await withCommit("T-1");
      const released = () => "released" as const;
      const first = await manager.sweep({ classify: released });
      expect(first.removed).toEqual([]);
      expect(first.kept[0].why.join(" ")).toMatch(/no way to start a worker on it/);
      await git(repo.root, ["merge", "-q", "--ff-only", info.branch]);
      expect((await manager.sweep({ classify: released })).removed).toMatchObject([{ taskId: "T-1", branchDeleted: true }]);
    }, SLOW);

    it("a folder git holds locked is kept", async () => {
      const info = await manager.create({ taskId: "T-1", actor: person });
      await git(repo.root, ["worktree", "lock", info.path]);
      const result = await manager.sweep({ classify: finished });
      expect(result.removed).toEqual([]);
      expect(result.kept[0].why.join(" ")).toMatch(/locked/);
      expect(existsSync(info.path)).toBe(true);
    }, SLOW);

    it("a folder that is missing or unlinked is listed with its note, never removed", async () => {
      const a = await manager.create({ taskId: "T-1", actor: person });
      const b = await manager.create({ taskId: "T-2", actor: person });
      rmSync(a.path, { recursive: true, force: true });
      rmSync(path.join(repo.root, ".git", "worktrees", "T-2"), { recursive: true, force: true });
      writeFiles(b.path, { "mine.txt": "x\n" });
      const result = await manager.sweep({ classify: finished });
      expect(result.removed).toEqual([]);
      expect(result.kept.map((k) => [k.taskId, k.state])).toEqual([["T-1", "missing"], ["T-2", "unlinked"]]);
      expect(existsSync(path.join(b.path, "mine.txt"))).toBe(true);
    }, SLOW);

    it("a sweep and a create at the same moment never interleave: the new folder is not swept, and the swept one is gone for good", async () => {
      const old = await withCommit("T-1");
      await git(repo.root, ["merge", "-q", "--ff-only", old.branch]);
      const [swept, fresh] = await Promise.all([manager.sweep({ classify: (info) => (info.taskId === "T-1" ? "finished" : "active") }), manager.create({ taskId: "T-2", actor: person })]);
      expect(swept.removed.map((r) => r.taskId)).toEqual(["T-1"]);
      expect(existsSync(fresh.path)).toBe(true);
      expect(existsSync(old.path)).toBe(false);
      expect((await manager.list()).map((i) => i.taskId)).toEqual(["T-2"]);
    }, SLOW);

    it("two sweeps at once remove each folder once and never fail the second", async () => {
      const a = await manager.create({ taskId: "T-1", actor: person });
      const [one, two] = await Promise.all([manager.sweep({ classify: finished }), manager.sweep({ classify: finished })]);
      expect([...one.removed, ...two.removed].map((r) => r.taskId)).toEqual(["T-1"]);
      expect(existsSync(a.path)).toBe(false);
    }, SLOW);
  });

  describe("removeChecked (the person's own choice)", () => {
    it("removes a clean folder whose commits are only on the branch, keeping the branch; refuses dirty ones and open unmerged ones", async () => {
      const info = await withCommit("T-1");
      const tip = await git(info.path, ["rev-parse", "HEAD"]);
      // An open task with an unmerged branch cannot lose its folder: no new folder could ever be made for it.
      await expect(manager.removeChecked("T-1", person, () => ({ needMerged: true }))).rejects.toThrow(/no way to start a worker/);
      await expect(manager.removeChecked("T-1", person, () => ({ refuse: "T-1 is still being worked on." }))).rejects.toThrow(/still being worked on/);
      writeFiles(info.path, { "notes.txt": "x\n" });
      await expect(manager.removeChecked("T-1", person, () => ({}))).rejects.toThrow(/uncommitted/);
      rmSync(path.join(info.path, "notes.txt"));
      const removed = await manager.removeChecked("T-1", person, () => ({}));
      expect(removed).toMatchObject({ taskId: "T-1", branchDeleted: false });
      expect(existsSync(info.path)).toBe(false);
      expect(await git(repo.root, ["rev-parse", "pp/T-1"])).toBe(tip);
    }, SLOW);
  });

  it("readFacts takes no git lock: the index of a worker's folder is never held while looking", async () => {
    const info = await withCommit("T-1");
    writeFiles(info.path, { "x.txt": "x\n" });
    const lock = path.join(repo.root, ".git", "worktrees", "T-1", "index.lock");
    const looking = manager.assess(info);
    expect(existsSync(lock)).toBe(false);
    await looking;
    expect(existsSync(lock)).toBe(false);
  }, SLOW);
});
