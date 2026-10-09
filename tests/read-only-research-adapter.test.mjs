import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createReadOnlyResearchAdapter } from "../src/node/readOnlyResearchAdapter.mjs";

const origin = "https://evidence.example";
const response = (value, overrides = {}) => new Response(JSON.stringify(value), { status: overrides.status ?? 200, headers: { "content-type": overrides.contentType ?? "application/json", ...(overrides.headers ?? {}) } });

test("approved HTTPS metadata becomes hashed assess-only evidence", async () => {
  let options; const adapter = createReadOnlyResearchAdapter({ allowedOrigins: [origin], fetchImpl: async (_url, input) => { options = input; return response({ repository: "planner", license: "MIT" }); } });
  const record = await adapter.read({ sourceId: "github-metadata", evidenceKind: "repository", url: `${origin}/repos/planner`, capturedAt: "2026-09-02T00:00:00.000Z" });
  assert.equal(record.authority, "UNTRUSTED_EXTERNAL_EVIDENCE"); assert.equal(record.action, "ASSESS_ONLY"); assert.match(record.sha256, /^[a-f0-9]{64}$/); assert.deepEqual(options, { method: "GET", redirect: "error", credentials: "omit", headers: { accept: "application/json" } });
});

test("unapproved, credentialed, local, and non-HTTPS sources are refused before fetch", async () => {
  let calls = 0; const adapter = createReadOnlyResearchAdapter({ allowedOrigins: [origin], fetchImpl: async () => { calls += 1; return response({}); } });
  for (const url of ["http://evidence.example/x", "https://user:secret@evidence.example/x", "https://localhost/x", "https://127.0.0.1/x", "https://other.example/x"]) await assert.rejects(() => adapter.read({ sourceId: "x", evidenceKind: "market", url }), /HTTPS|local|private|not approved/);
  assert.equal(calls, 0);
});

test("status, content type, malformed JSON, and byte overflow fail closed", async () => {
  const request = { sourceId: "x", evidenceKind: "market", url: `${origin}/x` };
  await assert.rejects(() => createReadOnlyResearchAdapter({ allowedOrigins: [origin], fetchImpl: async () => response({}, { status: 503 }) }).read(request), /HTTP 503/);
  await assert.rejects(() => createReadOnlyResearchAdapter({ allowedOrigins: [origin], fetchImpl: async () => response({}, { contentType: "text/html" }) }).read(request), /JSON evidence/);
  await assert.rejects(() => createReadOnlyResearchAdapter({ allowedOrigins: [origin], fetchImpl: async () => new Response("not-json", { headers: { "content-type": "application/json" } }) }).read(request), /invalid JSON/);
  await assert.rejects(() => createReadOnlyResearchAdapter({ allowedOrigins: [origin], maxBytes: 4, fetchImpl: async () => response({ too: "large" }) }).read(request), /byte ceiling/);
});

test("bounded batches are deterministic and duplicate source identities are refused", async () => {
  const adapter = createReadOnlyResearchAdapter({ allowedOrigins: [origin], maxRequests: 2, fetchImpl: async (url) => response({ path: url.pathname }) });
  const records = await adapter.readBatch([{ sourceId: "one", evidenceKind: "market", url: `${origin}/one` }, { sourceId: "two", evidenceKind: "legal-policy", url: `${origin}/two` }]);
  assert.deepEqual(records.map((item) => item.sourceId), ["one", "two"]);
  await assert.rejects(() => adapter.readBatch([{ sourceId: "one", evidenceKind: "market", url: `${origin}/one` }, { sourceId: "one", evidenceKind: "market", url: `${origin}/two` }]), /Duplicate/);
  await assert.rejects(() => adapter.readBatch([1, 2, 3]), /1-2/);
});
