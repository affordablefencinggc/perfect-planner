import { randomUUID } from "node:crypto";
// The whole loop as a person drives it from the app: dispatch a worker, approve
// its test, check the work, approve the diff and merge. The worker is a real
// agent client talking to the loopback bridge with the token dispatch issued.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeCall } from "../../mcp/index";
import { isAuthoritative } from "../../ledger/index";
import { appendNumbered } from "../../numbering/index";
import { asPersonRequest } from "../keys";
import { hostCall, startTestHost } from "../testing";
import { icaclsPath } from "../tokenFile";
import * as worktreeCare from "./worktreeCare";
import * as worktreeModule from "../../worktrees/index";
import { WorktreeManager } from "../../worktrees/index";
import { recordedWorkerReport, recordedWorkerDispatch, createOptionalGitCache, gitIdentityRefusal, gitTop, __resetGitTopCacheForTests, overview, quoteFor, repoRefusal, withOutputTail, workerCommands, worktreesForWatcher } from "./tasks";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

let repo: string;
let ctx: Awaited<ReturnType<typeof startTestHost>>;
const q = "?project=loop";


const tasks = async () => (await hostCall(ctx.base, "GET", `/tasks${q}`)).body.result as { repo: { ok: boolean; root?: string; reason?: string; suggested?: string }; tasks: any[] };
const post = async (route: string, body: unknown = {}) => { const started = Date.now(); console.info("[task-timing] POST start", route); try {
  if (route.endsWith("/check") && body && typeof body === "object" && Object.keys(body).length === 0) {
    const prepared = await hostCall(ctx.base, "GET", route + "-input" + q);
    expect(prepared.status).toBe(200);
    body = { requestId: randomUUID(), ...prepared.body.result };
  }
  return await hostCall(ctx.base, "POST", route + q, body); } finally { console.info("[task-timing] POST finished", route, Date.now() - started); } };

