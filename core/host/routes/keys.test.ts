// The project owner pin (core/host/owner.ts) and key rotation (POST /keys/rotate).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendNumbered } from "../../numbering/index";
import { asPersonRequest, HostKeys } from "../keys";
import { MemoryKeyProvider } from "../../ledger/index";
import { openCoreProject, pinOwnerAfterWrite } from "../project";
import { ownerPinFile } from "../owner";
import { hostCall, startTestHost } from "../testing";

let ctx: Awaited<ReturnType<typeof startTestHost>>;
const q = "?project=keys";

beforeEach(async () => {
  ctx = await startTestHost();
});
afterEach(async () => ctx.stop());

const personWrite = (summary: string) =>
  asPersonRequest(() => appendNumbered(ctx.host.project("keys").ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary, data: { title: summary } }));

/** Opens the project again from disk, as a restart would (same keys, same app data). */
const reopen = async () => {
  await ctx.host.close();
  return ctx.host.project("keys");
};

/** Closes a project opened in a test after its git work is done (Windows cannot remove a folder git is still in). */
const closeProject = async (project: { ready: Promise<unknown>; protection: Promise<unknown>; ledger: { close(): void } }) => {
  await Promise.allSettled([project.ready, project.protection]);
  project.ledger.close();
};

const genesisOf = (project: { entries(): readonly { hash: string }[] }) => project.entries()[0]!.hash;
const claim = () => hostCall(ctx.base, "POST", `/people/claim${q}`, { name: "Solo" });

