import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import {runBoundedProcess} from './guardedGitRunner.mjs';
import { mkdir, lstat, realpath, open, rename } from "node:fs/promises";
import {constants} from 'node:fs';
import path from "node:path";
import { withPlanLock } from "./planLock.mjs";
import {allocateCompilationTemp,removeEmptyCompilationTemp} from './nativeCompilationScratch.mjs';

const HANDLE = /^dpapi:v1:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const FIXED_DPAPI_SCRIPT = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $request=[Console]::In.ReadToEnd()|ConvertFrom-Json; $bytes=[Convert]::FromBase64String([string]$request.value); if($request.action -eq 'protect'){$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)}elseif($request.action -eq 'unprotect'){$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{throw 'Unsupported DPAPI action'}; @{value=[Convert]::ToBase64String($result)}|ConvertTo-Json -Compress`;

const POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
async function executeFixedPowerShell({ file, args, stdin, maxOutputBytes,timeoutMs,signal,compilationTempRoot }) {
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||path.relative(file,await realpath(file))!=='')throw Error('DPAPI executable unavailable.');
  let scratch,cleanupProven=true;
  try{
  scratch=await allocateCompilationTemp(compilationTempRoot);
  cleanupProven=false;
  const result=await runBoundedProcess(file,args,{cwd:'C:\\Windows\\System32',env:{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TEMP:scratch.directory,TMP:scratch.directory},input:stdin,maxBytes:maxOutputBytes,timeoutMs,signal});
  cleanupProven=result.cleanupComplete===true;
  if(result.cleanupComplete!==true)throw Object.assign(Error('DPAPI process cleanup uncertain.'),{code:'DPAPI_PROCESS_UNCERTAIN',cleanupComplete:false});
  if(result.reason||result.exit!==0||result.outputComplete!==true)throw Object.assign(Error('DPAPI provider did not complete.'),{code:'DPAPI_PROCESS_FAILED',cleanupComplete:true});
  // Provider output can contain protected or plaintext bytes: never include it
  // in errors, logs or a propagated process result.
  return result.stdout;
  }catch(error){if(error?.cleanupComplete===false)throw Object.assign(Error('DPAPI process cleanup uncertain.'),{code:'DPAPI_PROCESS_UNCERTAIN',cleanupComplete:false});throw Object.assign(Error('DPAPI provider did not complete.'),{code:'DPAPI_PROCESS_FAILED',cleanupComplete:cleanupProven});}
  finally{if(cleanupProven)await removeEmptyCompilationTemp(scratch);}
}

export function createWindowsDpapiRunner(options = {}) {
  const platform = options.platform ?? process.platform; const execute = options.execute ?? executeFixedPowerShell; const maxOutputBytes = Number(options.maxOutputBytes ?? 64 * 1024);
  if (platform !== "win32") throw new Error("Windows DPAPI custody is unavailable on this platform.");
  const compilationTempRoot=options.compilationTempRoot;
  if(typeof execute!=='function')throw Error('DPAPI executor is invalid.');
  if(execute===executeFixedPowerShell&&(typeof compilationTempRoot!=='string'||!path.isAbsolute(compilationTempRoot)||path.normalize(compilationTempRoot)!==compilationTempRoot||compilationTempRoot.includes('\0')))throw Error('DPAPI native compilation root is required.');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 256 || maxOutputBytes > 1024 * 1024) throw new Error("DPAPI output bound is invalid.");
  const timeoutMs=options.timeoutMs??10000,signal=options.signal;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('DPAPI time bound is invalid.');
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw Error('DPAPI signal is invalid.');
  const invoke = async (action, value) => {
    if(signal?.aborted)throw Error('DPAPI request cancelled.');
    if((typeof value!=='string'&&!Buffer.isBuffer(value)&&!(value instanceof Uint8Array))||Buffer.byteLength(value)>(action==='protect'?16384:65536))throw Error('DPAPI input bound is invalid.');
    const stdin = JSON.stringify({ action, value: Buffer.from(value).toString("base64") });
    // Respect host policy. An unavailable or policy-blocked provider is an
    // explicit failure, never a reason to bypass Windows security settings.
    const stdout = await execute({ file: POWERSHELL, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", FIXED_DPAPI_SCRIPT], stdin, maxOutputBytes,timeoutMs,signal,compilationTempRoot,shell: false });
    if (Buffer.byteLength(stdout) > maxOutputBytes) throw new Error("DPAPI sidecar output exceeded its bound.");
    let decoded; try { decoded = JSON.parse(stdout); } catch { throw new Error("DPAPI sidecar returned malformed JSON."); }
    if (!decoded?.value || typeof decoded.value!=='string'||Object.keys(decoded).join('|')!=='value'||Buffer.from(decoded.value, "base64").toString("base64") !== decoded.value) throw new Error("DPAPI sidecar returned malformed protected bytes.");
    const bytes=Buffer.from(decoded.value,'base64');
    if(bytes.length>(action==='protect'?65536:16384))throw Error('DPAPI response byte bound exceeded.');
    return bytes;
  };
  return Object.freeze({ kind: "windows-dpapi-current-user", protect: (value) => invoke("protect", value), unprotect: (value) => invoke("unprotect", value) });
}

const MAX_RECORD_BYTES=1024*1024;
const location = (root, handle) => {
  if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root)throw Error('Opaque secret root is invalid.');
  const match=typeof handle==='string'&&HANDLE.exec(handle);
  if(!match)throw Error('Opaque secret handle is malformed.');
  return path.join(root,'dpapi-secrets',`${match[1]}.json`);
};
async function checkDirectory(directory,create=false){
  let cursor=path.parse(directory).root;
  for(const part of ['',...path.relative(cursor,directory).split(path.sep).filter(Boolean)]){
    if(part)cursor=path.join(cursor,part);
    if(create&&part)try{await mkdir(cursor);}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await lstat(cursor);
    if(!info.isDirectory()||info.isSymbolicLink()||path.relative(cursor,await realpath(cursor))!=='')throw Error('Opaque secret parent is redirected.');
  }
}
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const safeFile=info=>info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=MAX_RECORD_BYTES;
const atomicWrite = async (file, value) => {
  const body=Buffer.from(`${JSON.stringify(value,null,2)}\n`);
  if(body.length>MAX_RECORD_BYTES)throw Error('Opaque secret record exceeds byte limit.');
  await checkDirectory(path.dirname(file),true);
  const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`,handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(body);await handle.sync();}finally{await handle.close();}
  await checkDirectory(path.dirname(file));
  await rename(temporary,file);
  // File flush is not a claim of directory power-loss durability or protection
  // against a hostile same-user process replacing paths between these checks.
};
const readRecord = async (root, handle) => {
  const file=location(root,handle);await checkDirectory(path.dirname(file));
  const before=await lstat(file);if(!safeFile(before))throw Error('Opaque secret file is unsafe or oversized.');
  const reader=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));let bytes;
  try{
    const opened=await reader.stat();if(!safeFile(opened)||!sameFile(before,opened))throw Error('Opaque secret file changed.');
    bytes=Buffer.alloc(before.size);let offset=0;
    while(offset<bytes.length){const part=await reader.read(bytes,offset,Math.min(65536,bytes.length-offset),offset);if(!part.bytesRead)break;offset+=part.bytesRead;}
    const after=await reader.stat(),current=await lstat(file);await checkDirectory(path.dirname(file));
    if(offset!==before.size||!safeFile(current)||!sameFile(before,after)||!sameFile(before,current))throw Error('Opaque secret file changed.');
  }finally{await reader.close();}
  const value=JSON.parse(bytes.toString('utf8'));
  if(value?.schemaVersion!==1||value.handle!==handle)throw Error('Opaque secret record identity is invalid.');return value;
};
const authorize = (record, options) => { if (!options?.ownerId || record.ownerId !== options.ownerId || (options.purpose && record.purpose !== options.purpose)) throw new Error("Opaque secret access refused: owner or purpose does not match."); if (record.state !== "active" || !record.protectedValue) throw new Error("Opaque secret is retired."); };

