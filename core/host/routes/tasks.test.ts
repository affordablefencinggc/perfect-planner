// The whole loop as a person drives it from the app: dispatch a worker, approve
// its test, check the work, approve the diff and merge. The worker is a real
// agent client talking to the loopback bridge with the token dispatch issued.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeCall } from "../../mcp/index";
import { appendNumbered } from "../../numbering/index";
import { asPersonRequest } from "../keys";
import { hostCall, startTestHost } from "../testing";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

let repo: string;
let ctx: Awaited<ReturnType<typeof startTestHost>>;
const q = "?project=loop";

beforeEach(async () => {
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
  ctx = await startTestHost({ projectRootOverride: repo });
  const project = ctx.host.project("loop");
  asPersonRequest(() => appendNumbered(project.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Save notes", data: { title: "Save notes" } }));
});

afterEach(async () => {
  await ctx.stop();
  fs.rmSync(repo, { recursive: true, force: true });
});

const tasks = async () => (await hostCall(ctx.base, "GET", `/tasks${q}`)).body.result as { repo: { ok: boolean; root?: string; reason?: string }; tasks: any[] };
const post = (route: string, body: unknown = {}) => hostCall(ctx.base, "POST", `${route}${q}`, body);

describe("tasks routes", () => {
  it("lists tasks from the ledger with their gate stage, and finds the git repo", async () => {
    const view = await tasks();
    expect(view.repo).toMatchObject({ ok: true, root: repo });
    expect(view.tasks).toMatchObject([{ id: "T-1", title: "Save notes", status: "open", stage: "needs-test", worktree: null }]);
  });

  it("only the person's app window can dispatch, approve, check, approve a diff or merge", async () => {
    for (const route of ["/tasks/T-1/dispatch", "/tasks/T-1/test", "/tasks/T-1/approve-test", "/tasks/T-1/check", "/tasks/T-1/approve-diff", "/tasks/T-1/merge"]) {
      const res = await hostCall(ctx.base, "POST", `${route}${q}`, {}, { asAgent: true });
      expect(res.status, route).toBe(401);
    }
  });

  it("runs the loop: dispatch, worker proposes a failing test, person approves, worker builds, check, diff approval, merge", async () => {
    // 1. One click: a worktree, a worker token for this task only, the brief and the command.
    const dispatched = await post("/tasks/T-1/dispatch", { model: "claude-sonnet" });
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    const d = dispatched.body.result;
    expect(d).toMatchObject({ task: "T-1", branch: "pp/T-1", model: "claude-sonnet" });
    expect(d.token).toMatch(/^pp_w_/);
    expect(fs.existsSync(d.worktree)).toBe(true);
    expect(d.brief).toContain("T-1");
    expect(d.brief).toContain("propose_test");
    expect(d.setup).toContain(`PP_AGENT_TOKEN=${d.token}`);
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "needs-test", worktree: { branch: "pp/T-1" }, dispatch: { model: "claude-sonnet" } });
    expect(JSON.stringify((await tasks()))).not.toContain(d.token);

    // 2. The worker checks in over the bridge and writes the test first.
    const call = bridgeCall(d.bridgeUrl, d.token);
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

    // 3. The person approves; the app runs it and it fails on today's code, as it must.
    const approved = await post("/tasks/T-1/approve-test");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.result).toMatchObject({ approved: true, failsFirst: true });
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "ready-to-claim" });

    // 4. The worker claims, builds and attaches its commit.
    expect(await call({ tool: "claim_task", args: { task: "T-1" }, agent })).toMatchObject({ status: "claimed" });
    write(d.worktree, "src/save.js", "export const save = (note) => note;\n");
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Save notes");
    const head = git(d.worktree, "rev-parse", "HEAD");
    await call({ tool: "attach_proof", args: { task: "T-1", kind: "commit", link: head }, agent });
    expect((await tasks()).tasks[0]).toMatchObject({ status: "claimed", stage: "building", proofs: [{ kind: "commit", link: head }] });

    // 5. Merge is refused before the test passed and before the diff is approved.
    expect((await post("/tasks/T-1/merge")).status).toBe(409);
    const checked = await post("/tasks/T-1/check");
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body.result).toMatchObject({ passed: true, commit: head });
    const diff = (await hostCall(ctx.base, "GET", `/tasks/T-1/diff${q}`)).body.result;
    expect(diff.files).toEqual(["src/save.js", "tests/save.check.mjs"]);
    expect(diff.text).toContain("export const save");
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "review-diff" });
    const early = await post("/tasks/T-1/merge");
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/has not been approved/);

    // 6. The person approves the diff and merges; the gate reruns the test on the merge first.
    expect((await post("/tasks/T-1/approve-diff")).status).toBe(200);
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "ready-to-merge" });
    const merged = await post("/tasks/T-1/merge");
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(git(repo, "show", "main:src/save.js")).toContain("export const save");
    const done = (await tasks()).tasks[0];
    expect(done).toMatchObject({ status: "done", stage: "done", worktree: null });
    const types = ctx.host.project("loop").entries().map((e) => `${e.actor.kind}:${e.type}`);
    expect(types).toEqual(expect.arrayContaining(["agent:test.defined", "person:test.approved", "system:test.failed", "agent:task.claimed", "system:test.passed", "person:review.verdict", "person:merge.done", "system:task.done"]));
  }, 60_000);

  it("a person can write the test themselves, and a rejected diff goes back to the worker as the next attempt", async () => {
    const d = (await post("/tasks/T-1/dispatch", {})).body.result;
    write(d.worktree, "tests/save.check.mjs", 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/save.js") ? 0 : 1);\n');
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Test");
    const defined = await post("/tasks/T-1/test", { command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] });
    expect(defined.status, JSON.stringify(defined.body)).toBe(200);
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "test-proposed", test: { by: { kind: "person" } } });
    expect((await post("/tasks/T-1/approve-test")).body.result).toMatchObject({ failsFirst: true });
    const call = bridgeCall(d.bridgeUrl, d.token);
    const { agent } = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
    await call({ tool: "claim_task", args: { task: "T-1" }, agent });
    write(d.worktree, "src/save.js", "export const save = 1;\n");
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Save");
    expect((await post("/tasks/T-1/check")).body.result).toMatchObject({ passed: true });
    expect((await post("/tasks/T-1/reject")).status).toBe(400);
    const rejected = await post("/tasks/T-1/reject", { notes: "Use a real file store" });
    expect(rejected.body.result).toMatchObject({ reopenedAs: "T-1.a2" });
    expect((await tasks()).tasks[0]).toMatchObject({ id: "T-1", attempt: 2, label: "T-1.a2", status: "open" });
  }, 60_000);

  it("says plainly when the project folder is not a git repository", async () => {
    await ctx.stop();
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pp-tasks-plain-"));
    ctx = await startTestHost({ projectRootOverride: plain });
    const view = await tasks();
    expect(view.repo.ok).toBe(false);
    expect(view.repo.reason).toMatch(/git/);
    const res = await post("/tasks/T-1/dispatch");
    expect(res.status).toBe(409);
    fs.rmSync(plain, { recursive: true, force: true });
  });
});
