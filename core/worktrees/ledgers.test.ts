// Several ledgers (projects) on one git repo: each keeps its own branches, folders, registry and ports,
// and a worktree that would land on another ledger's is refused instead of created.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ledger } from "../ledger/index";
import { git } from "./git";
import { WorktreeManager } from "./manager";
import { samePath } from "./platform";
import { makeRepo, memoryLedger } from "./testing";

const person = { kind: "person", id: "looplet-spare" } as const;
const SLOW = 60_000;
const NS = "l-1a2b3c4d";
const OTHER_NS = "l-ffffffff";

describe("ledgers sharing a git repo", () => {
  let repo: { root: string; cleanup: () => void };
  let ledgerA: Ledger;
  let ledgerB: Ledger;
  let first: WorktreeManager;
  let second: WorktreeManager;
  const state = () => path.join(repo.root, ".git", "perfect-planner");

  beforeEach(async () => {
    repo = await makeRepo({ "README.md": "hello\n", "src/app.ts": "export const a = 1;\n" });
    ledgerA = await memoryLedger();
    ledgerB = await memoryLedger();
    first = new WorktreeManager({ repoRoot: repo.root, ledger: ledgerA, install: false, maxParallel: 3, ports: [43200, 43299] });
    second = new WorktreeManager({ repoRoot: repo.root, ledger: ledgerB, install: false, maxParallel: 3, ports: [43200, 43299], namespace: NS });
  });
  afterEach(() => repo.cleanup());

  it("the same task id in two ledgers gets two branches, two folders, two registries and two ports", async () => {
    const a = await first.create({ taskId: "T-1", actor: person });
    const b = await second.create({ taskId: "T-1", actor: person });
    expect(a.branch).toBe("pp/T-1");
    expect(b.branch).toBe(`pp/${NS}/T-1`);
    expect(samePath(a.path, path.join(repo.root, ".perfect-planner", "worktrees", "T-1"))).toBe(true);
    expect(samePath(b.path, path.join(repo.root, ".perfect-planner", "worktrees", NS, "T-1"))).toBe(true);
    expect(await git(a.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("pp/T-1");
    expect(await git(b.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(`pp/${NS}/T-1`);
    expect(a.port).not.toBe(b.port);
    expect((await first.list()).map((w) => w.branch)).toEqual(["pp/T-1"]);
    expect((await second.list()).map((w) => w.branch)).toEqual([`pp/${NS}/T-1`]);
    expect(existsSync(path.join(state(), "worktrees.json"))).toBe(true);
    expect(existsSync(path.join(state(), `worktrees.${NS}.json`))).toBe(true);
    // Neither ledger sees the other's folder as stray work, and the main checkout stays clean.
    expect(await first.reconcile()).toEqual({ missing: [], untracked: [] });
    expect(await second.reconcile()).toEqual({ missing: [], untracked: [] });
    expect(await git(repo.root, ["status", "--porcelain"])).toBe("");
  }, SLOW);

  it("each ledger has its own cap on parallel worktrees", async () => {
    for (const id of ["T-1", "T-2", "T-3"]) await first.create({ taskId: id, actor: person });
    await expect(first.create({ taskId: "T-4", actor: person })).rejects.toThrow(/3 worktrees are already running/);
    await expect(second.create({ taskId: "T-1", actor: person })).resolves.toMatchObject({ branch: `pp/${NS}/T-1` });
  }, SLOW);

  it("removing one ledger's task leaves the other's untouched", async () => {
    await first.create({ taskId: "T-1", actor: person });
    const b = await second.create({ taskId: "T-1", actor: person });
    await first.remove("T-1", person);
    expect(existsSync(b.path)).toBe(true);
    expect(await git(repo.root, ["branch", "--list", `pp/${NS}/T-1`])).toContain(`pp/${NS}/T-1`);
    expect((await second.list()).map((w) => w.taskId)).toEqual(["T-1"]);
  }, SLOW);

  describe("the collision guard", () => {
    const neighbour = (file: string, worktrees: unknown[]) => {
      mkdirSync(state(), { recursive: true });
      writeFileSync(path.join(state(), file), JSON.stringify({ schemaVersion: 1, worktrees }));
    };
    const entry = (over: Record<string, unknown>) => ({ taskId: "T-9", branch: "pp/elsewhere", path: path.join(repo.root, "elsewhere"), baseSha: "a".repeat(40), baseRef: "main", port: 43250, actor: "x", createdAt: "2026-01-01T00:00:00Z", claims: [], ...over });

    it("refuses a branch another ledger's registry already holds", async () => {
      neighbour(`worktrees.${OTHER_NS}.json`, [entry({ branch: "pp/T-1" })]);
      await expect(first.create({ taskId: "T-1", actor: person })).rejects.toThrow(/already belongs to another ledger/);
      expect(existsSync(path.join(repo.root, ".perfect-planner", "worktrees", "T-1"))).toBe(false);
    }, SLOW);

    it("refuses a folder another ledger's registry already holds", async () => {
      neighbour("worktrees.json", [entry({ path: path.join(repo.root, ".perfect-planner", "worktrees", NS, "T-1") })]);
      await expect(second.create({ taskId: "T-1", actor: person })).rejects.toThrow(/already belongs to another ledger/);
      expect(await git(repo.root, ["branch", "--list", `pp/${NS}/T-1`])).toBe("");
    }, SLOW);

    it("never hands out a dev-server port another ledger's registry holds", async () => {
      neighbour(`worktrees.${OTHER_NS}.json`, [entry({ port: 43200 })]);
      const a = await first.create({ taskId: "T-1", actor: person });
      expect(a.port).not.toBe(43200);
    }, SLOW);

    it("refuses file claims another ledger's worker already holds", async () => {
      await first.create({ taskId: "T-1", actor: person, claims: ["src/app.ts"] });
      await expect(second.create({ taskId: "T-1", actor: person, claims: ["src/app.ts"] })).rejects.toThrow(/claims files already claimed/);
      expect(await git(repo.root, ["branch", "--list", `pp/${NS}/T-1`])).toBe("");
    }, SLOW);

    it("creates nothing beside a neighbour's list it cannot read", async () => {
      mkdirSync(state(), { recursive: true });
      writeFileSync(path.join(state(), `worktrees.${OTHER_NS}.json`), "{ not json");
      await expect(first.create({ taskId: "T-1", actor: person })).rejects.toThrow(/cannot be read/);
      expect(await git(repo.root, ["branch", "--list", "pp/T-1"])).toBe("");
      expect(readFileSync(path.join(state(), `worktrees.${OTHER_NS}.json`), "utf8")).toBe("{ not json");
    }, SLOW);

    it("rejects a namespace that is not a ledger namespace", () => {
      for (const namespace of ["T-1", "l-xyz", "../x", "l-1A2B3C4D", ""]) {
        expect(() => new WorktreeManager({ repoRoot: repo.root, ledger: ledgerA, install: false, namespace }), namespace).toThrow(/not a ledger namespace/);
      }
    });
  });
});
