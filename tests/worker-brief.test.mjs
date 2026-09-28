import test from "node:test";
import assert from "node:assert/strict";
import { currentComponentPlanInput } from "../src/engine/componentPlanSeed.js";
import { freezeComponentPlans } from "../src/engine/componentPlanEngine.js";
import { createComponentWorkerBrief, verifyComponentWorkerBriefBinding, createStoredWorkerBriefChannel } from "../src/node/workerBrief.mjs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishComponentPlans } from "../src/node/componentPlanStore.mjs";
import { createSession, releaseSession } from "../src/node/sessionRegistry.mjs";
import { bindComponentParents } from "./fixtures/componentParents.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-brief-parents-"));
  const catalog = structuredClone(currentComponentPlanInput);
  for (const component of catalog.components) component.handover.openQuestions = [];
  const boundCatalog = await bindComponentParents(root, catalog);
  const contract = await freezeComponentPlans(boundCatalog, { planId: boundCatalog.planId, actor: "fixture-planner", approvedAt: "2026-09-05T00:00:00.000Z" });
  const component = contract.components.find(c => c.dependencies?.length) ?? contract.components[0];
  return { contract, component, input: { contract, expectedContractDigest: contract.digest, projectId: "project-one", planRevision: 1, policyDigest: "a".repeat(64), workerId: "worker-one", owner: component.owner, taskIds: [component.taskId] } };
}

test("brief preserves all assigned obligations from the verified catalog and omits unrelated full records", async () => {
  const { input, component, contract } = await fixture();
  const brief = await createComponentWorkerBrief(input);
  assert.deepEqual(brief.components.find(c => c.id === component.id), component);
  assert.ok(brief.components.length < contract.components.length);
  assert.equal(brief.executionAuthorized, false); assert.equal(brief.authority, "CONTEXT_ONLY");
  assert.equal(brief.acknowledgmentRequired, true);
  assert.equal(brief.dependencies.length, component.dependencies.length);
  assert.equal(brief.architectureDigest, contract.architectureDigest);
  assert.equal(brief.architectureRevision, contract.architectureRevision);
  assert.equal(brief.folderDigest, contract.folderDigest);
  assert.equal(brief.folderRevision, contract.folderRevision);
  assert.ok(brief.dependencies.every(d => d.completion === "not-verified" && d.detail.contractDigest === contract.digest));
  assert.ok(brief.components.every(c => Object.isFrozen(c.proof.acceptanceCriteria)));
  assert.equal(verifyComponentWorkerBriefBinding(brief, { projectId: input.projectId, planRevision: 1, contractDigest: contract.digest, policyDigest: input.policyDigest, workerId: input.workerId, expectedBriefDigest: brief.digest }).valid, true);
});

test("tampered catalogs, stale revisions and relabelled owners never generate accepted context", async () => {
  const { input } = await fixture();
  await assert.rejects(createComponentWorkerBrief({ ...input, expectedContractDigest: "b".repeat(64) }), /source-stale/);
  await assert.rejects(createComponentWorkerBrief({ ...input, owner: "different-owner" }), /assignment-mismatch/);
  await assert.rejects(createComponentWorkerBrief({ ...input, taskIds: ["missing-task"] }), /assignment-mismatch/);
  const changed = structuredClone(input.contract); changed.components[0].proof.acceptanceCriteria.pop();
  await assert.rejects(createComponentWorkerBrief({ ...input, contract: changed }), /source-invalid/);
  const brief = await createComponentWorkerBrief(input);
  const expected = { projectId: input.projectId, planRevision: 1, contractDigest: input.contract.digest, policyDigest: input.policyDigest, workerId: input.workerId, expectedBriefDigest: brief.digest };
  for (const change of [{ planRevision: 2 }, { policyDigest: "c".repeat(64) }, { projectId: "project-two" }, { workerId: "worker-two" }]) assert.throws(() => verifyComponentWorkerBriefBinding(brief, { ...expected, ...change }), /binding-stale/);
  const altered = structuredClone(brief); altered.components[0].proof.tests = [];
  assert.throws(() => verifyComponentWorkerBriefBinding(altered, expected), /brief-invalid/);
});

