import { createHash } from "node:crypto";
import { verifyComponentPlans } from "../engine/componentPlanEngine.js";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { withStoredComponentPlans } from "./componentPlanStore.mjs";
import { authenticateSession } from "./sessionRegistry.mjs";
import { createWorkerMessageStore } from "./workerMessageStore.mjs";
import { withPlanLock } from "./planLock.mjs";

const HASH = /^[a-f0-9]{64}$/;
const isDigest = value => typeof value === "string" && HASH.test(value);
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function snapshotTaskIds(value) {
  // Do not call an input array's getters, iteration protocol or overridden
  // methods. Capture primitive IDs before source serialization and any await.
  try {
    if (!Array.isArray(value)) fail("worker-brief-request-invalid");
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > 128) fail("worker-brief-request-invalid");
    const tasks = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !id(descriptor.value)) fail("worker-brief-request-invalid");
      tasks.push(descriptor.value);
    }
    if (new Set(tasks).size !== tasks.length) fail("worker-brief-request-invalid");
    return Object.freeze(tasks);
  } catch { fail("worker-brief-request-invalid"); }
}

// Derived context only. The runtime must independently establish current ledger
// identity, authenticated delivery/acknowledgment and broker grants before work.
export async function createComponentWorkerBrief({ contract, expectedContractDigest, projectId, planRevision, policyDigest, workerId, owner, taskIds, maxBytes = 64 * 1024 } = {}) {
  if (![projectId, workerId].every(id) || typeof owner !== "string" || !owner.trim() || owner.length > 128
    || !Number.isSafeInteger(planRevision) || planRevision < 1 || !isDigest(policyDigest) || !isDigest(expectedContractDigest)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024) fail("worker-brief-request-invalid");
  const assignedTaskIds = snapshotTaskIds(taskIds);
  // Snapshot before asynchronous verification; caller mutation cannot change a
  // verified source or a delivered brief during the hashing await.
  let source;
  try {
    const encoded = JSON.stringify(contract);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 2 * 1024 * 1024) fail("worker-brief-source-limit");
    source = JSON.parse(encoded);
  } catch { fail("worker-brief-source-invalid"); }
  if (!Array.isArray(source?.components) || source.components.length > 256 || !Array.isArray(source.inventory) || source.inventory.length > 256) fail("worker-brief-source-limit");
  if (source.digest !== expectedContractDigest) fail("worker-brief-source-stale");
  let verification;
  try { verification = await verifyComponentPlans(source); } catch { fail("worker-brief-source-invalid"); }
  if (!verification.valid) fail("worker-brief-source-invalid");
  const selected = source.components.filter(component => assignedTaskIds.includes(component.taskId));
  if (assignedTaskIds.some(taskId => !selected.some(component => component.taskId === taskId)) || selected.some(component => component.owner !== owner)) fail("worker-brief-assignment-mismatch");
  const byId = new Map(source.components.map(component => [component.id, component]));
  const selectedIds = new Set(selected.map(component => component.id));
  const dependencyIds = new Set(selected.flatMap(component => (component.dependencies ?? []).map(dependency => dependency.componentId)));
  const dependencies = [...dependencyIds].sort().filter(componentId => !selectedIds.has(componentId)).map(componentId => {
    const component = byId.get(componentId);
    if (!component) fail("worker-brief-dependency-missing");
    return { componentId, taskId: component.taskId, owner: component.owner, componentDigest: hash(component), detail: { source: "component-catalog", contractDigest: source.digest, componentId }, completion: "not-verified" };
  });
  const payload = {
    schemaVersion: 1, kind: "component-worker-brief", projectId, planId: source.planId, planRevision, contractDigest: source.digest,
    architectureDigest: source.architectureDigest, architectureRevision: source.architectureRevision,
    folderDigest: source.folderDigest, folderRevision: source.folderRevision,
    policyDigest, workerId, owner, taskIds: [...assignedTaskIds].sort(),
    authority: "CONTEXT_ONLY", executionAuthorized: false, acknowledgmentRequired: true, sourceTextAuthority: "untrusted-data",
    nextAction: "acknowledge-exact-brief-digest", blockers: ["Authenticated delivery and exact-digest acknowledgment are not yet verified.", "Current task, dependency, conflict, lease and tool-grant checks are required before execution."],
    // Full assigned component records preserve acceptance, failure/recovery,
    // interface, security and file-scope obligations. Never summarize them away.
    components: selected.sort((a, b) => a.id.localeCompare(b.id)), dependencies,
  };
  const encoded = JSON.stringify(canonical(payload));
  const contentBytes = Buffer.byteLength(encoded);
  const brief = { ...payload, digest: hash(payload), contentBytes, estimatedTokens: Math.ceil(contentBytes / 4), tokenEstimateMethod: "UTF-8 bytes / 4; approximate, not tokenizer-measured" };
  if (Buffer.byteLength(JSON.stringify(brief)) > maxBytes) fail("worker-brief-budget-exceeded");
  return freeze(brief);
}

