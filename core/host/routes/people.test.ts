import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asPersonRequest } from "../keys";
import { hostCall, startTestHost } from "../testing";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

let ctx: Awaited<ReturnType<typeof startTestHost>>;
beforeEach(async () => {
  ctx = await startTestHost();
});
afterEach(async () => {
  await ctx.stop();
});

const call = (method: "GET" | "POST", route: string, body?: unknown) => hostCall(ctx.base, method, `${route}${route.includes("?") ? "&" : "?"}project=p1`, body);

describe("people routes", () => {
  it("starts empty with the local person defaulting to owner", async () => {
    const res = await call("GET", "/people");
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ view: { members: [], docs: [] }, photos: {}, me: "owner", firstRun: true });
  });

  it("first person added becomes the owner and the local person", async () => {
    const res = await call("POST", "/people/members", { person: "owner", name: "Dana Lee", role: "owner" });
    expect(res.status).toBe(200);
    expect(res.body.result.entry).toMatch(/^L-/);
    expect(res.body.result.me).toBe("owner");
    expect(res.body.result.firstRun).toBe(false);
    expect(res.body.result.view.owner).toMatchObject({ person: "owner", name: "Dana Lee" });
  });

  it("refuses a first owner who is not the project's pinned owner", async () => {
    const res = await call("POST", "/people/members", { person: "dana", name: "Dana Lee", role: "owner" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("OWNER_IS_PINNED");
    expect((await call("GET", "/people")).body.result.view.members).toEqual([]);
  });

  it("passes the pinned owner to the People, MVP and Decisions routes", async () => {
    expect((await call("POST", "/people/claim", { name: "Solo" })).status).toBe(200);
    const people = await call("GET", "/people");
    expect(people.body.result.view.owner).toMatchObject({ person: "owner", name: "Solo" });
    // Each route rebuilds the roster from the ledger with the pinned owner; without it the owner has no name.
    expect((await call("GET", "/mvp")).status).toBe(200);
    expect((await call("POST", "/decisions/ask", { question: "Which database should we use?", options: ["SQLite", "Postgres"] })).status).toBe(200);
    const decisions = await call("GET", "/decisions");
    expect(decisions.status).toBe(200);
    expect(decisions.body.result.open[0].askedBy).toMatchObject({ kind: "person", id: "owner", name: "Solo" });
  });

  it("names the person who started the project as the only one who can become its owner", async () => {
    expect((await call("POST", "/planning/start", { idea: "A notes app that syncs" })).status).toBe(200);
    // Written as the person's own request would be (only that may make and use their key).
    asPersonRequest(() => ctx.host.project("p1").ledger.append({ actor: { kind: "person", id: "owner" }, type: "task.created", subject: "T-1", summary: "Worked on before adding people" }));
    const before = await call("GET", "/people");
    expect(before.body.result).toMatchObject({ firstRun: true, starter: "owner" });
    const res = await call("POST", "/people/members", { person: "owner", name: "Riley Owner", role: "owner" });
    expect(res.status).toBe(200);
    expect(res.body.result.view.owner).toMatchObject({ person: "owner", name: "Riley Owner" });
    expect(res.body.result).not.toHaveProperty("starter");
  });

  it("refuses a first person who is not the owner", async () => {
    const res = await call("POST", "/people/members", { person: "eli", name: "Eli", role: "helper" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("FIRST_IS_OWNER");
  });

  it("claim works once, then refuses", async () => {
    expect((await call("POST", "/people/claim", { name: "Solo" })).body.result.me).toBe("owner");
    const again = await call("POST", "/people/claim", { name: "Other", person: "other" });
    expect(again.status).toBe(409);
  });

  it("adds, changes and removes a helper", async () => {
    await call("POST", "/people/members", { person: "owner", name: "Dana", role: "owner" });
    const add = await call("POST", "/people/members", { person: "eli", name: "Eli Kim", role: "helper", approves: ["test"] });
    expect(add.status).toBe(200);
    expect(add.body.result.view.members.map((m: { person: string }) => m.person)).toEqual(["owner", "eli"]);
    expect(add.body.result.view.members[1].approves).toEqual(["test"]);
    const change = await call("POST", "/people/members/eli/role", { role: "viewer" });
    expect(change.status).toBe(200);
    expect(change.body.result.view.members[1]).toMatchObject({ role: "viewer", approves: [] });
    const dupe = await call("POST", "/people/members", { person: "eli", name: "Eli", role: "helper" });
    expect(dupe.status).toBe(422);
    const ownerOff = await call("POST", "/people/members/owner/remove", {});
    expect(ownerOff.status).toBe(422);
    const rm = await call("POST", "/people/members/eli/remove", {});
    expect(rm.body.result.view.members).toHaveLength(1);
  });

  it("validates input", async () => {
    expect((await call("POST", "/people/members", { person: "Not Ok", name: "X" })).status).toBe(400);
    expect((await call("POST", "/people/members", { person: "x", name: "" })).status).toBe(400);
    await call("POST", "/people/members", { person: "owner", name: "Dana", role: "owner" });
    expect((await call("POST", "/people/members/eli/role", { role: "boss" })).status).toBe(400);
    expect((await call("POST", "/people/docs", { title: "T", path: "../etc/passwd" })).status).toBe(400);
    expect((await call("POST", "/people/docs", { title: "T", path: "javascript:alert(1)" })).status).toBe(400);
  });

  it("stores a photo under the project and returns it as a data URL", async () => {
    await call("POST", "/people/members", { person: "owner", name: "Dana", role: "owner" });
    const res = await call("POST", "/people/photo", { image: PNG.toString("base64") });
    expect(res.status).toBe(200);
    expect(res.body.result.photos.owner).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    const file = res.body.result.view.members[0].photo.file as string;
    expect(fs.existsSync(path.join(ctx.dir, "projects", "p1", ...file.split("/")))).toBe(true);
    const again = await call("GET", "/people");
    expect(again.body.result.photos.owner).toMatch(/^data:image\/png;base64,/);
  });

  it("refuses photos that are not images, too large, or before an owner exists", async () => {
    expect((await call("POST", "/people/photo", { image: PNG.toString("base64") })).status).toBe(422);
    await call("POST", "/people/members", { person: "owner", name: "Dana", role: "owner" });
    const svg = await call("POST", "/people/photo", { image: Buffer.from("<svg></svg>").toString("base64") });
    expect(svg.status).toBe(422);
    expect(svg.body.code).toBe("PHOTO_TYPE");
    expect((await call("POST", "/people/photo", { image: "%%%" })).status).toBe(400);
    const big = await call("POST", "/people/photo", { image: Buffer.alloc(150 * 1024, 1).toString("base64") });
    expect(big.status).toBe(422);
    const large = Buffer.concat([PNG, Buffer.alloc(400 * 1024, 7)]);
    expect((await call("POST", "/people/photo", { image: large.toString("base64") })).status).toBe(200);
    const over = Buffer.concat([PNG, Buffer.alloc(513 * 1024, 7)]);
    expect((await call("POST", "/people/photo", { image: over.toString("base64") })).status).toBe(413);
  });

  it("shares a document that shows in the view", async () => {
    await call("POST", "/people/members", { person: "owner", name: "Dana", role: "owner" });
    const res = await call("POST", "/people/docs", { title: "Core specs", path: "specs/CORE.md" });
    expect(res.status).toBe(200);
    expect(res.body.result.view.docs[0]).toMatchObject({ doc: "core-specs", title: "Core specs", version: "v1", kind: "document", sharedBy: "owner" });
  });
});
