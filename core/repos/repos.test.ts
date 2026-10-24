import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, MemoryStore, type Actor } from "../ledger/index";
import { installNumberingRules } from "../numbering/index";
import { foldBoard } from "../mcp/index";
import { writeRoadmap } from "../planning/roadmap";
import type { Roadmap, RoadmapTask } from "../planning/types";
import { MAX_REPOS, groupKey, readRepos, repoNameProblem, splitByRepo, writeRepos } from "./index";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-repos-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("repo names", () => {
  it("accepts plain names and refuses paths, devices, the reserved main and long names", () => {
    for (const ok of ["web", "api-2", "a.b_c", "0day"]) expect(repoNameProblem(ok), ok).toBeUndefined();
    for (const bad of ["", " ", "../x", "a/b", "a\\b", "con", "NUL.txt", "lpt1", "main", "x.", "-x", "A".repeat(33), "has space", 7, null, undefined]) expect(repoNameProblem(bad), String(bad)).toBeTruthy();
  });
});

describe("the repos file", () => {
  it("no file is no extra repos", () => {
    expect(readRepos(dir)).toEqual({ repos: [], ignored: [] });
  });

  it("round-trips, keeps order, and replaces the file without leaving a temp file", () => {
    const repos = [{ name: "web", root: path.join(dir, "web"), addedAt: "2026-10-23T00:00:00Z" }, { name: "api", root: path.join(dir, "api"), addedAt: "" }];
    writeRepos(dir, repos);
    expect(readRepos(dir).repos).toEqual(repos);
    expect(fs.readdirSync(path.join(dir, ".perfect-planner"))).toEqual(["repos.json"]);
  });

  it("leaves out entries that add would refuse, each with a reason, and does not crash on garbage", () => {
    const file = path.join(dir, ".perfect-planner", "repos.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(readRepos(dir)).toMatchObject({ repos: [], ignored: [{ reason: expect.stringContaining("cannot be read") }] });
    fs.writeFileSync(file, JSON.stringify({ repos: "nope" }));
    expect(readRepos(dir).repos).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ repos: [null, 5, { name: "a", root: 5 }, { name: "__proto__", root: dir }, { name: "ok", root: dir }] }));
    const read = readRepos(dir);
    expect(read.repos.map((r) => r.name)).toEqual(["ok"]);
    expect(read.ignored).toHaveLength(4);
    // A network path is never read as a repo.
    fs.writeFileSync(file, JSON.stringify({ repos: [{ name: "net", root: "//host/share/r" }] }));
    expect(readRepos(dir).ignored).toMatchObject([{ name: "net" }]);
  });

  it("holds at most the limit, counting the first repo", () => {
    const file = path.join(dir, ".perfect-planner", "repos.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ repos: Array.from({ length: 30 }, (_, i) => ({ name: `r${i}`, root: dir })) }));
    const read = readRepos(dir);
    expect(read.repos).toHaveLength(MAX_REPOS - 1);
    expect(read.ignored).toHaveLength(30 - (MAX_REPOS - 1));
  });
});

describe("splitting a plan task over repos", () => {
  it("leaves a task alone for no repo or one, and splits for several without repeats", () => {
    expect(splitByRepo("K-1", "Sync", undefined)).toEqual([{ title: "Sync" }]);
    expect(splitByRepo("K-1", "Sync", [])).toEqual([{ title: "Sync" }]);
    expect(splitByRepo("K-1", "Sync", ["api"])).toEqual([{ repo: "api", title: "Sync" }]);
    expect(splitByRepo("K-1", "Sync", ["api", "web", "api"])).toEqual([{ repo: "api", title: "Sync (api)", group: "K-1" }, { repo: "web", title: "Sync (web)", group: "K-1" }]);
  });
  it("makes group keys the board accepts, different for different keys even when long", () => {
    const a = groupKey("K-component-" + "x".repeat(100) + "-one");
    const b = groupKey("K-component-" + "x".repeat(100) + "-two");
    expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
    expect(a).not.toBe(b);
    expect(groupKey("../../etc")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
  });
});

describe("a roadmap with a task over two repos", () => {
  const person: Actor = { kind: "person", id: "owner" };
  const task = (key: string, extra: Partial<RoadmapTask> = {}): RoadmapTask => ({ key, title: key.toUpperCase(), phase: "core", owner: "owner", doneWhen: "a test passes", node: key, change: "feature", dependsOn: [], ...extra });

  it("writes one task per repo with a shared group, and what waited on it waits on every part", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-23T05:00:00Z") });
    installNumberingRules(ledger);
    const roadmap: Roadmap = { phases: [{ id: "core", title: "Core", tasks: [task("sync", { repos: ["api", "web"] }), task("docs", { dependsOn: ["sync"] }), task("solo", { repos: ["web"] })] }] };
    const numbers = writeRoadmap(ledger, person, roadmap);
    expect(numbers).toEqual({ sync: "T-1", docs: "T-3", solo: "T-4" });
    const board = foldBoard(ledger.entries());
    expect([...board.values()].map((t) => [t.id, t.title, t.repo, t.dependsOn])).toEqual([
      ["T-1", "SYNC (api)", "api", []],
      ["T-2", "SYNC (web)", "web", []],
      ["T-3", "DOCS", null, ["T-1", "T-2"]],
      ["T-4", "SOLO", "web", []],
    ]);
    expect(board.get("T-1")!.group).toBeTruthy();
    expect(board.get("T-1")!.group).toBe(board.get("T-2")!.group);
    expect(board.get("T-4")!.group).toBeNull();
  });
});