test("budget failure refuses delivery instead of truncating required proof or recovery", async () => {
  const { input } = await fixture();
  await assert.rejects(createComponentWorkerBrief({ ...input, maxBytes: 1024 }), /budget-exceeded/);
  const brief = await createComponentWorkerBrief(input);
  assert.equal(brief.estimatedTokens, Math.ceil(brief.contentBytes / 4));
  assert.match(brief.tokenEstimateMethod, /approximate/);
  assert.deepEqual(brief.components[0].failureModes, input.contract.components.find(c => c.id === brief.components[0].id).failureModes);
});

test("caller edits during async verification do not change the frozen brief", async () => {
  const { input, component } = await fixture();
  const original = structuredClone(component);
  const pending = createComponentWorkerBrief(input);
  component.purpose = "modified during verification";
  const brief = await pending;
  assert.deepEqual(brief.components.find(c => c.id === original.id), original);
});

test("assignment edits during verification cannot erase the worker's obligations", async () => {
  const { input, component } = await fixture();
  const originalTasks = [...input.taskIds];
  const pending = createComponentWorkerBrief(input);
  input.taskIds.length = 0;
  const brief = await pending;
  assert.deepEqual(brief.taskIds, originalTasks);
  assert.deepEqual(brief.components.map(c => c.id), [component.id]);
});

test("assignment edits during verification cannot replace or expand assigned work", async () => {
  const { input, component } = await fixture();
  const other = input.contract.components.find(c => c.owner === component.owner && c.taskId !== component.taskId);
  assert.ok(other, "fixture must include another task for the same owner");
  const pending = createComponentWorkerBrief(input);
  input.taskIds.splice(0, 1, other.taskId);
  const brief = await pending;
  assert.deepEqual(brief.taskIds, [component.taskId]);
  assert.deepEqual(brief.components.map(c => c.id), [component.id]);
});

test("coercible digest objects are rejected without invoking user code", async () => {
  const { input } = await fixture();
  let calls = 0;
  const value = { toString() { calls++; return input.policyDigest; } };
  await assert.rejects(createComponentWorkerBrief({ ...input, policyDigest: value }), /request-invalid/);
  await assert.rejects(createComponentWorkerBrief({ ...input, policyDigest: [input.policyDigest] }), /request-invalid/);
  assert.equal(calls, 0);
});

test("assignment accessors and sparse arrays cannot smuggle unvalidated task identities", async () => {
  const { input } = await fixture();
  let calls = 0;
  const tasks = [];
  Object.defineProperty(tasks, "0", { get() { calls++; return input.taskIds[0]; }, enumerable: true });
  await assert.rejects(createComponentWorkerBrief({ ...input, taskIds: tasks }), /request-invalid/);
  await assert.rejects(createComponentWorkerBrief({ ...input, taskIds: new Array(1) }), /request-invalid/);
  assert.equal(calls, 0);
});

test("assignment array methods cannot override validated selection", async () => {
  const { input, component } = await fixture();
  input.taskIds.includes = () => true;
  input.taskIds[Symbol.iterator] = function* () { yield "unassigned-task"; };
  const brief = await createComponentWorkerBrief(input);
  assert.deepEqual(brief.taskIds, [component.taskId]);
  assert.deepEqual(brief.components.map(c => c.id), [component.id]);
});

