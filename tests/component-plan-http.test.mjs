import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentComponentPlanInput } from "../src/engine/componentPlanSeed.js";
import { createComponentPlanMiddleware } from "../src/node/componentPlanHttp.mjs";
import { bindComponentParents } from "./fixtures/componentParents.mjs";

async function live(root) { const middleware = createComponentPlanMiddleware({ root, actor: "danie", token: "component-token" }); const server = createServer((req, res) => middleware(req, res)); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${server.address().port}`; return { origin, close: () => new Promise((resolve) => server.close(resolve)) }; }
const post = (origin, route, token, value) => fetch(`${origin}/api/component-plans/${route}`, { method: "POST", headers: { origin, "content-type": "application/json", "x-pp-component-token": token }, body: JSON.stringify(value) });
const resolvedInput = () => {
  const value = structuredClone(currentComponentPlanInput);
  for (const component of value.components) component.handover.openQuestions = [];
  return value;
};
test("same-origin POST session requires a bounded empty JSON object", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-component-session-")); const server = await live(root);
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await post(server.origin, "session", "", {})).status, 200);
  for (const body of [null, [], { actor: "forged" }, { ignored: "x".repeat(1200) }]) assert.equal((await post(server.origin, "session", "", body)).status, 400);
  assert.equal((await fetch(`${server.origin}/api/component-plans/session`, { method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" }, body: "{}" })).status, 403);
});
test("foreign origins and missing capabilities cannot inspect component truth", async (t) => { const root = await mkdtemp(path.join(os.tmpdir(), "pp-component-http-")); const server = await live(root); t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); }); assert.equal((await fetch(`${server.origin}/api/component-plans/session`, { headers: { origin: "https://attacker.invalid" } })).status, 403); assert.equal((await post(server.origin, "inspect", "", { planId: "PP-CLEANROOM" })).status, 403); });
test("local guarded publication freezes, rereads, and refuses replay", async (t) => { const root = await mkdtemp(path.join(os.tmpdir(), "pp-component-http-")); const server = await live(root); t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); }); const session = await fetch(`${server.origin}/api/component-plans/session`, { headers: { origin: server.origin } }); const token = (await session.json()).token; const input = await bindComponentParents(root, resolvedInput()); const first = await post(server.origin, "publish", token, { input, expectedRevision: 0, expectedHeadDigest: "GENESIS" }); assert.equal(first.status, 200); const published = await first.json(); assert.equal(published.head.componentCount, input.components.length); const replay = await post(server.origin, "publish", token, { input, expectedRevision: 0, expectedHeadDigest: "GENESIS" }); assert.equal(replay.status, 409); const inspect = await post(server.origin, "inspect", token, { planId: "PP-CLEANROOM" }); assert.equal((await inspect.json()).head.contractDigest, published.head.contractDigest); });
