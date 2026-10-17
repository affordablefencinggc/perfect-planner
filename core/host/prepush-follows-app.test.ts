// The pre-push shim names the app's Node by absolute path. An app update moves that Node, so every
// project open rewrites the shim in the workers' repository too, or pushes would fail closed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTestHost } from "./testing";

const original = process.env.PP_NODE_BINARY;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  if (original === undefined) delete process.env.PP_NODE_BINARY;
  else process.env.PP_NODE_BINARY = original;
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("the pre-push shim in the workers' repository", () => {
  it("is rewritten on every open, so it follows the app's Node after an update", async () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-shim-follows-")));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const ledgerRoot = path.join(base, "ledger");
    const repo = path.join(base, "repo");
    fs.mkdirSync(path.join(ledgerRoot, ".perfect-planner"), { recursive: true });
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "Initial");
    fs.writeFileSync(path.join(ledgerRoot, ".perfect-planner", "repo.json"), JSON.stringify({ root: repo }));
    const hook = () => fs.readFileSync(path.join(repo, ".git", "hooks", "pre-push"), "utf8");

    const open = async (node: string) => {
      process.env.PP_NODE_BINARY = node;
      const ctx = await startTestHost({ projectRootOverride: ledgerRoot });
      await ctx.host.project("app").protection;
      await ctx.stop();
    };
    const before = path.join(base, "app-1.0", "node");
    const after = path.join(base, "app-1.1", "node");
    await open(before);
    expect(hook()).toContain(`exec '${before.replace(/\\/g, "/")}' `);
    await open(after);
    expect(hook()).toContain(`exec '${after.replace(/\\/g, "/")}' `);
    expect(hook()).not.toContain("app-1.0");
  }, 60_000);
});
