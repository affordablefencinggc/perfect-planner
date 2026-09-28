#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SITES_PACKAGE_LIMITS = Object.freeze({
  maxDepth: 64,
  maxPathLength: 4096,
  maxFiles: 20_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
});

const codepointSort = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function requireRegularFile(filePath, label, limits) {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch {
    throw new Error(`Missing Sites build input: ${label}.`);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Sites build input must be a regular file: ${label}.`);
  }
  if (entry.size > limits.maxFileBytes) {
    throw new Error(`Sites build input exceeds the per-file limit: ${label}.`);
  }
  return entry;
}

async function requireRealDirectory(directory, label) {
  let entry;
  try {
    entry = await lstat(directory);
  } catch {
    throw new Error(`Missing Sites build directory: ${label}.`);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Sites build directory must be a real directory: ${label}.`);
  }
  return realpath(directory);
}

async function enumerateRegularFiles(root, prefix, limits) {
  const artifacts = [];
  let totalBytes = 0;
  const stack = [{ absolute: root, relative: "", depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > limits.maxDepth) {
      throw new Error(`Sites package directory depth exceeds ${limits.maxDepth}.`);
    }
    const entries = await readdir(current.absolute, { withFileTypes: true });
    entries.sort((left, right) => codepointSort(left.name, right.name));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (absolute.length > limits.maxPathLength) {
        throw new Error(`Sites package path exceeds ${limits.maxPathLength} characters.`);
      }
      const inspected = await lstat(absolute);
      if (inspected.isSymbolicLink()) {
        throw new Error(`Sites package refuses symbolic links: ${relative}.`);
      }
      if (inspected.isDirectory()) {
        stack.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!inspected.isFile()) {
        throw new Error(`Sites package refuses special files: ${relative}.`);
      }
      if (inspected.size > limits.maxFileBytes) {
        throw new Error(`Sites package file exceeds ${limits.maxFileBytes} bytes: ${relative}.`);
      }
      totalBytes += inspected.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(`Sites package exceeds ${limits.maxTotalBytes} total bytes.`);
      }
      artifacts.push({ absolute, path: `${prefix}/${relative}`, bytes: inspected.size });
      if (artifacts.length > limits.maxFiles) {
        throw new Error(`Sites package exceeds ${limits.maxFiles} files.`);
      }
    }
  }
  artifacts.sort((left, right) => codepointSort(left.path, right.path));
  return { artifacts, totalBytes };
}

export async function prepareSitesBuild(
  projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  options = {},
) {
  const limits = Object.freeze({ ...SITES_PACKAGE_LIMITS, ...(options.limits ?? {}) });
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid Sites package limit: ${name}.`);
    }
  }

  const root = await requireRealDirectory(path.resolve(projectRoot), "project root");
  const dist = path.join(root, "dist");
  const client = await requireRealDirectory(path.join(dist, "client"), "dist/client");
  const index = path.join(client, "index.html");
  const worker = path.join(root, "worker", "index.js");
  const hosting = path.join(root, ".openai", "hosting.json");
  await requireRegularFile(index, "dist/client/index.html", limits);
  await requireRegularFile(worker, "worker/index.js", limits);
  await requireRegularFile(hosting, ".openai/hosting.json", limits);

  const hostingConfig = JSON.parse(await readFile(hosting, "utf8"));
  if (hostingConfig?.static?.directory !== "dist/client") {
    throw new Error("Sites static.directory must be dist/client.");
  }

  const serverDirectory = path.join(dist, "server");
  const hostingDirectory = path.join(dist, ".openai");
  await mkdir(serverDirectory, { recursive: true });
  await mkdir(hostingDirectory, { recursive: true });
  const packagedWorker = path.join(serverDirectory, "index.js");
  const packagedHosting = path.join(hostingDirectory, "hosting.json");
  for (const destination of [packagedWorker, packagedHosting]) {
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`Refusing unsafe Sites package destination: ${destination}.`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await copyFile(worker, packagedWorker);
  await copyFile(hosting, packagedHosting);

  const clientScan = await enumerateRegularFiles(client, "client", limits);
  const fixedFiles = [
    { absolute: packagedWorker, path: "server/index.js" },
    { absolute: packagedHosting, path: ".openai/hosting.json" },
  ];
  const fixedArtifacts = [];
  let totalBytes = clientScan.totalBytes;
  for (const item of fixedFiles) {
    const entry = await requireRegularFile(item.absolute, item.path, limits);
    totalBytes += entry.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`Sites package exceeds ${limits.maxTotalBytes} total bytes.`);
    }
    fixedArtifacts.push({ ...item, bytes: entry.size });
  }

  const artifactInputs = [...clientScan.artifacts, ...fixedArtifacts].sort((left, right) =>
    codepointSort(left.path, right.path),
  );
  if (artifactInputs.length > limits.maxFiles) {
    throw new Error(`Sites package exceeds ${limits.maxFiles} files.`);
  }
  const artifacts = [];
  for (const artifact of artifactInputs) {
    const bytes = await readFile(artifact.absolute);
    if (bytes.length !== artifact.bytes) {
      throw new Error(`Sites package input changed during hashing: ${artifact.path}.`);
    }
    artifacts.push({ path: artifact.path, bytes: bytes.length, sha256: sha256(bytes) });
  }

  const manifestBody = {
    schemaVersion: 2,
    releaseMode: "STATIC_CLIENT_NO_LOCAL_AUTHORITY",
    limits,
    totals: { files: artifacts.length, bytes: totalBytes },
    artifacts,
  };
  const manifest = {
    ...manifestBody,
    manifestSha256: sha256(Buffer.from(JSON.stringify(manifestBody))),
  };
  const manifestPath = path.join(dist, "release-manifest.json");
  const temporaryManifest = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rm(manifestPath, { force: true });
    await rename(temporaryManifest, manifestPath);
  } catch (error) {
    await rm(temporaryManifest, { force: true });
    throw error;
  }
  return Object.freeze(manifest);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const manifest = await prepareSitesBuild();
  process.stdout.write(
    `Prepared verified static package: ${manifest.totals.files} files, ${manifest.totals.bytes} bytes.\n`,
  );
}