describe("optional Git inspection cache", () => {
  beforeEach(() => {
    __resetGitTopCacheForTests();
  });
  it("batches repository top-level and committed-HEAD discovery into one hardened Git read", async () => {
    const root = fs.realpathSync.native(process.cwd());
    const result = { code: 0, stdout: `${root}\n0123456789012345678901234567890123456789\n`, stderr: "", stdoutBytes: Buffer.alloc(0) };
    const discovery = vi.spyOn(worktreeModule, "runGit").mockResolvedValue(result);
    try {
      await expect(gitTop(root)).resolves.toBe(root);
      expect(discovery).toHaveBeenCalledTimes(1);
      expect(discovery).toHaveBeenCalledWith(root, ["rev-parse", "--show-toplevel", "--verify", "HEAD^{commit}"]);
    } finally {
      discovery.mockRestore();
    }
  });

  it("keeps a top-level path's embedded newline and trailing whitespace when parsing the final verified object id", async () => {
    const root = fs.realpathSync.native(process.cwd());
    const top = `${root} named with a space\nand a newline `;
    const result = { code: 0, stdout: `${top}\n0123456789012345678901234567890123456789\r\n`, stderr: "", stdoutBytes: Buffer.alloc(0) };
    const discovery = vi.spyOn(worktreeModule, "runGit").mockResolvedValue(result);
    const resolved = vi.spyOn(fs, "realpathSync").mockReturnValue(top);
    try {
      await expect(gitTop(root)).resolves.toBe(top);
      expect(resolved).toHaveBeenCalledWith(top);
    } finally {
      resolved.mockRestore();
      discovery.mockRestore();
    }
  });

  it("reports a rejection that arrives after the caller deadline before starting another inspection", async () => {
    const cache = createOptionalGitCache<string[]>({ timeoutMs: 5 });
    let reject!: (reason: Error) => void;
    const load = vi.fn(() => new Promise<string[]>((_, fail) => { reject = fail; }));
    await expect(cache.read("repo", load)).resolves.toEqual({ state: "pending" });
    reject(new Error("late git denial"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(cache.read("repo", load)).resolves.toEqual({ state: "unavailable", reason: "late git denial" });
    expect(load).toHaveBeenCalledTimes(1);
    await expect(cache.read("repo", async () => [])).resolves.toEqual({ state: "ready", value: [] });
    await cache.drain();
  });

  it("drains invalidated and cleared reads, and refuses new reads once closing begins", async () => {
    const cache = createOptionalGitCache<string[]>({ timeoutMs: 5 });
    let releaseFirst!: (value: string[]) => void;
    let releaseSecond!: (value: string[]) => void;
    const first = cache.read("same", () => new Promise<string[]>((resolve) => { releaseFirst = resolve; }));
    await expect(first).resolves.toEqual({ state: "pending" });
    cache.invalidate("same");
    const second = cache.read("same", () => new Promise<string[]>((resolve) => { releaseSecond = resolve; }));
    await expect(second).resolves.toEqual({ state: "pending" });
    cache.clear();
    let drained = false;
    const closing = cache.drain().then(() => { drained = true; });
    const forbidden = vi.fn(async () => ["must not run"]);
    await expect(cache.read("new", forbidden)).resolves.toMatchObject({ state: "unavailable" });
    expect(forbidden).not.toHaveBeenCalled();
    expect(drained).toBe(false);
    releaseFirst([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);
    releaseSecond([]);
    await closing;
    expect(drained).toBe(true);
  });

  it("shares one slow inspection, keeps timeout unknown, and exposes its eventual result", async () => {
    const cache = createOptionalGitCache<string[]>({ timeoutMs: 5, cacheMs: 1_000 });
    let calls = 0;
    let resolve!: (value: string[]) => void;
    const load = () => { calls += 1; return new Promise<string[]>((done) => { resolve = done; }); };
    const [first, second] = await Promise.all([cache.read("board\0main\0C:/one", load), cache.read("board\0main\0C:/one", load)]);
    expect(first).toEqual({ state: "pending" });
    expect(second).toEqual({ state: "pending" });
    expect(calls).toBe(1);
    resolve(["T-1"]);
    await vi.waitFor(async () => expect(await cache.read("board\0main\0C:/one", load)).toEqual({ state: "ready", value: ["T-1"] }));
    expect(calls).toBe(1);
  });

  it("retries a failed inspection and keeps roots, refused access, and watch mode separate", async () => {
    const cache = createOptionalGitCache<string[]>({ timeoutMs: 100, cacheMs: 1_000 });
    let calls = 0;
    await expect(cache.read("board\0main\0C:/one", async () => { calls += 1; throw new Error("access denied"); }))
      .resolves.toEqual({ state: "unavailable", reason: "access denied" });
    await expect(cache.read("board\0main\0C:/one", async () => { calls += 1; return ["recovered"]; }))
      .resolves.toEqual({ state: "ready", value: ["recovered"] });
    await expect(cache.read("board\0main\0C:/two", async () => { calls += 1; return ["new-root"]; }))
      .resolves.toEqual({ state: "ready", value: ["new-root"] });
    await expect(cache.read("watch\0main\0C:/two", async () => { calls += 1; return ["watch"]; }))
      .resolves.toEqual({ state: "ready", value: ["watch"] });
    await expect(cache.read("board\0main\0refused:access denied", async () => { calls += 1; return ["must-not-inherit"]; }))
      .resolves.toEqual({ state: "ready", value: ["must-not-inherit"] });
    expect(calls).toBe(5);
  });

  it("invalidates an inspected value so a dispatch can expose a new worktree immediately", async () => {
    const cache = createOptionalGitCache<string[]>({ timeoutMs: 100, cacheMs: 1_000 });
    const key = "board\0main\0C:/repo";
    await cache.read(key, async () => []);
    cache.invalidate(key);
    await expect(cache.read(key, async () => ["T-1"])).resolves.toEqual({ state: "ready", value: ["T-1"] });
  });
});

describe("repository task routes", () => {
beforeEach(async ({ task }) => {
  const started = Date.now();
  console.info("[task-timing] fixture start", task.name);
  // native: Windows runners hand out 8.3 short temp paths (RUNNER~1); git reports the long form.
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-tasks-repo-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  // The gate's merge commit needs an identity; CI runners have no global one.
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.invalid");
  write(repo, "README.md", "# Notes app\n");
  write(repo, ".gitignore", ".perfect-planner/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial");
  ctx = await startTestHost({ projectRootOverride: repo, ...(task.suite?.name === "optional Git inspection integration" ? { watch: false as const } : {}) });
  console.info("[task-timing] fixture host ready", Date.now() - started);
  const projectStarted = Date.now();
  console.info("[task-timing] project open start");
  const project = ctx.host.project("loop");
  console.info("[task-timing] project open finished", Date.now() - projectStarted);
  const appendStarted = Date.now();
  asPersonRequest(() => appendNumbered(project.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Save notes", data: { title: "Save notes" } }));
  console.info("[task-timing] signed append finished", Date.now() - appendStarted);
});

afterEach(async () => {
  const started = Date.now();
  console.info("[task-timing] stop start");
  await ctx.stop();
  console.info("[task-timing] stop finished", Date.now() - started);
  fs.rmSync(repo, { recursive: true, force: true });
// focus-journeys-04: aggregate test expiry overlapped a real final merge;
// Windows cleanup took 25.041s waiting for that operation. Keep it bounded and
// let it finish before another fixture starts. This is not a product deadline.
}, process.platform === "win32" ? 30_000 : 10_000);



it("retains only signed requested worker identity after project reopen without restoring a live dispatch", async () => {
  const result = await post("/tasks/T-1/dispatch", { model: "gpt-5.6" });
  expect(result.status).toBe(200);
  const d = result.body.result;
  const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8").trim());
  const first = await call({ tool: "hello", args: { name: "Codex", model: "gpt-reported" } }) as { agent: string };
  const receipts = () => ctx.host.project("loop").entries().filter(e => e.data?.workerReport);
  expect(receipts()).toHaveLength(1);
  expect(isAuthoritative(receipts()[0]!)).toBe(true);
  await call({ tool: "hello", args: { name: "Codex", model: "gpt-reported" } });
  expect(receipts()).toHaveLength(1);
  const changed = await call({ tool: "hello", args: { name: "Codex", model: "gpt-reported-2" } }) as { agent: string };
  expect(changed.agent).toBe(first.agent);
  expect(receipts()).toHaveLength(2);
  expect(recordedWorkerReport(receipts(), "T-1.a2")).toBeNull();
  expect(recordedWorkerReport(receipts(), "T-1", "other-worker")).toBeNull();
  expect(recordedWorkerReport([JSON.parse(JSON.stringify(receipts()[1]))], "T-1")).toBeNull();
  const before = (await tasks()).tasks[0];
  expect(before.workerReport).toMatchObject({ worker: first.agent, reportedModel: "gpt-reported-2" });
  expect(before.lastProgress).toBeNull();
  expect(before.workerDispatch).toEqual({ requestedModel: "gpt-5.6", requestedAt: before.dispatch.issuedAt });
  const entries = ctx.host.project("loop").entries();
  expect(recordedWorkerDispatch(entries, "T-1.a2")).toBeNull();
  expect(recordedWorkerDispatch(entries, "T-2")).toBeNull();
  const recorded = entries.find(e => e.data?.workerDispatch)!;
  expect(recorded).toBeTruthy();
  expect(isAuthoritative(recorded, { personOnly: true })).toBe(true);
  expect(recordedWorkerDispatch([JSON.parse(JSON.stringify(recorded))], "T-1")).toBeNull();
  expect(JSON.stringify(recorded.data)).not.toMatch(/token|secret|bridgeUrl/);
  await ctx.host.closeProject("loop");
  const reopened = (await tasks()).tasks[0];
  expect(reopened.workerDispatch).toEqual(before.workerDispatch);
  expect(reopened.workerReport).toEqual(before.workerReport);
  expect(reopened.dispatch).toBeNull();
  expect(reopened.lastProgress).toBeNull();
  expect(reopened.status).toBe("open");
  expect(reopened.owner).toBeNull();
  expect(reopened.attempt).toBe(before.attempt);
});

it("projects explicit activity by ledger order across real checks sharing one timestamp", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T05:00:00Z"));
  try {
    const dispatched = await post("/tasks/T-1/dispatch", { model: "gpt-5.6" });
    expect(dispatched.status).toBe(200);
    const d = dispatched.body.result;
    const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8").trim());
    const { agent } = await call({ tool: "hello", args: { name: "Codex", model: "gpt-5.6" } }) as { agent: string };
    write(d.worktree, "check.mjs", 'import {existsSync} from "node:fs"; process.exit(existsSync("fixed.txt") ? 0 : 7);\n');
    git(d.worktree, "add", "check.mjs"); git(d.worktree, "commit", "-q", "-m", "Regression first");
    await call({ tool: "propose_test", args: { task: "T-1", command: "node check.mjs", files: ["check.mjs"] }, agent });
    const definition = (await tasks()).tasks[0].test.entry;
    const approved = await post("/tasks/T-1/approve-test", { test: definition });
    expect(approved.body.result).toMatchObject({ approved: true, failsFirst: true });
    await call({ tool: "claim_task", args: { task: "T-1" }, agent });
    write(d.worktree, "fixed.txt", "fixed\n"); git(d.worktree, "add", "fixed.txt"); git(d.worktree, "commit", "-q", "-m", "Repair");
    expect((await post("/tasks/T-1/check")).body.result.passed).toBe(true);
    const checked = (await tasks()).tasks[0];
    await call({ tool: "report_progress", args: { task: "T-1", text: "Reworking navigation", activity: "working" }, agent });
    const reworking = (await tasks()).tasks[0];
    expect(reworking.workerActivity).toMatchObject({ worker: agent, activity: "working", afterCheck: true });
    expect(reworking.check).toEqual(checked.check);
    const entries = ctx.host.project("loop").entries();
    expect(entries.find(e => e.n === checked.check.entry)!.at).toBe(entries.find(e => e.n === reworking.workerActivity.entry)!.at);
    expect((await post("/tasks/T-1/check")).body.result.passed).toBe(true);
    expect((await tasks()).tasks[0].workerActivity.afterCheck).toBe(false);
    await call({ tool: "report_progress", args: { task: "T-1", text: "Finished", activity: "finished" }, agent });
    expect((await tasks()).tasks[0].workerActivity).toMatchObject({ activity: "finished", afterCheck: true });
    await call({ tool: "report_progress", args: { task: "T-1", text: "Legacy prose" }, agent });
    expect((await tasks()).tasks[0].workerActivity).toBeNull();
  } finally { vi.useRealTimers(); }
});
describe("optional Git inspection integration", () => {
  it("keeps the successful allocation visible during held discovery, but never for a changed selection", async () => {
    const project = ctx.host.project("loop");
    await Promise.all([project.ready, project.protection]);
    const dispatched = await post("/tasks/T-1/dispatch", { model: "gpt-5.6-terra" });
    expect(dispatched.status).toBe(200);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = worktreeModule.runGit;
    const discovery = vi.spyOn(worktreeModule, "runGit").mockImplementation(async (dir, args, options) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") await held;
      return original(dir, args, options);
    });
    const selection = path.join(project.root, ".perfect-planner", "repo.json");
    const prior = fs.existsSync(selection) ? fs.readFileSync(selection) : undefined;
    try {
      const view = await overview(project);
      expect(view.repo.discovery).toBe("pending");
      expect(view.repos[0].worktrees).toBeUndefined();
      expect(view.tasks[0].worktree).toMatchObject({ path: dispatched.body.result.worktree, branch: "pp/T-1" });
      // Same folder text changed deliberately: the old receipt is not proof
      // about a newly selected root, even while its validation is still held.
      fs.writeFileSync(selection, JSON.stringify({ root: path.dirname(repo) }));
      const changed = await overview(project);
      expect(changed.repo.discovery).toBe("pending");
      expect(changed.tasks[0].worktree).toBeUndefined();
    } finally {
      release();
      discovery.mockRestore();
      if (prior) fs.writeFileSync(selection, prior);
      else fs.writeFileSync(selection, JSON.stringify({ root: repo }));
    }
  });

  it("returns the ledger while discovery is held, shares discovery, and drains it on close", async () => {
    const project = ctx.host.project("loop");
    await project.watch?.stop();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    // Startup protection performs its own discovery; finish it before spying
    // on the optional board/watcher discovery operation under test.
    await Promise.all([project.ready, project.protection]);
    const original = worktreeModule.runGit;
    let discovers = 0;
    const discovery = vi.spyOn(worktreeModule, "runGit").mockImplementation(async (dir, args, options) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") { discovers += 1; enter(); await held; }
      return original(dir, args, options);
    });
    let closing: Promise<void> | undefined;
    let reading: ReturnType<typeof overview> | undefined;
    try {
      const started = Date.now();
      reading = overview(project);
      await entered;
      const view = await reading;
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(view.tasks[0].id).toBe("T-1");
      expect(view.repo.discovery).toBe("pending");
      expect(view.tasks[0].worktree).toBeUndefined();
      await expect(worktreesForWatcher(project)).rejects.toThrow(/still running/);
      expect(discovers).toBe(1);
      let closed = false;
      closing = ctx.host.closeProject("loop").then(() => { closed = true; });
      const duringClose = await overview(project);
      expect(duringClose.repo.discovery).toBe("unavailable");
      expect(discovers).toBe(1);
      expect(closed).toBe(false);
      release();await closing;expect(closed).toBe(true);
    } finally { release();await reading;await closing;discovery.mockRestore(); }
  });

  it.each(["project", "host"])("%s close waits for a held inspection and closes admission", async (scope) => {
    const project = ctx.host.project("loop");
    await project.watch?.stop();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = WorktreeManager.prototype.list;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const listing = vi.spyOn(WorktreeManager.prototype, "list").mockImplementation(async function (this: WorktreeManager) {
      enter();
      await held;
      return original.call(this);
    });
    let closing: Promise<void> | undefined;
    let reading: ReturnType<typeof overview> | undefined;
    try {
      reading = overview(project);
      // A first discovery may itself hit its deadline before listing begins.
      // Poll boundedly so it can advance; never wait forever on an entry signal.
      await vi.waitFor(async () => {
        await reading;
        if (!listing.mock.calls.length) reading = overview(project);
        expect(listing.mock.calls.length).toBeGreaterThan(0);
      }, { timeout: 10_000 });
      await entered;
      await reading; // Caller deadline expires; the underlying read is still held.
      let closed = false;
      closing = (scope === "project" ? ctx.host.closeProject("loop") : ctx.host.close()).then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(closed).toBe(false);
      const calls = listing.mock.calls.length;
      const duringClose = await overview(project);
      expect(duringClose.repos[0].worktreeInspection).toBe("unavailable");
      expect(listing.mock.calls.length).toBe(calls);
      release();
      await closing;
      expect(closed).toBe(true);
    } finally {
      release();
      await reading;
      await closing;
      listing.mockRestore();
    }
  });

  it("keeps a dispatched allocation after a ready watcher scan while the board is pending, then retires it after a ready board scan", async () => {
    const project = ctx.host.project("loop");
    await project.watch?.stop();
    const dispatched = await post("/tasks/T-1/dispatch", { model: "gpt-5.6-terra" });
    expect(dispatched.status).toBe(200);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await vi.waitFor(async () => {
      const watched = await worktreesForWatcher(project);
      expect(watched.list.some((tree) => tree.taskId === "T-1")).toBe(true);
    }, { timeout: 10_000 });
    const listing = vi.spyOn(WorktreeManager.prototype, "list").mockImplementation(async () => { await held; return []; });
    try {
      const pending = await overview(project);
      expect(pending.repos[0].worktreeInspection).toBe("pending");
      expect(pending.repos[0].worktrees).toBeUndefined();
      expect(pending.tasks[0].worktree).toMatchObject({ path: dispatched.body.result.worktree, branch: "pp/T-1" });
      release();
      await vi.waitFor(async () => {
        const ready = await overview(project);
        expect(ready.repos[0].worktreeInspection).toBe("ready");
        expect(ready.repos[0].worktrees).toBe(0);
        expect(ready.tasks[0].worktree).toBeNull();
      }, { timeout: 10_000 });
    } finally { release(); listing.mockRestore(); }
  });

  it("does not reuse a dispatched allocation after repository access is lost", async () => {
    const project = ctx.host.project("loop");
    await project.watch?.stop();
    const dispatched = await post("/tasks/T-1/dispatch", { model: "gpt-5.6-terra" });
    expect(dispatched.status).toBe(200);
    // The fixture is outside any parent Git repository. Retain and restore its
    // actual Git directory; a failed discovery must not expose the old allocation.
    const gitDir = path.join(repo, ".git");
    const retained = path.join(repo, ".git-retained-for-access-test");
    fs.renameSync(gitDir, retained);
    try {
      const unavailable = await overview(project);
      expect(unavailable.repo.ok).toBe(false);
      expect(unavailable.repos[0].worktreeInspection).toBe("unavailable");
      expect(unavailable.tasks[0].worktree).toBeUndefined();
    } finally { fs.renameSync(retained, gitDir); }
  });

  it("does not turn a real worktree-list rejection into an empty overview or watcher list", async () => {
    const rejected = vi.spyOn(WorktreeManager.prototype, "list").mockRejectedValue(new Error("git list denied"));
    const project = ctx.host.project("loop");
    try {
      await vi.waitFor(async () => {
        const view = await overview(project);
        expect(view.repos[0]).toMatchObject({ worktreeInspection: "unavailable", worktrees: undefined });
        expect(view.tasks[0].worktree).toBeUndefined();
      }, { timeout: 10_000 });
      await expect(worktreesForWatcher(project)).rejects.toThrow(/Cannot safely watch worktrees.*git list denied/);
    } finally { rejected.mockRestore(); }
  });
});

describe("tasks routes", () => {
  it("lists tasks from the ledger with their gate stage, and finds the git repo", async () => {
    const view = await tasks();
    expect(view.repo).toMatchObject({ ok: true, root: repo });
    expect(view.tasks).toMatchObject([{ id: "T-1", title: "Save notes", status: "open", stage: "needs-test", worktree: null }]);
  });

  it("rejects a raw empty check request without reserving or launching", async () => {
    const project = ctx.host.project("loop");
    const before = project.entries().filter(e => e.type === "check.execution").length;
    const rejected = await hostCall(ctx.base, "POST", "/tasks/T-1/check" + q, {}, { prepareCheck: false });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("INVALID_CHECK_REQUEST");
    expect(project.entries().filter(e => e.type === "check.execution")).toHaveLength(before);
  });

  it("rejects a raw array check request without helper enrichment or reservation", async () => {
    const project = ctx.host.project("loop");
    const before = project.entries().filter(e => e.type === "check.execution").length;
    const rejected = await hostCall(ctx.base, "POST", "/tasks/T-1/check" + q, []);
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("INVALID_CHECK_REQUEST");
    expect(project.entries().filter(e => e.type === "check.execution")).toHaveLength(before);
  });
  it("only the person's app window can dispatch, approve, check, approve a diff or merge", async () => {
    for (const route of ["/tasks/T-1/dispatch", "/tasks/T-1/test", "/tasks/T-1/approve-test", "/tasks/T-1/check", "/tasks/T-1/approve-diff", "/tasks/T-1/merge", "/tasks/T-1/release"]) {
      const res = await hostCall(ctx.base, "POST", `${route}${q}`, {}, { asAgent: true });
      expect(res.status, route).toBe(401);
    }
  });

  it.each(["project", "host"])("drains a reserved check before closing its %s ledger", async target => {
    const project = ctx.host.project("loop");
    const request = { requestId: randomUUID(), attempt: "T-1", expected: { definitionEntry: "L-1", approvalEntry: "L-2", pin: "a".repeat(64), commit: "b".repeat(40) } };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const resolver = vi.fn(async () => { await held; return repo; });
    const running = project.service.gate.proveRequest(request, "fixture-scope", resolver);
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
      closing = (target === "project" ? ctx.host.closeProject("loop") : ctx.host.close()).then(() => { closed = true; });
      expect(await project.service.gate.proveRequest({ ...request, requestId: randomUUID() }, "fixture-scope", resolver)).toMatchObject({ ok: false, reason: expect.stringContaining("closing") });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(closed).toBe(false);
    } finally { release(); await running; await closing; }
    expect(closed).toBe(true);
    expect([...project.entries()].reverse().find(e => e.data?.execution)?.data?.execution).toMatchObject({ phase: "refused-beforelaunch", settlement: "not-launched" });
    if (target === "project") expect(ctx.host.project("loop").service.gate.checks.status(request.requestId)?.execution.phase).toBe("refused-beforelaunch");
  });

  it("runs the loop: dispatch, worker proposes a failing test, person approves, worker builds, check, diff approval, merge", async () => {
    // 1. One click: a worktree, a worker token for this task only, the brief and the command.
    const dispatched = await post("/tasks/T-1/dispatch", { model: "claude-sonnet" });
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    const d = dispatched.body.result;
    expect(d).toMatchObject({ task: "T-1", branch: "pp/T-1", model: "claude-sonnet" });
    expect(d).not.toHaveProperty("token");
    const token = fs.readFileSync(d.tokenFile, "utf8");
    expect(token).toMatch(/^pp_w_/);
    if (process.platform !== "win32") expect(fs.statSync(d.tokenFile).mode & 0o077).toBe(0);
    else expect(execFileSync(icaclsPath(), [d.tokenFile], { encoding: "utf8" })).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/i);
    expect(fs.existsSync(d.worktree)).toBe(true);
    // connect.mjs, run from the worktree in its own process, learns the worktree folders from the file beside the token.
    const roots = JSON.parse(fs.readFileSync(d.tokenFile.replace(/\.token$/, ".roots.json"), "utf8")).roots as string[];
    expect(roots.some((root) => fs.realpathSync(d.worktree).startsWith(fs.realpathSync(root) + path.sep))).toBe(true);
    expect(d.brief).toContain("T-1");
    expect(d.brief).toContain("propose_test");
    expect(d.setup).toContain("connect.mjs");
    expect(`${d.setup}${d.start}${d.json}${d.brief}`).not.toContain(token);
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "needs-test", worktree: { branch: "pp/T-1" }, dispatch: { model: "claude-sonnet" } });
    expect(JSON.stringify((await tasks()))).not.toContain(token);

    // 2. The worker checks in over the bridge and writes the test first.
    const call = bridgeCall(d.bridgeUrl, token);
    const hello = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string; role: string; task: string };
    expect(hello).toMatchObject({ role: "worker", task: "T-1" });
    const agent = hello.agent;
    write(d.worktree, "tests/save.check.mjs", 'import { existsSync } from "node:fs";\nif (!existsSync("src/save.js")) { console.error("save.js missing"); process.exit(1); }\n');
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Test: notes are saved");
    await expect(call({ tool: "claim_task", args: { task: "T-1" }, agent })).rejects.toThrow(/no done-when test/);
    await call({ tool: "propose_test", args: { task: "T-1", command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] }, agent });
    // Test first is on by default: no claim before a person approves.
    await expect(call({ tool: "claim_task", args: { task: "T-1" }, agent })).rejects.toThrow(/waiting for the owner's approval/);
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "test-proposed", test: { command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"], by: { kind: "agent" } } });

    // 3. The person approves the test they read; the app runs it and it fails on today's code, as it must.
    const proposed = (await tasks()).tasks[0].test.entry;
    expect((await post("/tasks/T-1/approve-test")).body.code).toBe("STALE");
    const approved = await post("/tasks/T-1/approve-test", { test: proposed });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.result).toMatchObject({ approved: true, failsFirst: true });
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "ready-to-claim" });

    // 4. The worker claims, builds and attaches its commit.
    expect(await call({ tool: "claim_task", args: { task: "T-1" }, agent })).toMatchObject({ status: "claimed" });
    write(d.worktree, "src/save.js", "export const save = (note) => note;\n");
    // Files that can run code on the person's machine: the diff screen asks for their own confirmation.
    write(d.worktree, "package.json", '{ "name": "notes", "scripts": { "postinstall": "node setup.js" } }\n');
    write(d.worktree, ".github/workflows/ci.yml", "on: push\n");
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Save notes");
    const head = git(d.worktree, "rev-parse", "HEAD");
    await call({ tool: "attach_proof", args: { task: "T-1", kind: "commit", link: head }, agent });
    expect((await tasks()).tasks[0]).toMatchObject({ status: "claimed", stage: "building", proofs: [{ kind: "commit", link: head }] });

    // 5. Merge is refused before the test passed and before the diff is approved.
    expect((await post("/tasks/T-1/merge", { commit: head })).status).toBe(409);
    const checked = await post("/tasks/T-1/check");
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body.result).toMatchObject({ passed: true, commit: head });
    const diff = (await hostCall(ctx.base, "GET", `/tasks/T-1/diff${q}`)).body.result;
    expect(diff.files).toEqual([".github/workflows/ci.yml", "package.json", "src/save.js", "tests/save.check.mjs"]);
    // The gate's own list, minus the approved test file: it passed unchanged at this tip, and the person read it when approving the test.
    expect(diff.sensitive).toEqual([".github/workflows/ci.yml", "package.json"]);
    expect(diff.text).toContain("export const save");
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "review-diff" });
    // A program planted in the repo's config (a filter git would run on diff) is a plain refusal, never a crash.
    const planted = path.join(repo, "planted-ran");
    git(repo, "config", "filter.planted.clean", `node -e "require('fs').writeFileSync('${planted.replace(/\\/g, "/")}', '')"`);
    // A lost reply is recovered from its exact durable terminal even when fresh Git now refuses.
    const execution = checked.body.result.execution;
    expect(execution.phase).toBe("terminal");
    const replayBody = { requestId: execution.requestId, attempt: execution.attempt, expected: execution.expected };
    const replay = await post("/tasks/T-1/check", replayBody);
    expect(replay.body.result).toEqual(checked.body.result);
    const changedRequest = await post("/tasks/T-1/check", { ...replayBody, expected: { ...execution.expected, commit: "a".repeat(40) } });
    expect(changedRequest.status).toBe(409);
    const refusedDiff = await hostCall(ctx.base, "GET", `/tasks/T-1/diff${q}`);
    expect(refusedDiff.status, JSON.stringify(refusedDiff.body)).toBe(409);
    expect(refusedDiff.body).toMatchObject({ code: "GIT_PROGRAM_REFUSED", message: expect.stringContaining("filter.planted.clean") });
    const refusedApprove = await post("/tasks/T-1/approve-diff", { commit: diff.commit, confirmSensitive: diff.sensitive });
    expect(refusedApprove.status, JSON.stringify(refusedApprove.body)).toBe(409);
    expect(refusedApprove.body.code).toBe("GIT_PROGRAM_REFUSED");
    expect(fs.existsSync(planted)).toBe(false);
    git(repo, "config", "--unset", "filter.planted.clean");
    const early = await post("/tasks/T-1/merge", { commit: head });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("STALE");

    // 6. The person approves the diff at the commit they read and merges; the gate reruns the test on the merge first.
    expect((await post("/tasks/T-1/approve-diff")).body.code).toBe("STALE");
    const unconfirmed = await post("/tasks/T-1/approve-diff", { commit: diff.commit });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.code).toBe("CONFIRM_SENSITIVE");
    expect(unconfirmed.body.message).toContain("package.json");
    expect((await post("/tasks/T-1/approve-diff", { commit: diff.commit, confirmSensitive: ["package.json"] })).body.code).toBe("CONFIRM_SENSITIVE");
    expect((await post("/tasks/T-1/approve-diff", { commit: diff.commit, confirmSensitive: diff.sensitive })).status).toBe(200);
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "ready-to-merge" });
    expect((await post("/tasks/T-1/merge", { commit: "0".repeat(40) })).body.code).toBe("STALE");
    // No usable git identity (an empty name is refused by git): plain message, nothing signed, nothing merged.
    git(repo, "config", "user.name", "");
    const noName = await post("/tasks/T-1/merge", { commit: head });
    expect(noName.status).toBe(409);
    expect(noName.body.code).toBe("GIT_IDENTITY_MISSING");
    expect(noName.body.message).toContain('git config --global user.email "you@example.com"');
    expect(noName.body.message).not.toMatch(/conflict|Committer identity unknown/i);
    expect(ctx.host.project("loop").entries().some((entry: any) => entry.type === "merge.done")).toBe(false);
    git(repo, "config", "user.name", "Owner");
    // With an identity the merge takes its normal path.
    const merged = await post("/tasks/T-1/merge", { commit: head });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    // The worker is finished: its token no longer works and its token file is gone.
    expect(fs.existsSync(d.tokenFile)).toBe(false);
    expect(git(repo, "show", "main:src/save.js")).toContain("export const save");
    const done = (await tasks()).tasks[0];
    expect(done).toMatchObject({ status: "done", stage: "done", worktree: null });
    // Reopen the real persisted project after merge: replay must not inspect its now-removed task worktree.
    await ctx.host.closeProject("loop");
    const afterRestart = await post("/tasks/T-1/check", replayBody);
    expect(afterRestart.body.result).toEqual(checked.body.result);
    const types = ctx.host.project("loop").entries().map((e) => `${e.actor.kind}:${e.type}`);
    expect(types).toEqual(expect.arrayContaining(["agent:test.defined", "person:test.approved", "system:test.failed", "agent:task.claimed", "system:test.passed", "person:review.verdict", "person:merge.done", "system:task.done"]));
  // This one journey includes many deliberate refusals and the complete real
  // merge. focus-journeys-04 reached the final merge (35.329s) when its 60s
  // aggregate budget expired. Keep every assertion and watcher; give Windows
  // a bounded aggregate budget. Individual product latency remains unqualified.
  }, process.platform === "win32" ? 120_000 : 60_000);

  it("a person can write the test themselves, and a rejected diff goes back to the worker as the next attempt", async () => {
    const d = (await post("/tasks/T-1/dispatch", {})).body.result;
    write(d.worktree, "tests/save.check.mjs", 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/save.js") ? 0 : 1);\n');
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Test");
    const defined = await post("/tasks/T-1/test", { command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] });
    expect(defined.status, JSON.stringify(defined.body)).toBe(200);
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "test-proposed", test: { by: { kind: "person" } } });
    expect((await post("/tasks/T-1/approve-test", { test: (await tasks()).tasks[0].test.entry })).body.result).toMatchObject({ failsFirst: true });
    const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
    const { agent } = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
    await call({ tool: "claim_task", args: { task: "T-1" }, agent });
    write(d.worktree, "src/save.js", "export const save = 1;\n");
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Save");
    expect((await post("/tasks/T-1/check")).body.result).toMatchObject({ passed: true });
    expect((await post("/tasks/T-1/reject")).status).toBe(400);
    const rejected = await post("/tasks/T-1/reject", { notes: "Use a real file store" });
    expect(rejected.body.result).toMatchObject({ reopenedAs: "T-1.a2" });
    expect(fs.existsSync(d.tokenFile)).toBe(false);
    expect((await tasks()).tasks[0]).toMatchObject({ id: "T-1", attempt: 2, label: "T-1.a2", status: "open" });
  }, 60_000);

  it("B1: never suggests the host's own data folder as the git folder", async () => {
    await ctx.stop();
    ctx = await startTestHost();
    const view = await tasks();
    expect(view.repo.ok).toBe(false);
    expect(view.repo.suggested).toBeUndefined();
    await ctx.stop();
    ctx = await startTestHost({ projectRootOverride: repo });
  }, 60_000);

  it("says plainly when the project folder is not a git repository", async () => {
    await ctx.stop();
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pp-tasks-plain-"));
    ctx = await startTestHost({ projectRootOverride: plain });
    const view = await tasks();
    expect(view.repo.ok).toBe(false);
    expect(view.repo.reason).toMatch(/git/);
    // The folder the person already imported is offered as the answer, not an empty box.
    expect(view.repo.suggested).toBe(fs.realpathSync(plain));
    const res = await post("/tasks/T-1/dispatch");
    expect(res.status).toBe(409);
    // Close the host before removing its folder: Windows refuses to delete a folder whose ledger is still open.
    await ctx.stop();
    fs.rmSync(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    ctx = await startTestHost({ projectRootOverride: repo });
  });
});

