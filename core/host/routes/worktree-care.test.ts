// Lane L10: small bugs and worktree clean-up, as the person meets them in the Tasks screen.
// Each block starts from something that was wrong on main 113afb6 (see RESULT.md for the failing output
// before the fix): the Git folder box offering the app's own data folder, a task folder deleted by hand,
// leftover folders piling up after reject or release, a failed merge hiding the test's output.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeCall } from "../../mcp/index";
import { appendNumbered } from "../../numbering/index";
import { asPersonRequest } from "../keys";
import { hostCall, startTestHost } from "../testing";
import { worktreesForWatcher } from "./tasks";
import { withHygieneLock, withWatcherAway } from "./worktreeCare";

const IDENT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT } }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const SLOW = 60_000;
const q = "?project=loop";
const PASSING = 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/save.js") ? 0 : 1);\n';

let repo: string;
let ctx: Awaited<ReturnType<typeof startTestHost>>;
const makeRepo = () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-care-repo-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "user.name", "Owner");
  git(dir, "config", "user.email", "owner@example.invalid");
  write(dir, "README.md", "# Notes app\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial");
  return dir;
};
const addTask = (host: typeof ctx.host, title = "Save notes") => asPersonRequest(() => appendNumbered(host.project("loop").ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: title, data: { title } }));

/** The app's own folder for its data: no repo is chosen, the way a fresh install starts. */
const startOwnData = async () => {
  const c = await startTestHost();
  addTask(c.host);
  return c;
};

