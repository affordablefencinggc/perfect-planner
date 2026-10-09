import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlanningApprovalRecovery} from '../src/project/planningApprovalRecovery.js';
import {createImportedProjectId} from '../src/project/projectIds.js';

test('recovery notification hints match the full binding and unsubscribe both transports',async t=>{
 const previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),previousChannel=Object.getOwnPropertyDescriptor(globalThis,'BroadcastChannel');
 const listeners=new Map(),channels=[];
 Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener:(name,listener)=>listeners.set(name,listener),removeEventListener:(name,listener)=>{if(listeners.get(name)===listener)listeners.delete(name);}}});
 Object.defineProperty(globalThis,'BroadcastChannel',{configurable:true,value:class{constructor(name){this.name=name;this.closed=false;channels.push(this);}close(){this.closed=true;}}});
 t.after(()=>{if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else delete globalThis.window;if(previousChannel)Object.defineProperty(globalThis,'BroadcastChannel',previousChannel);else delete globalThis.BroadcastChannel;});
 const rootIdentity='a'.repeat(64),binding={projectId:createImportedProjectId(rootIdentity),rootIdentity,censusDigest:'b'.repeat(64)},recovery=createPlanningApprovalRecovery({indexedDB:null,name:'notification-test'});let calls=0;
 const unsubscribe=recovery.subscribe(binding,()=>calls++),local=listeners.get('notification-test:changed');
 for(const bad of [{...binding,censusDigest:'c'.repeat(64)},{...binding,rootIdentity:'d'.repeat(64)},{...binding,projectId:'other'},null]){local({detail:{binding:bad}});channels[0].onmessage({data:{binding:bad}});}
 assert.equal(calls,0);local({detail:{binding}});channels[0].onmessage({data:{binding}});assert.equal(calls,2);
 unsubscribe();assert.equal(listeners.size,0);assert.equal(channels[0].closed,true);await recovery.close();
});

test('recovery notification subscription rejects malformed identity without opening storage',()=>{
 let opens=0;const recovery=createPlanningApprovalRecovery({indexedDB:{open(){opens++;throw Error('must not open');}}});
 assert.throws(()=>recovery.subscribe({projectId:'bad',rootIdentity:'a',censusDigest:'b'},()=>{}));assert.equal(opens,0);
});
