// Batch approve and merge, Start all, the worker limit and the auto-merge switch (ledger 07).
// Attacks, each with a marker that must hold:
//   a diff with a flagged file in the batch   -> skipped, never approved, never merged
//   the worker commits after the screen loads -> skipped as changed, nothing approved
//   one task whose test fails after merge     -> that one fails with the test output; the others still merge
//   a forged (non-person) call                -> 401, nothing changes
//   a task waiting on a dependency            -> Start all never starts it
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendNumbered } from "../../numbering/index";
import { bridgeCall } from "../../mcp/index";
import { asPersonRequest } from "../keys";
import { hostCall, startTestHost } from "../testing";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

const q = "?project=loop";
let repo: string;
let ctx: Awaited<ReturnType<typeof startTestHost>>;

beforeEach(async () => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-batch-repo-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.invalid");
  write(repo, "README.md", "# Notes app\n");
  write(repo, ".gitignore", ".perfect-planner/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial");
  ctx = await startTestHost({ projectRootOverride: repo });
});

afterEach(async () => {
  await ctx.stop();
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const post = (route: string, body: unknown = {}) => hostCall(ctx.base, "POST", `${route}${q}`, body);
const view = async () => (await hostCall(ctx.base, "GET", `/tasks${q}`)).body.result as { tasks: any[]; settings: { limit: number; autoMerge: boolean }; queue: any };
const addTask = (title: string, data: Record<string, unknown> = {}) =>
  asPersonRequest(() => appendNumbered(ctx.host.project("loop").ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: title, data: { title, ...data } })).subject;

/**
 * A scripted worker that takes a task to "diff to review". `flagged` adds an install script, which the diff
 * screen makes the person confirm; the worker's own approved test file is not flagged.
 */
async function toReview(id: string, options: { testFile?: string; flagged?: boolean } = {}): Promise<{ worktree: string; head: string }> {
  const d = (await post(`/tasks/${id}/dispatch`, { model: "claude-sonnet" })).body.result;
  const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
  const { agent } = (await call({ tool: "hello", args: { name: `Worker ${id}` } })) as { agent: string };
  const slug = id.toLowerCase();
  const testFile = options.testFile ?? `check-${slug}.mjs`;
  write(d.worktree, testFile, `import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/${slug}.js") ? 0 : 1);\n`);
  git(d.worktree, "add", "-A");
  git(d.worktree, "commit", "-q", "-m", `Test for ${id}`);
  await call({ tool: "propose_test", args: { task: id, command: `node ${testFile}`, files: [testFile] }, agent });
  const proposed = (await view()).tasks.find((t) => t.id === id).test.entry;
  expect((await post(`/tasks/${id}/approve-test`, { test: proposed })).body.result).toMatchObject({ failsFirst: true });
  await call({ tool: "claim_task", args: { task: id }, agent });
  write(d.worktree, `src/${slug}.js`, `export const ${slug.replace("-", "")} = true;\n`);
  if (options.flagged) write(d.worktree, "package.json", '{ "name": "notes", "scripts": { "postinstall": "node setup.js" } }\n');
  git(d.worktree, "add", "-A");
  git(d.worktree, "commit", "-q", "-m", `Build ${id}`);
  const head = git(d.worktree, "rev-parse", "HEAD");
  await call({ tool: "attach_proof", args: { task: id, kind: "commit", link: head }, agent });
  expect((await post(`/tasks/${id}/check`)).body.result).toMatchObject({ passed: true, commit: head });
  return { worktree: d.worktree, head };
}

const stageOf = async (id: string) => (await view()).tasks.find((t) => t.id === id).stage;

describe("worker limit and Start all", () => {
  it("saves a limit between 1 and 8, refuses anything else, and refuses a forged call", async () => {
    addTask("Save notes");
    expect((await view()).settings).toEqual({ limit: 3, autoMerge: false });
    expect((await post("/tasks/settings", { limit: 2, autoMerge: true })).status).toBe(200);
    expect((await view()).settings).toEqual({ limit: 2, autoMerge: true });
    for (const bad of [0, 9, 1.5, "3", null]) expect((await post("/tasks/settings", { limit: bad })).status, String(bad)).toBe(400);
    expect((await post("/tasks/settings", { autoMerge: "yes" })).status).toBe(400);
    expect((await view()).settings).toEqual({ limit: 2, autoMerge: true });
    const forged = await hostCall(ctx.base, "POST", `/tasks/settings${q}`, { limit: 8 }, { asAgent: true });
    expect(forged.status).toBe(401);
    expect((await view()).settings.limit).toBe(2);
  });

  it("starts workers up to the limit, queues the rest with the reason, never starts a task waiting on another, and a second press starts nobody", async () => {
    addTask("One");
    addTask("Two");
    addTask("Three");
    addTask("Needs one", { dependsOn: ["T-1"] });
    await post("/tasks/settings", { limit: 2 });
    const before = await view();
    expect(before.queue.notStarted.map((t: any) => [t.id, t.why])).toEqual([
      ["T-1", "Can start now."],
      ["T-2", "Can start now."],
      ["T-3", "Waiting for a free worker (limit 2)."],
      ["T-4", expect.stringContaining("cannot start yet")],
    ]);
    const res = await post("/tasks/start-all", { model: "claude-sonnet" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.started.map((d: any) => d.task)).toEqual(["T-1", "T-2"]);
    expect(res.body.result.started[0]).not.toHaveProperty("token");
    const after = await view();
    expect(after.queue.running).toEqual(["T-1", "T-2"]);
    expect(after.queue.notStarted.map((t: any) => t.id)).toEqual(["T-3", "T-4"]);
    expect(after.tasks.find((t) => t.id === "T-3").worktree).toBeNull();
    expect(after.tasks.find((t) => t.id === "T-4").worktree).toBeNull();
    const again = await post("/tasks/start-all", {});
    expect(again.body.result.started).toEqual([]);
    expect(fs.readdirSync(path.join(repo, ".perfect-planner")).filter((f) => f.includes("T-3"))).toEqual([]);
  }, 60_000);
});

describe("batch approve and merge", () => {
  it("merges the clean tasks one after another and leaves the one with a flagged file alone", async () => {
    addTask("One");
    addTask("Two");
    addTask("Flagged");
    const one = await toReview("T-1");
    const two = await toReview("T-2");
    const three = await toReview("T-3", { testFile: "tests/t-3.check.mjs", flagged: true });
    expect(await stageOf("T-1")).toBe("review-diff");
    const diff = (await hostCall(ctx.base, "GET", `/tasks/T-3/diff${q}`)).body.result;
    expect(diff.sensitive).toEqual(["package.json"]);
    expect(diff.files).toContain("tests/t-3.check.mjs");
    const res = await post("/tasks/batch", { items: [{ id: "T-1", commit: one.head }, { id: "T-2", commit: two.head }, { id: "T-3", commit: three.head }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.results.map((r: any) => [r.id, r.outcome])).toEqual([["T-1", "merged"], ["T-2", "merged"], ["T-3", "skipped"]]);
    expect(res.body.result.results[2].message).toContain("package.json");
    expect(git(repo, "show", "main:src/t-1.js")).toContain("true");
    expect(git(repo, "show", "main:src/t-2.js")).toContain("true");
    expect(() => git(repo, "show", "main:src/t-3.js")).toThrow();
    expect(await stageOf("T-3")).toBe("review-diff");
    const types = ctx.host.project("loop").entries().filter((e: any) => e.subject === "T-3").map((e: any) => e.type);
    expect(types).not.toContain("review.verdict");
    expect(types).not.toContain("merge.done");
  }, 90_000);

  it("skips a task whose work moved after the screen loaded, and one failing merge does not stop the next", async () => {
    addTask("Moved");
    addTask("Breaks on merge");
    addTask("Fine");
    const moved = await toReview("T-1");
    // Passes in the worktree, fails once merged: main gains a file the test refuses.
    const broken = await toReview("T-2");
    const fine = await toReview("T-3");
    write(moved.worktree, "src/extra.js", "export const extra = 1;\n");
    git(moved.worktree, "add", "-A");
    git(moved.worktree, "commit", "-q", "-m", "More");
    write(repo, "src/t-2.js", "// main already has this file\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Conflicting change on main");
    const res = await post("/tasks/batch", { items: [{ id: "T-1", commit: moved.head }, { id: "T-2", commit: broken.head }, { id: "T-3", commit: fine.head }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [a, b, c] = res.body.result.results;
    expect(a).toMatchObject({ id: "T-1", outcome: "skipped", message: expect.stringContaining("changed since the screen loaded") });
    expect(b).toMatchObject({ id: "T-2", outcome: "failed" });
    expect(c).toMatchObject({ id: "T-3", outcome: "merged" });
    expect(await stageOf("T-1")).not.toBe("done");
    expect(() => git(repo, "show", "main:src/t-1.js")).toThrow();
    expect(ctx.host.project("loop").entries().some((e: any) => e.subject === "T-1" && e.type === "merge.done")).toBe(false);
    expect(git(repo, "show", "main:src/t-3.js")).toContain("true");
  }, 90_000);

  it("refuses an empty batch, an oversized one and a forged call", async () => {
    expect((await post("/tasks/batch", { items: [] })).status).toBe(400);
    expect((await post("/tasks/batch", { items: Array.from({ length: 51 }, () => ({ id: "T-1" })) })).status).toBe(400);
    expect((await hostCall(ctx.base, "POST", `/tasks/batch${q}`, { items: [{ id: "T-1" }] }, { asAgent: true })).status).toBe(401);
  });
});

describe("the auto-merge switch", () => {
  it("off: approving leaves the task ready to merge. On: a clean diff merges at once, a flagged one still needs its confirmation and stops at ready to merge", async () => {
    addTask("Clean");
    addTask("Clean too");
    addTask("Flagged");
    const clean = await toReview("T-1");
    const cleanToo = await toReview("T-2");
    const flagged = await toReview("T-3", { testFile: "tests/t-3.check.mjs", flagged: true });
    const off = await post("/tasks/T-1/approve-diff", { commit: clean.head });
    expect(off.body.result.approved).toBe(true);
    expect(await stageOf("T-1")).toBe("ready-to-merge");
    await post("/tasks/settings", { autoMerge: true });
    const on = await post("/tasks/T-2/approve-diff", { commit: cleanToo.head });
    expect(on.body.result).toMatchObject({ approved: true, merged: true, into: "main" });
    expect(await stageOf("T-2")).toBe("done");
    expect((await post("/tasks/T-3/approve-diff", { commit: flagged.head })).body.code).toBe("CONFIRM_SENSITIVE");
    const diff = (await hostCall(ctx.base, "GET", `/tasks/T-3/diff${q}`)).body.result;
    const confirmed = await post("/tasks/T-3/approve-diff", { commit: flagged.head, confirmSensitive: diff.sensitive });
    expect(confirmed.body.result).toMatchObject({ approved: true, clean: false });
    expect(confirmed.body.result).not.toHaveProperty("merged");
    expect(await stageOf("T-3")).toBe("ready-to-merge");
  }, 90_000);
});
