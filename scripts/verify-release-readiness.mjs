#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyCompletionReport } from "../src/node/completionReport.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_POINTER_BYTES = 32 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function requireRealDirectory(directory, label) {
  const entry = await lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
  return realpath(directory);
}

async function readBoundedRegularFile(filePath, maxBytes, label) {
  const entry = await lstat(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  if (entry.size < 1 || entry.size > maxBytes) {
    throw new Error(`${label} exceeds its safe size limit.`);
  }
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino ||
        before.size !== entry.size || before.mtimeMs !== entry.mtimeMs || before.ctimeMs !== entry.ctimeMs) {
      throw new Error(`${label} changed while it was opened.`);
    }
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`${label} changed while it was read.`);
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function requireDirectoryChain(root, segments) {
  let directory = root;
  for (const segment of segments) {
    const expected = path.join(directory, segment);
    directory = await requireRealDirectory(expected, "Release truth directory");
    if (directory !== expected) throw new Error("Release truth directory resolves through a redirected path.");
  }
  return directory;
}

export async function verifyReleaseReadiness(projectRoot = process.cwd()) {
  const root = await requireRealDirectory(path.resolve(projectRoot), "Project root");
  const generated = await requireDirectoryChain(root, ["dist", "client", "generated"]);
  const pointerBytes = await readBoundedRegularFile(
    path.join(generated, "current-generation.json"),
    MAX_POINTER_BYTES,
    "Release truth pointer",
  );
  const pointer = JSON.parse(pointerBytes.toString("utf8"));
  if (
    pointer?.schemaVersion !== 1 ||
    !SHA256.test(pointer?.generationId ?? "") ||
    pointer.directory !== `generations/${pointer.generationId}` ||
    !Array.isArray(pointer.artifacts)
  ) {
    throw new Error("Release truth pointer is invalid.");
  }
  const reports = pointer.artifacts.filter((item) => item?.name === "completion-report.json");
  const truthReports = pointer.artifacts.filter((item) => item?.name === "truth-core-report.json");
  const artifact = reports[0];
  if (
    reports.length !== 1 || truthReports.length !== 1 || !artifact ||
    !SHA256.test(artifact.sha256 ?? "") ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    artifact.size > MAX_REPORT_BYTES
  ) {
    throw new Error("Release completion artifact manifest is invalid.");
  }
  const generationDirectory = await requireDirectoryChain(generated, ["generations", pointer.generationId]);
  const truthArtifact = truthReports[0];
  if (!SHA256.test(truthArtifact?.sha256 ?? "") || !Number.isSafeInteger(truthArtifact?.size) || truthArtifact.size < 1 || truthArtifact.size > MAX_REPORT_BYTES) throw new Error("Release truth-core artifact manifest is invalid.");
  const truthBytes = await readBoundedRegularFile(path.join(generationDirectory, truthArtifact.name), MAX_REPORT_BYTES, "Release truth-core report");
  if (truthBytes.length !== truthArtifact.size || sha256(truthBytes) !== truthArtifact.sha256) throw new Error("Release truth-core report failed integrity verification.");
  const truthReport = JSON.parse(truthBytes.toString("utf8"));
  if (truthReport?.schemaVersion !== 1 || truthReport?.generatedAt !== pointer.generatedAt) throw new Error("Release truth-core report does not match the current generation.");
  const artifactPath = path.join(generationDirectory, artifact.name);
  if (!artifactPath.startsWith(`${generated}${path.sep}`)) {
    throw new Error("Release completion artifact escaped its generation directory.");
  }
  const bytes = await readBoundedRegularFile(
    artifactPath,
    MAX_REPORT_BYTES,
    "Release completion report",
  );
  if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) {
    throw new Error("Release completion report failed integrity verification.");
  }
  const report = JSON.parse(bytes.toString("utf8"));
  if (report?.generatedAt !== pointer.generatedAt) {
    throw new Error("Release completion report does not match the current generation.");
  }
  verifyCompletionReport(report, { expectedGeneratedAt: pointer.generatedAt });
  const blockers = report.blockers;
  if (report?.verdict !== "GO" || report?.ready !== true || blockers.length !== 0) {
    const summary = blockers.length
      ? blockers.slice(0, 5).map((item) => String(item?.reason ?? item?.title ?? item)).join("; ")
      : "completion report is not GO";
    throw new Error(`Release blocked: ${summary}.`);
  }
  return Object.freeze({
    generationId: pointer.generationId,
    generatedAt: pointer.generatedAt,
    verdict: report.verdict,
    truthCoreSha256: truthArtifact.sha256,
    authenticated: false,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const projectRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await verifyReleaseReadiness(projectRoot);
  process.stdout.write(`Release readiness verified: ${result.generationId}.\n`);
}
