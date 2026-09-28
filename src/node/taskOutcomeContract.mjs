import { createHash } from 'node:crypto';
import { assertProjectId } from '../project/projectIds.js';

// Wire validation only. Valid data is not authenticated execution evidence.
const digest = /^[a-f0-9]{64}$/;
const token = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const bindingKeys = ['projectId','rootIdentity','ledgerRevision','ledgerDigest','taskId','taskDigest','candidateDigest','acceptanceDigest'];
const fail = () => { throw new Error('TASK_OUTCOME_INVALID'); };
function exact(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail(); }
function integer(value, min = 0) { if (!Number.isSafeInteger(value) || value < min) fail(); }
function id(value) { if (typeof value !== 'string' || !token.test(value)) fail(); }
function hash(value) { if (typeof value !== 'string' || !digest.test(value)) fail(); }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function binding(value) {
  exact(value, bindingKeys); assertProjectId(value.projectId); integer(value.ledgerRevision,1); id(value.taskId);
  for (const field of ['rootIdentity','ledgerDigest','taskDigest','candidateDigest','acceptanceDigest']) hash(value[field]);
}
export function acceptanceSetDigest(checkIds) {
  if (!Array.isArray(checkIds) || checkIds.length < 1 || checkIds.length > 256) fail();
  const snapshot = [];
  for (let index = 0; index < checkIds.length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(checkIds, String(index));
    if (!entry || !Object.hasOwn(entry, 'value')) fail();
    id(entry.value); snapshot.push(entry.value);
  }
  if (new Set(snapshot).size !== snapshot.length) fail();
  return createHash('sha256').update(JSON.stringify(snapshot.sort())).digest('hex');
}
function readWire(wire) {
  if (typeof wire !== 'string' || Buffer.byteLength(wire,'utf8') > 262144) fail();
  try { return JSON.parse(wire); } catch { fail(); }
}
export function parseTaskAttempt(wire) {
  const value = readWire(wire);
  exact(value,['schemaVersion','kind','binding','attemptId','attemptNumber','producerId','sessionId','grantId','requiredCheckIds']);
  if (value.schemaVersion !== 1 || value.kind !== 'TASK_ATTEMPT') fail();
  binding(value.binding);integer(value.attemptNumber,1);
  for(const field of ['attemptId','producerId','sessionId','grantId']) id(value[field]);
  if (acceptanceSetDigest(value.requiredCheckIds) !== value.binding.acceptanceDigest) fail();
  return freeze(value);
}
export function parseTaskCheckResult(wire) {
  const value=readWire(wire);
  exact(value,['schemaVersion','kind','binding','attemptId','checkId','producerId','sessionId','exitCode','timedOut','outputTruncated','cleanup','artifactDigest']);
  if(value.schemaVersion!==1||value.kind!=='TASK_CHECK_RESULT')fail();
  binding(value.binding);for(const field of ['attemptId','checkId','producerId','sessionId'])id(value[field]);
  if(value.exitCode!==null && (!Number.isSafeInteger(value.exitCode)||Math.abs(value.exitCode)>4294967295))fail();
  if(typeof value.timedOut!=='boolean'||typeof value.outputTruncated!=='boolean'||!['complete','incomplete','unknown'].includes(value.cleanup))fail();
  hash(value.artifactDigest);return freeze(value);
}
export function inspectTaskAttemptResults(attemptWire,resultWires) {
  const attempt=parseTaskAttempt(attemptWire);
  if(!Array.isArray(resultWires)||resultWires.length>256)fail();
  const results=resultWires.map(parseTaskCheckResult),byCheck=new Map();
  for(const result of results){
    if(bindingKeys.some(key=>result.binding[key]!==attempt.binding[key]) || result.attemptId!==attempt.attemptId || result.producerId!==attempt.producerId || result.sessionId!==attempt.sessionId || !attempt.requiredCheckIds.includes(result.checkId) || byCheck.has(result.checkId))fail();
    byCheck.set(result.checkId,result);
  }
  const missing=attempt.requiredCheckIds.filter(key=>!byCheck.has(key));
  const failed=results.filter(r=>r.exitCode!==null && r.exitCode!==0 || r.timedOut || r.outputTruncated).map(r=>r.checkId);
  const unresolved=results.filter(r=>r.exitCode===null || r.cleanup!=='complete').map(r=>r.checkId);
  return freeze({kind:'TASK_RESULT_INSPECTION',missing,failed,unresolved,
    allRequiredChecksPassed:missing.length===0&&failed.length===0&&unresolved.length===0,
    authorityVerified:false,promotionAuthority:false});
}