export async function storeOpaqueSecret(root, input, options = {}) {
  const ownerId = String(input?.ownerId ?? "").trim(); const purpose = String(input?.purpose ?? "").trim(); const secret = Buffer.from(input?.secret ?? ""); const dpapi = options.dpapi;
  if (!ownerId || !purpose || secret.length === 0 || !dpapi?.protect) throw new Error("Opaque secret storage requires owner, purpose, non-empty secret, and DPAPI custody.");
  const id = randomUUID(); const handle = `dpapi:v1:${id}`; const file=location(root,handle);
  await checkDirectory(path.dirname(file),true);
  let protectedValue;try{protectedValue=await dpapi.protect(secret);}finally{secret.fill(0);}
  const now = options.timestamp ?? new Date().toISOString();
  const record = { schemaVersion: 1, handle, ownerId, purpose, version: 1, state: "active", createdAt: now, rotatedAt: null, retiredAt: null, retirementReason: null, protectedValue: protectedValue.toString("base64") }; await atomicWrite(location(root, handle), record); return { handle, version: 1, ownerId, purpose };
}

export async function inspectOpaqueSecret(root, handle) { const { protectedValue, ...record } = await readRecord(root, handle); return { ...record, secret: "OPAQUE" }; }

export async function useOpaqueSecret(root, handle, options, consumer) {
  if (typeof consumer !== "function" || !options?.dpapi?.unprotect) throw new Error("Opaque secret use requires DPAPI custody and a bounded consumer."); const record = await readRecord(root, handle); authorize(record, options); const secret = await options.dpapi.unprotect(Buffer.from(record.protectedValue, "base64"));
  try { return await consumer(secret); } finally { secret.fill(0); }
}

