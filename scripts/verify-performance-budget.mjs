#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const PERFORMANCE_BUDGETS = Object.freeze({
  maxIndividualJavaScriptGzipBytes: 300 * 1024,
  // v1 (Oct 2026): totals raised for the seven on-demand imported-project panels; first-load limits unchanged.
  // Core loop screens (Oct 2026): raised again for six on-demand core screens; first-load limits unchanged.
  maxTotalJavaScriptGzipBytes: 512 * 1024,
  maxIndividualStylesheetGzipBytes: 44 * 1024,
  // UI polish (Oct 2026): total raised for the page frame and per-screen polish layers; the per-file limit is unchanged.
  // Core loop screens (Oct 2026): raised for their on-demand stylesheets.
  maxTotalStylesheetGzipBytes: 80 * 1024,
  maxClientBytes: 14 * 1024 * 1024,
  maxClientFiles: 200, // raised from 160 when v1 feature panels moved to on-demand chunks
});

const SCAN_CEILINGS = Object.freeze({
  maxDirectories: 512,
  maxDepth: 32,
  maxPathLength: 4096,
  maxFileBytes: 64 * 1024 * 1024,
  maxDurationMs: 30_000,
});

const GENERATED_POINTER = "generated/current-generation.json";
const GENERATED_ROOT = "generated";
const GENERATIONS_ROOT = "generated/generations";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const codepointSort = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asPosix = (value) => value.split(path.sep).join("/");
const formatBytes = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

function validatePositiveIntegers(values, label) {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid ${label}: ${name}.`);
    }
  }
}

function checkDeadline(startedAt, ceilings) {
  if (Date.now() - startedAt > ceilings.maxDurationMs) {
    throw new Error(`Performance scan exceeded ${ceilings.maxDurationMs}ms.`);
  }
}

async function requireRealDirectory(directory, label) {
  let entry;
  try {
    entry = await lstat(directory);
  } catch {
    throw new Error(`Missing performance input: ${label}.`);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Performance input must be a real directory: ${label}.`);
  }
  return realpath(directory);
}