describe("project owner pin", () => {
  it("is written after the person's first write, signed by the app, for the ledger's genesis", async () => {
    const project = ctx.host.project("keys");
    expect(project.owner.state).toBe("new");
    expect(project.ledger.ownerKeyPinned).toBe(true);
    expect((await claim()).status).toBe(200);
    expect(project.owner.state).toBe("pinned");
    const pin = JSON.parse(fs.readFileSync(ownerPinFile(ctx.dir, genesisOf(project)), "utf8"));
    expect(pin).toMatchObject({ genesis: genesisOf(project), principal: "person:owner", ownerKey: project.owner.ownerKey, sig: { key: expect.stringMatching(/^k-/), value: expect.any(String) } });
    expect(project.entries().find((e) => e.actor.kind === "person")!.sig?.key).toBe(project.owner.ownerKey);
    expect(project.ledger.owner).toBe("person:owner");
    // The pin is kept in the app's data folder, never in the project folder.
    expect(fs.existsSync(path.join(project.root, ".perfect-planner", "owner-pin.json"))).toBe(false);
  });

  it("is used on every later open", async () => {
    await claim();
    const created = ctx.host.project("keys").owner.ownerKey;
    const again = await reopen();
    expect(again.owner).toMatchObject({ ownerKey: created, principal: "person:owner", state: "pinned" });
    expect(again.ledger.owner).toBe("person:owner");
  });

  it("a pin someone rewrote is ignored: no owner, and status says so", async () => {
    await claim();
    const file = ownerPinFile(ctx.dir, genesisOf(ctx.host.project("keys")));
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ownerKey: "k-0000000000000000" }));
    const again = await reopen();
    expect(again.owner.state).toBe("tampered");
    expect(again.ledger.ownerKeyPinned).toBe(false);
    expect(again.ledger.owner).toBeUndefined();
    expect((await hostCall(ctx.base, "GET", `/status${q}`)).body.result.owner).toMatchObject({ state: "tampered" });
  });

  it("a pin copied from another project does not fit this one", async () => {
    await claim();
    const other = openCoreProject(ctx.dir, "other", path.join(ctx.dir, "other"), ctx.host.keys);
    asPersonRequest(() => appendNumbered(other.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Other", data: { title: "Other" } }));
    await closeProject(other);
    fs.copyFileSync(ownerPinFile(ctx.dir, genesisOf(ctx.host.project("keys"))), ownerPinFile(ctx.dir, genesisOf(other)));
    const reopened = openCoreProject(ctx.dir, "other", path.join(ctx.dir, "other"), ctx.host.keys);
    try {
      expect(reopened.owner).toMatchObject({ state: "tampered", reason: expect.stringMatching(/does not belong/) });
      expect(reopened.ledger.owner).toBeUndefined();
    } finally {
      await closeProject(reopened);
    }
  });

  it("follows the project when its folder is moved or renamed", async () => {
    const before = path.join(ctx.dir, "first-place");
    const opened = openCoreProject(ctx.dir, "moving", before, ctx.host.keys);
    asPersonRequest(() => appendNumbered(opened.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Save notes", data: { title: "Save notes" } }));
    pinOwnerAfterWrite(ctx.dir, opened, ctx.host.keys);
    expect(opened.owner.state).toBe("pinned");
    await closeProject(opened);
    const after = path.join(ctx.dir, "renamed");
    fs.renameSync(before, after);
    const moved = openCoreProject(ctx.dir, "moving", after, ctx.host.keys);
    try {
      expect(moved.owner).toMatchObject({ ownerKey: opened.owner.ownerKey, principal: "person:owner", state: "pinned" });
      expect(moved.ledger.owner).toBe("person:owner");
    } finally {
      await closeProject(moved);
    }
  });

  it("a folder whose ledger was deleted is reported as replaced, never pinned again as new", async () => {
    await claim();
    const root = ctx.host.project("keys").root;
    await ctx.host.close();
    fs.rmSync(path.join(root, ".perfect-planner"), { recursive: true, force: true });
    const again = ctx.host.project("keys");
    expect(again.owner).toMatchObject({ state: "replaced", reason: expect.stringMatching(/deleted/) });
    expect(again.ledger.ownerKeyPinned).toBe(false);
    expect((await claim()).status).not.toBe(200);
    expect(ctx.host.project("keys").owner.state).toBe("replaced");
  });

  it("after a restart that lost this device's keys, a written project says why it cannot change", async () => {
    const written = openCoreProject(ctx.dir, "written", path.join(ctx.dir, "written"), ctx.host.keys);
    asPersonRequest(() => appendNumbered(written.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Save notes", data: { title: "Save notes" } }));
    pinOwnerAfterWrite(ctx.dir, written, ctx.host.keys);
    await closeProject(written);
    const lost = openCoreProject(ctx.dir, "written", path.join(ctx.dir, "written"), new HostKeys(new MemoryKeyProvider({ autoCreate: false })));
    try {
      expect(lost.owner.state).toMatch(/^(tampered|replaced)$/);
      expect(lost.ledger.owner).toBeUndefined();
    } finally {
      await closeProject(lost);
    }
  });
});

describe("starting a new history", () => {
  const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", ...args], { cwd, encoding: "utf8" });
  const repoWithCommit = () => {
    const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-start-")));
    gitIn(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "README.md"), "# App\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "init");
    return repo;
  };

  it("refuses a new project's first write until the person starts its history, then pins on the next write", async () => {
    const repo = repoWithCommit();
    const host = await startTestHost({ projectRootOverride: repo, autoStart: false });
    try {
      const status = (await hostCall(host.base, "GET", "/status?project=s")).body.result;
      expect(status.owner).toMatchObject({ state: "new", signals: [], started: false });
      const refused = await hostCall(host.base, "POST", "/people/claim?project=s", { name: "Solo" });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("START_HISTORY");
      expect(host.host.project("s").entries()).toHaveLength(0);
      // Agents never reach it: no session, no start.
      expect((await hostCall(host.base, "POST", "/owner/start?project=s", {}, { asAgent: true })).status).toBe(401);
      expect((await hostCall(host.base, "POST", "/owner/start?project=s", {})).status).toBe(200);
      expect((await hostCall(host.base, "POST", "/people/claim?project=s", { name: "Solo" })).status).toBe(200);
      expect(host.host.project("s").owner.state).toBe("pinned");
      expect((await hostCall(host.base, "POST", "/owner/start?project=s", {})).body.code).toBe("NOT_NEW");
    } finally {
      await host.stop();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("warns when the folder's repo shows earlier Perfect Planner use, as a wiped history would", async () => {
    const repo = repoWithCommit();
    const first = await startTestHost({ projectRootOverride: repo });
    let appData: string;
    try {
      expect((await hostCall(first.base, "POST", "/people/claim?project=w", { name: "Solo" })).status).toBe(200);
      await first.host.project("w").protection;
      gitIn(repo, "branch", "pp/T-1");
      appData = first.dir;
    } finally {
      await first.host.close();
    }
    // Ledger, pin and the app's record of the folder all deleted: the app cannot tell it was pinned.
    fs.rmSync(path.join(repo, ".perfect-planner"), { recursive: true, force: true });
    fs.rmSync(path.join(appData!, "owners"), { recursive: true, force: true });
    const second = await startTestHost({ projectRootOverride: repo, autoStart: false });
    try {
      const owner = (await hostCall(second.base, "GET", "/status?project=w")).body.result.owner;
      expect(owner.state).toBe("new");
      expect(owner.signals.join(" ")).toMatch(/pre-push scan/);
      expect(owner.signals.join(" ")).toMatch(/task branch/);
      expect(owner.signals.join(" ")).toMatch(/\.perfect-planner/);
      expect((await hostCall(second.base, "POST", "/people/claim?project=w", { name: "Solo" })).body.code).toBe("START_HISTORY");
    } finally {
      await second.stop();
      await first.stop().catch(() => undefined);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("ownerKey source (CoreHostOptions.ownerKey)", () => {
  it("replaces the pin when given: a supplied key owns the project, none leaves it unowned", async () => {
    const keys = new HostKeys(new MemoryKeyProvider({ autoCreate: false }));
    const ownerKey = keys.ownerKeyFor("person:owner")!;
    const base = fs.mkdtempSync(path.join(ctx.dir, "source-"));
    const owned = openCoreProject(base, "a", undefined, keys, () => ownerKey);
    expect(owned.owner).toMatchObject({ state: "pinned", ownerKey, principal: "person:owner" });
    expect(owned.ledger.ownerKeyPinned).toBe(true);
    const unowned = openCoreProject(base, "b", undefined, keys, () => undefined);
    expect(unowned.owner.state).toBe("missing");
    expect(unowned.ledger.ownerKeyPinned).toBe(false);
    // Nothing is written to app data for a supplied owner.
    expect(fs.existsSync(path.join(base, "owners"))).toBe(false);
    for (const project of [owned, unowned]) await closeProject(project);
  });
});

describe("POST /keys/rotate", () => {
  it("rotates through the ledger: the old key vouches for the new one, then is retired; only the person can do it", async () => {
    const first = personWrite("Save notes");
    expect((await hostCall(ctx.base, "POST", `/keys/rotate${q}`, { reason: "new PC" }, { asAgent: true })).status).toBe(401);
    expect((await hostCall(ctx.base, "POST", `/keys/rotate${q}`, {})).status).toBe(400);
    const res = await hostCall(ctx.base, "POST", `/keys/rotate${q}`, { reason: "new PC" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.retired).toBe(first.sig?.key);
    expect(res.body.result.key).not.toBe(first.sig?.key);
    const entries = ctx.host.project("keys").entries();
    const trusted = entries.find((e) => e.type === "key.trusted")!;
    const retired = entries.find((e) => e.type === "key.retired")!;
    expect(trusted.sig?.key).toBe(first.sig?.key);
    expect(retired.sig?.key).toBe(res.body.result.key);
    expect(personWrite("Export notes").sig?.key).toBe(res.body.result.key);
    expect(ctx.host.project("keys").ledger.owner).toBe("person:owner");
  });

  it("cannot be done from outside the person's own request", () => {
    const ledger = ctx.host.project("keys").ledger;
    personWrite("Save notes");
    expect(() => ledger.rotateKey({ kind: "person", id: "owner" }, "agent tries")).toThrow(/person's own request/);
  });
});