beforeEach(async () => {
  repo = makeRepo();
  ctx = await startTestHost({ projectRootOverride: repo });
  addTask(ctx.host);
});
afterEach(async () => {
  await ctx.stop();
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const tasks = async (c = ctx) => (await hostCall(c.base, "GET", `/tasks${q}`)).body.result as { repo: any; tasks: any[] };
const post = (route: string, body: unknown = {}, c = ctx) => hostCall(c.base, "POST", `${route}${q}`, body);
const get = (route: string, c = ctx) => hostCall(c.base, "GET", `${route}${q}`);
const dispatch = async (c = ctx, id = "T-1") => {
  const res = await post(`/tasks/${id}/dispatch`, {}, c);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.result;
};

/** The person writes the done-when test; a worker claims and commits half the work. Leaves the task claimed and building. */
async function claimAndCommit(d: any, message = "Half done", c = ctx) {
  write(d.worktree, "tests/save.check.mjs", PASSING);
  git(d.worktree, "add", "-A");
  git(d.worktree, "commit", "-q", "-m", "Test");
  expect((await post("/tasks/T-1/test", { command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] }, c)).status).toBe(200);
  expect((await post("/tasks/T-1/approve-test", { test: (await tasks(c)).tasks[0].test.entry }, c)).body.result).toMatchObject({ failsFirst: true });
  const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
  const { agent } = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
  await call({ tool: "claim_task", args: { task: "T-1" }, agent });
  write(d.worktree, "src/save.js", "export const save = 1;\n");
  git(d.worktree, "add", "-A");
  git(d.worktree, "commit", "-q", "-m", message);
  return { call, agent, head: git(d.worktree, "rev-parse", "HEAD") };
}

describe("1. the Git folder box", () => {
  it("never offers the app's own data folder", async () => {
    const own = await startOwnData();
    try {
      const view = await tasks(own);
      expect(view.repo.ok).toBe(false);
      expect(view.repo.suggested).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain(own.dir);
    } finally {
      await own.stop();
    }
  });

  it("still offers the folder the host was started for (PP_CORE_PROJECT_ROOT), when that is a normal folder", async () => {
    await ctx.stop();
    const plain = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-care-plain-")));
    ctx = await startTestHost({ projectRootOverride: plain });
    addTask(ctx.host);
    expect((await tasks()).repo.suggested).toBe(plain);
    await ctx.stop();
    fs.rmSync(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    ctx = await startTestHost({ projectRootOverride: repo });
  });
});

describe("4. a task folder that is gone", () => {
  it("is reported as missing with its branch kept, dispatch offers to recreate it instead of a command for a folder that is not there, and recreating keeps the work", async () => {
    const d = await dispatch();
    const { head } = await claimAndCommit(d);
    const branches = git(repo, "branch", "--list", "pp/*");
    // The person (or a clean-up tool) deletes the task's folder by hand.
    fs.rmSync(d.worktree, { recursive: true, force: true });

    // Start worker again: no command for a folder that is not there, and no token handed out.
    const again = await post("/tasks/T-1/dispatch", { model: "claude-sonnet" });
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.code).toBe("WORKTREE_MISSING");
    expect(again.body.result).toBeUndefined();
    expect(again.body.message).toContain("pp/T-1");
    expect(again.body.message).toMatch(/recreate/i);
    expect(JSON.stringify(again.body)).not.toContain("claude mcp add");
    expect(fs.existsSync(d.worktree)).toBe(false);

    const seen = (await tasks()).tasks[0];
    expect(seen.worktree).toMatchObject({ branch: "pp/T-1", state: "missing" });
    expect(seen.worktree.note).toMatch(/deleted/i);
    expect(seen.worktree.note).toContain("pp/T-1");

    // The person accepts the offer: the folder comes back from the branch, with the commit.
    const back = await post("/tasks/T-1/recreate-folder");
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(fs.existsSync(path.join(d.worktree, "src", "save.js"))).toBe(true);
    expect(git(d.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(git(d.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pp/T-1");
    expect(git(repo, "branch", "--list", "pp/*")).toBe(branches);
    expect((await tasks()).tasks[0].worktree.state).toBe("ok");
    // A second recreate has nothing to do and says so, rather than touching the folder.
    expect((await post("/tasks/T-1/recreate-folder")).status).toBe(409);
    const worker = await post("/tasks/T-1/dispatch", {});
    expect(worker.status, JSON.stringify(worker.body)).toBe(200);
    expect(worker.body.result.worktree).toBe(d.worktree);
  }, SLOW);

  it("when the folder and the branch are both gone there is nothing to recreate: the stale record is forgotten and a fresh folder is made", async () => {
    const d = await dispatch();
    fs.rmSync(d.worktree, { recursive: true, force: true });
    git(repo, "worktree", "prune");
    git(repo, "branch", "-D", "pp/T-1");
    const res = await post("/tasks/T-1/dispatch", {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(fs.existsSync(res.body.result.worktree)).toBe(true);
    expect(git(res.body.result.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pp/T-1");
    const entries = ctx.host.project("loop").entries().filter((e) => e.type === "worktree.removed" && e.subject === "T-1");
    expect(entries.at(-1)?.data).toMatchObject({ forgotten: true });
  }, SLOW);

  it("a folder that is still there but that git no longer tracks is never touched: dispatch says so and recreate refuses", async () => {
    const d = await dispatch();
    write(d.worktree, "notes.txt", "keep me\n");
    fs.rmSync(path.join(repo, ".git", "worktrees", "T-1"), { recursive: true, force: true });
    expect((await tasks()).tasks[0].worktree.state).toBe("unlinked");
    const res = await post("/tasks/T-1/dispatch", {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WORKTREE_UNLINKED");
    expect((await post("/tasks/T-1/recreate-folder")).status).toBe(409);
    expect(fs.readFileSync(path.join(d.worktree, "notes.txt"), "utf8")).toBe("keep me\n");
  }, SLOW);

  it("survives deleting the whole .perfect-planner folder: every task folder reads as missing, nothing is deleted, recreate brings the work back", async () => {
    await ctx.stop();
    ctx = await startOwnData();
    expect((await post("/tasks/repo", { root: repo })).status).toBe(200);
    const d = await dispatch();
    const { head } = await claimAndCommit(d);
    expect(d.worktree.startsWith(path.join(repo, ".perfect-planner"))).toBe(true);
    fs.rmSync(path.join(repo, ".perfect-planner"), { recursive: true, force: true });
    expect((await tasks()).tasks[0].worktree.state).toBe("missing");
    expect((await post("/tasks/T-1/dispatch", {})).body.code).toBe("WORKTREE_MISSING");
    expect((await post("/tasks/T-1/recreate-folder")).status).toBe(200);
    expect(git(d.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "rev-parse", "pp/T-1")).toBe(head);
    await ctx.stop();
    ctx = await startTestHost({ projectRootOverride: repo });
    addTask(ctx.host);
  }, SLOW);

  it("a registry that names a folder outside the planner's own folder is never recreated into or removed", async () => {
    const d = await dispatch();
    const registry = path.join(repo, ".git", "perfect-planner", "worktrees.json");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pp-care-outside-"));
    write(outside, "precious.txt", "mine\n");
    const doc = JSON.parse(fs.readFileSync(registry, "utf8"));
    doc.worktrees[0].path = outside;
    fs.writeFileSync(registry, JSON.stringify(doc));
    fs.rmSync(d.worktree, { recursive: true, force: true });
    const clean = await post("/worktrees/clean");
    expect(clean.status, JSON.stringify(clean.body)).toBe(200);
    expect((await post("/worktrees/T-1/remove", {})).status).toBe(409);
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("mine\n");
    expect(git(repo, "branch", "--list", "pp/T-1")).toContain("pp/T-1");
    fs.rmSync(outside, { recursive: true, force: true });
  }, SLOW);
});

describe("5. leftover folders: a safe sweep, and a list for the person to decide", () => {
  /** T-1 claimed, half built, committed, then sent back: its folder is a leftover with one commit that is not merged or pushed. */
  async function sentBack() {
    const d = await dispatch();
    const built = await claimAndCommit(d);
    expect((await post("/tasks/T-1/check")).body.result).toMatchObject({ passed: true });
    expect((await post("/tasks/T-1/reject", { notes: "Use a real file store" })).body.result).toMatchObject({ reopenedAs: "T-1.a2" });
    return { d, ...built };
  }
  const folders = async () => (await get("/worktrees")).body.result as { folders: any[]; untracked: any[] };

  it("never removes a leftover with commits that are neither merged nor pushed, lists it with its owner, size and why it is kept, and the branch survives", async () => {
    const { d, head } = await sentBack();
    const swept = await post("/worktrees/clean");
    expect(swept.status, JSON.stringify(swept.body)).toBe(200);
    expect(swept.body.result.removed).toEqual([]);
    expect(fs.existsSync(d.worktree)).toBe(true);
    const row = (await folders()).folders.find((f) => f.task === "T-1");
    expect(row).toMatchObject({ state: "ok", branch: "pp/T-1", removable: true });
    // Started from this window by the person, so the owner reads "you", not their internal id.
    expect(row.owner).toBe("you");
    expect(row.sizeBytes).toBeGreaterThan(0);
    expect(row.why.join(" ")).toMatch(/not merged into main or pushed/);
    expect(git(repo, "rev-parse", "pp/T-1")).toBe(head);
  }, SLOW);

  it("never removes a leftover that has uncommitted or untracked files, even when the person asks", async () => {
    const { d } = await sentBack();
    write(d.worktree, "scratch/notes.txt", "not committed\n");
    const swept = await post("/worktrees/clean");
    expect(swept.body.result.removed).toEqual([]);
    const row = (await folders()).folders.find((f) => f.task === "T-1");
    expect(row.why.join(" ")).toMatch(/uncommitted|untracked/);
    expect(row.removable).toBe(false);
    const asked = await post("/worktrees/T-1/remove", {});
    expect(asked.status).toBe(409);
    expect(fs.readFileSync(path.join(d.worktree, "scratch", "notes.txt"), "utf8")).toBe("not committed\n");
  }, SLOW);

  it("removes a leftover once its work is on a remote (pushed), keeps the branch, and writes the removal to the ledger", async () => {
    const { d, head } = await sentBack();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "pp-care-remote-"));
    git(remote, "init", "-q", "--bare");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "pp/T-1");
    const swept = await post("/worktrees/clean");
    expect(swept.body.result.removed.map((r: any) => r.task)).toEqual(["T-1"]);
    expect(fs.existsSync(d.worktree)).toBe(false);
    // Never a deleted branch: the unmerged work is still on it.
    expect(git(repo, "rev-parse", "pp/T-1")).toBe(head);
    const removed = ctx.host.project("loop").entries().filter((e) => e.type === "worktree.removed" && e.subject === "T-1").at(-1);
    expect(removed?.data).toMatchObject({ branch: "pp/T-1", branchDeleted: false });
    expect((await folders()).folders.find((f) => f.task === "T-1")).toBeUndefined();
    fs.rmSync(remote, { recursive: true, force: true });
  }, SLOW);

  it("removes a released task's folder only once its commits are merged, and then deletes only that merged branch", async () => {
    const d = await dispatch();
    const { head } = await claimAndCommit(d);
    const owner = (await tasks()).tasks[0].owner;
    expect((await post("/tasks/T-1/release", { owner })).status).toBe(200);
    // Released, but the half-done commit is neither merged nor pushed: kept.
    expect((await post("/worktrees/clean")).body.result.removed).toEqual([]);
    expect(fs.existsSync(d.worktree)).toBe(true);
    // The person merges the work themselves; now nothing can be lost.
    git(repo, "merge", "-q", "--no-edit", "pp/T-1");
    const swept = await post("/worktrees/clean");
    expect(swept.body.result.removed).toMatchObject([{ task: "T-1", branchDeleted: true }]);
    expect(fs.existsSync(d.worktree)).toBe(false);
    expect(git(repo, "branch", "--list", "pp/T-1")).toBe("");
    expect(git(repo, "cat-file", "-t", head)).toBe("commit");
  }, SLOW);

  it("never touches a task a worker holds or a worker that was just started, however clean its folder looks", async () => {
    const d = await dispatch();
    // Fresh dispatch: clean, nothing committed, base == tip: "merged" by any measure, but the worker is on its way.
    expect((await post("/worktrees/clean")).body.result.removed).toEqual([]);
    expect(fs.existsSync(d.worktree)).toBe(true);
    await claimAndCommit(d);
    expect((await post("/worktrees/clean")).body.result.removed).toEqual([]);
    expect(fs.existsSync(d.worktree)).toBe(true);
    expect((await folders()).folders).toEqual([]);
  }, SLOW);

  it("a merged task whose folder still holds an ignored file is kept and listed, never deleted with the file", async () => {
    const d = await dispatch();
    const { head } = await claimAndCommit(d);
    expect((await post("/tasks/T-1/check")).body.result).toMatchObject({ passed: true });
    const diff = (await get("/tasks/T-1/diff")).body.result;
    expect((await post("/tasks/T-1/approve-diff", { commit: diff.commit, confirmSensitive: diff.sensitive })).status).toBe(200);
    // An ignored file that is real work (notes the worker kept next to the code).
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "keep-me.log\n");
    write(d.worktree, "keep-me.log", "important\n");
    const merged = await post("/tasks/T-1/merge", { commit: head });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body.result.removed).toMatchObject({ error: expect.stringMatching(/ignored files/) });
    expect(fs.readFileSync(path.join(d.worktree, "keep-me.log"), "utf8")).toBe("important\n");
    const swept = await post("/worktrees/clean");
    expect(swept.body.result.removed).toEqual([]);
    const row = (await folders()).folders.find((f) => f.task === "T-1");
    expect(row.why.join(" ")).toMatch(/ignored files/);
    expect(fs.existsSync(path.join(d.worktree, "keep-me.log"))).toBe(true);
  }, SLOW);

  it("the person can choose to remove a kept folder that has no uncommitted work: the folder goes, the branch with its commit stays", async () => {
    const { d, head } = await sentBack();
    const res = await post("/worktrees/T-1/remove", {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(fs.existsSync(d.worktree)).toBe(false);
    expect(git(repo, "rev-parse", "pp/T-1")).toBe(head);
    // The next attempt gets its own folder; a folder a worker was just started in is not removable from the list.
    const d2 = await dispatch(ctx, "T-1");
    expect(d2.task).toBe("T-1.a2");
    expect(d2.worktree).not.toBe(d.worktree);
    expect((await post("/worktrees/T-1.a2/remove", {})).status).toBe(409);
    expect(fs.existsSync(d2.worktree)).toBe(true);
  }, SLOW);

  it("the git watcher stays out of the folders a clean-up is removing (Windows cannot delete a folder git has open), and never waits for the clean-up", async () => {
    await dispatch();
    const project = ctx.host.project("loop");
    const names = async () => (await worktreesForWatcher(project)).list.map((info) => info.taskId);
    expect(await names()).toContain("T-1");
    expect(await withWatcherAway(project, ["T-1"], names)).not.toContain("T-1");
    expect(await names()).toContain("T-1");
    // Its listing does not tidy, so a pass that a clean-up is waiting for cannot be waiting for that clean-up.
    const listed = await withHygieneLock(project, () => Promise.race([names(), new Promise<string[]>((resolve) => setTimeout(() => resolve(["stuck"]), 8000))]));
    expect(listed).toContain("T-1");
  }, SLOW);

  it("a sweep and a dispatch at the same moment never leave the person a command for a folder that is not there", async () => {
    const d = await dispatch();
    await claimAndCommit(d);
    const owner = (await tasks()).tasks[0].owner;
    expect((await post("/tasks/T-1/release", { owner })).status).toBe(200);
    git(repo, "merge", "-q", "--no-edit", "pp/T-1");
    // Released, clean, merged: the sweep may take it. A dispatch for the same task races it.
    const [swept, again] = await Promise.all([post("/worktrees/clean"), post("/tasks/T-1/dispatch", {})]);
    expect(swept.status, JSON.stringify(swept.body)).toBe(200);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(fs.existsSync(again.body.result.worktree)).toBe(true);
    // And the other order: dispatched first, then swept. The new worker's folder is not taken from under it.
    const after = await post("/worktrees/clean");
    expect(after.body.result.removed).toEqual([]);
    expect(fs.existsSync(again.body.result.worktree)).toBe(true);
    expect((await tasks()).tasks[0].worktree.state).toBe("ok");
  }, SLOW);
});

describe("3. Check the work says what is missing", () => {
  it("names unsaved changes in the worker's folder, and says when the worker has not said it is done", async () => {
    const d = await dispatch();
    const { call, agent } = await claimAndCommit(d);
    let building = (await tasks()).tasks[0];
    expect(building.stage).toBe("building");
    // Saved work, no proof attached yet: the check can run, and the screen says what is still missing.
    expect(building.checkReady).toMatchObject({ ok: true });
    expect(building.checkReady.note).toMatch(/not said it is done/);
    // The worker left changes unsaved: the gate would refuse, so the screen says so first.
    write(d.worktree, "src/extra.js", "export const extra = 1;\n");
    building = (await tasks()).tasks[0];
    expect(building.checkReady.ok).toBe(false);
    expect(building.checkReady.note).toMatch(/unsaved changes in 1 file/);
    expect(building.checkReady.note).toContain("src/extra.js");
    // Committed and proof attached: nothing is missing.
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Extra");
    await call({ tool: "attach_proof", args: { task: "T-1", kind: "commit", link: git(d.worktree, "rev-parse", "HEAD") }, agent });
    expect((await tasks()).tasks[0].checkReady).toEqual({ ok: true });
  }, SLOW);

  it("looking never changes the worker's folder: the readiness read takes no git lock and leaves status as it was", async () => {
    const d = await dispatch();
    await claimAndCommit(d);
    write(d.worktree, "src/extra.js", "x\n");
    const before = git(d.worktree, "status", "--porcelain");
    await tasks();
    await tasks();
    expect(git(d.worktree, "status", "--porcelain")).toBe(before);
    expect(fs.existsSync(path.join(repo, ".git", "worktrees", "T-1", "index.lock"))).toBe(false);
  }, SLOW);
});

describe("6. a failed merge shows the test's own output", () => {
  it("puts the end of the failing test's output in the refusal, and leaves main untouched", async () => {
    const d = await dispatch();
    // The test passes in the worker's folder; once merged with what main gained, it prints why it fails.
    write(d.worktree, "tests/save.check.mjs", 'import { existsSync } from "node:fs";\nif (existsSync("BLOCKED.txt")) { console.error("merge-output-marker: BLOCKED.txt exists on main"); process.exit(1); }\nprocess.exit(existsSync("src/save.js") ? 0 : 1);\n');
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Test");
    expect((await post("/tasks/T-1/test", { command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] })).status).toBe(200);
    expect((await post("/tasks/T-1/approve-test", { test: (await tasks()).tasks[0].test.entry })).body.result).toMatchObject({ failsFirst: true });
    const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
    const { agent } = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
    await call({ tool: "claim_task", args: { task: "T-1" }, agent });
    write(d.worktree, "src/save.js", "export const save = 1;\n");
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Save");
    const head = git(d.worktree, "rev-parse", "HEAD");
    expect((await post("/tasks/T-1/check")).body.result).toMatchObject({ passed: true });
    const diff = (await get("/tasks/T-1/diff")).body.result;
    expect((await post("/tasks/T-1/approve-diff", { commit: diff.commit, confirmSensitive: diff.sensitive })).status).toBe(200);
    // Main moves on: a file that makes the approved test fail once the two are merged.
    write(repo, "BLOCKED.txt", "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Main moved");
    const mainBefore = git(repo, "rev-parse", "main");
    const merged = await post("/tasks/T-1/merge", { commit: head });
    expect(merged.status, JSON.stringify(merged.body)).toBe(409);
    expect(merged.body.message).toContain("main was left untouched");
    expect(merged.body.message).toContain("End of the test output:");
    expect(merged.body.message).toContain("merge-output-marker: BLOCKED.txt exists on main");
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
  }, SLOW);
});
