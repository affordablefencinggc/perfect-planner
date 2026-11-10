import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ledger } from "../ledger/index";
import { git, runGit } from "./git";
import { WorktreeManager, preCommitHook } from "./manager";
import { lines, samePath } from "./platform";
import { PLACEHOLDER } from "./settings";
import { commitAll, makeRepo, memoryLedger, workerGit, writeFiles } from "./testing";

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

  it("creates from an empty registry through dispatch without a full reconciliation", async () => {
    const reconcile = vi.spyOn(manager, "reconcileWithDisk");
    const info = await manager.getOrCreateForDispatch({ taskId: "T-19", actor: person });
    expect(info.taskId).toBe("T-19");
    expect(existsSync(info.path)).toBe(true);
    expect(reconcile).not.toHaveBeenCalled();
  }, SLOW);

  it("forgets gone rows only when at capacity, then creates the dispatched worktree", async () => {
    const old = await Promise.all(["T-20", "T-21", "T-22"].map((taskId) => manager.create({ taskId, actor: person })));
    for (const info of old) {
      await git(repo.root, ["worktree", "remove", "--force", info.path]);
      await git(repo.root, ["branch", "-D", info.branch]);
    }

    const info = await manager.getOrCreateForDispatch({ taskId: "T-23", actor: person });
    expect(info.taskId).toBe("T-23");
    expect((await manager.list()).map((item) => item.taskId)).toEqual(["T-23"]);
    expect(ledger.entries().filter((entry) => entry.type === "worktree.removed" && entry.data?.forgotten === true).map((entry) => entry.subject).sort()).toEqual(["T-20", "T-21", "T-22"]);
  }, SLOW);

  it("forgets only the exact gone row when malformed duplicate task ids include a live worktree", async () => {
    const live = await manager.create({ taskId: "T-28", actor: person });
    const registryPath = path.join(repo.root, ".git", "perfect-planner", "worktrees.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { schemaVersion: number; worktrees: (typeof live)[] };
    const goneDuplicate = {
      ...live,
      branch: `${live.branch}-stale-duplicate`,
      path: path.join(manager.worktreeRoot, "T-28-stale-duplicate"),
    };
    registry.worktrees.push(goneDuplicate);
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const result = await manager.reconcileWithDisk({ forget: true });
    expect(result.forgotten).toEqual(["T-28"]);
    const remaining = await manager.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ taskId: live.taskId, branch: live.branch, path: live.path });
    expect(existsSync(live.path)).toBe(true);
    expect((await manager.reconcileWithDisk()).folders).toEqual([
      expect.objectContaining({ taskId: live.taskId, branch: live.branch, path: live.path, state: "ok" }),
    ]);
  }, SLOW);

  it("refuses a missing or unlinked dispatch target without recreating or changing it", async () => {
    const missing = await manager.create({ taskId: "T-24", actor: person });
    await git(repo.root, ["worktree", "remove", "--force", missing.path]);
    await expect(manager.getOrCreateForDispatch({ taskId: "T-24", actor: person })).rejects.toMatchObject({ reason: "missing" });
    expect((await runGit(repo.root, ["show-ref", "--verify", "refs/heads/pp/T-24"])).code).toBe(0);

    const unlinked = await manager.create({ taskId: "T-25", actor: person });
    await git(repo.root, ["worktree", "remove", "--force", unlinked.path]);
    writeFiles(unlinked.path, { "notes.txt": "keep this folder\n" });
    await expect(manager.getOrCreateForDispatch({ taskId: "T-25", actor: person })).rejects.toMatchObject({ reason: "unlinked" });
    expect(readFileSync(path.join(unlinked.path, "notes.txt"), "utf8")).toBe("keep this folder\n");
  }, SLOW);

  it("refuses a listed task folder on detached HEAD or a different branch with a truthful note", async () => {
    const info = await manager.create({ taskId: "T-27", actor: person });
    await git(info.path, ["switch", "--detach", "HEAD"]);
    await expect(manager.getOrCreateForDispatch({ taskId: "T-27", actor: person })).rejects.toMatchObject({
      reason: "unlinked",
      message: expect.stringContaining("detached HEAD"),
    });
    const detached = (await manager.reconcileWithDisk()).folders.find((item) => item.taskId === "T-27");
    expect(detached).toMatchObject({ state: "unlinked" });
    expect(detached?.note).toContain(info.branch);

    await git(info.path, ["switch", "-c", "wrong-branch"]);
    await expect(manager.getOrCreateForDispatch({ taskId: "T-27", actor: person })).rejects.toMatchObject({
      reason: "unlinked",
      message: expect.stringContaining("branch wrong-branch"),
    });
    const wrongBranch = (await manager.reconcileWithDisk()).folders.find((item) => item.taskId === "T-27");
    expect(wrongBranch).toMatchObject({ state: "unlinked" });
    expect(wrongBranch?.note).toContain(`not its expected branch ${info.branch}`);
  }, SLOW);

  it("refuses bad ids, a second worktree for a task, and a reused branch", async () => {
    await expect(manager.create({ taskId: "../evil", actor: person })).rejects.toThrow(/not a task id/);
    await manager.create({ taskId: "T-1", actor: person });
    await expect(manager.create({ taskId: "T-1", actor: person })).rejects.toThrow(/already has a worktree/);
    await git(repo.root, ["branch", "pp/T-2"]);
    await expect(manager.create({ taskId: "T-2", actor: person })).rejects.toThrow(/already exists/);
  }, SLOW);

  it("clears a worktree add that never finished, but never a branch that holds work", async () => {
    // What a killed add leaves: git's entry for the folder, the folder, and the branch at the base commit.
    const folder = path.join(repo.root, ".perfect-planner", "worktrees", "T-5");
    await git(repo.root, ["worktree", "add", "-b", "pp/T-5", folder, "main"]);
    const again = await manager.create({ taskId: "T-5", actor: person });
    expect(again.branch).toBe("pp/T-5");
    expect(await git(repo.root, ["worktree", "list", "--porcelain"])).not.toMatch(/locked/);
    await manager.remove("T-5");
    // The same leftover with a commit of someone's own on the branch is left exactly as it is.
    const kept = path.join(repo.root, ".perfect-planner", "worktrees", "T-6");
    await git(repo.root, ["worktree", "add", "-b", "pp/T-6", kept, "main"]);
    writeFileSync(path.join(kept, "mine.txt"), "work\n");
    await commitAll(kept, "my work");
    await expect(manager.create({ taskId: "T-6", actor: person })).rejects.toThrow(/already exists/);
    expect(readFileSync(path.join(kept, "mine.txt"), "utf8")).toBe("work\n");
    expect(await git(repo.root, ["rev-list", "--count", "main..pp/T-6"])).toBe("1");
  }, SLOW);

  it("leaves an unregistered interrupted worktree with user work untouched", async () => {
    writeFiles(repo.root, { ".gitignore": "*.local.md\n" });
    await commitAll(repo.root, "ignore local notes");
    const folder = path.join(repo.root, ".perfect-planner", "worktrees", "T-26");
    await git(repo.root, ["worktree", "add", "-b", "pp/T-26", folder, "main"]);
    writeFiles(folder, { "notes.txt": "unsaved work\n", "ideas.local.md": "ignored idea\n" });
    const before = await git(folder, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all"]);

    await expect(manager.create({ taskId: "T-26", actor: person })).rejects.toThrow(/left untouched/);

    expect(readFileSync(path.join(folder, "notes.txt"), "utf8")).toBe("unsaved work\n");
    expect(readFileSync(path.join(folder, "ideas.local.md"), "utf8")).toBe("ignored idea\n");
    expect(await git(folder, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all"])).toBe(before);
    expect((await runGit(repo.root, ["show-ref", "--verify", "refs/heads/pp/T-26"])).code).toBe(0);
    const listed = lines(await git(repo.root, ["worktree", "list", "--porcelain"]));
    expect(listed.some((line) => line.startsWith("worktree ") && samePath(line.slice("worktree ".length), folder))).toBe(true);
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

  it("never gives two projects open at once the same dev-server port", async () => {
    const other = await makeRepo({ "README.md": "other\n" });
    try {
      const second = new WorktreeManager({ repoRoot: other.root, ledger: await memoryLedger(), install: false, maxParallel: 3, ports: [43100, 43199] });
      const made = await Promise.all([manager.create({ taskId: "T-1", actor: person }), second.create({ taskId: "T-1", actor: person }), manager.create({ taskId: "T-2", actor: person }), second.create({ taskId: "T-2", actor: person })]);
      expect(new Set(made.map((info) => info.port)).size).toBe(4);
    } finally {
      other.cleanup();
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
    expect(readFileSync(path.join(info.path, ".env"), "utf8")).toBe(`API_KEY=${PLACEHOLDER}\r\nPORT=3000\r\nDB_PASSWORD=${PLACEHOLDER}\r\n`);
    expect(readFileSync(path.join(info.path, ".env.example"), "utf8")).toBe("API_KEY=\n");
  }, SLOW);

  it("installs a commit-time secret scan that blocks a planted key in the task worktree only", async () => {
    const info = await manager.create({ taskId: "T-6", actor: person });
    writeFiles(info.path, { "src/config.ts": `export const key = "AKIA${"A".repeat(16)}";\n` });
    // The worker commits with its own git, which runs the worktree's hooks (the app's own git never does).
    await git(info.path, ["add", "-A"]);
    const blocked = workerGit(info.path, ["commit", "-m", "add config"]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toMatch(/blocked this commit[\s\S]*src\/config\.ts:1 \(aws-access-key\)/);
    expect(blocked.stderr).not.toContain("AKIA");
    writeFiles(info.path, { "src/config.ts": "export const key = process.env.KEY;\n" });
    await git(info.path, ["add", "-A"]);
    expect(workerGit(info.path, ["commit", "-m", "read key from env"]).code).toBe(0);
    // The main checkout keeps its own hooks.
    expect((await runGit(repo.root, ["config", "--local", "--get", "core.hooksPath"])).stdout.trim()).toBe("");
  }, SLOW);

  it("preserves a worktree if the add operation fails after the folder is exposed", async () => {
    const racing = new class extends WorktreeManager {
      protected override async addTaskWorktree(branch: string, worktreePath: string, baseSha: string): Promise<void> {
        await super.addTaskWorktree(branch, worktreePath, baseSha);
        writeFiles(worktreePath, { "concurrent-note.txt": "keep the concurrent worktree\n" });
        throw new Error("simulated add failure after another process exposed the folder");
      }
    }({ repoRoot: repo.root, ledger, install: false });
    const target = path.join(repo.root, ".perfect-planner", "worktrees", "T-29");

    await expect(racing.create({ taskId: "T-29", actor: person })).rejects.toThrow(/no cleanup was attempted/);

    expect(readFileSync(path.join(target, "concurrent-note.txt"), "utf8")).toBe("keep the concurrent worktree\n");
    expect((await runGit(repo.root, ["show-ref", "--verify", "refs/heads/pp/T-29"])).code).toBe(0);
    expect((await racing.reconcileWithDisk()).untracked).toEqual([
      expect.objectContaining({ path: target, branch: "pp/T-29" }),
    ]);
    expect(ledger.entries().filter((entry) => entry.type === "worktree.created" && entry.subject === "T-29")).toEqual([]);
    await expect(racing.create({ taskId: "T-29", actor: person })).rejects.toThrow(/left untouched/);
    expect(readFileSync(path.join(target, "concurrent-note.txt"), "utf8")).toBe("keep the concurrent worktree\n");
  }, SLOW);
  it("preserves the worktree when dependency setup fails after creation", async () => {
    const seen: string[] = [];
    const ok = new WorktreeManager({ repoRoot: repo.root, ledger, install: async (dir) => void seen.push(dir) });
    const info = await ok.create({ taskId: "T-7", actor: person });
    expect(seen).toEqual([info.path]);

    const failing = new WorktreeManager({
      repoRoot: repo.root,
      ledger,
      install: async (dir) => {
        writeFiles(dir, { "notes.txt": "keep the setup failure note\n" });
        throw new Error("install broke");
      },
    });
    const failedPath = path.join(repo.root, ".perfect-planner", "worktrees", "T-8");
    await expect(failing.create({ taskId: "T-8", actor: person })).rejects.toThrow(/left in place[\s\S]*install broke/);
    expect((await runGit(repo.root, ["show-ref", "--verify", "refs/heads/pp/T-8"])).code).toBe(0);
    expect(readFileSync(path.join(failedPath, "notes.txt"), "utf8")).toBe("keep the setup failure note\n");
    expect((await failing.list()).map((item) => item.taskId)).toEqual(["T-7"]);
    expect((await failing.reconcileWithDisk()).untracked).toEqual([
      expect.objectContaining({ path: failedPath, branch: "pp/T-8" }),
    ]);
    await expect(failing.create({ taskId: "T-8", actor: person })).rejects.toThrow(/left untouched/);
    expect(readFileSync(path.join(failedPath, "notes.txt"), "utf8")).toBe("keep the setup failure note\n");
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
    expect(readFileSync(path.join(info.path, "notes.txt"), "utf8")).toBe("unsaved idea\n");
    await commitAll(info.path, "keep idea");
    const result = await manager.remove("T-10");
    expect(result.branchDeleted).toBe(false);
    expect(result.branchKeptReason).toMatch(/not merged into main/);
    expect((await runGit(repo.root, ["show-ref", "--verify", "refs/heads/pp/T-10"])).code).toBe(0);
  }, SLOW);

  it("keeps ignored work: refuses removal while ignored files other than dependencies and untouched settings exist", async () => {
    writeFiles(repo.root, { ".gitignore": "*.local.md\nnode_modules/\n.env\n", ".env": "PORT=3000\nAPI_KEY=abc\n" });
    await commitAll(repo.root, "ignore local notes");
    const info = await manager.create({ taskId: "T-18", actor: person });
    writeFiles(info.path, { "node_modules/dep/index.js": "export {};\n", "ideas.local.md": "keep me\n" });
    await expect(manager.remove("T-18")).rejects.toThrow(/ignored files[\s\S]*ideas\.local\.md/);
    expect(readFileSync(path.join(info.path, "ideas.local.md"), "utf8")).toBe("keep me\n");
    writeFiles(info.path, { ".env": "PORT=3000\nAPI_KEY=real-value-typed-in\n" });
    rmSync(path.join(info.path, "ideas.local.md"));
    await expect(manager.remove("T-18")).rejects.toThrow(/\.env/);
    expect(readFileSync(path.join(info.path, ".env"), "utf8")).toBe("PORT=3000\nAPI_KEY=real-value-typed-in\n");
    expect(readFileSync(path.join(info.path, "node_modules/dep/index.js"), "utf8")).toBe("export {};\n");
    writeFiles(info.path, { ".env": `PORT=3000\nAPI_KEY=${PLACEHOLDER}\n` });
    expect((await manager.remove("T-18")).taskId).toBe("T-18");
    expect(existsSync(info.path)).toBe(false);
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
    expect(readFileSync(exclude, "utf8")).toBe("*.log\n/.perfect-planner/\n");
  }, SLOW);
});

describe("preCommitHook", () => {
  it("runs the secret scan with node from PATH by default", () => {
    expect(preCommitHook({})).toBe('#!/bin/sh\nexec node "$(dirname "$0")/secret-scan.mjs"\n');
  });

  it("runs it with the desktop app's own Node when there is one, in git sh's forward slashes", () => {
    expect(preCommitHook({ PP_NODE_BINARY: "C:\\Program Files\\Perfect Planner\\desktop-host\\node.exe" })).toBe(
      '#!/bin/sh\nexec \'C:/Program Files/Perfect Planner/desktop-host/node.exe\' "$(dirname "$0")/secret-scan.mjs"\n',
    );
  });

  it("keeps a $ or a quote in the path literal", () => {
    expect(preCommitHook({ PP_NODE_BINARY: "/opt/$(x)/it's/node" })).toBe(`#!/bin/sh\nexec '/opt/$(x)/it'\\''s/node' "$(dirname "$0")/secret-scan.mjs"\n`);
  });
});