async function channelFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-brief-channel-"));
  const messageRoot = path.join(root, "messages"); await mkdir(messageRoot);
  const sessionRegistryPath = path.join(root, "sessions.json");
  const catalog = structuredClone(currentComponentPlanInput);
  for (const component of catalog.components) component.handover.openQuestions = [];
  const input = await bindComponentParents(root, catalog);
  const component = input.components.find(component => component.dependencies.length) ?? input.components[0];
  const published = await publishComponentPlans(root, input, { planId: input.planId, expectedRevision: 0, expectedHeadDigest: "GENESIS" }, { actor: "fixture-coordinator", timestamp: "2026-09-05T00:00:00.000Z" });
  let time = Date.parse("2026-09-05T00:01:00.000Z");
  const options = { timestamp: new Date(time).toISOString() };
  const coordinator = await createSession(sessionRegistryPath, { actor: "coordinator", claim: "planning" }, options);
  const worker = await createSession(sessionRegistryPath, { actor: "worker", claim: "not-an-authority-binding" }, options);
  let enrollment = { projectId: "project-one", planId: input.planId, planRevision: 7, catalogRevision: 1, contractDigest: published.head.contractDigest,
    policyDigest: "a".repeat(64), epoch: 3, coordinatorId: coordinator.actor, coordinatorSessionId: coordinator.id, workerId: worker.actor, workerSessionId: worker.id,
    owner: component.owner, taskIds: [component.taskId], packageId: "B07", messageId: "dispatch-1", deadlineAt: time + 60000 };
  const config = { catalogRoot: root, messageRoot, sessionRegistryPath, enrollment: structuredClone(enrollment), readCurrentEnrollment: () => structuredClone(enrollment), now: () => time };
  return { root, input, component, published, config, coordinator, worker, channel: await createStoredWorkerBriefChannel(config),
    revoke: () => { enrollment.epoch++; }, tick: value => { time += value; } };
}

test("stored catalog to authenticated delivery and acknowledgment survives reopening without granting execution", async () => {
  const f = await channelFixture();
  const initialSessions = await readFile(f.config.sessionRegistryPath, "utf8");
  const queued = await f.channel.queue(f.coordinator);
  assert.equal(queued.status, "queued"); assert.equal(queued.executionAuthorized, false);
  const payloadFile = (await readdir(f.config.messageRoot)).find(name => name.startsWith("worker-brief-") && name.endsWith(".json"));
  const saved = JSON.parse(await readFile(path.join(f.config.messageRoot, payloadFile), "utf8"));
  assert.equal(saved.brief.digest, queued.briefDigest);
  assert.deepEqual(saved.brief.components[0], f.input.components.find(item => item.id === saved.brief.components[0].id));
  assert.equal(saved.brief.planRevision, 7); assert.equal(saved.enrollment.catalogRevision, 1);
  const reopened = await createStoredWorkerBriefChannel(f.config);
  assert.equal((await reopened.queue(f.coordinator)).duplicate, true);
  const brief = await reopened.read(f.worker);
  assert.equal((await reopened.inspect(f.worker))[0].status, "queued");
  await assert.rejects(reopened.acknowledge(f.worker, brief.digest), /transition-invalid/);
  await reopened.received(f.worker, brief.digest);
  const ack = await reopened.acknowledge(f.worker, brief.digest);
  assert.equal(ack.status, "acknowledged"); assert.equal(ack.understandingVerified, false);
  assert.equal(ack.executionAuthorized, false); assert.equal(ack.completionVerified, undefined);
  assert.equal((await reopened.inspect(f.coordinator))[0].completionVerified, false);
  assert.equal(await readFile(f.config.sessionRegistryPath, "utf8"), initialSessions, "authentication must not refresh heartbeat");
  assert.equal("acted" in reopened, false);
});

test("channel refuses forged sessions, role swapping, wrong digests and revoked enrollment", async () => {
  const f = await channelFixture();
  await assert.rejects(f.channel.queue(f.worker), /role-refused/);
  await assert.rejects(f.channel.queue({ ...f.coordinator, token: "forged" }), /authentication-refused/);
  await f.channel.queue(f.coordinator);
  await assert.rejects(f.channel.read(f.coordinator), /role-refused/);
  await assert.rejects(f.channel.read({ ...f.worker, actor: "coordinator" }), /authentication-refused/);
  await assert.rejects(f.channel.received(f.worker, "b".repeat(64)), /digest-refused/);
  f.revoke();
  await assert.rejects(f.channel.read(f.worker), /enrollment-stale/);
  await assert.rejects(f.channel.queue(f.coordinator), /enrollment-stale/);
});

