// The gate's approveDiff (as Jev or a person) and approveMerge sign for any in-process caller
// (core/gate README). This proves no agent can reach them: no MCP tool or agent route calls them,
// the only caller is the Tasks route, and that route needs the person's claimed window session.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeCall, TOOL_NAMES } from "../mcp/index";
import { appendNumbered } from "../numbering/index";
import { asPersonRequest } from "./keys";
import { hostCall, startTestHost } from "./testing";

const CORE = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const file = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : sources(file);
    return /\.(ts|mjs|js)$/.test(d.name) && !/\.test\.|testing\.ts$/.test(d.name) ? [file] : [];
  });
}

describe("who can approve a diff or a merge", () => {
  it("only the gate itself and the person's Tasks route call approveDiff or approveMerge", () => {
    const callers = sources(CORE)
      .filter((file) => /\.(approveDiff|approveMerge)\s*\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(CORE, file).split(path.sep).join("/"))
      .sort();
    expect(callers).toEqual(["host/routes/tasks.ts"]);
    const mcp = sources(path.join(CORE, "mcp")).map((file) => fs.readFileSync(file, "utf8")).join("\n");
    expect(mcp).not.toMatch(/approveDiff|approveMerge|approve-diff|\/merge\b/);
    expect(TOOL_NAMES.filter((name) => /approve|merge/i.test(name))).toEqual([]);
  });
});

describe("over HTTP and the agent bridge", () => {
  let repo: string;
  let ctx: Awaited<ReturnType<typeof startTestHost>>;
  const q = "?project=reach";
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeEach(async () => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-reach-")));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "Initial");
    ctx = await startTestHost({ projectRootOverride: repo });
    asPersonRequest(() => appendNumbered(ctx.host.project("reach").ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Save notes", data: { title: "Save notes" } }));
  });
  afterEach(async () => {
    await ctx.stop();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("an agent's token, or no session, gets 401 on approve-diff and merge and writes nothing", async () => {
    const d = (await hostCall(ctx.base, "POST", `/tasks/T-1/dispatch${q}`, {})).body.result;
    const token = fs.readFileSync(d.tokenFile, "utf8");
    const commit = "a".repeat(40);
    for (const route of ["approve-diff", "merge"]) {
      const bare = await hostCall(ctx.base, "POST", `/tasks/T-1/${route}${q}`, { commit }, { asAgent: true });
      expect(bare.status, route).toBe(401);
      const withToken = await fetch(`${ctx.base}/tasks/T-1/${route}${q}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: ctx.base.replace(/\/api\/core$/, "") }, body: JSON.stringify({ commit }) });
      expect(withToken.status, route).toBe(401);
    }
    expect(ctx.host.project("reach").entries().filter((e) => e.type === "review.verdict")).toEqual([]);
  });

  it("only the person's window can release a worker's claim: an agent token or no session gets 401 and writes nothing", async () => {
    const d = (await hostCall(ctx.base, "POST", `/tasks/T-1/dispatch${q}`, {})).body.result;
    const token = fs.readFileSync(d.tokenFile, "utf8");
    const before = ctx.host.project("reach").entries().length;
    const bare = await hostCall(ctx.base, "POST", `/tasks/T-1/release${q}`, { reason: "x" }, { asAgent: true });
    expect(bare.status).toBe(401);
    const withToken = await fetch(`${ctx.base}/tasks/T-1/release${q}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: ctx.base.replace(/\/api\/core$/, "") }, body: JSON.stringify({ reason: "x" }) });
    expect(withToken.status).toBe(401);
    expect(ctx.host.project("reach").entries().length).toBe(before);
    // The token was not revoked by the refused calls: the worker still works.
    expect(fs.existsSync(d.tokenFile)).toBe(true);
  });

  it("no MCP tool, whatever it is sent, writes a person's release of a claim", async () => {
    const d = (await hostCall(ctx.base, "POST", `/tasks/T-1/dispatch${q}`, {})).body.result;
    const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
    const { agent } = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
    const args = { task: "T-1", reason: "release it", released: true, by: "person", owner: "someone" };
    for (const tool of TOOL_NAMES) await call({ tool, args, agent }).catch(() => undefined);
    const personReleases = ctx.host.project("reach").entries().filter((e) => e.data?.released === true && e.actor.kind === "person");
    expect(personReleases).toEqual([]);
    // And no MCP source reaches the person's release route.
    const mcp = sources(path.join(CORE, "mcp")).map((file) => fs.readFileSync(file, "utf8")).join("\n");
    expect(mcp).not.toMatch(/\/release\b|releaseClaim/);
  });

  it("no MCP tool, whatever it is sent, writes a diff or merge approval", async () => {
    const d = (await hostCall(ctx.base, "POST", `/tasks/T-1/dispatch${q}`, {})).body.result;
    const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
    const { agent } = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
    const commit = "b".repeat(40);
    const attempts = { task: "T-1", commit, scope: "merge", verdict: "approve", kind: "jev", reviewer: { kind: "jev", id: "jev" }, evidence: ["scope:merge", "verdict:approve", `commit:${commit}`] };
    for (const tool of TOOL_NAMES) await call({ tool, args: attempts, agent }).catch(() => undefined);
    const approvals = ctx.host.project("reach").entries().filter((e) => e.type === "review.verdict" && (e.data?.scope === "diff" || e.data?.scope === "merge") && e.actor.kind !== "agent");
    expect(approvals).toEqual([]);
    const state = ctx.host.project("reach").service.gate.state("T-1");
    expect(state.diffApproval).toBeUndefined();
    expect(state.mergeApproval).toBeUndefined();
  });
});
