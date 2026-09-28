import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authenticateSession, withAuthenticatedSession, classifyHeartbeat, createSession, heartbeatSession, inspectSessions, inspectReleasedSession, readSessionRegistry, releaseSession } from "../src/node/sessionRegistry.mjs";

const registryFixture = async () => path.join(await mkdtemp(path.join(os.tmpdir(), "pp-sessions-")), "state", "sessions.json");
const mockDpapi = { protect: async (value) => Buffer.concat([Buffer.from("dpapi:"), Buffer.from(value)]), unprotect: async (value) => Buffer.from(value).subarray(6) };

test('recovery requires an explicitly released original session through a safe file',async()=>{
 const file=await registryFixture(),session=await createSession(file,{actor:'native-owner',claim:'original-request'});
 const expected={id:session.id,actor:session.actor};
 assert.equal(await inspectReleasedSession(file,expected),false);
 await releaseSession(file,session);
 assert.equal(await inspectReleasedSession(file,expected),true);
 assert.equal(await inspectReleasedSession(file,{...expected,actor:'foreign-owner'}),false);
 assert.equal(await inspectReleasedSession(file,{...expected,id:'missing'}),false);
 const linked=file+'.hardlink';await link(file,linked);
 await assert.rejects(inspectReleasedSession(linked,expected),/file refused/);
});

test('session release waits for bounded admission and later admission is refused',async()=>{
 const registryPath=await registryFixture();
 const session=await createSession(registryPath,{actor:'agent-a',claim:'T0001'});
 const expected={id:session.id,actor:session.actor};
 let entered,finish,admissionFinished=false;
 const ready=new Promise(resolve=>{entered=resolve;});
 const admission=withAuthenticatedSession(registryPath,session,expected,async current=>{
  assert.equal(current.executionAuthorized,false);assert.equal('token' in current,false);entered();
  await new Promise(resolve=>{finish=resolve;});admissionFinished=true;return 'admitted-observation';
 });
 await ready;
 const release=releaseSession(registryPath,session).then(result=>{assert.equal(admissionFinished,true);return result;});
 finish();assert.equal(await admission,'admitted-observation');await release;
 let invoked=false;await assert.rejects(withAuthenticatedSession(registryPath,session,expected,()=>{invoked=true;}),/authentication refused/);
 assert.equal(invoked,false);
});

test('admission snapshots credentials and does not manufacture a heartbeat',async()=>{
 const registryPath=await registryFixture();const session=await createSession(registryPath,{actor:'agent-a',claim:'T0001'});
 const credentials={...session},expected={id:session.id,actor:session.actor};
 const before=await readFile(registryPath,'utf8');
 const pending=withAuthenticatedSession(registryPath,credentials,expected,current=>current.id);
 credentials.actor='other';expected.id='changed';
 assert.equal(await pending,session.id);assert.equal(await readFile(registryPath,'utf8'),before);
 await assert.rejects(withAuthenticatedSession(registryPath,{...session,token:'forged'},{id:session.id,actor:session.actor},()=>assert.fail('must not invoke')),/authentication refused/);
});

test("a session survives a fresh registry read with its claim intact", async () => {
  const registryPath = await registryFixture();
  const created = await createSession(registryPath, { actor: "agent-a", claim: "B07" }, { timestamp: "2026-09-02T00:00:00.000Z" });
  const reloaded = await readSessionRegistry(registryPath);
  assert.equal(reloaded.sessions[0].id, created.id);
  assert.equal(reloaded.sessions[0].claim, "B07");
  assert.equal(reloaded.sessions[0].token, null); assert.match(reloaded.sessions[0].tokenDigest, /^[a-f0-9]{64}$/); assert.equal(reloaded.sessions[0].custodyMode, "legacy-ephemeral-token");
});

