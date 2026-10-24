// Several projects may share a git folder - also a project's extra repos: a second project gets a namespace
// of its own beside the first (core/host/repoClaim.ts) instead of being refused.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCall, startTestHost } from "../testing";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

function makeRepo(label: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `pp-claim-${label}-`)));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), `# ${label}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial");
  return dir;
}

let ctx: Awaited<ReturnType<typeof startTestHost>>;
let x: string;
let y: string;
let z: string;

beforeEach(async () => {
  ctx = await startTestHost();
  [x, y, z] = [makeRepo("x"), makeRepo("y"), makeRepo("z")];
});
afterEach(async () => {
  await ctx.stop();
  for (const dir of [x, y, z]) fs.rmSync(dir, { recursive: true, force: true });
});

const post = (project: string, route: string, body: unknown) => hostCall(ctx.base, "POST", `${route}?project=${project}`, body);

describe("a repo another project registered", () => {
  it("is shared with a second project as its own ledger (as its first repo or as an extra), and the first lets go without disturbing it", async () => {
    expect((await post("alpha", "/tasks/repo", { root: x })).status).toBe(200);
    expect((await post("alpha", "/repos", { name: "svc", root: y })).status).toBe(200);
    // alpha's first repo is x, so only repos.json says it uses y: the claim check must see that and give beta a namespace.
    const asFirst = await post("beta", "/tasks/repo", { root: y });
    expect(asFirst.status, JSON.stringify(asFirst.body)).toBe(200);
    const records = fs.readdirSync(path.join(y, ".git", "perfect-planner", "projects"));
    expect(records).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(y, ".git", "perfect-planner", "projects", records[0]!), "utf8"))).toMatchObject({ key: "beta" });
    expect((await post("beta", "/tasks/repo", { root: z })).status).toBe(200);
    expect((await post("beta", "/repos", { name: "svc", root: y })).status).toBe(200);
    // alpha stops using y: nothing changes for beta, and alpha may take it back as another ledger.
    expect((await post("alpha", "/repos/remove", { name: "svc" })).status).toBe(200);
    expect((await post("alpha", "/repos", { name: "svc", root: y })).status).toBe(200);
  }, 60_000);
});
