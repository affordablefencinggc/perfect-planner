import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareSitesBuild } from "../scripts/prepare-sites-build.mjs";
import {
  PERFORMANCE_BUDGETS,
  verifyPerformanceBudget,
} from "../scripts/verify-performance-budget.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const generationId = "a".repeat(64);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-performance-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "dist", "client", "assets");
  const generation = path.join(
    root,
    "dist",
    "client",
    "generated",
    "generations",
    generationId,
  );
  await mkdir(assets, { recursive: true });
  await mkdir(generation, { recursive: true });
  await mkdir(path.join(root, "worker"), { recursive: true });
  await mkdir(path.join(root, ".openai"), { recursive: true });

  await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>Planner</title>");
  await writeFile(path.join(assets, "app.js"), "export const planner = 'ready';\n");
  await writeFile(path.join(assets, "app.css"), "body { color: #202522; }\n");
  const truth = Buffer.from('{"verdict":"NO-GO"}\n');
  await writeFile(path.join(generation, "truth.json"), truth);
  await writeFile(
    path.join(root, "dist", "client", "generated", "current-generation.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generationId,
        generatedAt: "2026-09-04T00:00:00.000Z",
        directory: `generations/${generationId}`,
        artifacts: [{ name: "truth.json", sha256: sha256(truth), size: truth.length }],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(root, "worker", "index.js"), "export default { fetch() {} };\n");
  await writeFile(
    path.join(root, ".openai", "hosting.json"),
    `${JSON.stringify({ d1: null, r2: null, static: { directory: "dist/client" } })}\n`,
  );
  await prepareSitesBuild(root);
  return root;
}

test("performance verifier measures the real package and accepts the protected fixture", async (t) => {
  const root = await fixture(t);
  const result = await verifyPerformanceBudget(root);
  assert.equal(result.files, 5);
  assert.ok(result.clientBytes > 0);
  assert.equal(result.generationId, generationId);
  assert.equal(result.largestJavaScript.path, "assets/app.js");
  assert.equal(result.largestStylesheet.path, "assets/app.css");
  assert.deepEqual(result.budgets, PERFORMANCE_BUDGETS);
});

test("performance verifier rejects individual and aggregate JavaScript gzip overruns", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    () =>
      verifyPerformanceBudget(root, {
        budgets: { maxIndividualJavaScriptGzipBytes: 1 },
      }),
    /individual JavaScript budget/,
  );

  await writeFile(path.join(root, "dist", "client", "assets", "second.js"), "export default 'another chunk';\n");
  await prepareSitesBuild(root);
  await assert.rejects(
    () =>
      verifyPerformanceBudget(root, {
        budgets: {
          maxIndividualJavaScriptGzipBytes: 1024,
          maxTotalJavaScriptGzipBytes: 1,
        },
      }),
    /aggregate budget/,
  );
});

test("performance verifier rejects stylesheet gzip, package byte, and file-count overruns", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    () =>
      verifyPerformanceBudget(root, {
        budgets: { maxIndividualStylesheetGzipBytes: 1 },
      }),
    /individual stylesheet budget/,
  );
  await assert.rejects(
    () => verifyPerformanceBudget(root, { budgets: { maxClientBytes: 1 } }),
    /exceeds the 1-byte budget/,
  );
  await assert.rejects(
    () => verifyPerformanceBudget(root, { budgets: { maxClientFiles: 1 } }),
    /file-count budget/,
  );
});

test("performance verifier refuses transient cache output and orphan truth generations", async (t) => {
  const cachedRoot = await fixture(t);
  await mkdir(path.join(cachedRoot, "dist", "client", ".cache"));
  await writeFile(path.join(cachedRoot, "dist", "client", ".cache", "stale.tmp.json"), "{}\n");
  await prepareSitesBuild(cachedRoot);
  await assert.rejects(() => verifyPerformanceBudget(cachedRoot), /transient cache output/);

  const orphanedRoot = await fixture(t);
  await mkdir(path.join(orphanedRoot, "dist", "client", "generated", "generations", "orphan"));
  await assert.rejects(
    () => verifyPerformanceBudget(orphanedRoot),
    /orphan or missing generation/,
  );
});

test("performance verifier fails closed when the package diverges from its release manifest", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "dist", "client", "assets", "app.js"), "export default 'changed after packaging';\n");
  await assert.rejects(
    () => verifyPerformanceBudget(root),
    /manifest metadata does not match|manifest hash does not match/,
  );
  const manifest = JSON.parse(
    await readFile(path.join(root, "dist", "release-manifest.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 2);
});