describe("approvals are bound to what the person saw", () => {
  it("refuses to approve a test a worker swapped after the person read it, and a diff that moved after the check", async () => {
    const d = (await post("/tasks/T-1/dispatch", {})).body.result;
    const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
    const { agent } = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
    write(d.worktree, "tests/save.check.mjs", 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/save.js") ? 0 : 1);\n');
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Test");
    await call({ tool: "propose_test", args: { task: "T-1", command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] }, agent });
    const seen = (await tasks()).tasks[0].test.entry;
    // The worker replaces the test while the person is reading it.
    await call({ tool: "propose_test", args: { task: "T-1", command: "node -e \"process.exit(1)\"", files: ["tests/save.check.mjs"] }, agent });
    const swapped = await post("/tasks/T-1/approve-test", { test: seen });
    expect(swapped.status).toBe(409);
    expect(swapped.body.code).toBe("STALE");
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "test-proposed", approval: null });

    // The worker puts the real test back; the person approves that one, the worker builds, the app checks.
    await call({ tool: "propose_test", args: { task: "T-1", command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] }, agent });
    expect((await post("/tasks/T-1/approve-test", { test: (await tasks()).tasks[0].test.entry })).status).toBe(200);
    await call({ tool: "claim_task", args: { task: "T-1" }, agent });
    write(d.worktree, "src/save.js", "export const save = 1;\n");
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Save");
    const checked = git(d.worktree, "rev-parse", "HEAD");
    expect((await post("/tasks/T-1/check")).body.result).toMatchObject({ passed: true, commit: checked });
    // Then the worker commits again before the person approves the diff.
    write(d.worktree, "src/extra.js", "export const extra = 1;\n");
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Sneak in more");
    const moved = await post("/tasks/T-1/approve-diff", { commit: checked });
    expect(moved.body.code).toBe("STALE");
    const tip = git(d.worktree, "rev-parse", "HEAD");
    expect((await post("/tasks/T-1/approve-diff", { commit: tip })).body.code).toBe("STALE");
  }, 60_000);
});

