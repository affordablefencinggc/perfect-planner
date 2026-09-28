import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrchestration,transitionOrchestration} from '../src/engine/orchestrationRounds.js';
const make=()=>createOrchestration({id:'o1',projectId:'p1',goal:'Build the app',participants:[{id:'lead',label:'Lead',providerId:'p',model:'m1'},{id:'jev',label:'Jev',providerId:'q',model:'m2'}],leadId:'lead',reviewerIds:['jev'],maxRounds:2});
const send=(s,e)=>transitionOrchestration(s,{projectId:s.projectId,orchestrationId:s.id,revision:s.revision,...e});
function proposed(){let s=make();for(const id of ['lead','jev'])s=send(s,{type:'output',participantId:id,status:'completed',content:id+' proposal',artifactId:id+'-1'});return s;}
function synthesized(){return send(proposed(),{type:'synthesize',participantId:'lead',content:'Combined proposal',artifactId:'s1',includedArtifactIds:['lead-1','jev-1']});}
test('retains original proposals, Jev disagreement and feedback through optimization',()=>{
 const original=synthesized();let s=send(original,{type:'review',participantId:'jev',synthesisArtifactId:'s1',verdict:'disagree',content:'Test recovery first'});
 s=send(s,{type:'optimize',instruction:'Improve the proposal and address review findings'});
 assert.equal(s.rounds.length,2);assert.equal(s.rounds[1].priorReviews[0].verdict,'disagree');
 assert.equal(s.rounds[0].outputs.length,2);assert.equal(original.rounds[0].reviews.length,0);
 assert.equal(s.rounds[1].previousSynthesisArtifactId,'s1');assert.equal(s.executionAuthorized,false);
});
test('incomplete proposals need explicit partial decision and preserve missing identities',()=>{
 let s=send(make(),{type:'output',participantId:'lead',status:'completed',content:'Proposal',artifactId:'a'});
 const event={type:'synthesize',participantId:'lead',content:'Partial',artifactId:'s',includedArtifactIds:['a']};
 assert.throws(()=>send(s,event),/PARTIAL/);s=send(s,{...event,acceptPartial:true});
 assert.deepEqual(s.rounds[0].synthesis.missingParticipantIds,['jev']);
});
test('rejects stale context, duplicate output, missing sources and wrong reviewer',()=>{
 const s=proposed();assert.throws(()=>send(s,{type:'cancel',projectId:'foreign'}),/STALE_OR_FOREIGN/);
 assert.throws(()=>send(s,{type:'cancel',revision:1}),/STALE_OR_FOREIGN/);
 assert.throws(()=>send(s,{type:'output',participantId:'lead'}),/ALREADY_RECORDED/);
 assert.throws(()=>send(s,{type:'synthesize',participantId:'lead',includedArtifactIds:['lead-1']}),/SOURCES_INCOMPLETE/);
 assert.throws(()=>send(synthesized(),{type:'review',participantId:'lead'}),/REVIEWER_REQUIRED/);
});
test('cancellation stops further transitions and round limits prevent endless optimization',()=>{
 const cancelled=send(make(),{type:'cancel'});assert.throws(()=>send(cancelled,{type:'output'}),/CANCELLED/);
 let s=send(synthesized(),{type:'optimize',instruction:'Improve'});
 s=send(s,{type:'output',participantId:'lead',status:'completed',content:'Better',artifactId:'a2'});
 s=send(s,{type:'synthesize',participantId:'lead',includedArtifactIds:['a2'],acceptPartial:true,content:'Revised',artifactId:'s2'});
 assert.throws(()=>send(s,{type:'optimize',instruction:'Again'}),/ROUND_LIMIT/);
});
