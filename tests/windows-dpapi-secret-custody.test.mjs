import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir, link, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import { createWindowsDpapiRunner, exportOpaqueSecretRecovery, importOpaqueSecretRecovery, inspectOpaqueSecret, retireOpaqueSecret, rotateOpaqueSecret, storeOpaqueSecret, useOpaqueSecret, windowsDpapiScript } from "../src/node/windowsDpapiSecretCustody.mjs";

const mockDpapi = { protect: async (value) => Buffer.concat([Buffer.from("dpapi:"), Buffer.from(value)]), unprotect: async (value) => { const bytes = Buffer.from(value); if (!bytes.subarray(0, 6).equals(Buffer.from("dpapi:"))) throw new Error("wrong user"); return bytes.subarray(6); } };
const fixture = () => mkdtemp(path.join(os.tmpdir(), "pp-dpapi-custody-"));

test('custody rejects malformed handles before lock side effects and relative roots',async()=>{
 const root=await fixture(),before=await readdir(root);
 for(const handle of ['../escape','dpapi:v1:------------------------------------','dpapi:v1:../../outside']){
  await assert.rejects(retireOpaqueSecret(root,handle,{ownerId:'test',reason:'test'}),/malformed/);
  await assert.rejects(rotateOpaqueSecret(root,handle,{secret:'test'},{dpapi:mockDpapi}),/malformed/);
 }
 assert.deepEqual(await readdir(root),before);
 await assert.rejects(inspectOpaqueSecret('.',`dpapi:v1:00000000-0000-0000-0000-000000000000`),/root is invalid/);
});

test('custody refuses oversized files, hardlinks and redirected parents before unprotect',async()=>{
 const root=await fixture(),stored=await storeOpaqueSecret(root,{ownerId:'test',purpose:'test',secret:'synthetic'},{dpapi:mockDpapi});
 const file=path.join(root,'dpapi-secrets',`${stored.handle.split(':').at(-1)}.json`),original=await readFile(file);
 await writeFile(file,Buffer.alloc(1024*1024+1));await assert.rejects(inspectOpaqueSecret(root,stored.handle),/oversized/);
 await writeFile(file,original);const alias=path.join(root,'alias.json');await link(file,alias);
 await assert.rejects(inspectOpaqueSecret(root,stored.handle),/unsafe/);
 const redirected=`${root}-redirect`;await symlink(root,redirected,process.platform==='win32'?'junction':'dir');
 await assert.rejects(inspectOpaqueSecret(redirected,stored.handle),/redirected/);
 assert.deepEqual(await readFile(file),original);
});

test('redirected mutations never create locks and invalid roots never invoke protection',async t=>{
 const root=await fixture(),stored=await storeOpaqueSecret(root,{ownerId:'test',purpose:'test',secret:'synthetic'},{dpapi:mockDpapi});
 const redirected=`${root}-mutation`;await symlink(root,redirected,process.platform==='win32'?'junction':'dir');
 let locks=0,protects=0;const actualMkdir=fs.mkdir;
 const mock=t.mock.method(fs,'mkdir',async(...args)=>{if(String(args[0]).endsWith('.pp-lock'))locks++;return actualMkdir(...args);});syncBuiltinESMExports();
 try{
  await assert.rejects(retireOpaqueSecret(redirected,stored.handle,{ownerId:'test',reason:'test'}),/redirected/);
  await assert.rejects(rotateOpaqueSecret(redirected,stored.handle,{ownerId:'test',secret:'synthetic'},{dpapi:mockDpapi}),/redirected/);
  await assert.rejects(storeOpaqueSecret('.',{ownerId:'test',purpose:'test',secret:'synthetic'},{dpapi:{protect:async()=>{protects++;return Buffer.from('x');}}}),/root is invalid/);
  assert.equal(locks,0);assert.equal(protects,0);
 }finally{mock.mock.restore();syncBuiltinESMExports();}
});