describe("releasing a dead worker's claim", () => {
  it("writes the person's signed release, ends the worker's token, keeps the worktree and its commits, and lets a new worker take it", async () => {
    expect((await post("/tasks/T-1/release")).body.code).toBe("NOT_CLAIMED");
    const d = (await post("/tasks/T-1/dispatch", {})).body.result;
    const token = fs.readFileSync(d.tokenFile, "utf8");
    const call = bridgeCall(d.bridgeUrl, token);
    const { agent } = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
    write(d.worktree, "tests/save.check.mjs", 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/save.js") ? 0 : 1);\n');
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Test");
    await call({ tool: "propose_test", args: { task: "T-1", command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] }, agent });
    expect((await post("/tasks/T-1/approve-test", { test: (await tasks()).tasks[0].test.entry })).status).toBe(200);
    await call({ tool: "claim_task", args: { task: "T-1" }, agent });
    write(d.worktree, "src/half.js", "export const half = 1;\n");
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Half done");
    const tip = git(d.worktree, "rev-parse", "HEAD");
    const held = (await tasks()).tasks[0];
    expect(held).toMatchObject({ status: "claimed", stage: "building" });

    expect((await post("/tasks/T-1/release", { owner: "someone-else" })).body.code).toBe("STALE");
    expect((await post("/tasks/T-1/release", { reason: 5 })).status).toBe(400);
    // A signed release must resolve even if optional readiness inspection never does.
    let unblock!: () => void;
    const heldRead = new Promise<void>(resolve => { unblock = resolve; });
    const readiness = vi.spyOn(worktreeCare, "checkReadiness").mockImplementation(async () => { await heldRead; return { ok: true }; });
    let released: Awaited<ReturnType<typeof post>>;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      released = await Promise.race([
        post("/tasks/T-1/release", { owner: held.owner, reason: "The worker's window was closed" }),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Release waited for optional inspection")), 2000); }),
      ]);
      expect(readiness).not.toHaveBeenCalled();
    } finally { unblock(); readiness.mockRestore(); if (deadline) clearTimeout(deadline); }
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.result).toMatchObject({ released: "T-1", from: held.owner });

    // The release is the person's own signed entry, with the reason kept.
    const project = ctx.host.project("loop");
    const entry = project.entries().find((e) => e.n === released.body.result.entry)!;
    expect(entry).toMatchObject({ type: "task.progress", subject: "T-1", reason: "The worker's window was closed", data: { released: true, from: held.owner } });
    expect(isAuthoritative(entry, { personOnly: true })).toBe(true);
    // The old worker is cut off.
    expect(fs.existsSync(d.tokenFile)).toBe(false);
    await expect(call({ tool: "report_progress", args: { task: "T-1", summary: "still here" }, agent })).rejects.toThrow();
    // The work is kept: same worktree, same branch, same commit.
    expect(fs.existsSync(d.worktree)).toBe(true);
    expect(git(d.worktree, "rev-parse", "HEAD")).toBe(tip);
    await vi.waitFor(async () => {
      const free = (await tasks()).tasks[0];
      // A pending optional scan is unknown, never an assertion of absence.
      expect(free.worktree).not.toBeNull();
      expect(free).toMatchObject({ status: "open", owner: null, stage: "ready-to-claim", worktree: { path: d.worktree }, dispatch: null });
    }, { timeout: 10_000 });

    // A new worker is dispatched on the same worktree and can claim it.
    const again = (await post("/tasks/T-1/dispatch", {})).body.result;
    expect(again.worktree).toBe(d.worktree);
    const call2 = bridgeCall(again.bridgeUrl, fs.readFileSync(again.tokenFile, "utf8"));
    const second = (await call2({ tool: "hello", args: { name: "Worker 2" } })) as { agent: string };
    expect(await call2({ tool: "claim_task", args: { task: "T-1" }, agent: second.agent })).toMatchObject({ status: "claimed" });
    expect(git(again.worktree, "log", "--format=%s", "-1")).toBe("Half done");
  }, 60_000);
});

