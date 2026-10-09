// Jev's test review is required once Jev is set up (a key saved in Settings), and not before.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryKeyProvider } from "../jev/index";
import { bridgeCall } from "../mcp/index";
import { appendNumbered } from "../numbering/index";
import { asPersonRequest } from "./keys";
import { setDecisionJev } from "./routes/decisions";
import { hostCall, startTestHost } from "./testing";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  setDecisionJev({ keys: new MemoryKeyProvider() });
});

/** Runs the loop up to the worker's claim and returns the bridge's answer to it. */
async function claimAfterApproval(): Promise<{ refused?: string; project: ReturnType<Awaited<ReturnType<typeof startTestHost>>["host"]["project"]> }> {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-jev-policy-")));
  cleanups.push(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  write(repo, "README.md", "# Notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial");
  const ctx = await startTestHost({ projectRootOverride: repo });
  cleanups.push(() => ctx.stop());
  const q = "?project=jev";
  const post = (route: string, body: unknown = {}) => hostCall(ctx.base, "POST", `${route}${q}`, body);
  const project = ctx.host.project("jev");
  asPersonRequest(() => appendNumbered(project.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Save notes", data: { title: "Save notes" } }));
  const d = (await post("/tasks/T-1/dispatch")).body.result;
  write(d.worktree, "tests/save.check.mjs", 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/save.js") ? 0 : 1);\n');
  git(d.worktree, "add", "-A");
  git(d.worktree, "commit", "-q", "-m", "Test");
  expect((await post("/tasks/T-1/test", { command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] })).status).toBe(200);
  const entry = (await hostCall(ctx.base, "GET", `/tasks${q}`)).body.result.tasks[0].test.entry;
  expect((await post("/tasks/T-1/approve-test", { test: entry })).body.result).toMatchObject({ failsFirst: true });
  const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
  const { agent } = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
  try {
    await call({ tool: "claim_task", args: { task: "T-1" }, agent });
    return { project };
  } catch (error) {
    return { refused: (error as Error).message, project };
  }
}

describe("Jev's test review", () => {
  it("is not required while no Jev key is saved: the person's approval starts work", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider() });
    const { refused, project } = await claimAfterApproval();
    expect(project.policy.requireJevTestReview).toBe(false);
    expect(refused).toBeUndefined();
  }, 60_000);

  it("is required once a Jev key is saved: work waits for Jev, at the claim and in the gate", async () => {
    setDecisionJev({ keys: new MemoryKeyProvider("ts_live_FAKE0123456789abcdef") });
    const { refused, project } = await claimAfterApproval();
    expect(project.policy.requireJevTestReview).toBe(true);
    expect(refused).toMatch(/requires Jev's review/);
    expect(project.service.gate.canStart("T-1")).toMatchObject({ ok: false, reason: expect.stringMatching(/requires Jev's review/) });
  }, 60_000);
});
