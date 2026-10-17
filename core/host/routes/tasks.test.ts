// The whole loop as a person drives it from the app: dispatch a worker, approve
// its test, check the work, approve the diff and merge. The worker is a real
// agent client talking to the loopback bridge with the token dispatch issued.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeCall } from "../../mcp/index";
import { isAuthoritative } from "../../ledger/index";
import { appendNumbered } from "../../numbering/index";
import { asPersonRequest } from "../keys";
import { hostCall, startTestHost } from "../testing";
import { icaclsPath } from "../tokenFile";
import { quoteFor, repoRefusal, workerCommands } from "./tasks";

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
    for (const route of ["/tasks/T-1/dispatch", "/tasks/T-1/test", "/tasks/T-1/approve-test", "/tasks/T-1/check", "/tasks/T-1/approve-diff", "/tasks/T-1/merge", "/tasks/T-1/release"]) {
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
    expect(d).not.toHaveProperty("token");
    const token = fs.readFileSync(d.tokenFile, "utf8");
    expect(token).toMatch(/^pp_w_/);
    if (process.platform !== "win32") expect(fs.statSync(d.tokenFile).mode & 0o077).toBe(0);
    else expect(execFileSync(icaclsPath(), [d.tokenFile], { encoding: "utf8" })).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/i);
    expect(fs.existsSync(d.worktree)).toBe(true);
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
    // The gate's own list: the proposed test file counts too, since a change there changes what is checked.
    expect(diff.sensitive).toEqual([".github/workflows/ci.yml", "package.json", "tests/save.check.mjs"]);
    expect(diff.text).toContain("export const save");
    expect((await tasks()).tasks[0]).toMatchObject({ stage: "review-diff" });
    // A program planted in the repo's config (a filter git would run on diff) is a plain refusal, never a crash.
    const planted = path.join(repo, "planted-ran");
    git(repo, "config", "filter.planted.clean", `node -e "require('fs').writeFileSync('${planted.replace(/\\/g, "/")}', '')"`);
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
    const merged = await post("/tasks/T-1/merge", { commit: head });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    // The worker is finished: its token no longer works and its token file is gone.
    expect(fs.existsSync(d.tokenFile)).toBe(false);
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

  it("says plainly when the project folder is not a git repository", async () => {
    await ctx.stop();
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pp-tasks-plain-"));
    ctx = await startTestHost({ projectRootOverride: plain });
    const view = await tasks();
    expect(view.repo.ok).toBe(false);
    expect(view.repo.reason).toMatch(/git/);
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
    const released = await post("/tasks/T-1/release", { owner: held.owner, reason: "The worker's window was closed" });
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
    const free = (await tasks()).tasks[0];
    expect(free).toMatchObject({ status: "open", owner: null, stage: "ready-to-claim", worktree: { path: d.worktree }, dispatch: null });

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
    expect(posix.setup).toBe("cd '/w/$(x)' && node '/a/connect.mjs' http://127.0.0.1:1 '/t/T-1.token'");
    expect(posix.start).toBe("claude \"$(cat '/b/`x`.md')\"");
    expect(workerCommands({ worktree: "C:\\w", bridgeUrl: "http://127.0.0.1:1", tokenFile: "C:\\t", entry: "C:\\a", briefFile: "C:\\b.md", platform: "win32" }).start).toBe("claude (Get-Content -Raw 'C:\\b.md')");
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
