import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ledger } from "../ledger/index";
import { git, runGit } from "./git";
import { WorktreeManager } from "./manager";
import { lines, samePath } from "./platform";
import { commitAll, makeRepo, memoryLedger, writeFiles } from "./testing";

const person = { kind: "person", id: "looplet-spare" } as const;
const SLOW = 60_000;

describe("WorktreeManager", () => {
  let repo: { root: string; cleanup: () => void };
  let ledger: Ledger;
  let manager: WorktreeManager;

  beforeEach(async () => {
    repo = await makeRepo({ "README.md": "hello\n", "src/app.ts": "export const a = 1;\n" });
    ledger = await memoryLedger();
    manager = new WorktreeManager({ repoRoot: repo.root, ledger, install: false, maxParallel: 3, ports: [43100, 43199] });
  });
  afterEach(() => repo.cleanup());

  it("creates branch pp/T-n and a worktree under .perfect-planner/worktrees, and logs it", async () => {
    const info = await manager.create({ taskId: "T-14", actor: person });
    expect(info.branch).toBe("pp/T-14");
    expect(samePath(info.path, path.join(repo.root, ".perfect-planner", "worktrees", "T-14"))).toBe(true);
    expect(await git(info.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("pp/T-14");
    expect(info.baseSha).toBe(await git(repo.root, ["rev-parse", "main"]));
    expect(info.baseRef).toBe("main");
    const [entry] = ledger.entries().filter((item) => item.type === "worktree.created");
    expect(entry.subject).toBe("T-14");
    expect(entry.evidence).toContain("branch:pp/T-14");
    expect(entry.data).toMatchObject({ branch: "pp/T-14", port: info.port, path: ".perfect-planner/worktrees/T-14" });
    // The main checkout stays clean: task worktrees are excluded locally, not via the tracked .gitignore.
    expect(await git(repo.root, ["status", "--porcelain"])).toBe("");
    expect(await manager.list()).toHaveLength(1);
  }, SLOW);

  it("refuses bad ids, a second worktree for a task, and a reused branch", async () => {
    await expect(manager.create({ taskId: "../evil", actor: person })).rejects.toThrow(/not a task id/);
    await manager.create({ taskId: "T-1", actor: person });
    await expect(manager.create({ taskId: "T-1", actor: person })).rejects.toThrow(/already has a worktree/);
    await git(repo.root, ["branch", "pp/T-2"]);
    await expect(manager.create({ taskId: "T-2", actor: person })).rejects.toThrow(/already exists/);
  }, SLOW);

  it("relies on git to refuse checking out one branch in two worktrees", async () => {
    const info = await manager.create({ taskId: "T-3", actor: person });
    const result = await runGit(repo.root, ["worktree", "add", path.join(path.dirname(repo.root), "elsewhere"), info.branch]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/already (checked out|used by worktree)/);
  }, SLOW);

  it("enforces the parallel cap and hands out distinct free ports", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(43100, "127.0.0.1", resolve));
    try {
      const made = await Promise.all(["T-1", "T-2", "T-3"].map((taskId) => manager.create({ taskId, actor: person })));
      const ports = made.map((info) => info.port);
      expect(new Set(ports).size).toBe(3);
      expect(ports).not.toContain(43100);
      await expect(manager.create({ taskId: "T-4", actor: person })).rejects.toThrow(/3 worktrees are already running/);
    } finally {
      blocker.close();
    }
  }, SLOW);

  it("keeps file claims apart, matching folders and case the way the collision engine does", async () => {
    await manager.create({ taskId: "T-1", actor: person, claims: ["src/invoice/**"] });
    await expect(manager.create({ taskId: "T-2", actor: person, claims: ["SRC/Invoice/send.ts"] })).rejects.toThrow(/already claimed/);
    await manager.create({ taskId: "T-2", actor: person, claims: ["src/email.ts"] });
    expect(await manager.claim("T-2", ["src/invoice/pdf.ts"])).toEqual([{ taskId: "T-1", mine: "src/invoice/pdf.ts", theirs: "src/invoice/**" }]);
    expect(await manager.claim("T-2", ["docs\\notes.md"])).toEqual([]);
    expect((await manager.get("T-2"))?.claims).toEqual(["docs/notes.md", "src/email.ts"]);
  }, SLOW);

  it("copies local settings with secrets replaced by placeholders", async () => {
    // Built at runtime so the repo's own secret scan does not flag this fixture.
    const fakeKey = ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("-");
    writeFiles(repo.root, { ".env": `API_KEY=${fakeKey}\r\nPORT=3000\r\nDB_PASSWORD=hunter2hunter2\r\n`, ".env.example": "API_KEY=\n" });
    const info = await manager.create({ taskId: "T-5", actor: person });
    expect(readFileSync(path.join(info.path, ".env"), "utf8")).toBe("API_KEY=PLACEHOLDER\r\nPORT=3000\r\nDB_PASSWORD=PLACEHOLDER\r\n");
    expect(readFileSync(path.join(info.path, ".env.example"), "utf8")).toBe("API_KEY=\n");
  }, SLOW);

  it("installs a commit-time secret scan that blocks a planted key in the task worktree only", async () => {
    const info = await manager.create({ taskId: "T-6", actor: person });
    writeFiles(info.path, { "src/config.ts": `export const key = "AKIA${"A".repeat(16)}";\n` });
    await git(info.path, ["add", "-A"]);
    const blocked = await runGit(info.path, ["commit", "-m", "add config"]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toMatch(/blocked this commit[\s\S]*src\/config\.ts:1 \(aws-access-key\)/);
    expect(blocked.stderr).not.toContain("AKIA");
    writeFiles(info.path, { "src/config.ts": "export const key = process.env.KEY;\n" });
    await git(info.path, ["add", "-A"]);
    expect((await runGit(info.path, ["commit", "-m", "read key from env"])).code).toBe(0);
    // The main checkout keeps its own hooks.
    expect((await runGit(repo.root, ["config", "--get", "core.hooksPath"])).stdout.trim()).toBe("");
  }, SLOW);

  it("runs the dependency installer in the new worktree and rolls back if it fails", async () => {
    const seen: string[] = [];
    const ok = new WorktreeManager({ repoRoot: repo.root, ledger, install: async (dir) => void seen.push(dir) });
    const info = await ok.create({ taskId: "T-7", actor: person });
    expect(seen).toEqual([info.path]);

    const failing = new WorktreeManager({ repoRoot: repo.root, ledger, install: async () => { throw new Error("install broke"); } });
    await expect(failing.create({ taskId: "T-8", actor: person })).rejects.toThrow(/install broke/);
    expect((await runGit(repo.root, ["show-ref", "--verify", "refs/heads/pp/T-8"])).code).not.toBe(0);
    expect(existsSync(path.join(repo.root, ".perfect-planner", "worktrees", "T-8"))).toBe(false);
    expect((await failing.list()).map((item) => item.taskId)).toEqual(["T-7"]);
  }, SLOW);

  it("removes a merged task's worktree and branch, and logs it", async () => {
    const info = await manager.create({ taskId: "T-9", actor: person });
    writeFiles(info.path, { "src/app.ts": "export const a = 2;\n" });
    await commitAll(info.path, "change a");
    await git(repo.root, ["merge", "-q", "--ff-only", info.branch]);
    const result = await manager.remove("T-9", person);
    expect(result).toEqual({ taskId: "T-9", branchDeleted: true, branchKeptReason: undefined });
    expect(existsSync(info.path)).toBe(false);
    expect((await runGit(repo.root, ["show-ref", "--verify", "refs/heads/pp/T-9"])).code).not.toBe(0);
    expect(ledger.entries().at(-1)).toMatchObject({ type: "worktree.removed", subject: "T-9" });
  }, SLOW);

  it("never discards work: refuses a dirty worktree and keeps an unmerged branch", async () => {
    const info = await manager.create({ taskId: "T-10", actor: person });
    writeFiles(info.path, { "notes.txt": "unsaved idea\n" });
    await expect(manager.remove("T-10")).rejects.toThrow(/uncommitted changes/);
    expect(existsSync(path.join(info.path, "notes.txt"))).toBe(true);
    await commitAll(info.path, "keep idea");
    const result = await manager.remove("T-10");
    expect(result.branchDeleted).toBe(false);
    expect(result.branchKeptReason).toMatch(/not merged into main/);
    expect((await runGit(repo.root, ["show-ref", "--verify", "refs/heads/pp/T-10"])).code).toBe(0);
  }, SLOW);

  it("reconciles the registry with git's own worktree list", async () => {
    const info = await manager.create({ taskId: "T-11", actor: person });
    await git(repo.root, ["worktree", "add", "-b", "pp/T-12", path.join(repo.root, ".perfect-planner", "worktrees", "T-12")]);
    await git(repo.root, ["worktree", "remove", "--force", info.path]);
    expect(await manager.reconcile()).toEqual({ missing: ["T-11"], untracked: ["T-12"] });
    // A worktree that disappeared can still be cleaned out of the registry.
    await manager.remove("T-11");
    expect((await manager.list()).map((item) => item.taskId)).toEqual([]);
  }, SLOW);

  it("survives a new manager instance (state lives in the git dir, not memory)", async () => {
    await manager.create({ taskId: "T-13", actor: person, claims: ["a.txt"] });
    const again = new WorktreeManager({ repoRoot: repo.root, ledger, install: false });
    expect((await again.get("T-13"))?.claims).toEqual(["a.txt"]);
    const listed = lines(await git(repo.root, ["worktree", "list", "--porcelain"])).filter((line) => line.startsWith("branch "));
    expect(listed).toContain("branch refs/heads/pp/T-13");
  }, SLOW);

  it("lets an agent launch a worktree; the manager writes the entry and names the agent", async () => {
    const agent = { kind: "agent", id: "worker-2", model: "test-model" } as const;
    await manager.create({ taskId: "T-17", actor: agent });
    expect(ledger.entries().at(-1)).toMatchObject({ type: "worktree.created", actor: { kind: "system", id: "worktrees" }, data: { launchedBy: agent } });
  }, SLOW);

  it("leaves a user's own pre-existing exclude lines alone", async () => {
    const exclude = path.join(repo.root, ".git", "info", "exclude");
    writeFileSync(exclude, "*.log");
    await manager.create({ taskId: "T-15", actor: person });
    await manager.create({ taskId: "T-16", actor: person });
    expect(readFileSync(exclude, "utf8")).toBe("*.log\n/.perfect-planner/worktrees/\n");
  }, SLOW);
});
