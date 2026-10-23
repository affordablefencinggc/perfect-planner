// Several git repos in one project: adding a repo, a task per repo with its own worktree and merge, one plan
// task split over two repos and merged together, and what happens when a repo goes away.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeCall } from "../../mcp/index";
import { appendNumbered } from "../../numbering/index";
import { asPersonRequest } from "../keys";
import { forgeEntry, hostCall, startTestHost } from "../testing";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

function makeRepo(label: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `pp-multi-${label}-`)));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "user.name", "Owner");
  git(dir, "config", "user.email", "owner@example.invalid");
  write(dir, "README.md", `# ${label}\n`);
  write(dir, ".gitignore", ".perfect-planner/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial");
  return dir;
}

let api: string;
let web: string;
let ctx: Awaited<ReturnType<typeof startTestHost>>;
const q = "?project=loop";
const dirs: string[] = [];

beforeEach(async () => {
  api = makeRepo("api");
  web = makeRepo("web");
  dirs.push(api, web);
  ctx = await startTestHost({ projectRootOverride: api });
});

afterEach(async () => {
  await ctx.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const get = (route: string) => hostCall(ctx.base, "GET", `${route}${q}`);
const post = (route: string, body: unknown = {}) => hostCall(ctx.base, "POST", `${route}${q}`, body);
const view = async () => (await get("/tasks")).body.result as { repo: any; repos: any[]; tasks: any[]; groups: any[] };
const addWeb = async () => {
  const added = await post("/repos", { name: "web", root: web });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
};
const createTask = (title: string, data: Record<string, unknown> = {}) =>
  asPersonRequest(() => appendNumbered(ctx.host.project("loop").ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: title, data: { title, ...data } })).subject;

/** Drives one task to "ready to merge" the way a worker and the person would; returns the commit to merge. */
async function ready(id: string, file: string, options: { repoDir: string; testFails?: boolean }): Promise<string> {
  const d = (await post(`/tasks/${id}/dispatch`, { model: "claude-sonnet" })).body.result;
  const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
  const hello = (await call({ tool: "hello", args: { name: `Worker ${id}` } })) as { agent: string };
  write(d.worktree, `tests/${id}.check.mjs`, `import { existsSync } from "node:fs";\nif (!existsSync("${file}")) process.exit(1);\n`);
  git(d.worktree, "add", "-A");
  git(d.worktree, "commit", "-q", "-m", `Test for ${id}`);
  await call({ tool: "propose_test", args: { task: id, command: `node tests/${id}.check.mjs`, files: [`tests/${id}.check.mjs`] }, agent: hello.agent });
  const proposed = (await view()).tasks.find((t) => t.id === id).test.entry;
  expect((await post(`/tasks/${id}/approve-test`, { test: proposed })).status).toBe(200);
  await call({ tool: "claim_task", args: { task: id }, agent: hello.agent });
  write(d.worktree, file, `// ${id}\n`);
  git(d.worktree, "add", "-A");
  git(d.worktree, "commit", "-q", "-m", `Build ${id}`);
  const head = git(d.worktree, "rev-parse", "HEAD");
  await call({ tool: "attach_proof", args: { task: id, kind: "commit", link: head }, agent: hello.agent });
  expect((await post(`/tasks/${id}/check`)).body.result.passed).toBe(true);
  // The test file is among the files the gate wants the person to confirm they read.
  const diff = (await get(`/tasks/${id}/diff`)).body.result;
  const approved = await post(`/tasks/${id}/approve-diff`, { commit: head, confirmSensitive: diff.sensitive });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect(options.repoDir).toBeTruthy();
  return head;
}

describe("adding a repo", () => {
  it("lists the first repo as main, then the added one, each usable", async () => {
    const before = await view();
    expect(before.repos).toMatchObject([{ name: "main", ok: true, root: api, worktrees: 0 }]);
    await addWeb();
    const after = await view();
    expect(after.repos).toMatchObject([{ name: "main", ok: true }, { name: "web", ok: true, root: web, worktrees: 0 }]);
    expect(JSON.parse(fs.readFileSync(path.join(api, ".perfect-planner", "repos.json"), "utf8")).repos).toMatchObject([{ name: "web", root: web }]);
    // The pre-push scan went into the new repo too.
    expect(fs.readFileSync(path.join(web, ".git", "hooks", "pre-push"), "utf8")).toContain("Perfect Planner");
  });

  it("refuses bad names, folders that are not git, the same repo twice (also through a link), and the home folder", async () => {
    for (const name of ["", "../x", "con", "main", "a".repeat(33), "Has Space", "x."]) expect((await post("/repos", { name, root: web })).status, name).toBe(400);
    expect((await post("/repos", { name: "web", root: "relative/path" })).status).toBe(400);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pp-multi-plain-"));
    dirs.push(plain);
    expect((await post("/repos", { name: "web", root: plain })).body.code).toBe("NOT_GIT");
    expect((await post("/repos", { name: "web", root: os.homedir() })).status).toBe(400);
    // The project's first repo, by its own path and from inside its private folder.
    expect((await post("/repos", { name: "again", root: api })).body.code).toBe("SAME_REPO");
    fs.mkdirSync(path.join(api, ".perfect-planner"), { recursive: true });
    expect((await post("/repos", { name: "inside", root: path.join(api, ".perfect-planner") })).body.code).toBe("SAME_REPO");
    await addWeb();
    expect((await post("/repos", { name: "web", root: web })).body.code).toBe("NAME_TAKEN");
    const link = path.join(os.tmpdir(), `pp-multi-link-${process.pid}`);
    fs.symlinkSync(web, link);
    dirs.push(link);
    expect((await post("/repos", { name: "weblink", root: link })).body.code).toBe("SAME_REPO");
    expect((await view()).repos).toHaveLength(2);
  });

  it("only the person's window may add or remove a repo", async () => {
    expect((await hostCall(ctx.base, "POST", `/repos${q}`, { name: "web", root: web }, { asAgent: true })).status).toBeGreaterThanOrEqual(401);
    expect((await hostCall(ctx.base, "POST", `/repos/remove${q}`, { name: "web" }, { asAgent: true })).status).toBeGreaterThanOrEqual(401);
  });

  it("ignores a hand-edited repos.json entry that add would refuse, and says why", async () => {
    fs.mkdirSync(path.join(api, ".perfect-planner"), { recursive: true });
    fs.writeFileSync(
      path.join(api, ".perfect-planner", "repos.json"),
      JSON.stringify({ repos: [{ name: "../evil", root: web }, { name: "net", root: "//host/share/repo" }, { name: "rel", root: "some/where" }, { name: "web", root: web }, { name: "web", root: api }] }),
    );
    const listed = (await get("/repos")).body.result;
    expect(listed.repos.map((r: any) => r.name)).toEqual(["main", "web"]);
    expect(listed.ignored.map((i: any) => i.name)).toEqual(["../evil", "net", "rel", "web"]);
  });
});

describe("a task per repo", () => {
  it("runs two tasks in two repos side by side: own worktree, branch and merge, other repo untouched", async () => {
    await addWeb();
    const t1 = createTask("API route");
    const t2 = createTask("Web page", { repo: "web" });
    expect([t1, t2]).toEqual(["T-1", "T-2"]);
    const h1 = await ready("T-1", "src/route.js", { repoDir: api });
    const h2 = await ready("T-2", "src/page.js", { repoDir: web });
    const mid = await view();
    expect(mid.tasks.map((t) => [t.id, t.repo, t.stage, t.worktree?.branch])).toEqual([["T-1", "main", "ready-to-merge", "pp/T-1"], ["T-2", "web", "ready-to-merge", "pp/T-2"]]);
    expect(mid.repos.map((r) => r.worktrees)).toEqual([1, 1]);
    expect(git(api, "branch", "--list", "pp/*")).toContain("pp/T-1");
    expect(git(api, "branch", "--list", "pp/*")).not.toContain("pp/T-2");
    expect(git(web, "branch", "--list", "pp/*")).toContain("pp/T-2");
    // The wrong repo's commit is stale, never merged into the other repo.
    expect((await post("/tasks/T-1/merge", { commit: h2 })).body.code).toBe("STALE");
    const m1 = await post("/tasks/T-1/merge", { commit: h1 });
    expect(m1.status, JSON.stringify(m1.body)).toBe(200);
    expect(git(api, "show", "main:src/route.js")).toContain("T-1");
    expect(() => git(web, "show", "main:src/route.js")).toThrow();
    const m2 = await post("/tasks/T-2/merge", { commit: h2 });
    expect(m2.status, JSON.stringify(m2.body)).toBe(200);
    expect(git(web, "show", "main:src/page.js")).toContain("T-2");
    expect(() => git(api, "show", "main:src/page.js")).toThrow();
    expect((await view()).tasks.map((t) => t.stage)).toEqual(["done", "done"]);
  }, 90_000);

  it("a task naming a repo the project does not have, or a forged one, cannot start", async () => {
    createTask("Ghost", { repo: "nowhere" });
    const dispatched = await post("/tasks/T-1/dispatch", {});
    expect(dispatched.status).toBe(409);
    expect(dispatched.body.code).toBe("REPO_MISSING");
    expect(dispatched.body.message).toContain("nowhere");
    // An unsigned task.created is not on the board at all, whatever repo it names.
    forgeEntry(ctx.host.project("loop"), { actor: { kind: "agent", id: "evil", model: "x" }, type: "task.created", subject: "T-9", summary: "Sneaky", data: { title: "Sneaky", repo: "web" } });
    expect((await view()).tasks.map((t) => t.id)).toEqual(["T-1"]);
  });

  it("a repo whose folder is gone stops only its own tasks", async () => {
    await addWeb();
    createTask("API route");
    createTask("Web page", { repo: "web" });
    const h1 = await ready("T-1", "src/route.js", { repoDir: api });
    fs.renameSync(web, `${web}-moved`);
    dirs.push(`${web}-moved`);
    const gone = await post("/tasks/T-2/dispatch", {});
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe("REPO_MISSING");
    expect(gone.body.message).toContain('"web"');
    expect(gone.body.message).toContain("other repos are not affected");
    expect((await view()).repos.map((r) => [r.name, r.ok])).toEqual([["main", true], ["web", false]]);
    expect((await post("/tasks/T-1/merge", { commit: h1 })).status).toBe(200);
  }, 60_000);

  it("removing a repo is refused while it has unfinished tasks or worktrees, and never for main", async () => {
    await addWeb();
    createTask("Web page", { repo: "web" });
    const refused = await post("/repos/remove", { name: "web" });
    expect(refused.body.code).toBe("REPO_BUSY");
    expect(refused.body.message).toContain("T-1");
    expect((await post("/repos/remove", { name: "main" })).status).toBe(400);
    expect((await post("/repos/remove", { name: "nope" })).status).toBe(404);
    const h = await ready("T-1", "src/page.js", { repoDir: web });
    expect((await post("/repos/remove", { name: "web" })).body.code).toBe("REPO_BUSY");
    expect((await post("/tasks/T-1/merge", { commit: h })).status).toBe(200);
    const removed = await post("/repos/remove", { name: "web" });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.result.repos.map((r: any) => r.name)).toEqual(["main"]);
  }, 60_000);
});