export async function rotateOpaqueSecret(root, handle, input, options = {}) {
  const next = Buffer.from(input?.secret ?? ""); if (next.length === 0 || !options.dpapi?.protect) throw new Error("Opaque secret rotation requires replacement secret and DPAPI custody."); const file = location(root, handle);
  await checkDirectory(path.dirname(file));
  return withPlanLock(file, { actor: input?.ownerId ?? "secret-rotation" }, async () => { const record = await readRecord(root, handle); authorize(record, input); if (input.expectedVersion !== record.version) throw new Error("Opaque secret rotation requires the exact current version."); const protectedValue = await options.dpapi.protect(next); next.fill(0); record.version += 1; record.rotatedAt = options.timestamp ?? new Date().toISOString(); record.protectedValue = protectedValue.toString("base64"); await atomicWrite(file, record); return { handle, version: record.version, ownerId: record.ownerId, purpose: record.purpose }; });
}

export async function retireOpaqueSecret(root, handle, input, options = {}) {
  const reason = String(input?.reason ?? "").trim(); const file = location(root, handle); if (!reason) throw new Error("Opaque secret retirement requires a reason.");
  await checkDirectory(path.dirname(file));
  return withPlanLock(file, { actor: input?.ownerId ?? "secret-retirement" }, async () => { const record = await readRecord(root, handle); authorize(record, input); if (input.expectedVersion !== record.version) throw new Error("Opaque secret retirement requires the exact current version."); record.state = "retired"; record.retiredAt = options.timestamp ?? new Date().toISOString(); record.retirementReason = reason; record.protectedValue = null; await atomicWrite(file, record); return { handle, version: record.version, state: record.state, retiredAt: record.retiredAt, reason }; });
}

export async function exportOpaqueSecretRecovery(root, handle, input, options = {}) {
  const passphrase = String(input?.recoveryPassphrase ?? ""); if (passphrase.length < 16) throw new Error("Recovery export requires a passphrase of at least 16 characters.");
  return useOpaqueSecret(root, handle, { ownerId: input.ownerId, purpose: input.purpose, dpapi: options.dpapi }, async (secret) => { const salt = randomBytes(32); const iv = randomBytes(12); const key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); const cipher = createCipheriv("aes-256-gcm", key, iv); const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]); key.fill(0); return { schemaVersion: 1, kind: "portable-recovery-export", ownerId: input.ownerId, purpose: input.purpose, kdf: "scrypt-N32768-r8-p1", cipher: "aes-256-gcm", salt: salt.toString("base64"), iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64") }; });
}

export async function importOpaqueSecretRecovery(root, recovery, input, options = {}) {
  if (recovery?.schemaVersion !== 1 || recovery.kind !== "portable-recovery-export" || recovery.kdf !== "scrypt-N32768-r8-p1" || recovery.cipher !== "aes-256-gcm" || recovery.ownerId !== input?.ownerId || recovery.purpose !== input?.purpose) throw new Error("Recovery import metadata does not match the exact owner and purpose."); const passphrase = String(input.recoveryPassphrase ?? ""); if (passphrase.length < 16) throw new Error("Recovery import requires a passphrase of at least 16 characters.");
  const key = scryptSync(passphrase, Buffer.from(recovery.salt, "base64"), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(recovery.iv, "base64")); decipher.setAuthTag(Buffer.from(recovery.authTag, "base64")); let secret; try { secret = Buffer.concat([decipher.update(Buffer.from(recovery.ciphertext, "base64")), decipher.final()]); } catch { throw new Error("Recovery import authentication failed."); } finally { key.fill(0); }
  try { return await storeOpaqueSecret(root, { ownerId: input.ownerId, purpose: input.purpose, secret }, options); } finally { secret.fill(0); }
}

export const windowsDpapiScript = FIXED_DPAPI_SCRIPT;
