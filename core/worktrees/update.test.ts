// Bringing a task's worktree up to date with the branch it merges into (manager.updateFromMain), and
// releasing file claims (manager.releaseClaims). The attacks: main moves after dispatch; the worker has
// unsaved edits; the same lines changed on both sides; a file the worker keeps out of git sits where main
// adds one; a merge already in progress; git refusing to apply it. Every refusal must leave the worker's
// files and branch byte-for-byte as they were: a marker file with the worker's unsaved text is compared
// before and after, and no conflict markers or MERGE_HEAD may ever appear in the worker's folder.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ledger } from "../ledger/index";
import { git } from "./git";
import { WorktreeManager } from "./manager";
import { commitAll, makeRepo, memoryLedger, writeFiles } from "./testing";

const person = { kind: "person", id: "owner" } as const;
const SLOW = 60_000;
const MARKER = "unsaved work the worker typed a second ago\n";

describe("WorktreeManager.updateFromMain", () => {
  let repo: { root: string; cleanup: () => void };
  let ledger: Ledger;
  let manager: WorktreeManager;
  let ports = 43300;

  beforeEach(async () => {
    repo = await makeRepo({ "README.md": "hello\n", ".gitignore": "local-notes.txt\n", "src/app.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n", "src/main-only.ts": "export const m = 0;\n" });
    ledger = await memoryLedger();
    manager = new WorktreeManager({ repoRoot: repo.root, ledger, install: false, maxParallel: 4, ports: [ports, (ports += 50)] });
  });
  afterEach(() => repo.cleanup());

  const tipOf = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);
  const statusOf = (cwd: string) => git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);

  async function mainMoves(files: Record<string, string>, message = "main moves on"): Promise<string> {
    writeFiles(repo.root, files);
    return commitAll(repo.root, message);
  }

  it("merges what main gained into the task's own branch, keeps the worker's commit, and moves the base so the diff stays the worker's", async () => {
    const info = await manager.create({ taskId: "T-1", actor: person });
    writeFiles(info.path, { "src/feature.ts": "export const feature = true;\n" });
    const workerTip = await commitAll(info.path, "worker: add the feature");
    const mainTip = await mainMoves({ "src/main-only.ts": "export const m = 1;\n", "docs/new.md": "from main\n" });

    const result = await manager.updateFromMain("T-1");
    expect(result).toMatchObject({ status: "updated", taskId: "T-1", base: "main", before: workerTip, mergedIn: mainTip, fastForward: false, commits: 1 });
    expect(result.message).toContain("1 new change from main");
    // A real merge commit: the worker's tip and main's tip are its two parents.
    const parents = (await git(info.path, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(" ").slice(1);
    expect(parents).toEqual([workerTip, mainTip]);
    expect(await tipOf(info.path)).toBe(result.after);
    expect(readFileSync(path.join(info.path, "docs/new.md"), "utf8")).toBe("from main\n");
    expect(readFileSync(path.join(info.path, "src/feature.ts"), "utf8")).toContain("feature");
    expect(await statusOf(info.path)).toBe("");
    // The task's base is now the merged-in commit, so "what the worker changed" is only the worker's file.
    expect((await manager.get("T-1"))?.baseSha).toBe(mainTip);
    expect(await git(info.path, ["diff", "--name-only", mainTip, "HEAD"])).toBe("src/feature.ts");
    // Main itself is untouched.
    expect(await tipOf(repo.root)).toBe(mainTip);
  }, SLOW);

  it("fast-forwards a task that has no commits of its own yet", async () => {
    const info = await manager.create({ taskId: "T-1", actor: person });
    const mainTip = await mainMoves({ "docs/new.md": "from main\n" });
    const result = await manager.updateFromMain("T-1");
    expect(result).toMatchObject({ status: "updated", fastForward: true, after: mainTip, commits: 1 });
    expect(await tipOf(info.path)).toBe(mainTip);
    expect((await manager.get("T-1"))?.baseSha).toBe(mainTip);
  }, SLOW);

  it("says so and changes nothing when the task already has everything", async () => {
    const info = await manager.create({ taskId: "T-1", actor: person });
    const before = await tipOf(info.path);
    const result = await manager.updateFromMain("T-1");
    expect(result).toMatchObject({ status: "up-to-date", message: expect.stringContaining("already has everything") });
    expect(await tipOf(info.path)).toBe(before);
  }, SLOW);

  it("refuses a dirty worktree (edited, staged and untracked files) and leaves every file exactly as it was", async () => {
    const info = await manager.create({ taskId: "T-1", actor: person });
    await mainMoves({ "docs/new.md": "from main\n" });
    // Unsaved work of every kind: an edit, a staged new file, an untracked marker.
    writeFiles(info.path, { "src/app.ts": "export const a = 100;\nexport const b = 2;\nexport const c = 3;\n", "src/staged.ts": "staged\n", "WIP-MARKER.txt": MARKER });
    await git(info.path, ["add", "src/staged.ts"]);
    const tipBefore = await tipOf(info.path);
    const statusBefore = await statusOf(info.path);
    const bytesBefore = readFileSync(path.join(info.path, "src/app.ts"));

    const result = await manager.updateFromMain("T-1");
    expect(result).toMatchObject({ status: "refused", reason: "dirty" });
    expect(result.files).toEqual(expect.arrayContaining(["src/app.ts", "src/staged.ts", "WIP-MARKER.txt"]));
    expect(result.message).toContain("not committed yet");
    expect(result.message).toContain("Nothing in T-1's folder was changed");
    expect(readFileSync(path.join(info.path, "WIP-MARKER.txt"), "utf8")).toBe(MARKER);
    expect(readFileSync(path.join(info.path, "src/app.ts")).equals(bytesBefore)).toBe(true);
    expect(await statusOf(info.path)).toBe(statusBefore);
    expect(await tipOf(info.path)).toBe(tipBefore);
    expect(existsSync(path.join(info.path, "docs/new.md"))).toBe(false);
    expect((await manager.get("T-1"))?.baseSha).toBe(info.baseSha);
  }, SLOW);

  it("reports a conflict and leaves the worktree untouched: no merge started, no conflict markers, no MERGE_HEAD", async () => {
    const info = await manager.create({ taskId: "T-1", actor: person });
    writeFiles(info.path, { "src/app.ts": "export const a = 1;\nexport const b = 22;\nexport const c = 3;\n" });
    const workerTip = await commitAll(info.path, "worker changes b");
    await mainMoves({ "src/app.ts": "export const a = 1;\nexport const b = 99;\nexport const c = 3;\n" }, "main changes b too");
    const statusBefore = await statusOf(info.path);
    const bytesBefore = readFileSync(path.join(info.path, "src/app.ts"));

    const result = await manager.updateFromMain("T-1");
    expect(result).toMatchObject({ status: "refused", reason: "conflict", files: ["src/app.ts"] });
    expect(result.message).toContain("same lines were changed in src/app.ts");
    expect(result.message).toContain("Nothing in T-1's folder was changed");
    expect(await tipOf(info.path)).toBe(workerTip);
    expect(await statusOf(info.path)).toBe(statusBefore);
    const bytesAfter = readFileSync(path.join(info.path, "src/app.ts"));
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
    expect(bytesAfter.toString("utf8")).not.toMatch(/<<<<<<<|>>>>>>>/);
    const mergeHead = (await git(info.path, ["rev-parse", "--git-path", "MERGE_HEAD"]));
    expect(existsSync(path.resolve(info.path, mergeHead))).toBe(false);
    expect((await manager.get("T-1"))?.baseSha).toBe(info.baseSha);
  }, SLOW);

  it("refuses to overwrite a file the worker keeps out of git where main now has one", async () => {
    const info = await manager.create({ taskId: "T-1", actor: person });
    writeFiles(info.path, { "local-notes.txt": MARKER });
    // main force-adds a tracked file with the name the worker's ignored notes use.
    writeFiles(repo.root, { "local-notes.txt": "from main\n" });
    await git(repo.root, ["add", "-f", "local-notes.txt"]);
    await git(repo.root, ["commit", "-q", "-m", "track the notes file"]);

    const result = await manager.updateFromMain("T-1");
    expect(result).toMatchObject({ status: "refused", reason: "would-overwrite", files: ["local-notes.txt"] });
    expect(readFileSync(path.join(info.path, "local-notes.txt"), "utf8")).toBe(MARKER);
  }, SLOW);

  it("refuses while a merge, rebase or cherry-pick is already in progress", async () => {
    const info = await manager.create({ taskId: "T-1", actor: person });
    await mainMoves({ "docs/new.md": "from main\n" });
    const marker = path.resolve(info.path, await git(info.path, ["rev-parse", "--git-path", "MERGE_HEAD"]));
    writeFileSync(marker, `${await tipOf(info.path)}\n`);
    const result = await manager.updateFromMain("T-1");
    expect(result).toMatchObject({ status: "refused", reason: "unfinished" });
    expect(existsSync(path.join(info.path, "docs/new.md"))).toBe(false);
  }, SLOW);

  it("when git itself will not apply the update, the folder is verified unchanged and the answer says so", async () => {
    const info = await manager.create({ taskId: "T-1", actor: person });
    writeFiles(info.path, { "src/feature.ts": "export const feature = true;\n" });
    const workerTip = await commitAll(info.path, "worker: add the feature");
    await mainMoves({ "docs/new.md": "from main\n" });
    // A held index lock makes git refuse to move the checkout.
    const lock = path.resolve(info.path, await git(info.path, ["rev-parse", "--git-path", "index.lock"]));
    writeFileSync(lock, "");
    try {
      const result = await manager.updateFromMain("T-1");
      expect(result).toMatchObject({ status: "refused", reason: "failed" });
      expect(result.message).toContain("Nothing in T-1's folder was changed");
      expect(await tipOf(info.path)).toBe(workerTip);
      expect(existsSync(path.join(info.path, "docs/new.md"))).toBe(false);
    } finally {
      rmSync(lock, { force: true });
    }
    expect((await manager.get("T-1"))?.baseSha).toBe(info.baseSha);
    // With the lock gone the same call works.
    expect((await manager.updateFromMain("T-1")).status).toBe("updated");
  }, SLOW);

  it("refuses a worktree folder that is missing or on another branch, and an unknown task", async () => {
    const info = await manager.create({ taskId: "T-1", actor: person });
    await expect(manager.updateFromMain("T-9")).rejects.toThrow(/no worktree/);
    await git(info.path, ["checkout", "-q", "--detach"]);
    expect(await manager.updateFromMain("T-1")).toMatchObject({ status: "refused", reason: "wrong-branch" });
    await git(info.path, ["checkout", "-q", info.branch]);
    rmSync(info.path, { recursive: true, force: true });
    expect(await manager.updateFromMain("T-1")).toMatchObject({ status: "refused", reason: "folder-missing" });
    expect(existsSync(info.path)).toBe(false);
  }, SLOW);

  it("keeps updating from the integration branch a task was started from, not always main", async () => {
    await git(repo.root, ["branch", "integration"]);
    const info = await manager.create({ taskId: "T-1", actor: person, baseRef: "integration" });
    await mainMoves({ "docs/new.md": "main only\n" });
    expect((await manager.updateFromMain("T-1")).status).toBe("up-to-date");
    await git(repo.root, ["checkout", "-q", "integration"]);
    writeFiles(repo.root, { "docs/integration.md": "integration\n" });
    await commitAll(repo.root, "integration moves");
    await git(repo.root, ["checkout", "-q", "main"]);
    expect(await manager.updateFromMain("T-1")).toMatchObject({ status: "updated", base: "integration", fastForward: true });
    expect(existsSync(path.join(info.path, "docs/integration.md"))).toBe(true);
    expect(existsSync(path.join(info.path, "docs/new.md"))).toBe(false);
  }, SLOW);
});