test("heartbeat state uses explicit active, stale, and gone thresholds", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z");
  assert.equal(classifyHeartbeat("2026-09-02T11:55:00.000Z", now), "active");
  assert.equal(classifyHeartbeat("2026-09-02T11:00:00.000Z", now), "stale");
  assert.equal(classifyHeartbeat("2026-09-01T10:00:00.000Z", now), "gone");
});

test("only the owning token can heartbeat or release a claim", async () => {
  const registryPath = await registryFixture();
  const session = await createSession(registryPath, { actor: "agent-a", claim: "B07" });
  await assert.rejects(() => heartbeatSession(registryPath, { id: session.id, token: "forged", actor: "agent-b" }), /do not own/);
  await assert.rejects(() => releaseSession(registryPath, { id: session.id, token: "forged", actor: "agent-b" }), /do not own/);
});

test("heartbeats cannot move backwards and released sessions cannot revive", async () => {
  const registryPath = await registryFixture();
  const session = await createSession(registryPath, { actor: "agent-a", claim: "B07" }, { timestamp: "2026-09-02T00:00:00.000Z" });
  await heartbeatSession(registryPath, session, { timestamp: "2026-09-02T00:05:00.000Z" });
  await assert.rejects(() => heartbeatSession(registryPath, session, { timestamp: "2026-09-02T00:04:00.000Z" }), /backwards/);
  await releaseSession(registryPath, session, { timestamp: "2026-09-02T00:06:00.000Z", reason: "proof accepted" });
  await assert.rejects(() => heartbeatSession(registryPath, session, { timestamp: "2026-09-02T00:07:00.000Z" }), /already released/);
});

test("inspection never exposes ownership tokens", async () => {
  const registryPath = await registryFixture();
  await createSession(registryPath, { actor: "agent-a", claim: "B07" }, { timestamp: "2026-09-02T00:00:00.000Z" });
  const [visible] = await inspectSessions(registryPath, { now: Date.parse("2026-09-02T00:05:00.000Z") });
  assert.equal(visible.state, "active");
  assert.equal("token" in visible, false);
});

test("invalid heartbeat and release timestamps cannot poison durable session state", async () => {
  const registryPath = await registryFixture();
  const session = await createSession(registryPath, { actor: "agent-a", claim: "B07" }, { timestamp: "2026-09-02T00:00:00.000Z" });
  const before = await readFile(registryPath, "utf8");
  for (const timestamp of ["invalid", "2026-02-30T00:00:00.000Z", "", 0, {}, "2026-09-02"]) {
    await assert.rejects(() => heartbeatSession(registryPath, session, { timestamp }), /timestamp is invalid/);
    await assert.rejects(() => releaseSession(registryPath, session, { timestamp }), /timestamp is invalid/);
    assert.equal(await readFile(registryPath, "utf8"), before);
  }
  await assert.rejects(() => releaseSession(registryPath, session, { timestamp: "2026-09-01T23:59:59.000Z" }), /backwards/);
  assert.equal(await readFile(registryPath, "utf8"), before);
});

test("a token cannot be attributed to another actor and absent legacy tokens never authenticate", async () => {
  const registryPath = await registryFixture();
  const session = await createSession(registryPath, { actor: "agent-a", claim: "B07" });
  await assert.rejects(() => heartbeatSession(registryPath, { ...session, actor: "agent-b" }), /do not own/);
  await assert.rejects(() => releaseSession(registryPath, { ...session, actor: "agent-b" }), /do not own/);
  const registry = await readSessionRegistry(registryPath);
  delete registry.sessions[0].tokenDigest;
  await writeFile(registryPath, JSON.stringify(registry));
  await assert.rejects(() => heartbeatSession(registryPath, { id: session.id, actor: session.actor, token: null }), /do not own/);
});

