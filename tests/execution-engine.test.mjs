import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { classifySession, deriveExecutionMap } from "../src/engine/executionEngine.js";
import { claimsConflict } from "../src/engine/collisionEngine.js";

const now = Date.parse("2026-09-02T10:00:00.000Z");

test('nested glob claims serialize regardless of which task has the parent claim', () => {
  for (const surfaces of [['src/*','src/nested/*'],['src/nested/**','src/**']]) {
    const tasks = surfaces.map((surface, index) => ({ taskId: `T${index}`, dependsOn: [], claims: [{ kind: 'file', surface, access: 'write' }] }));
    const result = deriveExecutionMap({ schemaVersion: 1, planId: 'PP-GLOB', tasks });
    assert.equal(result.valid,true); assert.equal(result.peakParallelism,1);
  }
});

test("a bridging task joins every conflicting lane, not just the first", () => {
  const task = (taskId, surfaces) => ({ taskId, dependsOn: [], claims: surfaces.map(surface => ({ kind: 'file', surface, access: 'write' })) });
  const tasks = [task('A', ['src/a.ts']), task('B', ['src/b.ts']), task('C', ['src/a.ts', 'src/b.ts']), task('D', ['src/d.ts'])];
  const result = deriveExecutionMap({ schemaVersion: 1, planId: 'PP-BRIDGE', tasks });
  assert.equal(result.valid, true);
  assert.deepEqual(result.waves[0].lanes.map(lane => lane.tasks.map(task => task.taskId)), [['A', 'B', 'C'], ['D']]);
  assert.equal(result.peakParallelism, 2);
  assert.deepEqual(deriveExecutionMap({ schemaVersion: 1, planId: 'PP-BRIDGE', tasks: [...tasks].reverse() }).waves, result.waves);
});

test("no conflicting pair occupies separate parallel lanes across generated claim graphs", () => {
  // Exhaust all undirected conflict graphs on four tasks, including bridges.
  const pairs = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
  for (let mask = 0; mask < 64; mask += 1) {
    const tasks = Array.from({ length: 4 }, (_, i) => ({ taskId: `T${i}`, dependsOn: [], claims: [{ kind: 'file', surface: `src/own-${i}.ts`, access: 'write' }] }));
    pairs.forEach(([a,b], edge) => {
      if (mask & (1 << edge)) for (const i of [a,b]) tasks[i].claims.push({ kind: 'api', surface: `POST /edge-${edge}`, access: 'write' });
    });
    const result = deriveExecutionMap({ schemaVersion: 1, planId: 'PP-GRAPH', tasks });
    assert.equal(result.valid, true);
    const lanes = result.waves[0].lanes;
    assert.equal(lanes.flatMap(lane => lane.tasks).length, tasks.length);
    for (let a = 0; a < lanes.length; a += 1) for (let b = a + 1; b < lanes.length; b += 1) {
      for (const left of lanes[a].tasks) for (const right of lanes[b].tasks) {
        assert.equal(left.claims.some(x => right.claims.some(y => claimsConflict(x,y))), false, `mask=${mask}: ${left.taskId}/${right.taskId}`);
      }
    }
  }
});

test("read-only overlap remains parallel until a writer bridges readers", () => {
  const tasks = ['A','B'].map(taskId => ({ taskId, dependsOn: [], claims: [{ kind: 'file', surface: 'src/shared.ts', access: 'read' }] }));
  const manifest = { schemaVersion: 1, planId: 'PP-READ', tasks };
  assert.equal(deriveExecutionMap(manifest).peakParallelism, 2);
  const writer = { taskId: 'C', dependsOn: [], claims: [{ kind: 'file', surface: 'src/shared.ts', access: 'write' }] };
  assert.equal(deriveExecutionMap({ ...manifest, tasks: [...tasks, writer] }).peakParallelism, 1);
});

test("classifies fresh, stale, and gone sessions with fixed thresholds", () => {
  assert.equal(classifySession("2026-09-02T09:55:00.000Z", now), "active");
  assert.equal(classifySession("2026-09-02T09:40:00.000Z", now), "stale");
  assert.equal(classifySession("2026-08-31T09:00:00.000Z", now), "gone");
});

test("derives dependency waves and keeps conflicting work in one sequential lane", () => {
  const result = deriveExecutionMap({ schemaVersion: 1, planId: "PP-MAP", tasks: [
    { taskId: "A", estimateMinutes: 20, dependsOn: [], claims: [{ kind: "file", surface: "src/shared.ts", access: "write" }] },
    { taskId: "B", estimateMinutes: 30, dependsOn: [], claims: [{ kind: "file", surface: "src/shared.ts", access: "write" }] },
    { taskId: "C", estimateMinutes: 40, dependsOn: [], claims: [{ kind: "file", surface: "src/free.ts", access: "write" }] },
    { taskId: "D", estimateMinutes: 10, dependsOn: ["A"], claims: [{ kind: "api", surface: "POST /ship", access: "write" }] },
  ] });
  assert.equal(result.valid, true);
  assert.deepEqual(result.waves[0].lanes.map((lane) => lane.tasks.map((task) => task.taskId)), [["A", "B"], ["C"]]);
  assert.deepEqual(result.waves[1].lanes[0].tasks.map((task) => task.taskId), ["D"]);
  assert.equal(result.peakParallelism, 2);
});

test("reports hotspots and a measured critical path", () => {
  const result = deriveExecutionMap({ schemaVersion: 1, planId: "PP-PATH", tasks: [
    { taskId: "A", estimateMinutes: 25, dependsOn: [], claims: [{ kind: "database", surface: "public.plans", access: "write" }] },
    { taskId: "B", estimateMinutes: 45, dependsOn: ["A"], claims: [{ kind: "database", surface: "public.plans", access: "read" }] },
    { taskId: "C", estimateMinutes: 10, dependsOn: [], claims: [{ kind: "file", surface: "src/c.ts", access: "write" }] },
  ] });
  assert.deepEqual(result.criticalPath, { minutes: 70, path: ["A", "B"] });
  assert.equal(result.hotspots[0].surface, "database:public.plans");
});