describe("choosing the repository", () => {
  it("refuses a whole drive or the home folder, and switching folders under a running worker", async () => {
    expect(repoRefusal(path.parse(repo).root)).toMatch(/whole drive/);
    expect(repoRefusal(repo, repo)).toMatch(/home folder/);
    expect(repoRefusal(repo)).toBeNull();
    await post("/tasks/T-1/dispatch", {});
    const other = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-tasks-other-")));
    git(other, "init", "-q", "-b", "main");
    git(other, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "x");
    const res = await post("/tasks/repo", { root: other });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WORKERS_ACTIVE");
    fs.rmSync(other, { recursive: true, force: true });
  });
});

describe("worker commands", () => {
  it("single-quotes paths so they cannot run commands, in both shells", () => {
    expect(quoteFor(false)("/tmp/$(touch pwned)/it's")).toBe("'/tmp/$(touch pwned)/it'\\''s'");
    expect(quoteFor(true)("C:\\$(calc)\\it's")).toBe("'C:\\$(calc)\\it''s'");
    const posix = workerCommands({ worktree: "/w/$(x)", bridgeUrl: "http://127.0.0.1:1", tokenFile: "/t/T-1.token", entry: "/a/agent.mjs", briefFile: "/b/`x`.md", platform: "linux" });
    expect(posix.setup).toBe("cd '/w/$(x)' && node '/a/connect.mjs' --agent codex http://127.0.0.1:1 '/t/T-1.token'");
    expect(posix.start).toBe("codex -s workspace-write -a on-request \"$(cat '/b/`x`.md')\"");
    expect(posix.agents.gemini.setup).toBe("cd '/w/$(x)' && node '/a/connect.mjs' --agent gemini http://127.0.0.1:1 '/t/T-1.token'");
    expect(posix.agents.gemini.start).toBe("gemini --approval-mode auto_edit -i \"$(cat '/b/`x`.md')\"");
    expect(posix.agents.codex.setup).toContain("--agent codex");
    expect(posix.agents.codex.start).toBe("codex -s workspace-write -a on-request \"$(cat '/b/`x`.md')\"");
    expect(posix.setup).toBe(posix.agents.codex.setup);
    expect(posix.start).toBe(posix.agents.codex.start);
    expect(posix.agents.claude.setup).toContain("--agent claude");
    expect(posix.agents.claude.start).toMatch(/^claude /);
    // Never an approve-everything flag, for any agent.
    for (const a of Object.values(posix.agents)) expect(a.start).not.toMatch(/yolo|danger|bypass|full-auto/);
    expect(workerCommands({ worktree: "C:\\w", bridgeUrl: "http://127.0.0.1:1", tokenFile: "C:\\t", entry: "C:\\a", briefFile: "C:\\b.md", platform: "win32" }).start).toBe("codex -s workspace-write -a on-request (Get-Content -Raw 'C:\\b.md')");
  });
});

