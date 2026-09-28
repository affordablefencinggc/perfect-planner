import test from 'node:test';
import assert from 'node:assert/strict';
import { planTaskRoutes } from '../src/engine/sonarEngine.js';

const context = { projectId: 'project-a', taskId: 'collect-records', revision: 2, goal: 'Bring records together', task: 'Find the records' };
const source = (id, state) => ({ id, state, label: id, projectId: 'project-a', revision: 2, adapterId: 'files', scope: 'read', capability: 'Records for the selected period' });

test('missing inputs produce an actionable planning path and map, not a terminal blocked report', () => {
  const plan = planTaskRoutes(context);
  assert.equal(plan.routes[0].id, 'inventory');
  assert.equal(plan.status, 'PLAN_DRAFT');
  assert.deepEqual(plan.map.edges, [{ from: 'goal', to: 'task', kind: 'task' }, { from: 'task', to: 'inventory', kind: 'alternative' }]);
  assert.equal(plan.executionAuthorized, false);
});

test('ranks usable access, local input and new connections with explicit fallback and exact scope', () => {
  const plan = planTaskRoutes({ ...context, sources: [source('new', 'connectable'), source('missing', 'unavailable'), source('local', 'local'), source('existing', 'connected')] });
  assert.deepEqual(plan.routes.map(r => r.id), ['source-existing', 'source-local', 'source-new', 'inventory', 'source-missing']);
  for (const route of plan.routes.filter(r => r.action)) {
    assert.equal(route.action.projectId, context.projectId);
    assert.equal(route.action.revision, context.revision);
    assert.equal(route.action.taskId, context.taskId);
    assert.equal(route.action.requiresCapabilityRecheck, true);
    assert.equal(route.action.executionAuthorized, false);
    assert.equal(route.fallbackId, 'inventory');
  }
  assert.equal(plan.routes.at(-1).action, null);
});

test('missing adapters do not produce fake connection actions', () => {
  const candidate = source('drive', 'connectable'); delete candidate.adapterId;
  const plan = planTaskRoutes({ ...context, sources: [candidate] });
  assert.equal(plan.routes[1].state, 'unavailable');
  assert.equal(plan.routes[1].action, null);
});

test('rejects foreign projects, stale revisions, duplicate identities and invalid scope', () => {
  for (const change of [{projectId:'other'}, {revision:1}, {scope:'admin'}])
    assert.throws(() => planTaskRoutes({...context, sources:[{...source('a','connected'), ...change}]}), /SONAR_SOURCE_INVALID/);
  assert.throws(() => planTaskRoutes({...context, sources:[source('a','local'),source('a','local')]}), /SONAR_SOURCE_INVALID/);
  assert.throws(() => planTaskRoutes({...context,revision:0}), /SONAR_TASK_CONTEXT_REQUIRED/);
});

test('map edges resolve and order does not depend on source input order', () => {
  const sources=[source('b','local'),source('a','local')];
  const first=planTaskRoutes({...context,sources});
  assert.deepEqual(first,planTaskRoutes({...context,sources:[...sources].reverse()}));
  const nodes=new Set(first.map.nodes.map(n=>n.id));
  for(const edge of first.map.edges) { assert.ok(nodes.has(edge.from)); assert.ok(nodes.has(edge.to)); }
});
