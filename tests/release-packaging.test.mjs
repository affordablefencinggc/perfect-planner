import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareReleaseTruthGeneration,
  publishVerifiedTruthGeneration,
} from "../scripts/generate-truth-report.mjs";
import { prepareSitesBuild } from "../scripts/prepare-sites-build.mjs";
import { verifyReleaseReadiness } from "../scripts/verify-release-readiness.mjs";
import { generateCompletionReport } from "../src/node/completionReport.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-release-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist", "client", "assets"), { recursive: true });
  await mkdir(path.join(root, "public", "generated"), { recursive: true });
  await mkdir(path.join(root, "worker"), { recursive: true });
  await mkdir(path.join(root, ".openai"), { recursive: true });
  await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>Planner</title>");
  await writeFile(path.join(root, "dist", "client", "assets", "app.css"), "body{}\n");
  await writeFile(path.join(root, "worker", "index.js"), "export default { fetch() {} };\n");
  await writeFile(
    path.join(root, ".openai", "hosting.json"),
    `${JSON.stringify({ d1: null, r2: null, static: { directory: "dist/client" } })}\n`,
  );
  await writeFile(path.join(root, "public", "generated", "keep.txt"), "historical evidence\n");
  return root;
}

async function fakeTruthGeneration(_root, options) {
  const cache = path.join(options.outputDirectory, ".cache");
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(path.join(cache, "truth-generation-"));
  const generatedAt = "2026-09-04T00:00:00.000Z";
  const files = {
    "truth-core-report.json": `${JSON.stringify({ schemaVersion: 1, generatedAt })}\n`,
    "completion-report.json": `${JSON.stringify(generateCompletionReport({ planId: "TEST-NO-GO", approved: false, openGates: 0, truthCoreValid: true, ciTier3: "green", completenessReview: true, items: [{ id: "T1", built: true, tested: true, proven: true }] }, { generatedAt }))}\n`,
    "completion-report.md": "# NO-GO\n",
    "evidence-bundle.html": "<!doctype html><title>Evidence</title>",
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(staging, name), value);
  }
  return publishVerifiedTruthGeneration(options.outputDirectory, staging, { generatedAt });
}

async function readyTruthGeneration(_root, options, reportFields = {}) {
  const cache = path.join(options.outputDirectory, ".cache");
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(path.join(cache, "truth-generation-"));
  const generatedAt = "2026-09-04T00:00:00.000Z";
  const files = {
    "truth-core-report.json": `${JSON.stringify({ schemaVersion: 1, generatedAt })}\n`,
    "completion-report.json": `${JSON.stringify({ ...generateCompletionReport({ planId: "TEST-ONLY-SYNTHETIC-GO", title: "Structured synthetic readiness fixture", approved: true, openGates: 0, truthCoreValid: true, ciTier3: "green", completenessReview: true, items: [{ id: "SYNTHETIC-1", title: "Synthetic test conjunction", built: true, tested: true, proven: true }] }, { generatedAt }), ...reportFields })}\n`,
    "completion-report.md": "# GO\n",
    "evidence-bundle.html": "<!doctype html><title>Evidence</title>",
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(staging, name), value);
  }
  return publishVerifiedTruthGeneration(options.outputDirectory, staging, { generatedAt });
}

async function replaceGenerationArtifact(generation, name, value) {
  const pointerPath = path.join(generation.outputDirectory, "current-generation.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  const artifact = pointer.artifacts.find((entry) => entry.name === name);
  assert.ok(artifact, `missing fixture artifact ${name}`);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  await writeFile(path.join(generation.outputDirectory, pointer.directory, name), bytes);
  artifact.size = bytes.length;
  artifact.sha256 = hash(bytes);
  await writeFile(pointerPath, JSON.stringify(pointer));
}

test("release truth output is bounded to one verified generation without touching public history", async (t) => {
  const root = await fixture(t);
  const first = await prepareReleaseTruthGeneration(root, { generate: fakeTruthGeneration });
  await mkdir(path.join(first.outputDirectory, "generations", "orphan"));
  const second = await prepareReleaseTruthGeneration(root, { generate: fakeTruthGeneration });
  const generations = await readdir(path.join(second.outputDirectory, "generations"));
  assert.deepEqual(generations, [second.pointer.generationId]);
  assert.equal(await readFile(path.join(root, "public", "generated", "keep.txt"), "utf8"), "historical evidence\n");
  await assert.rejects(readFile(path.join(second.outputDirectory, ".cache")), /ENOENT/);
});

test("concurrent release truth publishers serialize instead of racing the generated directory", async (t) => {
  const root = await fixture(t);
  let active = 0;
  let maximumActive = 0;
  const delayedGeneration = async (...args) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 80));
    try {
      return await fakeTruthGeneration(...args);
    } finally {
      active -= 1;
    }
  };
  const [first, second] = await Promise.all([
    prepareReleaseTruthGeneration(root, { generate: delayedGeneration }),
    prepareReleaseTruthGeneration(root, { generate: delayedGeneration }),
  ]);
  assert.equal(maximumActive, 1);
  assert.equal(first.pointer.generationId, second.pointer.generationId);
  const generations = await readdir(path.join(second.outputDirectory, "generations"));
  assert.deepEqual(generations, [second.pointer.generationId]);
});