// The reviewer's Batch 3 attack: any program on this PC asks the host for the person cookie while
// claiming to be the app window, then approves and runs things as the person. Since #15's fix the
// cookie only comes from claiming the one-time launch secret the launcher gave the window.
describe("a forged local request is not the person", () => {
  it("cannot get the person cookie from /session, so cannot approve a plan, dispatch, set a test or approve it", async () => {
    const origin = ctx.base.replace(/\/api\/core$/, "");
    const session = await fetch(`${ctx.base}/session${q}`, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", origin } });
    expect(session.headers.get("set-cookie")).toBeNull();
    // Guessing a launch secret, or replaying the one the real window already spent, gets nothing either.
    const guess = await fetch(`${ctx.base}/session/claim`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ launch: "x".repeat(43) }) });
    expect(guess.status).toBe(401);
    expect(guess.headers.get("set-cookie")).toBeNull();
    const launch = ctx.host.issueLaunch();
    const claim = () => fetch(`${ctx.base}/session/claim`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ launch }) });
    expect((await claim()).status).toBe(200);
    expect((await claim()).status).toBe(401);
    const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0];
    const forged = async (route: string, body: unknown = {}) => {
      const res = await fetch(`${ctx.base}${route}${q}`, { method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
      return res.status;
    };
    expect(await forged("/plan/approve", { tasks: [{ id: "T-1", title: "Save notes" }] })).toBe(401);
    expect(await forged("/tasks/T-1/dispatch")).toBe(401);
    expect(await forged("/tasks/T-1/test", { command: "node -e 1", files: ["README.md"] })).toBe(401);
    expect(await forged("/tasks/T-1/approve-test", { test: "L-000001" })).toBe(401);
    const types = ctx.host.project("loop").entries().map((e) => e.type);
    expect(types).not.toContain("plan.approved");
    expect(types).not.toContain("test.approved");
  });
});

