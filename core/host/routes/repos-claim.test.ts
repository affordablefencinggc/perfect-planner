// One git folder, one project - also for a project's extra repos: a second project cannot take a repo the
// first still lists, and can once the first stopped using it.
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
  it("is refused to a second project (as its first repo or as an extra) until the first lets go", async () => {
    expect((await post("alpha", "/tasks/repo", { root: x })).status).toBe(200);
    expect((await post("alpha", "/repos", { name: "svc", root: y })).status).toBe(200);
    // alpha's first repo is x, so only repos.json says it still uses y: this is the case the claim check must see.
    const asFirst = await post("beta", "/tasks/repo", { root: y });
    expect(asFirst.status, JSON.stringify(asFirst.body)).toBe(409);
    expect(asFirst.body.code).toBe("REPO_IN_USE");
    expect(asFirst.body.message).toContain("alpha");
    expect((await post("beta", "/tasks/repo", { root: z })).status).toBe(200);
    const asExtra = await post("beta", "/repos", { name: "svc", root: y });
    expect(asExtra.body.code).toBe("REPO_IN_USE");
    // alpha stops using y: beta may have it.
    expect((await post("alpha", "/repos/remove", { name: "svc" })).status).toBe(200);
    expect((await post("beta", "/repos", { name: "svc", root: y })).status).toBe(200);
    // ... and now alpha is the one refused.
    expect((await post("alpha", "/repos", { name: "svc", root: y })).body.code).toBe("REPO_IN_USE");
  }, 60_000);
});
