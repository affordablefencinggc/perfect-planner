import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { taskObservationVitePlugin } from '../src/node/taskObservationVitePlugin.mjs';
import { emptyTaskDraftLedger } from '../src/project/taskDraftLedger.js';

test('host revocation cuts off existing readers and survives new server creation',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'pp-observation-revoke-'));
  const journalPath=path.join(folder,'journal.jsonl');await writeFile(journalPath,'');
  const projectId='pp_vite_revoke',rootIdentity='a'.repeat(64);
  const ledger=emptyTaskDraftLedger({projectId,rootIdentity,censusDigest:'b'.repeat(64)});
  const plugin=taskObservationVitePlugin({bindings:[{projectId,rootIdentity,journalPath}]});
  const servers=[];
  const open=async()=>{
    const server=await createServer({configFile:false,logLevel:'silent',plugins:[plugin],server:{host:'127.0.0.1',port:0,watch:null},optimizeDeps:{noDiscovery:true,include:[]}});
    servers.push(server);await server.listen();
    const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
    // Each server generation gets a fresh HTTP connection, not a pooled socket
    // retained by Node fetch after the previous listener closed on this port.
    const session=await (await fetch(origin+'/api/task-run-observations/session',{method:'POST',headers:{origin,connection:'close'}})).json();
    return ()=>fetch(origin+'/api/task-run-observations/read',{method:'POST',headers:{origin,connection:'close','content-type':'application/json','x-pp-observation-token':session.token},body:JSON.stringify({ledger})});
  };
  try{
    const first=await open(),second=await open();
    for(const read of [first,second]){const response=await read();assert.equal(response.status,200);assert.deepEqual((await response.json()).runs,[]);}
    plugin.api.revoke(projectId);
    for(const read of [first,second]){const response=await read();assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'OBSERVATIONS_NOT_CONFIGURED'});}
    await Promise.all(servers.map(server=>server.close()));
    const restarted=await open(),response=await restarted();
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'OBSERVATIONS_NOT_CONFIGURED'});
  }finally{await Promise.all(servers.map(server=>server.close()));}
});

test('malformed optional configuration does not prevent Vite startup',async()=>{
  const previous=process.env.PP_TASK_OBSERVATION_BINDINGS;
  let plugin;
  try{process.env.PP_TASK_OBSERVATION_BINDINGS='{broken';plugin=taskObservationVitePlugin();}
  finally{if(previous===undefined)delete process.env.PP_TASK_OBSERVATION_BINDINGS;else process.env.PP_TASK_OBSERVATION_BINDINGS=previous;}
  assert.doesNotThrow(()=>plugin.api.revoke('pp_removed'));
  const server=await createServer({configFile:false,logLevel:'silent',plugins:[plugin],server:{host:'127.0.0.1',port:0,watch:null},optimizeDeps:{noDiscovery:true,include:[]}});
  try{
    await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
    const response=await fetch(origin+'/api/task-run-observations/session',{method:'POST',headers:{origin}});
    assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(await response.text(),'Observation configuration unavailable');
  }finally{await server.close();}
});

test('plugin can serve a new Vite host after its previous host closes',async()=>{
  const plugin=taskObservationVitePlugin({bindings:[]});
  for(let attempt=0;attempt<2;attempt++){
    const server=await createServer({configFile:false,logLevel:'silent',plugins:[plugin],server:{host:'127.0.0.1',port:0,watch:null},optimizeDeps:{noDiscovery:true,include:[]}});
    try{
      await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
      const response=await fetch(origin+'/api/task-run-observations/session',{method:'POST',headers:{origin}});
      assert.equal(response.status,200);assert.equal((await response.json()).executionAuthorized,false);
    }finally{await server.close();}
  }
});

test('actual Vite host mounts same-origin POST bootstrap and explicit unconfigured state',async()=>{
  const plugin=taskObservationVitePlugin({bindings:[]});
  const server=await createServer({configFile:false,root:process.cwd(),logLevel:'silent',plugins:[plugin],server:{host:'127.0.0.1',port:0,watch:null},optimizeDeps:{noDiscovery:true,include:[]}});
  try{
    await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
    const bootstrap=await fetch(origin+'/api/task-run-observations/session',{method:'POST',headers:{origin}});
    assert.equal(bootstrap.status,200);const session=await bootstrap.json();
    const ledger=emptyTaskDraftLedger({projectId:'pp_vite_fixture',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)});
    const reply=await fetch(origin+'/api/task-run-observations/read',{method:'POST',headers:{origin,'content-type':'application/json','x-pp-observation-token':session.token},body:JSON.stringify({ledger})});
    assert.equal(reply.status,503);assert.deepEqual(await reply.json(),{error:'OBSERVATIONS_NOT_CONFIGURED'});
    assert.equal((await fetch(origin+'/api/task-run-observations/session',{method:'POST',headers:{origin:'http://foreign.invalid'}})).status,403);
  }finally{await server.close();}
});