test("corrupt or duplicated stored sessions cannot be silently renewed", async () => {
  const registryPath = await registryFixture();
  const session = await createSession(registryPath, { actor: "agent-a", claim: "B07" });
  const baseline = await readSessionRegistry(registryPath);
  for (const mutate of [r => { r.sessions[0].heartbeat = "invalid"; }, r => r.sessions.push({ ...r.sessions[0] })]) {
    const registry = structuredClone(baseline); mutate(registry);
    await writeFile(registryPath, JSON.stringify(registry));
    const before = await readFile(registryPath, "utf8");
    await assert.rejects(() => inspectSessions(registryPath));
    await assert.rejects(() => heartbeatSession(registryPath, session));
    assert.equal(await readFile(registryPath, "utf8"), before);
  }
});

test("future and malformed heartbeat clocks remain invalid, not live", () => {
  const timestamp = "2026-09-02T00:00:00.000Z";
  assert.equal(classifyHeartbeat(timestamp, Date.parse(timestamp) - 1), "invalid");
  for (const now of [null, "0", NaN, Infinity]) assert.equal(classifyHeartbeat(timestamp, now), "invalid");
  assert.equal(classifyHeartbeat("2026-02-30T00:00:00.000Z"), "invalid");
});

test("OS-bound mode returns only an opaque handle and validates it for heartbeat and release", async () => {
  const registryPath = await registryFixture(); const custody = { root: path.join(path.dirname(registryPath), "custody"), dpapi: mockDpapi }; const session = await createSession(registryPath, { actor: "agent-a", claim: "B07" }, { secretCustody: custody }); assert.match(session.tokenHandle, /^dpapi:v1:/); assert.equal(session.token, null); const durable = await readSessionRegistry(registryPath); assert.equal(durable.sessions[0].token, null); assert.match(durable.sessions[0].tokenDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(() => heartbeatSession(registryPath, { ...session, tokenHandle: "dpapi:v1:00000000-0000-0000-0000-000000000000" }, { secretCustody: custody }), /do not own/); await heartbeatSession(registryPath, session, { secretCustody: custody }); await releaseSession(registryPath, session, { secretCustody: custody }); const [visible] = await inspectSessions(registryPath); assert.equal(visible.state, "released"); assert.equal("tokenDigest" in visible, false);
});

test("read-only authentication rejects redirected, multiply linked and oversized session files", async () => {
  const registryPath = await registryFixture();
  const session = await createSession(registryPath, { actor: "agent-a", claim: "B07" });
  const expected = { id: session.id, actor: session.actor };
  const redirected = path.join(path.dirname(path.dirname(registryPath)), "redirected");
  await symlink(path.dirname(registryPath), redirected, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(authenticateSession(path.join(redirected, "sessions.json"), session, expected), /path refused/);
  const linked = path.join(path.dirname(registryPath), "sessions-copy.json"); await link(registryPath, linked);
  await assert.rejects(authenticateSession(linked, session, expected), /file refused/);
  const large = path.join(path.dirname(registryPath), "large.json"); await writeFile(large, " ".repeat(1024 * 1024 + 1));
  await assert.rejects(authenticateSession(large, session, expected), /file refused/);
});

test("read-only authentication verifies opaque handles without publishing a heartbeat or secret", async () => {
  const registryPath = await registryFixture(); const timestamp = "2026-09-05T00:00:00.000Z";
  const secretCustody = { root: path.join(path.dirname(registryPath), "custody"), dpapi: mockDpapi };
  const session = await createSession(registryPath, { actor: "agent-a", claim: "B07" }, { timestamp, secretCustody });
  const before = await readFile(registryPath, "utf8"); const expected = { id: session.id, actor: session.actor };
  const result = await authenticateSession(registryPath, session, expected, { now: Date.parse(timestamp), secretCustody });
  assert.deepEqual(Object.keys(result).sort(), ["actor", "authenticated", "heartbeat", "id"]);
  assert.equal(await readFile(registryPath, "utf8"), before);
  await assert.rejects(authenticateSession(registryPath, session, expected, { now: Date.parse(timestamp) + 600001, secretCustody }), /authentication refused/);
});