test("new catalog heads invalidate prior dispatch and released sessions cannot acknowledge", async () => {
  const f = await channelFixture(); await f.channel.queue(f.coordinator);
  const brief = await f.channel.read(f.worker); await f.channel.received(f.worker, brief.digest);
  await releaseSession(f.config.sessionRegistryPath, f.worker, { timestamp: "2026-09-05T00:01:01.000Z" });
  await assert.rejects(f.channel.acknowledge(f.worker, brief.digest), /authentication-refused/);
  f.input.components[0].purpose += " Updated contract.";
  await publishComponentPlans(f.root, f.input, { planId: f.input.planId, expectedRevision: 1, expectedHeadDigest: f.published.head.contractDigest }, { actor: "fixture-coordinator" });
  await assert.rejects(f.channel.queue(f.coordinator), /catalog changed/);
});

test("partial or tampered brief payloads are retained and never queued or silently replaced", async () => {
  const f = await channelFixture(); await f.channel.queue(f.coordinator);
  const file = path.join(f.config.messageRoot, (await readdir(f.config.messageRoot)).find(name => name.startsWith("worker-brief-") && name.endsWith(".json")));
  const before = (await readdir(f.config.messageRoot)).filter(name => name.endsWith(".jsonl"));
  const journal = await readFile(path.join(f.config.messageRoot, before[0]), "utf8");
  await writeFile(file, '{"schemaVersion":');
  await assert.rejects(f.channel.queue(f.coordinator), /payload-incomplete/);
  await assert.rejects(f.channel.read(f.worker), /payload-incomplete/);
  assert.equal(await readFile(file, "utf8"), '{"schemaVersion":');
  assert.equal(await readFile(path.join(f.config.messageRoot, before[0]), "utf8"), journal);
});

test("expired sessions do not become live through brief inspection", async () => {
  const f = await channelFixture(); await f.channel.queue(f.coordinator); f.tick(600001);
  const before = await readFile(f.config.sessionRegistryPath, "utf8");
  await assert.rejects(f.channel.read(f.worker), /authentication-refused/);
  assert.equal(await readFile(f.config.sessionRegistryPath, "utf8"), before);
});

test("reusing a dispatch ID cannot borrow another assignment's acknowledgment during inspection", async () => {
  const f = await channelFixture(); await f.channel.queue(f.coordinator);
  const brief = await f.channel.read(f.worker); await f.channel.received(f.worker, brief.digest); await f.channel.acknowledge(f.worker, brief.digest);
  const enrollment = { ...f.config.enrollment, packageId: "different-package" };
  const reused = await createStoredWorkerBriefChannel({ ...f.config, enrollment, readCurrentEnrollment: () => structuredClone(enrollment) });
  await assert.rejects(reused.inspect(f.worker), /payload-mismatch/);
  assert.equal((await f.channel.inspect(f.coordinator))[0].status, "acknowledged");
});

test("source serialization cannot rewrite the captured assignment", async () => {
  const { input, component } = await fixture();
  const source = input.contract;
  input.contract = { toJSON() { input.taskIds.length = 0; return source; } };
  const brief = await createComponentWorkerBrief(input);
  assert.deepEqual(brief.taskIds, [component.taskId]);
  assert.deepEqual(brief.components.map(c => c.id), [component.id]);
});

test("binding expectations reject nonprimitive digests without coercion", async () => {
  const { input } = await fixture();
  const brief = await createComponentWorkerBrief(input);
  const expected = { projectId: input.projectId, planRevision: input.planRevision, contractDigest: input.expectedContractDigest, policyDigest: input.policyDigest, workerId: input.workerId, expectedBriefDigest: brief.digest };
  let calls = 0;
  for (const key of ["expectedBriefDigest", "contractDigest", "policyDigest"]) {
    const coerced = { toString() { calls++; return expected[key]; } };
    assert.throws(() => verifyComponentWorkerBriefBinding(brief, { ...expected, [key]: coerced }), /binding-stale/);
  }
  assert.equal(calls, 0);
  assert.equal(verifyComponentWorkerBriefBinding(brief, expected).executionAuthorized, false);
});