test("release truth preparation refuses a linked generated target", async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "pp-release-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  try {
    await symlink(
      outside,
      path.join(root, "dist", "client", "generated"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Host policy prevents creating a link fixture");
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => prepareReleaseTruthGeneration(root, { generate: fakeTruthGeneration }),
    /real directory/,
  );
  assert.equal(await readdir(outside).then((entries) => entries.length), 0);
});

test("Sites manifest recursively hashes the complete bounded package deterministically", async (t) => {
  const root = await fixture(t);
  await prepareReleaseTruthGeneration(root, { generate: fakeTruthGeneration });
  const first = await prepareSitesBuild(root);
  const second = await prepareSitesBuild(root);
  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.totals.files, first.artifacts.length);
  assert.deepEqual(
    first.artifacts.map((artifact) => artifact.path),
    [...first.artifacts.map((artifact) => artifact.path)].sort(),
  );
  for (const required of [
    "client/index.html",
    "client/assets/app.css",
    "client/generated/current-generation.json",
    "server/index.js",
    ".openai/hosting.json",
  ]) {
    assert.ok(first.artifacts.some((artifact) => artifact.path === required), required);
  }
  const total = first.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  assert.equal(first.totals.bytes, total);
  for (const artifact of first.artifacts) {
    const bytes = await readFile(path.join(root, "dist", artifact.path));
    assert.equal(artifact.sha256, hash(bytes));
  }
  const { manifestSha256, ...body } = first;
  assert.equal(manifestSha256, hash(Buffer.from(JSON.stringify(body))));
});

test("Sites packaging refuses links", async (t) => {
  const linkedRoot = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "pp-sites-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  try {
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(linkedRoot, "dist", "client", "secret.txt"),
      "file",
    );
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Host policy prevents creating a link fixture");
      return;
    }
    throw error;
  }
  await assert.rejects(() => prepareSitesBuild(linkedRoot), /refuses symbolic links/);
});

test("Sites packaging refuses hard file-count overruns", async (t) => {
  const boundedRoot = await fixture(t);
  await assert.rejects(
    () => prepareSitesBuild(boundedRoot, { limits: { maxFiles: 1 } }),
    /exceeds 1 files/,
  );
});

test("release readiness fails closed on NO-GO and accepts only a verified GO generation", async (t) => {
  const root = await fixture(t);
  await prepareReleaseTruthGeneration(root, { generate: fakeTruthGeneration });
  await assert.rejects(() => verifyReleaseReadiness(root), /Release blocked/);
  await prepareReleaseTruthGeneration(root, { generate: readyTruthGeneration });
  const result = await verifyReleaseReadiness(root);
  assert.equal(result.verdict, "GO");
  assert.match(result.generationId, /^[a-f0-9]{64}$/);
});

test("release readiness refuses a GO report with malformed blockers", async (t) => {
  const root = await fixture(t);
  await prepareReleaseTruthGeneration(root, {
    generate: (directory, options) => readyTruthGeneration(directory, options, { blockers: null }),
  });
  await assert.rejects(() => verifyReleaseReadiness(root), /schema is invalid/);
});

test("release readiness rejects a minimal forged GO shape even when its manifest hash matches", async (t) => {
  const root = await fixture(t);
  const generation = await prepareReleaseTruthGeneration(root, { generate: readyTruthGeneration });
  await replaceGenerationArtifact(generation, "completion-report.json", {
    schemaVersion: 1,
    generatedAt: generation.pointer.generatedAt,
    verdict: "GO",
    ready: true,
    blockers: [],
  });
  await assert.rejects(() => verifyReleaseReadiness(root), /schema is invalid/);
});

test("release readiness binds the truth-core report to the selected generation", async (t) => {
  const root = await fixture(t);
  const generation = await prepareReleaseTruthGeneration(root, { generate: readyTruthGeneration });
  await replaceGenerationArtifact(generation, "truth-core-report.json", {
    schemaVersion: 1,
    generatedAt: "2026-09-03T00:00:00.000Z",
  });
  await assert.rejects(() => verifyReleaseReadiness(root), /does not match the current generation/);
});

test("release readiness refuses duplicate completion report entries", async (t) => {
  const root = await fixture(t);
  const generation = await prepareReleaseTruthGeneration(root, { generate: readyTruthGeneration });
  const pointerPath = path.join(generation.outputDirectory, "current-generation.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  pointer.artifacts.push(pointer.artifacts.find((entry) => entry.name === "completion-report.json"));
  await writeFile(pointerPath, JSON.stringify(pointer));
  await assert.rejects(() => verifyReleaseReadiness(root), /manifest is invalid/);
});

for (const ancestor of ["dist", "generations", "generation"]) {
  test(`release readiness refuses redirected ${ancestor} even with intact report hashes`, async (t) => {
    const root = await fixture(t);
    const generation = await prepareReleaseTruthGeneration(root, { generate: readyTruthGeneration });
    const redirected = ancestor === "dist" ? path.join(root, "dist")
      : ancestor === "generations" ? path.join(generation.outputDirectory, "generations")
      : path.join(generation.outputDirectory, "generations", generation.pointer.generationId);
    const outside = await mkdtemp(path.join(os.tmpdir(), "pp-readiness-redirect-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const moved = path.join(outside, "original");
    await rename(redirected, moved);
    try {
      await symlink(moved, redirected, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error.code === "EPERM") return t.skip("Host policy prevents creating a link fixture");
      throw error;
    }
    await assert.rejects(() => verifyReleaseReadiness(root), /real directory|redirected path/);
  });
}
