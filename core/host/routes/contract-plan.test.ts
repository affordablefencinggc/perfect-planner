// Plan approval and the contracts: the plan the person approves carries a contract for every task, the
// approval signs them, a task that cannot be kept small is flagged and never approved silently, and a repo
// that changes after approval does not make the approved plan look changed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendNumbered } from "../../numbering/index";
import { contractDigest, contractOf } from "../../planning/index";
import { asPersonRequest } from "../keys";
import { hostCall, startTestHost } from "../testing";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

const IDEA = "Desktop invoice app with Stripe payments that works offline";
const P = "?project=plan";
const SCAN_KEY = "contract.repoScan";

let repo: string;
let ctx: Awaited<ReturnType<typeof startTestHost>>;
const project = () => ctx.host.project("plan");
const get = async (route: string) => (await hostCall(ctx.base, "GET", `${route}${P}`)).body.result;
const post = (route: string, body: unknown = {}) => hostCall(ctx.base, "POST", `${route}${P}`, body);
/** The host reads the repo's file list at most every few seconds; a test that changes the repo asks for a fresh read. */
const rescan = () => project().state.delete(SCAN_KEY);

beforeEach(async () => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-contract-plan-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.invalid");
  write(repo, "README.md", "# Invoices\n");
  write(repo, ".gitignore", ".perfect-planner/\n");
  write(repo, "src/main.ts", "export {};\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial");
  ctx = await startTestHost({ projectRootOverride: repo });
});

afterEach(async () => {
  await ctx.stop();
  fs.rmSync(repo, { recursive: true, force: true });
});

async function planUntilApprovable() {
  expect((await post("/planning/start", { idea: IDEA })).status).toBe(200);
  await post("/planning/accept", {});
  let view = await get("/planning");
  for (const b of view.blockers) {
    const res = await post("/planning/answer", b.recommendation.option ? { q: b.q, choice: b.recommendation.option } : { q: b.q, text: "Decided: keep it simple" });
    expect(res.status).toBe(200);
  }
  view = await get("/planning");
  expect(view.approval.canApprove).toBe(true);
}

