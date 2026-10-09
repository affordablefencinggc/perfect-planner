import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { appMapRegistry } from "../src/engine/appMapRegistry.js";
import { assessMapCoverage } from "../src/engine/mapCoverageEngine.js";
import { censusRepository } from "../src/node/repositoryCensus.mjs";

test("the live repository census is classified exactly once by the connected app atlas", async () => {
  const census = await censusRepository(".", { maxFiles: 3000, maxBytes: 2_000_000 });
  const result = assessMapCoverage(census.files.map((file) => file.path), appMapRegistry);

  assert.equal(result.verdict, "COMPLETE", result.blockers.join("\n"));
  assert.equal(result.coverage.percentage, 100);
  assert.equal(result.coverage.missing, 0);
  assert.equal(result.coverage.ambiguous, 0);
  assert.equal(result.reachableMaps.length, appMapRegistry.maps.length);
});

test("an unmapped live artifact makes the atlas incomplete", () => {
  const result = assessMapCoverage(["src/unknown/new-surface.js"], {
    schemaVersion: 1,
    atlasId: "M00",
    maps: [{ id: "M00", title: "Atlas", portals: [] }],
    components: [],
    supporting: { exact: [], prefixes: [] },
  });

  assert.equal(result.verdict, "INCOMPLETE");
  assert.deepEqual(result.missing, ["src/unknown/new-surface.js"]);
});

test("two component owners for one artifact are refused", () => {
  const registry = {
    schemaVersion: 1,
    atlasId: "M00",
    maps: [{ id: "M00", title: "Atlas", portals: [] }],
    components: [
      { id: "C001", maps: ["M00"], artifacts: ["src/shared.js"] },
      { id: "C002", maps: ["M00"], artifacts: ["src/shared.js"] },
    ],
    supporting: { exact: [], prefixes: [] },
  };

  const result = assessMapCoverage(["src/shared.js"], registry);
  assert.equal(result.verdict, "INCOMPLETE");
  assert.deepEqual(result.ambiguous, [{ path: "src/shared.js", owners: ["C001", "C002"] }]);
});

test("unknown and unreachable map portals are explicit blockers", () => {
  const result = assessMapCoverage([], {
    schemaVersion: 1,
    atlasId: "M00",
    maps: [
      { id: "M00", title: "Atlas", portals: ["M99"] },
      { id: "M01", title: "Orphan", portals: [] },
    ],
    components: [],
    supporting: { exact: [], prefixes: [] },
  });

  assert.equal(result.verdict, "INCOMPLETE");
  assert.match(result.blockers.join("\n"), /unknown map M99/);
  assert.match(result.blockers.join("\n"), /M01 is not reachable/);
});

test("a registered artifact missing from the census is a stale-map blocker", () => {
  const result = assessMapCoverage([], {
    schemaVersion: 1,
    atlasId: "M00",
    maps: [{ id: "M00", title: "Atlas", portals: [] }],
    components: [{ id: "C001", maps: ["M00"], artifacts: ["src/stale.js"] }],
    supporting: { exact: [], prefixes: [] },
  });

  assert.equal(result.verdict, "INCOMPLETE");
  assert.match(result.blockers.join("\n"), /does not exist in the current census/);
});
