import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,link,symlink,appendFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readProofArtifactDigest,MAX_PROOF_ARTIFACT_BYTES} from '../src/node/proofArtifactRead.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'pp-artifact-read-')),file=path.join(root,'proof.json');await writeFile(file,'retained proof');return {root,file};}
test('bounded read retains valid/mismatched hash semantics and immutable result',async()=>{const f=await fixture();const r=await readProofArtifactDigest(f.file,hash('retained proof'));assert.equal(r.valid,true);assert.ok(Object.isFrozen(r));assert.equal((await readProofArtifactDigest(f.file,'a'.repeat(64))).valid,false);});
test('bad identity, empty, oversized and linked evidence refuse',async()=>{
 const f=await fixture();for(const [file,digest]of [['relative.json',hash('retained proof')],[f.file,'wrong']])await assert.rejects(readProofArtifactDigest(file,digest),/PROOF_ARTIFACT_UNVERIFIED/);
 const handle=await open(f.file,'r+');await handle.truncate(MAX_PROOF_ARTIFACT_BYTES+1);await handle.close();await assert.rejects(readProofArtifactDigest(f.file,'a'.repeat(64)),/PROOF_ARTIFACT_UNVERIFIED/);
 await writeFile(f.file,'');await assert.rejects(readProofArtifactDigest(f.file,'a'.repeat(64)),/PROOF_ARTIFACT_UNVERIFIED/);
 await writeFile(f.file,'retained proof');await link(f.file,path.join(f.root,'alias.json'));await assert.rejects(readProofArtifactDigest(f.file,hash('retained proof')),/PROOF_ARTIFACT_UNVERIFIED/);
 const other=await fixture();await symlink(other.root,path.join(other.root,'redirect'),process.platform==='win32'?'junction':'dir');await assert.rejects(readProofArtifactDigest(path.join(other.root,'redirect','proof.json'),hash('retained proof')),/PROOF_ARTIFACT_UNVERIFIED/);
});
test('mutation during streaming refuses a previously matching digest',async t=>{
 const f=await fixture();const probe=await open(f.file,'r'),prototype=Object.getPrototypeOf(probe);await probe.close();const read=prototype.read;let changed=false;
 const mock=t.mock.method(prototype,'read',async function(...args){const result=await read.apply(this,args);if(!changed){changed=true;await appendFile(f.file,' changed');}return result;});
 try{await assert.rejects(readProofArtifactDigest(f.file,hash('retained proof')),/PROOF_ARTIFACT_UNVERIFIED/);assert.equal(changed,true);}finally{mock.mock.restore();}
});