describe("a refused merge shows why the test failed", () => {
  it("adds the end of the test's own output to the reason, and nothing when there is none", () => {
    const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const text = withOutputTail("The test fails after the merge (exit code 1); main was left untouched.", output);
    expect(text).toContain("exit code 1");
    expect(text).toContain("End of the test output:\nline 21\n");
    expect(text).toContain("line 40");
    expect(text).not.toContain("line 20\n");
    expect(withOutputTail("refused", "")).toBe("refused");
  });
});

describe("a computer whose git has no name and email", () => {
  const keep = { ...process.env };
  afterEach(() => {
    for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
      if (keep[key] === undefined) delete process.env[key];
      else process.env[key] = keep[key];
    }
  });

  it("gets a plain message with the two commands, and nothing in git config is changed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pp-nohome-"));
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "pp-noident-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main", bare]);
      Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "xdg"), GIT_CONFIG_NOSYSTEM: "1" });
      const personal = path.join(home, "gitconfig");
      process.env.GIT_CONFIG_GLOBAL = personal;
      // Git may guess an email from the host name; refuse the guess so this matches a beginner's machine.
      execFileSync("git", ["config", "user.useConfigOnly", "true"], { cwd: bare });
      // The app copies the person's git settings once per process; load it fresh, as on a computer with none.
      vi.resetModules();
      const fresh = await import("./tasks");
      const text = await fresh.gitIdentityRefusal(bare);
      expect(text).toContain('git config --global user.name "Your Name"');
      expect(text).toContain('git config --global user.email "you@example.com"');
      expect(text).not.toMatch(/Committer identity unknown|conflict/i);
      // The person runs the two commands while the app stays open: the next try passes, no restart.
      execFileSync("git", ["config", "--file", personal, "user.name", "Pat"]);
      execFileSync("git", ["config", "--file", personal, "user.email", "pat@example.invalid"]);
      expect(await fresh.gitIdentityRefusal(bare)).toBeNull();
      expect(fs.existsSync(path.join(home, ".gitconfig"))).toBe(false);
      expect(execFileSync("git", ["config", "--local", "--list"], { cwd: bare, encoding: "utf8" })).not.toMatch(/user\.(name|email)/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it("does not blame the identity when git itself fails", async () => {
    const text = await gitIdentityRefusal(path.join(os.tmpdir(), "pp-no-such-folder-for-git"));
    expect(text).toContain("Git did not answer");
    expect(text).not.toContain("user.name");
  });

  it("is not in the way when git has an identity", async () => {
    expect(await gitIdentityRefusal(repo)).toBeNull();
  });
});

}); // repository task routes: cache-only tests above need no Git/host fixture
