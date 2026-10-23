// Once a project has an owner (a roster), workers must keep working, and the owner can give tasks to people.
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
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-people-agents-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  write(repo, "README.md", "# Notes app\n");
  write(repo, ".gitignore", ".perfect-planner/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial");
  ctx = await startTestHost({ projectRootOverride: repo });
  const project = ctx.host.project("loop");
  for (const title of ["Save notes", "Load notes"]) {
    asPersonRequest(() => appendNumbered(project.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: title, data: { title } }));
  }
});
afterEach(async () => {
  await ctx.stop();
  fs.rmSync(repo, { recursive: true, force: true });
});

const post = (route: string, body: unknown = {}) => hostCall(ctx.base, "POST", `${route}${q}`, body);
const get = async (route: string) => (await hostCall(ctx.base, "GET", `${route}${q}`)).body.result;
const claimOwner = () => post("/people/claim", { name: "Dana Lee" });

async function worker(task: string) {
  const d = (await post(`/tasks/${task}/dispatch`, { model: "claude-sonnet" })).body.result;
  const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
  const hello = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
  write(d.worktree, `tests/${task}.check.mjs`, "process.exit(1);\n");
  git(d.worktree, "add", "-A");
  git(d.worktree, "commit", "-q", "-m", `Test ${task}`);
  return { d, call, agent: hello.agent };
}

describe("workers once the project has an owner", () => {
  it("a worker that checks in after the owner is on the roster is listed under them and can write", async () => {
    expect((await claimOwner()).status).toBe(200);
    const { call, agent } = await worker("T-1");
    await call({ tool: "propose_test", args: { task: "T-1", command: "node tests/T-1.check.mjs", files: ["tests/T-1.check.mjs"] }, agent });
    const people = await get("/people");
    expect(people.view.members[0].agents).toEqual([agent]);
    expect((await get("/tasks")).tasks[0]).toMatchObject({ stage: "test-proposed" });
  });

  it("a worker that checked in before the owner claimed is listed on its first refused write, and that write goes through", async () => {
    const { call, agent } = await worker("T-1");
    expect((await claimOwner()).status).toBe(200);
    expect((await get("/people")).view.members[0].agents).toEqual([]);
    await call({ tool: "propose_test", args: { task: "T-1", command: "node tests/T-1.check.mjs", files: ["tests/T-1.check.mjs"] }, agent });
    expect((await get("/people")).view.members[0].agents).toEqual([agent]);
  });

  it("an agent whose person is not on the roster stays refused, in the roster's own words", async () => {
    expect((await claimOwner()).status).toBe(200);
    const d = (await post("/tasks/T-1/dispatch", {})).body.result;
    ctx.host.project("loop").service.tokens.revoke(fs.readFileSync(d.tokenFile, "utf8").trim());
    const stranger = ctx.host.project("loop").service.tokens.issue({ role: "worker", person: "nobody", task: "T-1" });
    const call = bridgeCall(d.bridgeUrl, stranger);
    const { agent } = (await call({ tool: "hello", args: { name: "Stranger" } })) as { agent: string };
    await expect(call({ tool: "propose_test", args: { task: "T-1", command: "x", files: ["x"] }, agent })).rejects.toThrow(/not listed as anyone's agent/);
    expect((await get("/people")).view.members[0].agents).toEqual([]);
  });
});

describe("giving tasks to people", () => {
  async function team() {
    await claimOwner();
    await post("/people/members", { person: "jo", name: "Jo Park", role: "helper" });
    await post("/people/members", { person: "vi", name: "Vi Kim", role: "viewer" });
  }

  it("only the person's own window assigns, and only to a member who can work", async () => {
    await team();
    expect((await post("/people/assign", { task: "T-1", person: "jo" })).status).toBe(200);
    expect((await get("/people")).view.assignments).toEqual({ "T-1": "jo" });
    expect((await get("/tasks")).tasks.map((t: any) => [t.id, t.assignee])).toEqual([["T-1", "jo"], ["T-2", null]]);
    expect((await post("/people/assign", { task: "T-2", person: "vi" })).status).toBe(422);
    expect((await post("/people/assign", { task: "T-2", person: "ghost" })).status).toBe(422);
    expect((await post("/people/assign", { task: "T-9", person: "jo" })).status).toBe(404);
    expect((await post("/people/assign", { task: "nope", person: "jo" })).status).toBe(400);
    expect((await hostCall(ctx.base, "POST", `/people/assign${q}`, { task: "T-2", person: "jo" }, { asAgent: true })).status).toBe(401);
    // Giving it on replaces it.
    expect((await post("/people/assign", { task: "T-1", person: "dana-not-a-member" })).status).toBe(422);
    expect((await post("/people/assign", { task: "T-1", person: "owner" })).status).toBe(200);
    expect((await get("/tasks")).tasks[0].assignee).toBe("owner");
  });

  it("a worker started on a task given to Jo is Jo's, and is listed under Jo", async () => {
    await team();
    await post("/people/assign", { task: "T-1", person: "jo" });
    const { agent } = await worker("T-1");
    const members = (await get("/people")).view.members as { person: string; agents: string[] }[];
    expect(members.find((m) => m.person === "jo")!.agents).toEqual([agent]);
    expect(members.find((m) => m.person === "owner")!.agents).toEqual([]);
    expect((await get("/agents")).agents.find((a: any) => a.id === agent).person).toBe("jo");
  });

  it("removing a person hands their tasks back to nobody", async () => {
    await team();
    await post("/people/assign", { task: "T-1", person: "jo" });
    expect((await post("/people/members/jo/remove", {})).status).toBe(200);
    expect((await get("/tasks")).tasks[0].assignee).toBeNull();
  });
});