test("the fixed script loads no PowerShell modules, so an isolated environment cannot stall it", () => {
  assert.match(windowsDpapiScript, /^\$PSModuleAutoLoadingPreference='None';/);
  for (const cmdlet of ["ConvertFrom-Json", "ConvertTo-Json", "Add-Type", "Import-Module"]) assert.equal(windowsDpapiScript.includes(cmdlet), false, cmdlet);
  assert.equal(windowsDpapiScript.includes('"'), false);
  // The request it accepts is exactly what the adapter writes to stdin.
  const pattern = /\(protect\|unprotect\)/; assert.match(windowsDpapiScript, pattern);
  assert.equal(JSON.stringify({ action: "protect", value: "eA==" }), '{"action":"protect","value":"eA=="}');
});
test("the Windows adapter invokes one fixed direct PowerShell script and sends secrets only through stdin", async () => {
  let call; const runner = createWindowsDpapiRunner({ platform: "win32", execute: async (input) => { call = input; const request = JSON.parse(input.stdin); return JSON.stringify({ value: Buffer.from(`bound:${Buffer.from(request.value, "base64").toString("utf8")}`).toString("base64") }); } });
  const result = await runner.protect(Buffer.from("super-secret")); assert.match(result.toString(), /bound:super-secret/); assert.equal(call.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"); assert.equal(call.shell, false); assert.equal(call.args.at(-1), windowsDpapiScript); assert.equal(call.args.join(" ").includes("super-secret"), false); assert.equal(JSON.parse(call.stdin).value, Buffer.from("super-secret").toString("base64"));
});

test('credential calls bound input and time and reject pre-cancellation before provider',async()=>{
 let calls=0;const execute=async()=>{calls++;return JSON.stringify({value:'eA=='});};
 const controller=new AbortController();controller.abort();
 await assert.rejects(createWindowsDpapiRunner({platform:'win32',execute,signal:controller.signal}).protect('test'),/cancelled/);
 await assert.rejects(createWindowsDpapiRunner({platform:'win32',execute}).protect(Buffer.alloc(65537)),/input bound/);
 for(const timeoutMs of [0,30001,NaN])assert.throws(()=>createWindowsDpapiRunner({platform:'win32',execute,timeoutMs}),/time bound/);
 assert.equal(calls,0);
 await assert.rejects(createWindowsDpapiRunner({platform:'win32',execute:async()=>JSON.stringify({value:'eA==',extra:true})}).protect('x'),/malformed protected/);
});

test('real Windows credential provider handles only fresh test bytes with bounded cleanup',{skip:process.platform!=='win32'&&'Windows-only (DPAPI / native Windows paths)'},async()=>{
 assert.equal(process.platform,'win32');
 const root=await fixture();const runner=createWindowsDpapiRunner({timeoutMs:10000,compilationTempRoot:path.join(root,'compilation')});
 const original=Buffer.from('perfect-planner-new-synthetic-roundtrip');
 const protectedBytes=await runner.protect(original);
 assert.notDeepEqual(protectedBytes,original);
 assert.deepEqual(await runner.unprotect(protectedBytes),original);
 const boundary=Buffer.alloc(16384,42);
 assert.deepEqual(await runner.unprotect(await runner.protect(boundary)),boundary);
 await assert.rejects(runner.protect(Buffer.alloc(16385)),/input bound/);
});

test("the adapter refuses non-Windows use, malformed output, and output overflow", async () => {
  assert.throws(() => createWindowsDpapiRunner({ platform: "linux" }), /unavailable/);
  const malformed = createWindowsDpapiRunner({ platform: "win32", execute: async () => "not-json" }); await assert.rejects(() => malformed.protect("x"), /malformed JSON/);
  const overflow = createWindowsDpapiRunner({ platform: "win32", maxOutputBytes: 256, execute: async () => "x".repeat(257) }); await assert.rejects(() => overflow.protect("x"), /exceeded/);
});
test('real DPAPI execution requires an explicit native compilation root without environment fallback',()=>{
 for(const compilationTempRoot of [undefined,'.','relative',null])assert.throws(()=>createWindowsDpapiRunner({platform:'win32',compilationTempRoot}),/native compilation root/);
 assert.throws(()=>createWindowsDpapiRunner({platform:'win32',execute:null}),/native compilation root/);
});
test('fixture cleanup uncertainty propagates without plaintext diagnostics or retry',async()=>{let calls=0;const runner=createWindowsDpapiRunner({platform:'win32',execute:async()=>{calls++;throw Object.assign(Error('DPAPI process cleanup uncertain.'),{cleanupComplete:false});}});await assert.rejects(runner.protect('newly-generated-test-only'),error=>error.cleanupComplete===false&&!error.message.includes('newly-generated-test-only'));assert.equal(calls,1);});
test('fixed runner supplies exact isolated environment and retains uncertain or nonempty scratch',{skip:process.platform!=='win32'&&'Windows-only (DPAPI / native Windows paths)'},async t=>{
 assert.equal(process.platform,'win32');const originalEnvironment={...process.env};
 for(const mode of ['empty','residual','uncertain']){
  const root=await fixture();let scratch,finishInput;
  const mock=t.mock.method(childProcess,'spawn',(command,args,options)=>{
   assert.deepEqual(Object.keys(options.env).sort(),['SystemRoot','TEMP','TMP','WINDIR'].sort());assert.equal(options.env.TEMP,options.env.TMP);scratch=options.env.TEMP;assert.equal(path.dirname(scratch),path.join(root,'compilation'));
   const child=new EventEmitter();child.pid=undefined;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>false;
   child.stdin=new Writable({write(chunk,encoding,callback){callback();},final(callback){callback();finishInput();}});
   finishInput=()=>{if(mode==='uncertain')return;queueMicrotask(async()=>{try{if(mode==='residual')await writeFile(path.join(scratch,'retained.txt'),'test-only');child.stdout.end(JSON.stringify({value:'eA=='}));child.stderr.end();child.emit('close',0,null);}catch(error){child.emit('error',error);}});};return child;
  });syncBuiltinESMExports();
  try{const runner=createWindowsDpapiRunner({compilationTempRoot:path.join(root,'compilation'),timeoutMs:mode==='uncertain'?20:10000});if(mode==='uncertain')await assert.rejects(runner.protect('test-only'),error=>error.cleanupComplete===false);else assert.equal((await runner.protect('test-only')).toString(),'x');
   if(mode==='empty')await assert.rejects(fs.lstat(scratch),{code:'ENOENT'});else assert.deepEqual(await readdir(scratch),mode==='residual'?['retained.txt']:[]);
  }finally{mock.mock.restore();syncBuiltinESMExports();}
 }
 assert.deepEqual({...process.env},originalEnvironment);
});

test('credential provider respects host policy and propagates refusal without a fallback',async()=>{
 let calls=0;const refusal=Error('Host policy refused credential provider');
 const runner=createWindowsDpapiRunner({platform:'win32',execute:async call=>{
  calls++;assert.deepEqual(call.args.slice(0,-1),['-NoLogo','-NoProfile','-NonInteractive','-Command']);
  assert.equal(call.args.some(arg=>/bypass|executionpolicy|unrestricted/i.test(arg)),false);
  throw refusal;
 }});
 await assert.rejects(runner.protect(Buffer.from('synthetic-test-only')),error=>error===refusal);
 assert.equal(calls,1);
});

test("opaque handles support bounded use, exact rotation, retirement, and never expose stored plaintext", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const stored = await storeOpaqueSecret(root, { ownerId: "danie", purpose: "session", secret: "token-one" }, { dpapi: mockDpapi, timestamp: "2026-09-02T00:00:00.000Z" }); assert.match(stored.handle, /^dpapi:v1:/);
  const inspection = await inspectOpaqueSecret(root, stored.handle); assert.equal(inspection.secret, "OPAQUE"); assert.equal(JSON.stringify(inspection).includes("token-one"), false); const disk = await readFile(path.join(root, "dpapi-secrets", `${stored.handle.split(":").at(-1)}.json`), "utf8"); assert.equal(disk.includes("token-one"), false);
  assert.equal(await useOpaqueSecret(root, stored.handle, { ownerId: "danie", purpose: "session", dpapi: mockDpapi }, (secret) => secret.toString()), "token-one"); await assert.rejects(() => useOpaqueSecret(root, stored.handle, { ownerId: "attacker", purpose: "session", dpapi: mockDpapi }, () => true), /owner or purpose/);
  const rotated = await rotateOpaqueSecret(root, stored.handle, { ownerId: "danie", purpose: "session", expectedVersion: 1, secret: "token-two" }, { dpapi: mockDpapi }); assert.equal(rotated.version, 2); await assert.rejects(() => rotateOpaqueSecret(root, stored.handle, { ownerId: "danie", purpose: "session", expectedVersion: 1, secret: "stale" }, { dpapi: mockDpapi }), /exact current version/);
  assert.equal(await useOpaqueSecret(root, stored.handle, { ownerId: "danie", purpose: "session", dpapi: mockDpapi }, (secret) => secret.toString()), "token-two"); await retireOpaqueSecret(root, stored.handle, { ownerId: "danie", purpose: "session", expectedVersion: 2, reason: "actor removed" }); await assert.rejects(() => useOpaqueSecret(root, stored.handle, { ownerId: "danie", purpose: "session", dpapi: mockDpapi }, () => true), /retired/);
});

test("portable recovery export is passphrase-authenticated and imports as a new opaque handle", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const stored = await storeOpaqueSecret(root, { ownerId: "danie", purpose: "identity", secret: "private-pem" }, { dpapi: mockDpapi }); const recovery = await exportOpaqueSecretRecovery(root, stored.handle, { ownerId: "danie", purpose: "identity", recoveryPassphrase: "recovery passphrase long" }, { dpapi: mockDpapi }); assert.equal(JSON.stringify(recovery).includes("private-pem"), false);
  await assert.rejects(() => importOpaqueSecretRecovery(root, recovery, { ownerId: "danie", purpose: "identity", recoveryPassphrase: "wrong passphrase long" }, { dpapi: mockDpapi }), /authentication failed/); const imported = await importOpaqueSecretRecovery(root, recovery, { ownerId: "danie", purpose: "identity", recoveryPassphrase: "recovery passphrase long" }, { dpapi: mockDpapi }); assert.notEqual(imported.handle, stored.handle); assert.equal(await useOpaqueSecret(root, imported.handle, { ownerId: "danie", purpose: "identity", dpapi: mockDpapi }, (secret) => secret.toString()), "private-pem");
});