async function requireRegularFile(filePath, label, ceilings) {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch {
    throw new Error(`Missing performance input: ${label}.`);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Performance input must be a regular file: ${label}.`);
  }
  if (entry.size > ceilings.maxFileBytes) {
    throw new Error(`Performance input exceeds the scan file ceiling: ${label}.`);
  }
  return entry;
}

async function scanClient(client, budgets, ceilings, startedAt) {
  const files = [];
  const stack = [{ absolute: client, relative: "", depth: 0 }];
  let directoryCount = 1;
  let totalBytes = 0;

  while (stack.length) {
    checkDeadline(startedAt, ceilings);
    const current = stack.pop();
    if (current.depth > ceilings.maxDepth) {
      throw new Error(`Client package depth exceeds ${ceilings.maxDepth}.`);
    }
    const entries = await readdir(current.absolute, { withFileTypes: true });
    entries.sort((left, right) => codepointSort(left.name, right.name));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      checkDeadline(startedAt, ceilings);
      const entry = entries[index];
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (absolute.length > ceilings.maxPathLength) {
        throw new Error(`Client package path exceeds ${ceilings.maxPathLength} characters.`);
      }
      if (relative.split("/").includes(".cache") || entry.name.endsWith(".tmp")) {
        throw new Error(`Client package contains transient cache output: ${relative}.`);
      }
      const inspected = await lstat(absolute);
      if (inspected.isSymbolicLink()) {
        throw new Error(`Client package refuses symbolic links: ${relative}.`);
      }
      if (inspected.isDirectory()) {
        directoryCount += 1;
        if (directoryCount > ceilings.maxDirectories) {
          throw new Error(`Client package exceeds ${ceilings.maxDirectories} directories.`);
        }
        stack.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!inspected.isFile()) {
        throw new Error(`Client package refuses special files: ${relative}.`);
      }
      if (inspected.size > ceilings.maxFileBytes) {
        throw new Error(`Client package file exceeds the scan ceiling: ${relative}.`);
      }
      totalBytes += inspected.size;
      if (totalBytes > budgets.maxClientBytes) {
        throw new Error(
          `Client package is ${totalBytes} bytes and exceeds the ${budgets.maxClientBytes}-byte budget.`,
        );
      }
      files.push({ absolute, path: relative, bytes: inspected.size });
      if (files.length > budgets.maxClientFiles) {
        throw new Error(
          `Client package has more than ${budgets.maxClientFiles} files and exceeds the file-count budget.`,
        );
      }
    }
  }

  files.sort((left, right) => codepointSort(left.path, right.path));
  return { files, totalBytes };
}

async function verifyGeneratedRelease(client, scannedFiles, ceilings, startedAt) {
  const generatedDirectory = path.join(client, GENERATED_ROOT);
  await requireRealDirectory(generatedDirectory, "dist/client/generated");
  const generatedEntries = await readdir(generatedDirectory, { withFileTypes: true });
  generatedEntries.sort((left, right) => codepointSort(left.name, right.name));
  if (
    generatedEntries.length !== 2 ||
    generatedEntries[0]?.name !== "current-generation.json" ||
    !generatedEntries[0].isFile() ||
    generatedEntries[1]?.name !== "generations" ||
    !generatedEntries[1].isDirectory()
  ) {
    throw new Error(
      "Generated release must contain only current-generation.json and the generations directory.",
    );
  }

  const pointerPath = path.join(client, GENERATED_POINTER);
  await requireRegularFile(pointerPath, GENERATED_POINTER, ceilings);
  let pointer;
  try {
    pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  } catch {
    throw new Error("Generated release pointer is not valid JSON.");
  }
  checkDeadline(startedAt, ceilings);
  if (!HASH_PATTERN.test(pointer?.generationId ?? "")) {
    throw new Error("Generated release pointer has an invalid generationId.");
  }
  const expectedDirectory = `generations/${pointer.generationId}`;
  if (pointer.directory !== expectedDirectory) {
    throw new Error("Generated release pointer directory does not match its generationId.");
  }
  if (!Array.isArray(pointer.artifacts) || pointer.artifacts.length === 0) {
    throw new Error("Generated release pointer has no artifact inventory.");
  }

  const generationsDirectory = path.join(client, GENERATIONS_ROOT);
  await requireRealDirectory(generationsDirectory, "dist/client/generated/generations");
  const generations = await readdir(generationsDirectory, { withFileTypes: true });
  if (
    generations.length !== 1 ||
    generations[0].name !== pointer.generationId ||
    !generations[0].isDirectory() ||
    generations[0].isSymbolicLink()
  ) {
    throw new Error("Generated release contains an orphan or missing generation.");
  }

  const generationDirectory = await requireRealDirectory(
    path.join(generationsDirectory, pointer.generationId),
    `dist/client/${expectedDirectory}`,
  );
  const artifactEntries = await readdir(generationDirectory, { withFileTypes: true });
  const expectedNames = [];
  const seenNames = new Set();
  for (const artifact of pointer.artifacts) {
    if (
      typeof artifact?.name !== "string" ||
      path.basename(artifact.name) !== artifact.name ||
      artifact.name === "." ||
      artifact.name === ".." ||
      seenNames.has(artifact.name) ||
      !HASH_PATTERN.test(artifact.sha256 ?? "") ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0
    ) {
      throw new Error("Generated release pointer contains an invalid artifact record.");
    }
    seenNames.add(artifact.name);
    expectedNames.push(artifact.name);
    const artifactPath = path.join(generationDirectory, artifact.name);
    const entry = await requireRegularFile(artifactPath, `${expectedDirectory}/${artifact.name}`, ceilings);
    if (entry.size !== artifact.size) {
      throw new Error(`Generated release artifact size changed: ${artifact.name}.`);
    }
    const bytes = await readFile(artifactPath);
    checkDeadline(startedAt, ceilings);
    if (sha256(bytes) !== artifact.sha256) {
      throw new Error(`Generated release artifact hash changed: ${artifact.name}.`);
    }
  }
  expectedNames.sort(codepointSort);
  const actualNames = artifactEntries.map((entry) => entry.name).sort(codepointSort);
  if (artifactEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Generated release generation contains a non-file artifact.");
  }
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Generated release generation contains an orphan or missing artifact.");
  }

  const paths = new Set(scannedFiles.map((file) => file.path));
  if (!paths.has(GENERATED_POINTER)) {
    throw new Error("Generated release pointer was not included in the client scan.");
  }
  return pointer.generationId;
}

async function verifyReleaseManifest(projectRoot, scannedFiles, totalBytes, ceilings, startedAt) {
  const manifestPath = path.join(projectRoot, "dist", "release-manifest.json");
  await requireRegularFile(manifestPath, "dist/release-manifest.json", ceilings);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("Release manifest is not valid JSON.");
  }
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.artifacts)) {
    throw new Error("Release manifest schema is unsupported.");
  }
  const { manifestSha256, ...manifestBody } = manifest;
  if (!HASH_PATTERN.test(manifestSha256 ?? "") || sha256(Buffer.from(JSON.stringify(manifestBody))) !== manifestSha256) {
    throw new Error("Release manifest integrity hash is invalid.");
  }
  const uniqueArtifactPaths = new Set(manifest.artifacts.map((artifact) => artifact?.path));
  const manifestTotalBytes = manifest.artifacts.reduce(
    (total, artifact) => total + (Number.isSafeInteger(artifact?.bytes) ? artifact.bytes : Number.NaN),
    0,
  );
  if (
    uniqueArtifactPaths.size !== manifest.artifacts.length ||
    manifest?.totals?.files !== manifest.artifacts.length ||
    manifest?.totals?.bytes !== manifestTotalBytes
  ) {
    throw new Error("Release manifest totals or artifact inventory are invalid.");
  }

  const clientArtifacts = new Map();
  for (const artifact of manifest.artifacts) {
    if (typeof artifact?.path !== "string" || !artifact.path.startsWith("client/")) continue;
    const relative = artifact.path.slice("client/".length);
    if (clientArtifacts.has(relative)) {
      throw new Error(`Release manifest contains duplicate client artifact: ${relative}.`);
    }
    clientArtifacts.set(relative, artifact);
  }
  if (clientArtifacts.size !== scannedFiles.length) {
    throw new Error("Release manifest client inventory does not match dist/client.");
  }

  for (const file of scannedFiles) {
    const artifact = clientArtifacts.get(file.path);
    if (!artifact || artifact.bytes !== file.bytes || !HASH_PATTERN.test(artifact.sha256 ?? "")) {
      throw new Error(`Release manifest metadata does not match client artifact: ${file.path}.`);
    }
    const bytes = await readFile(file.absolute);
    checkDeadline(startedAt, ceilings);
    if (sha256(bytes) !== artifact.sha256) {
      throw new Error(`Release manifest hash does not match client artifact: ${file.path}.`);
    }
  }

  const manifestClientBytes = [...clientArtifacts.values()].reduce(
    (total, artifact) => total + artifact.bytes,
    0,
  );
  if (manifestClientBytes !== totalBytes) {
    throw new Error("Release manifest client byte total does not match dist/client.");
  }
}

async function measureCompressedAssets(scannedFiles, budgets, ceilings, startedAt) {
  const javascript = [];
  const stylesheets = [];
  for (const file of scannedFiles) {
    const extension = path.extname(file.path).toLowerCase();
    if (extension !== ".js" && extension !== ".css") continue;
    const bytes = await readFile(file.absolute);
    checkDeadline(startedAt, ceilings);
    const gzipBytes = gzipSync(bytes, { level: 9 }).length;
    const record = { path: file.path, rawBytes: file.bytes, gzipBytes };
    if (extension === ".js") javascript.push(record);
    else stylesheets.push(record);
  }
  if (javascript.length === 0 || stylesheets.length === 0) {
    throw new Error("Client package must contain JavaScript and stylesheet assets.");
  }

  const jsTotal = javascript.reduce((total, item) => total + item.gzipBytes, 0);
  const cssTotal = stylesheets.reduce((total, item) => total + item.gzipBytes, 0);
  const largestJs = javascript.reduce((largest, item) =>
    item.gzipBytes > largest.gzipBytes ? item : largest,
  );
  const largestCss = stylesheets.reduce((largest, item) =>
    item.gzipBytes > largest.gzipBytes ? item : largest,
  );

  const failures = [];
  if (largestJs.gzipBytes > budgets.maxIndividualJavaScriptGzipBytes) {
    failures.push(
      `${largestJs.path} is ${largestJs.gzipBytes} gzip bytes; individual JavaScript budget is ${budgets.maxIndividualJavaScriptGzipBytes}.`,
    );
  }
  if (jsTotal > budgets.maxTotalJavaScriptGzipBytes) {
    failures.push(
      `JavaScript totals ${jsTotal} gzip bytes; aggregate budget is ${budgets.maxTotalJavaScriptGzipBytes}.`,
    );
  }
  if (largestCss.gzipBytes > budgets.maxIndividualStylesheetGzipBytes) {
    failures.push(
      `${largestCss.path} is ${largestCss.gzipBytes} gzip bytes; individual stylesheet budget is ${budgets.maxIndividualStylesheetGzipBytes}.`,
    );
  }
  if (cssTotal > budgets.maxTotalStylesheetGzipBytes) {
    failures.push(
      `Stylesheets total ${cssTotal} gzip bytes; aggregate budget is ${budgets.maxTotalStylesheetGzipBytes}.`,
    );
  }
  if (failures.length) throw new Error(`Performance budget exceeded:\n- ${failures.join("\n- ")}`);

  return { javascript, stylesheets, jsTotal, cssTotal, largestJs, largestCss };
}

export async function verifyPerformanceBudget(
  projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  options = {},
) {
  const budgets = Object.freeze({ ...PERFORMANCE_BUDGETS, ...(options.budgets ?? {}) });
  const ceilings = Object.freeze({ ...SCAN_CEILINGS, ...(options.scanCeilings ?? {}) });
  validatePositiveIntegers(budgets, "performance budget");
  validatePositiveIntegers(ceilings, "performance scan ceiling");
  const startedAt = Date.now();
  const root = await requireRealDirectory(path.resolve(projectRoot), "project root");
  const client = await requireRealDirectory(path.join(root, "dist", "client"), "dist/client");
  const scan = await scanClient(client, budgets, ceilings, startedAt);
  const generationId = await verifyGeneratedRelease(client, scan.files, ceilings, startedAt);
  await verifyReleaseManifest(root, scan.files, scan.totalBytes, ceilings, startedAt);
  const compressed = await measureCompressedAssets(scan.files, budgets, ceilings, startedAt);
  checkDeadline(startedAt, ceilings);

  return Object.freeze({
    budgets,
    files: scan.files.length,
    clientBytes: scan.totalBytes,
    generationId,
    javascriptGzipBytes: compressed.jsTotal,
    stylesheetGzipBytes: compressed.cssTotal,
    largestJavaScript: compressed.largestJs,
    largestStylesheet: compressed.largestCss,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await verifyPerformanceBudget();
    process.stdout.write(
      [
        "Performance budgets passed.",
        `Client: ${result.files}/${result.budgets.maxClientFiles} files, ${formatBytes(result.clientBytes)} / ${formatBytes(result.budgets.maxClientBytes)}.`,
        `JavaScript: ${formatBytes(result.javascriptGzipBytes)} gzip aggregate; largest ${result.largestJavaScript.path} at ${formatBytes(result.largestJavaScript.gzipBytes)}.`,
        `CSS: ${formatBytes(result.stylesheetGzipBytes)} gzip aggregate; largest ${result.largestStylesheet.path} at ${formatBytes(result.largestStylesheet.gzipBytes)}.`,
        `Truth generation: ${result.generationId}.`,
      ].join("\n") + "\n",
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
