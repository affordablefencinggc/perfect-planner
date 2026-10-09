import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendNumbered } from "../../numbering/index";
import { asPersonRequest } from "../keys";
import { readOwnerKey } from "../project";
import { hostCall, startTestHost } from "../testing";

let ctx: Awaited<ReturnType<typeof startTestHost>>;
const q = "?project=keys";

beforeEach(async () => {
  ctx = await startTestHost();
});
afterEach(async () => ctx.stop());

const personWrite = (summary: string) =>
  asPersonRequest(() => appendNumbered(ctx.host.project("keys").ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary, data: { title: summary } }));

describe("project owner key", () => {
  it("pins the key that signs a project's first person entry, outside the ledger, and uses it on the next open", async () => {
    const ledger = ctx.host.project("keys").ledger;
    expect(readOwnerKey(ctx.dir, "keys")).toBeUndefined();
    const entry = personWrite("Save notes");
    expect(readOwnerKey(ctx.dir, "keys")).toBe(entry.sig?.key);
    expect(fs.existsSync(path.join(ctx.dir, "owners", "keys.json"))).toBe(true);
    expect(ledger.owner).toBe("person:owner");
    personWrite("Export notes");
    expect(readOwnerKey(ctx.dir, "keys")).toBe(entry.sig?.key);
  });

  it("refuses a first person entry signed by any key but the pinned one", () => {
    fs.mkdirSync(path.join(ctx.dir, "owners"), { recursive: true });
    fs.writeFileSync(path.join(ctx.dir, "owners", "keys.json"), JSON.stringify({ ownerKey: "k-someone-else" }));
    expect(() => personWrite("Save notes")).toThrow(/only the project owner's key/);
  });
});

describe("POST /keys/rotate", () => {
  it("makes a new key and retires the old one in the ledger; only the person can do it", async () => {
    const first = personWrite("Save notes");
    expect((await hostCall(ctx.base, "POST", `/keys/rotate${q}`, { reason: "new PC" }, { asAgent: true })).status).toBe(401);
    expect((await hostCall(ctx.base, "POST", `/keys/rotate${q}`, {})).status).toBe(400);
    const res = await hostCall(ctx.base, "POST", `/keys/rotate${q}`, { reason: "new PC" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.retired).toBe(first.sig?.key);
    expect(res.body.result.key).not.toBe(first.sig?.key);
    const retired = ctx.host.project("keys").entries().find((e) => e.type === "key.retired")!;
    expect(retired).toMatchObject({ subject: first.sig?.key, actor: { kind: "person", id: "owner" } });
    expect(retired.sig?.key).toBe(res.body.result.key);
    // The person keeps working with the new key, and the owner is unchanged.
    expect(personWrite("Export notes").sig?.key).toBe(res.body.result.key);
    expect(ctx.host.project("keys").ledger.owner).toBe("person:owner");
  });
});
