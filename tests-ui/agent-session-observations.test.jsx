import {afterEach,test,expect,vi} from 'vitest';
import {renderHook,act,cleanup}from'@testing-library/react';
import{useAgentSessionObservations,agentRequest}from'../src/runtime/useAgentSessionObservations.js';
const project={projectId:'pp_fixture',generation:1,registration:{workspaceId:'fixture',registryRevision:1,rootIdentity:'a'.repeat(64)}};
// One clock read: two Date.now() calls can straddle a millisecond and make the 30s window 30001ms.
const receipt=(p=project,at=Date.now())=>({...agentRequest(p),executionAuthorized:false,stopped:false,sessions:[{sessionId:'b'.repeat(32),state:'reachable',observedAt:at,expiresAt:at+30000,workVerified:false}]});
afterEach(()=>{cleanup();vi.useRealTimers();});
test('recorded worker failure stays visible alongside a reachable session',()=>{
 const h=renderHook(()=>useAgentSessionObservations(project));const r=receipt();r.workers={poolId:'a'.repeat(64),activeWorkers:1,outcomes:[{workerId:1,state:'failed',code:'AGENT_PLAN_CHANNEL_REFUSED',workVerified:false}],omittedOutcomes:0,durable:false,workVerified:false};
 act(()=>h.result.current.publish(r));expect(h.result.current.label).toBe('1 reachable · 1 recorded failure');expect(h.result.current.reachableCount).toBe(1);
});
test('header labels expire without another check and stop never claims reachable',()=>{
 vi.useFakeTimers();vi.setSystemTime(100000);const h=renderHook(()=>useAgentSessionObservations(project));
 act(()=>h.result.current.publish(receipt()));expect(h.result.current.label).toBe('1 agent reachable');
 act(()=>vi.advanceTimersByTime(30000));expect(h.result.current.reachableCount).toBe(0);expect(h.result.current.label).toBe('No live agent observations');
 act(()=>h.result.current.publish({...receipt(),stopped:true,sessions:[]}));expect(h.result.current.label).toBe('Agents disconnected');
});
test('foreign and duplicate observations fail closed',()=>{
 const h=renderHook(()=>useAgentSessionObservations(project));act(()=>h.result.current.publish(receipt({...project,projectId:'foreign'})));expect(h.result.current.label).toContain('check failed');
 const r=receipt();r.sessions.push({...r.sessions[0]});act(()=>h.result.current.publish(r));expect(h.result.current.reachableCount).toBe(0);
});
test('leaving and returning rejects callbacks from an earlier view',()=>{
 const h=renderHook(({p})=>useAgentSessionObservations(p),{initialProps:{p:project}});const earlier=h.result.current.publish;
 h.rerender({p:{...project,projectId:'other'}});h.rerender({p:project});act(()=>earlier(receipt()));expect(h.result.current.label).toContain('unverified');
});
test('clock rollback does not keep a future observation live',()=>{
 vi.useFakeTimers();vi.setSystemTime(100000);const h=renderHook(()=>useAgentSessionObservations(project));act(()=>h.result.current.publish(receipt()));
 vi.setSystemTime(90000);act(()=>vi.advanceTimersByTime(1000));expect(h.result.current.reachableCount).toBe(0);
});
