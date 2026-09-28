import assert from "node:assert/strict";
import test from "node:test";
import { assessDependencyConnectionMap, dependencyConnectionSeed } from "../src/engine/folderDependencyContract.js";

// Proves the C010 folder structure contract connection surface fails closed.

test("dependency map preserves the three ordered layers and exact live/open connections", () => {
  const map = assessDependencyConnectionMap(dependencyConnectionSeed, { D05: "live", D06: "live" });
  assert.deepEqual(map.layers, ["credentials", "middleware", "third-party"]);
  assert.equal(map.nodes.find((node) => node.id === "D06").state, "live");
  assert.equal(map.edges.find((edge) => edge.from === "D05" && edge.to === "D06").state, "connected");
  assert.ok(map.connectedPercentage > 0 && map.connectedPercentage < 100);
});

test("unknown states, duplicate nodes, missing endpoints, and reverse-layer edges fail closed", () => {
  assert.throws(() => assessDependencyConnectionMap(dependencyConnectionSeed, { D05: "green" }), /unsupported/);
  for (const mutate of [
    (value) => value.nodes.push({ ...value.nodes[0] }),
    (value) => value.edges.push({ from: "D01", to: "D99" }),
    (value) => value.edges.push({ from: "D10", to: "D05" }),
  ]) { const value = structuredClone(dependencyConnectionSeed); mutate(value); assert.throws(() => assessDependencyConnectionMap(value)); }
});