describe("WorktreeManager.releaseClaims", () => {
  let repo: { root: string; cleanup: () => void };
  let manager: WorktreeManager;
  beforeEach(async () => {
    repo = await makeRepo({ "README.md": "hello\n" });
    manager = new WorktreeManager({ repoRoot: repo.root, ledger: await memoryLedger(), install: false, ports: [43400, 43450] });
  });
  afterEach(() => repo.cleanup());

  it("frees all of a task's file claims, or just the ones named, and then another task can claim them", async () => {
    await manager.create({ taskId: "T-1", actor: person, claims: ["src/a.ts", "src/b.ts", "docs/**"] });
    await manager.create({ taskId: "T-2", actor: person, claims: ["src/z.ts"] });
    expect(await manager.claim("T-2", ["src/a.ts"])).toHaveLength(1);
    expect(await manager.releaseClaims("T-1", ["src/a.ts", "not-claimed.ts"])).toEqual({ released: ["src/a.ts"], remaining: ["docs/**", "src/b.ts"] });
    expect(await manager.claim("T-2", ["src/a.ts"])).toEqual([]);
    expect(await manager.releaseClaims("T-1")).toEqual({ released: ["docs/**", "src/b.ts"], remaining: [] });
    expect(await manager.releaseClaims("T-1")).toEqual({ released: [], remaining: [] });
    // It lives in the registry, so it survives a new manager.
    const again = new WorktreeManager({ repoRoot: repo.root, ledger: await memoryLedger(), install: false });
    expect((await again.get("T-1"))?.claims).toEqual([]);
    await expect(manager.releaseClaims("T-9")).rejects.toThrow(/no worktree/);
  }, SLOW);
});