/** Fills the repo with files that look like part of one roadmap task, so its contract cannot stay small. */
async function crowd(extra = 8) {
  const roadmap = await get("/planning/roadmap");
  const map = (await get("/planning/mindmap")).map;
  const task = roadmap.phases.flatMap((p: any) => p.tasks).find((t: any) => !t.own && t.key !== "K-first-release" && map.nodes[t.node]);
  expect(task, "a build task in the draft roadmap").toBeTruthy();
  const slug = String(map.nodes[task.node].label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (let i = 0; i < extra; i += 1) write(repo, `src/${slug}/part${i}.ts`, `export const part${i} = ${i};\n`);
  rescan();
  return { key: task.key as string, title: task.title as string, slug };
}

describe("plan approval signs the contracts", () => {
  it("drafts a contract for every task, from the repo's files and the task's words", async () => {
    await planUntilApprovable();
    const roadmap = await get("/planning/roadmap");
    const tasks = roadmap.phases.flatMap((p: any) => p.tasks).filter((t: any) => !t.own);
    expect(tasks.length).toBeGreaterThan(2);
    for (const t of tasks) {
      expect(t.contract.allowedFiles.length, t.key).toBeGreaterThan(0);
      expect(t.contract.clauses.length, t.key).toBeGreaterThan(0);
      expect(t.contract.sizeCap).toEqual({ maxFiles: 5, maxLines: 150 });
      expect(t.contract.doneWhen.length).toBeGreaterThan(5);
      expect(t.contractFlags).toEqual([]);
    }
    expect(tasks.at(-1).contract.allowedFiles).toEqual(["CHANGELOG.md", "docs/release/**"]);
    expect((await get("/planning")).contracts).toMatchObject({ written: false, flagged: [] });
  });

  it("flags a task that cannot be kept small, and will not approve it silently", async () => {
    await planUntilApprovable();
    const { key, title, slug } = await crowd(8);
    const view = await get("/planning");
    const flagged = view.contracts.flagged.find((f: any) => f.key === key);
    expect(flagged, JSON.stringify(view.contracts)).toBeTruthy();
    expect(flagged.flags[0]).toMatchObject({ code: "TOO_MANY_FILES", message: expect.stringMatching(/8 files in your repo look like part of this task.*Split this task/) });
    expect(view.approval.flagged.map((f: any) => f.key)).toContain(key);
    expect(view.approval.canApprove).toBe(true);

    // 1. Nothing is accepted by saying nothing, or by naming some other task.
    const silent = await post("/planning/approve", { fingerprint: view.fingerprint });
    expect(silent.status).toBe(409);
    expect(silent.body).toMatchObject({ code: "CONTRACT_FLAGGED", message: expect.stringContaining(`"${title}"`) });
    expect((await post("/planning/approve", { fingerprint: view.fingerprint, acceptFlagged: ["K-somewhere-else"] })).body.code).toBe("CONTRACT_FLAGGED");
    expect((await post("/planning/approve", { fingerprint: view.fingerprint, acceptFlagged: "yes" })).body.code).toBe("INVALID");
    expect(project().entries().some((e) => e.type === "plan.approved")).toBe(false);
    expect(project().entries().some((e) => e.type === "task.created")).toBe(false);

    // 2. A repo that changed what they were shown (9 files now, not 8) is a changed plan: the old fingerprint is stale.
    write(repo, `src/${slug}/part8.ts`, "export {};\n");
    rescan();
    const old = await post("/planning/approve", { fingerprint: view.fingerprint, acceptFlagged: view.approval.flagged.map((f: any) => f.key) });
    expect(old.status).toBe(409);
    expect(old.body.code).toBe("STALE");

    // 3. With a fresh look and the person's own tick for each flagged task, it is approved, and the approval signs the contracts.
    const fresh = await get("/planning");
    const accept = fresh.approval.flagged.map((f: any) => f.key);
    expect(accept).toContain(key);
    const ok = await post("/planning/approve", { fingerprint: fresh.fingerprint, acceptFlagged: accept });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const approval = project().entries().find((e) => e.type === "plan.approved")!;
    expect(approval.actor.kind).toBe("person");
    const signed = (approval.data as any).contracts as { digest: string; tasks: Record<string, string>; accepted: string[] };
    expect(signed.accepted).toEqual([...accept].sort());
    const created = project().entries().filter((e) => e.type === "task.created");
    expect(created.length).toBe(Object.keys(signed.tasks).length);
    for (const e of created) {
      expect(signed.tasks[(e.data as any).key]).toBe((e.data as any).contractDigest);
      expect(contractDigest((e.data as any).contract)).toBe((e.data as any).contractDigest);
    }

    // The board shows each contract as signed by this approval, and which flagged ones the person accepted.
    const board = (await hostCall(ctx.base, "GET", `/tasks${P}`)).body.result.tasks as any[];
    const taskNumber = ok.body.result.tasks[key] as string;
    const card = board.find((t) => t.id === taskNumber);
    expect(card.contract).toMatchObject({ status: "signed", plan: "P-1", flagsAccepted: true });
    expect(card.contract.flags[0]).toMatch(/Split this task/);
    expect(board.filter((t) => t.id !== taskNumber).every((t) => t.contract.status === "signed" && t.contract.flagsAccepted === false)).toBe(true);
  }, 60_000);

  it("an approved plan does not look changed when the repo changes afterwards, and shows the signed contracts", async () => {
    await planUntilApprovable();
    const view = await get("/planning");
    const ok = await post("/planning/approve", { fingerprint: view.fingerprint });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.result.plan).toBe("P-1");
    const before = await get("/planning/roadmap");
    // Workers merge, files appear: the plan the person approved is still the approved plan.
    for (let i = 0; i < 12; i += 1) write(repo, `src/new-area/file${i}.ts`, "export {};\n");
    write(repo, "src/billing/billing.ts", "export {};\n");
    rescan();
    const after = await get("/planning");
    expect(after.approval).toMatchObject({ current: true, canApprove: false, flagged: [] });
    expect(after.contracts.written).toBe(true);
    const roadmap = await get("/planning/roadmap");
    const written = roadmap.phases.flatMap((p: any) => p.tasks).filter((t: any) => t.task && !t.own);
    expect(written.length).toBeGreaterThan(2);
    for (const t of written) {
      expect(t.contractState).toMatchObject({ status: "signed", widened: 0 });
      const wasThen = before.phases.flatMap((p: any) => p.tasks).find((x: any) => x.key === t.key);
      expect(t.contract).toEqual(wasThen.contract);
    }
  }, 60_000);

  it("a task from planning is dispatched with the signed contract's files as its claims", async () => {
    await planUntilApprovable();
    const view = await get("/planning");
    const ok = await post("/planning/approve", { fingerprint: view.fingerprint });
    expect(ok.status).toBe(200);
    // The closing task waits for every other task, so the first task with nothing to wait for is the one to start.
    const roadmap = await get("/planning/roadmap");
    const first = roadmap.phases.flatMap((p: any) => p.tasks).find((t: any) => t.task && !t.own && t.dependsOn.length === 0);
    const releaseTask = first.task as string;
    const files = first.contract.allowedFiles as string[];
    const dispatched = await hostCall(ctx.base, "POST", `/tasks/${releaseTask}/dispatch${P}`, {});
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(dispatched.body.result.brief).toContain(`You may change only: ${files.join(", ")}`);
    const created = project().entries().find((e) => e.type === "worktree.created" && e.subject === releaseTask)!;
    expect(created.data).toMatchObject({ claims: files });
    const view2 = contractOf(project().entries(), releaseTask)!;
    expect(view2).toMatchObject({ status: "signed", plan: "P-1" });
  }, 60_000);

  it("planning refuses a roadmap task written without its contract, from anyone", async () => {
    await planUntilApprovable();
    const person = { kind: "person" as const, id: "owner" };
    expect(() => asPersonRequest(() => appendNumbered(project().ledger, { actor: person, type: "task.created", summary: "Sneaky task", data: { source: "planning", key: "K-sneaky" } }))).toThrow(/no usable contract/);
    expect(() => asPersonRequest(() => appendNumbered(project().ledger, { actor: person, type: "task.created", summary: "Sneaky task", data: { source: "planning", key: "K-sneaky", contract: { clauses: ["x"], allowedFiles: ["**"], doneWhen: "y", sizeCap: { maxFiles: 50, maxLines: 2000 } }, contractDigest: "nope" } }))).toThrow(/does not match its digest/);
    expect(project().entries().some((e) => e.type === "task.created")).toBe(false);
  });
});