export function verifyComponentWorkerBriefBinding(brief, { projectId, planRevision, contractDigest, policyDigest, workerId, expectedBriefDigest } = {}) {
  if (!brief || brief.schemaVersion !== 1 || brief.kind !== "component-worker-brief" || brief.authority !== "CONTEXT_ONLY" || brief.executionAuthorized !== false || brief.acknowledgmentRequired !== true) fail("worker-brief-invalid");
  if (![projectId, workerId].every(id) || !Number.isSafeInteger(planRevision) || planRevision < 1 || ![expectedBriefDigest, contractDigest, policyDigest].every(isDigest)
    || brief.digest !== expectedBriefDigest || brief.projectId !== projectId || brief.planRevision !== planRevision || brief.contractDigest !== contractDigest || brief.policyDigest !== policyDigest || brief.workerId !== workerId) fail("worker-brief-binding-stale");
  const { digest, contentBytes, estimatedTokens, tokenEstimateMethod, ...payload } = brief;
  if (hash(payload) !== digest || contentBytes !== Buffer.byteLength(JSON.stringify(canonical(payload))) || estimatedTokens !== Math.ceil(contentBytes / 4) || tokenEstimateMethod !== "UTF-8 bytes / 4; approximate, not tokenizer-measured") fail("worker-brief-invalid");
  return Object.freeze({ valid: true, authority: "CONTEXT_ONLY", executionAuthorized: false, digest });
}