describe("one plan task over two repos", () => {
  const splitTask = async () => {
    await addWeb();
    const added = await post("/planning/tasks", { title: "Notes sync", repos: ["main", "web"] });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    return added.body.result as { task: string; tasks: string[] };
  };

  it("writes one linked task per repo, and refuses a repo the project does not have", async () => {
    const bad = await post("/planning/tasks", { title: "Notes sync", repos: ["main", "nowhere"] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("UNKNOWN_REPO");
    expect((await view()).tasks).toHaveLength(0);
    const split = await splitTask();
    expect(split.tasks).toEqual(["T-1", "T-2"]);
    const v = await view();
    expect(v.tasks.map((t) => [t.id, t.title, t.repo])).toEqual([["T-1", "Notes sync (main)", "main"], ["T-2", "Notes sync (web)", "web"]]);
    expect(v.tasks[0].group).toBe(v.tasks[1].group);
    expect(v.tasks[0].group).toMatch(/^[A-Za-z0-9._-]{1,40}$/);
    expect(v.groups).toEqual([{ group: v.tasks[0].group, tasks: ["T-1", "T-2"], ready: false, done: false }]);
    // One repo named: one plain task, no group.
    const one = await post("/planning/tasks", { title: "Docs", repos: ["web"] });
    expect(one.body.result.tasks).toBeUndefined();
    expect((await view()).tasks.find((t) => t.title === "Docs")).toMatchObject({ repo: "web", group: null });
  });

  it("merges together only when every part is ready, and says plainly when one is not", async () => {
    await splitTask();
    const h1 = await ready("T-1", "src/sync.js", { repoDir: api });
    const group = (await view()).tasks[0].group as string;
    const early = await post(`/tasks/groups/${group}/merge`, { commits: { "T-1": h1 } });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("GROUP_NOT_READY");
    expect(early.body.message).toContain("nothing in this group was merged");
    expect(() => git(api, "show", "main:src/sync.js")).toThrow();
    const h2 = await ready("T-2", "src/sync.js", { repoDir: web });
    expect((await view()).groups[0]).toMatchObject({ ready: true, done: false });
    // A stale commit for one part refuses the whole group before anything merges.
    const stale = await post(`/tasks/groups/${group}/merge`, { commits: { "T-1": h1, "T-2": "0".repeat(40) } });
    expect(stale.body.code).toBe("GROUP_NOT_READY");
    expect(() => git(api, "show", "main:src/sync.js")).toThrow();
    const both = await post(`/tasks/groups/${group}/merge`, { commits: { "T-1": h1, "T-2": h2 } });
    expect(both.status, JSON.stringify(both.body)).toBe(200);
    expect(both.body.result.merged.map((m: any) => [m.task, m.repo])).toEqual([["T-1", "main"], ["T-2", "web"]]);
    expect(git(api, "show", "main:src/sync.js")).toContain("T-1");
    expect(git(web, "show", "main:src/sync.js")).toContain("T-2");
    // Pressed again: nothing left to do, nothing broken.
    const again = await post(`/tasks/groups/${group}/merge`, { commits: { "T-1": h1, "T-2": h2 } });
    expect(again.status).toBe(200);
    expect(again.body.result.merged).toEqual([]);
    expect(again.body.result.message).toContain("already merged");
    expect((await view()).groups[0]).toMatchObject({ done: true });
    expect((await post("/tasks/groups/nope/merge", {})).status).toBe(404);
  }, 120_000);

  it("when the second repo refuses, the first stays merged and the answer names both", async () => {
    await splitTask();
    const h1 = await ready("T-1", "src/sync.js", { repoDir: api });
    const h2 = await ready("T-2", "src/sync.js", { repoDir: web });
    // Someone lands a different src/sync.js on web's main after the worker started: the merge conflicts.
    write(web, "src/sync.js", "// someone else\n");
    git(web, "add", "-A");
    git(web, "commit", "-q", "-m", "Other work on web");
    const group = (await view()).tasks[0].group as string;
    const partly = await post(`/tasks/groups/${group}/merge`, { commits: { "T-1": h1, "T-2": h2 } });
    expect(partly.status).toBe(409);
    expect(partly.body.code).toBe("GROUP_PARTLY_MERGED");
    expect(partly.body.message).toContain("Merged T-1 (main)");
    expect(partly.body.message).toContain("T-2");
    expect(partly.body.message).toContain("Git cannot undo a merge in another repo");
    expect(git(api, "show", "main:src/sync.js")).toContain("T-1");
    expect(git(web, "show", "main:src/sync.js")).toContain("someone else");
    expect((await view()).tasks.map((t) => t.stage)).toEqual(["done", "ready-to-merge"]);
  }, 120_000);

  it("two merges of one group at once: one runs, the other is told to wait", async () => {
    await splitTask();
    const h1 = await ready("T-1", "src/sync.js", { repoDir: api });
    const h2 = await ready("T-2", "src/sync.js", { repoDir: web });
    const group = (await view()).tasks[0].group as string;
    const body = { commits: { "T-1": h1, "T-2": h2 } };
    const [a, b] = await Promise.all([post(`/tasks/groups/${group}/merge`, body), post(`/tasks/groups/${group}/merge`, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.code).toBe("BUSY");
    expect((await view()).tasks.map((t) => t.stage)).toEqual(["done", "done"]);
  }, 120_000);
});
