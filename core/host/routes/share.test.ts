import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCall, startTestHost } from "../testing";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
const q = "?project=loop";
let repo: string;
let ctx: Awaited<ReturnType<typeof startTestHost>>;
const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: ENV, encoding: "utf8" }).trim();

beforeEach(async () => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-share-")));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "o"], ["config", "user.email", "o@e.invalid"]]) g(...args);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".perfect-planner/\n");
  g("add", "-A");
  g("commit", "-q", "-m", "i");
  ctx = await startTestHost({ projectRootOverride: repo });
});
afterEach(async () => {
  await ctx.stop();
  fs.rmSync(repo, { recursive: true, force: true });
});

const call = (method: "GET" | "POST", route: string, body?: unknown, asAgent = false) => hostCall(ctx.base, method, `${route}${q}`, body, { asAgent });

describe("share routes", () => {
  it("lists branches, exports to the outbox, imports from the inbox, and checks the merge", async () => {
    g("checkout", "-q", "-b", "pp/T-1");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-q", "-m", "work");
    g("checkout", "-q", "main");
    expect((await call("GET", "/share")).body.result).toMatchObject({ branches: ["pp/T-1"], outbox: [], inbox: [], received: [] });

    const exp = await call("POST", "/share/export", { name: "to-ben", branches: ["pp/T-1"] });
    expect(exp.status).toBe(200);
    const out = path.join(repo, ".perfect-planner", "share", "outbox", "to-ben.ppb");
    expect(fs.existsSync(out)).toBe(true);

    fs.copyFileSync(out, path.join(repo, ".perfect-planner", "share", "inbox", "from-ana.ppb"));
    const imp = await call("POST", "/share/import", { file: "from-ana.ppb" });
    expect(imp.status).toBe(200);
    const sender = imp.body.result.sender as string;
    expect(imp.body.result.refs["pp/T-1"]).toBe(`refs/pp-inbox/${sender}/pp/T-1`);
    expect(g("branch", "--list", "pp/*")).toContain("pp/T-1"); // own branch untouched

    expect((await call("POST", "/share/check", { sender, branch: "pp/T-1" })).body.result).toMatchObject({ clean: true });
  }, 60_000);

  it("never takes a path, and only the person may use it", async () => {
    expect((await call("POST", "/share/export", { name: "../evil", branches: ["pp/T-1"] })).status).toBe(400);
    expect((await call("POST", "/share/import", { file: "../../x.ppb" })).status).toBe(400);
    expect((await call("POST", "/share/export", { name: "x", branches: ["main"] })).status).toBe(400);
    expect((await call("POST", "/share/import", { file: "gone.ppb" })).status).toBe(404);
    expect((await call("POST", "/share/export", { name: "x", branches: ["pp/T-1"] }, true)).status).toBeGreaterThanOrEqual(401);
  }, 60_000);

  it("refuses a damaged bundle with a plain message", async () => {
    await call("GET", "/share"); // makes the folders
    fs.writeFileSync(path.join(repo, ".perfect-planner", "share", "inbox", "bad.ppb"), "nonsense");
    const r = await call("POST", "/share/import", { file: "bad.ppb" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/not a Perfect Planner bundle/);
  }, 60_000);
});