// Constructed by the trusted coordinator, never from a renderer/tool request.
// Enrollment explicitly maps a plan revision to a catalog revision; they are
// different counters. A current enrollment is not a tool grant or plan freeze.
export async function createStoredWorkerBriefChannel({ catalogRoot, messageRoot, sessionRegistryPath, enrollment, readCurrentEnrollment, secretCustody, now = Date.now } = {}) {
  enrollment = structuredClone(enrollment);
  const keys = ["projectId", "planId", "planRevision", "catalogRevision", "contractDigest", "policyDigest", "epoch", "coordinatorId", "coordinatorSessionId", "workerId", "workerSessionId", "owner", "taskIds", "packageId", "messageId", "deadlineAt"];
  if (!enrollment || Object.keys(enrollment).sort().join("|") !== keys.sort().join("|") || typeof readCurrentEnrollment !== "function"
    || ![enrollment.projectId, enrollment.planId, enrollment.coordinatorId, enrollment.coordinatorSessionId, enrollment.workerId, enrollment.workerSessionId, enrollment.packageId, enrollment.messageId].every(id)
    || ![enrollment.contractDigest, enrollment.policyDigest].every(isDigest)
    || ![enrollment.planRevision, enrollment.catalogRevision, enrollment.epoch].every(value => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(enrollment.deadlineAt) || enrollment.deadlineAt < 0 || enrollment.coordinatorId === enrollment.workerId
    || enrollment.coordinatorSessionId === enrollment.workerSessionId || typeof enrollment.owner !== "string" || !enrollment.owner.trim() || enrollment.owner.length > 128) fail("brief-channel-enrollment-invalid");
  snapshotTaskIds(enrollment.taskIds); freeze(enrollment);
  const enrollmentDigest = hash(enrollment);
  const scope = { projectId: enrollment.projectId, planRevision: enrollment.planRevision, epoch: enrollment.epoch };
  const file = path.join(messageRoot, `worker-brief-${hash({ ...scope, messageId: enrollment.messageId })}.json`);
  function current() {
    // The runtime owns this synchronous snapshot. External I/O belongs in its
    // enrollment authority, not an unbounded callback on the dispatch path.
    let value;
    try { value = readCurrentEnrollment(); } catch { fail("brief-channel-enrollment-unavailable"); }
    if (!value || typeof value.then === "function" || hash(value) !== enrollmentDigest) fail("brief-channel-enrollment-stale");
  }
  const store = await createWorkerMessageStore({ root: messageRoot, scope, now, authenticate: async credentials => {
    current();
    const actor = credentials?.id === enrollment.coordinatorSessionId ? enrollment.coordinatorId
      : credentials?.id === enrollment.workerSessionId ? enrollment.workerId : null;
    if (!actor) fail("brief-channel-session-not-enrolled");
    await authenticateSession(sessionRegistryPath, credentials, { id: credentials.id, actor }, { now: now(), secretCustody });
    current(); return { ...scope, actorId: actor };
  } });
  async function safePayloadRoot() {
    let cursor = path.resolve(messageRoot);
    for (;;) { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) fail("brief-channel-root-unsafe"); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
    if (path.relative(path.resolve(messageRoot), await realpath(messageRoot))) fail("brief-channel-root-unsafe");
  }
  async function readPayload() {
    await safePayloadRoot(); const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 96 * 1024) fail("brief-channel-payload-unsafe");
    const handle = await open(file, "r");
    try {
      const opened = await handle.stat(); if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) fail("brief-channel-payload-changed");
      const bytes = Buffer.alloc(info.size + 1); let length = 0;
      while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length); if (!result.bytesRead) break; length += result.bytesRead; }
      const after = await handle.stat(); const latest = await lstat(file); await safePayloadRoot();
      if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || latest.ino !== info.ino || latest.dev !== info.dev || latest.size !== info.size || latest.mtimeMs !== info.mtimeMs || latest.isSymbolicLink() || latest.nlink !== 1) fail("brief-channel-payload-changed");
      let payload; try { payload = JSON.parse(bytes.subarray(0, length).toString("utf8")); } catch { fail("brief-channel-payload-incomplete"); }
      return payload;
    } finally { await handle.close(); }
  }
  async function payload(contract, create) {
    const brief = await createComponentWorkerBrief({ contract, expectedContractDigest: enrollment.contractDigest, projectId: enrollment.projectId,
      planRevision: enrollment.planRevision, policyDigest: enrollment.policyDigest, workerId: enrollment.workerId, owner: enrollment.owner, taskIds: enrollment.taskIds });
    const expected = { schemaVersion: 1, enrollment, brief };
    return withPlanLock(file, { actor: "worker-brief-payload", timeoutMs: 3000 }, async () => {
      await safePayloadRoot();
      if (create) {
        let handle;
        try { handle = await open(file, "wx", 0o600); } catch (error) { if (error.code !== "EEXIST") throw error; }
        if (handle) { try { await handle.writeFile(JSON.stringify(expected)); await handle.sync(); } finally { await handle.close(); } }
      }
      // A failed/partial first write is preserved, never replaced or queued.
      const saved = await readPayload();
      if (hash(saved) !== hash(expected)) fail("brief-channel-payload-mismatch");
      return freeze(saved.brief);
    });
  }
  async function run(credentials, role, operation) {
    credentials = structuredClone(credentials); current();
    if (role && credentials?.id !== enrollment[`${role}SessionId`]) fail("brief-channel-role-refused");
    // Authenticate before source/payload access. Inspection does not renew liveness.
    await store.inspect(credentials);
    return withStoredComponentPlans(catalogRoot, enrollment, async contract => {
      current(); const result = await operation(contract, credentials); current(); return result;
    });
  }
  const message = brief => ({ messageId: enrollment.messageId, packageId: enrollment.packageId, recipientId: enrollment.workerId, payloadDigest: brief.digest, kind: "brief", deadlineAt: enrollment.deadlineAt });
  async function find(credentials, brief) {
    const item = (await store.inspect(credentials)).find(item => item.message.messageId === enrollment.messageId);
    if (!item || item.senderId !== enrollment.coordinatorId || hash(item.message) !== hash(message(brief))) fail("brief-channel-message-not-queued");
    return item;
  }
  async function transition(credentials, expectedBriefDigest, method) {
    if (!isDigest(expectedBriefDigest)) fail("brief-channel-digest-refused");
    return run(credentials, "worker", async (contract, captured) => {
      const brief = await payload(contract, false); await find(captured, brief);
      if (brief.digest !== expectedBriefDigest) fail("brief-channel-digest-refused");
      const receipt = await store[method](captured, { messageId: enrollment.messageId, payloadDigest: brief.digest });
      return { ...receipt, executionAuthorized: false, understandingVerified: false };
    });
  }
  return Object.freeze({
    queue: credentials => run(credentials, "coordinator", async (contract, captured) => {
      const brief = await payload(contract, true); current();
      const receipt = await store.send(captured, message(brief));
      return { ...receipt, executionAuthorized: false, briefDigest: brief.digest };
    }),
    read: credentials => run(credentials, "worker", async (contract, captured) => {
      const brief = await payload(contract, false); await find(captured, brief);
      return brief; // Retrieval does not prove runtime receipt or understanding.
    }),
    received: (credentials, digest) => transition(credentials, digest, "delivered"),
    acknowledge: (credentials, digest) => transition(credentials, digest, "acknowledge"),
    inspect: credentials => run(credentials, null, async (contract, captured) => {
      const items = (await store.inspect(captured)).filter(item => item.message.messageId === enrollment.messageId);
      if (!items.length) return [];
      const brief = await payload(contract, false); const item = await find(captured, brief);
      return [{ ...item, executionAuthorized: false, understandingVerified: false }];
    }),
  });
}
