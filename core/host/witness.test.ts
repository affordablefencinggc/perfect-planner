// The ledger's head copy in the app's data folder (core/host/witness.ts): a clean rollback of the
// project's ledger (an older valid copy put back, HEAD and all) is reported and stops writes.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendNumbered } from "../numbering/index";
import { asPersonRequest } from "./keys";
import { openCoreProject, pinOwnerAfterWrite, type CoreProject } from "./project";
import { hostCall, startTestHost } from "./testing";
import { witnessDir } from "./witness";

let ctx: Awaited<ReturnType<typeof startTestHost>>;
const q = "?project=witness";

beforeEach(async () => {
  ctx = await startTestHost();
});
afterEach(async () => ctx.stop());

const write = (project: CoreProject, summary: string) =>
  asPersonRequest(() => appendNumbered(project.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary, data: { title: summary } }));

const reopen = async () => {
  await ctx.host.close();
  return ctx.host.project("witness");
};

const ledgerDir = (root: string) => path.join(root, ".perfect-planner", "ledger");

/** Copies the ledger's files (every month file and HEAD, not the writer lock) into `to`. */
const copyLedger = (from: string, to: string) => {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (name.endsWith(".jsonl") || name === "HEAD") fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
};

const closeProject = async (project: CoreProject) => {
  await Promise.allSettled([project.ready, project.protection]);
  project.ledger.close();
};

describe("ledger head witness", () => {
  it("is kept signed in the app's data folder, never in the project folder", async () => {
    expect((await hostCall(ctx.base, "POST", `/people/claim${q}`, { name: "Solo" })).status).toBe(200);
    const project = ctx.host.project("witness");
    const files = fs.readdirSync(witnessDir(ctx.dir)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const copy = JSON.parse(fs.readFileSync(path.join(witnessDir(ctx.dir), files[0]!), "utf8"));
    expect(copy).toMatchObject({ n: project.ledger.last()!.n, hash: project.ledger.last()!.hash, entries: project.entries().length, sig: { key: expect.stringMatching(/^k-/), value: expect.any(String) } });
    expect(path.relative(project.root, witnessDir(ctx.dir)).startsWith("..")).toBe(true);
  });

  it("an older valid copy of the ledger put back is reported as rolled back, and writes are refused", async () => {
    expect((await hostCall(ctx.base, "POST", `/people/claim${q}`, { name: "Solo" })).status).toBe(200);
    const project = ctx.host.project("witness");
    write(project, "First");
    const root = project.root;
    const aside = path.join(ctx.dir, "aside");
    await ctx.host.close();
    copyLedger(ledgerDir(root), aside);
    const again = ctx.host.project("witness");
    write(again, "Second");
    write(again, "Third");
    const seen = again.entries().length;
    await ctx.host.close();
    // Put the older copy back, HEAD included, so the folder alone looks consistent.
    for (const name of fs.readdirSync(ledgerDir(root))) if (name.endsWith(".jsonl")) fs.rmSync(path.join(ledgerDir(root), name));
    copyLedger(aside, ledgerDir(root));

    const rolled = ctx.host.project("witness");
    expect(rolled.entries().length).toBeLessThan(seen);
    expect(rolled.ledger.status).toMatchObject({ ok: false, problem: "truncated" });
    const status = (await hostCall(ctx.base, "GET", `/status${q}`)).body.result;
    expect(status.integrity).toMatchObject({ state: "rolled-back", writesStopped: true, reason: expect.stringMatching(/copy of the head/) });
    expect(() => write(rolled, "After rollback")).toThrow(/writes are stopped/);
    const refused = await hostCall(ctx.base, "POST", `/people/members${q}`, { person: "helper", name: "Helper" });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("CHAIN_BROKEN");
    expect(ctx.host.project("witness").entries().length).toBe(rolled.entries().length);
  });

  it("a normal reopen is not flagged", async () => {
    expect((await hostCall(ctx.base, "POST", `/people/claim${q}`, { name: "Solo" })).status).toBe(200);
    write(ctx.host.project("witness"), "First");
    const again = await reopen();
    expect(again.ledger.status.ok).toBe(true);
    expect(again.ledger.status.witnessProblem).toBeUndefined();
    expect((await hostCall(ctx.base, "GET", `/status${q}`)).body.result.integrity).toEqual({ state: "ok", writesStopped: false });
    write(again, "Second");
    const third = await reopen();
    expect(third.ledger.status.ok).toBe(true);
  });

  it("moving the project folder is not flagged", async () => {
    const before = path.join(ctx.dir, "first-place");
    const opened = openCoreProject(ctx.dir, "moving", before, ctx.host.keys);
    write(opened, "Save notes");
    pinOwnerAfterWrite(ctx.dir, opened, ctx.host.keys);
    write(opened, "More notes");
    await closeProject(opened);
    const after = path.join(ctx.dir, "renamed");
    fs.renameSync(before, after);
    const moved = openCoreProject(ctx.dir, "moving", after, ctx.host.keys);
    try {
      expect(moved.ledger.status).toMatchObject({ ok: true, writable: true });
      expect(moved.ledger.status.witnessProblem).toBeUndefined();
      expect(() => write(moved, "Still writable")).not.toThrow();
    } finally {
      await closeProject(moved);
    }
  });

  it("a head copy someone rewrote is not trusted: reported, and never overwritten", async () => {
    expect((await hostCall(ctx.base, "POST", `/people/claim${q}`, { name: "Solo" })).status).toBe(200);
    write(ctx.host.project("witness"), "First");
    await ctx.host.close();
    const file = path.join(witnessDir(ctx.dir), fs.readdirSync(witnessDir(ctx.dir)).find((f) => f.endsWith(".json"))!);
    const forged = { ...JSON.parse(fs.readFileSync(file, "utf8")), entries: 1 };
    fs.writeFileSync(file, JSON.stringify(forged));
    const again = ctx.host.project("witness");
    expect(again.ledger.status.witnessProblem).toMatch(/signature does not match/);
    expect((await hostCall(ctx.base, "GET", `/status${q}`)).body.result.integrity).toMatchObject({ state: "witness-problem" });
    write(again, "Second");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(forged);
  });
});
