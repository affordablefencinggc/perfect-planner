// The project owner pin (core/host/owner.ts) and key rotation (POST /keys/rotate).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendNumbered } from "../../numbering/index";
import { asPersonRequest, HostKeys } from "../keys";
import { MemoryKeyProvider } from "../../ledger/index";
import { openCoreProject } from "../project";
import { ownerPinFile } from "../owner";
import { hostCall, startTestHost } from "../testing";

let ctx: Awaited<ReturnType<typeof startTestHost>>;
const q = "?project=keys";

beforeEach(async () => {
  ctx = await startTestHost();
});
afterEach(async () => ctx.stop());

const pinFile = () => ownerPinFile(ctx.dir, "keys", path.join(ctx.dir, "projects", "keys"));

const personWrite = (summary: string) =>
  asPersonRequest(() => appendNumbered(ctx.host.project("keys").ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary, data: { title: summary } }));

/** Opens the project again from disk, as a restart would (same keys, same app data). */
const reopen = async () => {
  await ctx.host.close();
  return ctx.host.project("keys");
};

describe("project owner pin", () => {
  it("is made when the project is created, signed by the app, and names the owner before anyone writes", () => {
    const project = ctx.host.project("keys");
    expect(project.owner.state).toBe("created");
    expect(project.ledger.ownerKeyPinned).toBe(true);
    const pin = JSON.parse(fs.readFileSync(pinFile(), "utf8"));
    expect(pin).toMatchObject({ project: "keys", principal: "person:owner", ownerKey: project.owner.ownerKey, sig: { key: expect.stringMatching(/^k-/), value: expect.any(String) } });
    expect(personWrite("Save notes").sig?.key).toBe(project.owner.ownerKey);
    expect(project.ledger.owner).toBe("person:owner");
  });

  it("is passed on every later open", async () => {
    const created = ctx.host.project("keys").owner.ownerKey;
    personWrite("Save notes");
    const again = await reopen();
    expect(again.owner).toEqual({ ownerKey: created, principal: "person:owner", state: "pinned" });
    expect(again.ledger.owner).toBe("person:owner");
  });

  it("a pin someone rewrote on disk is ignored: no owner, and status says so", async () => {
    personWrite("Save notes");
    const file = pinFile();
    const pin = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...pin, ownerKey: "k-0000000000000000" }));
    const again = await reopen();
    expect(again.owner.state).toBe("tampered");
    expect(again.ledger.ownerKeyPinned).toBe(false);
    expect(again.ledger.owner).toBeUndefined();
    const status = (await hostCall(ctx.base, "GET", `/status${q}`)).body.result;
    expect(status.owner).toMatchObject({ state: "tampered" });
  });

  it("an unsigned pin written by hand is ignored too", async () => {
    personWrite("Save notes");
    fs.writeFileSync(pinFile(), JSON.stringify({ project: "keys", ownerKey: "k-attacker", principal: "person:mallory", at: "2026-10-09T00:00:00Z" }));
    const project = await reopen();
    expect(project.owner.state).toBe("tampered");
    expect(project.ledger.owner).toBeUndefined();
  });

  it("on a project nobody has written to, a pin that cannot be used is replaced with a new owner", () => {
    fs.mkdirSync(path.dirname(pinFile()), { recursive: true });
    fs.writeFileSync(pinFile(), JSON.stringify({ project: "keys", ownerKey: "k-attacker", principal: "person:mallory", at: "2026-10-09T00:00:00Z" }));
    const project = ctx.host.project("keys");
    expect(project.owner).toMatchObject({ state: "created", principal: "person:owner", reason: expect.stringMatching(/new owner/) });
    expect(project.owner.ownerKey).not.toBe("k-attacker");
    expect(personWrite("Save notes").sig?.key).toBe(project.owner.ownerKey);
  });

  it("a leftover pin never locks out a new folder: each ledger folder has its own pin", async () => {
    const first = ctx.host.project("keys");
    personWrite("Save notes");
    const other = path.join(ctx.dir, "elsewhere");
    const moved = openCoreProject(ctx.dir, "keys", other, ctx.host.keys);
    try {
      expect(moved.owner.state).toBe("created");
      expect(moved.owner.ownerKey).toBe(first.owner.ownerKey);
      expect(asPersonRequest(() => appendNumbered(moved.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "New folder", data: { title: "New folder" } })).sig?.key).toBe(first.owner.ownerKey);
    } finally {
      moved.ledger.close();
    }
  });

  it("after a restart that lost this device's keys: an unwritten project gets a new owner, a written one says why it cannot change", async () => {
    const fresh = () => new HostKeys(new MemoryKeyProvider({ autoCreate: false }));
    ctx.host.project("keys");
    await ctx.host.close();
    const empty = openCoreProject(ctx.dir, "keys", undefined, fresh());
    expect(empty.owner).toMatchObject({ state: "created", reason: expect.stringMatching(/new owner/) });
    empty.ledger.close();

    const written = openCoreProject(ctx.dir, "written", undefined, ctx.host.keys);
    asPersonRequest(() => appendNumbered(written.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Save notes", data: { title: "Save notes" } }));
    written.ledger.close();
    const lost = openCoreProject(ctx.dir, "written", undefined, fresh());
    expect(lost.owner).toMatchObject({ state: "tampered", reason: expect.stringMatching(/not this app's key on this device/) });
    expect(lost.ledger.owner).toBeUndefined();
    lost.ledger.close();
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
