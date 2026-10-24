// The Cost panel's data: usage the worker reports over the bridge, the person's prices, and who may set them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeCall } from "../../mcp/index";
import { appendNumbered } from "../../numbering/index";
import { asPersonRequest } from "../keys";
import { hostCall, startTestHost } from "../testing";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
let repo: string;
let ctx: Awaited<ReturnType<typeof startTestHost>>;
const q = "?project=loop";

beforeEach(async () => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-cost-")));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "o"], ["config", "user.email", "o@e.invalid"]]) execFileSync("git", args, { cwd: repo, env: ENV });
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".perfect-planner/\n");
  execFileSync("git", ["add", "-A"], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: repo, env: ENV });
  ctx = await startTestHost({ projectRootOverride: repo });
  asPersonRequest(() => appendNumbered(ctx.host.project("loop").ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Save", data: { title: "Save" } }));
});
afterEach(async () => {
  await ctx.stop();
  fs.rmSync(repo, { recursive: true, force: true });
});

const get = () => hostCall(ctx.base, "GET", `/cost${q}`);
const prices = (body: unknown, asAgent = false) => hostCall(ctx.base, "POST", `/cost/prices${q}`, body, { asAgent });

describe("cost routes", () => {
  it("starts empty, takes a worker's usage, and turns tokens into dollars only with the person's price", async () => {
    expect((await get()).body.result).toMatchObject({ project: { calls: 0, usd: 0 }, byTask: [], prices: {}, ignored: 0 });
    const d = (await hostCall(ctx.base, "POST", `/tasks/T-1/dispatch${q}`, { model: "claude-x" })).body.result;
    const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
    const hello = (await call({ tool: "hello", args: { name: "W", model: "claude-x" } })) as { agent: string };
    execFileSync("git", ["-C", d.worktree, "commit", "-q", "--allow-empty", "-m", "t"], { env: ENV });
    await call({ tool: "propose_test", args: { task: "T-1", command: "node nope.js", files: ["README.md"] }, agent: hello.agent });
    const entry = (await hostCall(ctx.base, "GET", `/tasks${q}`)).body.result.tasks[0].test.entry;
    expect((await hostCall(ctx.base, "POST", `/tasks/T-1/approve-test${q}`, { test: entry })).status).toBe(200);
    await call({ tool: "claim_task", args: { task: "T-1" }, agent: hello.agent });
    await call({ tool: "report_progress", args: { task: "T-1", text: "one", usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 } }, agent: hello.agent });
    const noPrice = (await get()).body.result;
    expect(noPrice.project).toMatchObject({ usd: 0, unpricedTokens: 3_000_000, calls: 1 });
    expect(noPrice.byTask[0]).toMatchObject({ key: "T-1", repo: "main" });
    const priced = await prices({ "claude-x": { inputPerMillion: 3, outputPerMillion: 15 } });
    expect(priced.status, JSON.stringify(priced.body)).toBe(200);
    expect(priced.body.result.project).toMatchObject({ estimatedUsd: 21, reportedUsd: 0, measuredUsd: 0, usd: 21, unpricedTokens: 0 });
    expect(priced.body.result.prices).toEqual({ "claude-x": { inputPerMillion: 3, outputPerMillion: 15 } });
    // The setting survives a read, and a bad body changes nothing.
    expect((await prices({ "claude-x": { inputPerMillion: -1, outputPerMillion: 1 } })).status).toBe(400);
    expect((await get()).body.result.prices).toEqual({ "claude-x": { inputPerMillion: 3, outputPerMillion: 15 } });
  }, 60_000);

  it("only the person's window may set prices", async () => {
    expect((await prices({}, true)).status).toBeGreaterThanOrEqual(401);
    expect(fs.existsSync(path.join(repo, ".perfect-planner", "prices.json"))).toBe(false);
  });
});
