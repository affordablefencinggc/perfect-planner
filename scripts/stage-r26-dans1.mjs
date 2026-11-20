import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = Object.freeze({
  branch: "codex/qualification-r26",
  checkoutHead: "cfa409d6e8e33213ef740e833d0f7941d09c5e2e",
  qualifiedReleaseHead: "3e1164a55d10b2d8ef4a5884d197d64da59aeb0d",
  qualifiedTreeDigest: "677df5213d90a28c129795c5a9b0ba803570c47d85076aca2c04a937358e3bdf",
  packageLockSha256: "c4893f95fd17d696476046039f46a4bd6eb63e26b39795f58be2ad4f14857cf4",
  evidenceRoot: "C:\\Users\\danie\\Documents\\PerfectPlannerEvidence",
  defaultRepoRoot: "C:\\Users\\danie\\projects\\Planner-Release-20261110-r26",
  defaultStageRoot: "C:\\Users\\danie\\Documents\\PerfectPlannerEvidence\\20261120-R26-DANS1-Stage-03",
  defaultDependenciesArchive: "C:\\Users\\danie\\Documents\\PerfectPlannerEvidence\\20261120-R26-StagePrep\\r26-node-modules.tar.gz",
});

function parseArgs(argv) {
  const result = { repoRoot: PIN.defaultRepoRoot, stageRoot: PIN.defaultStageRoot, dependenciesArchive: PIN.defaultDependenciesArchive, dependenciesSha256: "", planOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan-only") result.planOnly = true;
    else if (["--repo-root", "--stage-root", "--dependencies-archive", "--dependencies-sha256"].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a path`);
      const keys = { "--repo-root": "repoRoot", "--stage-root": "stageRoot", "--dependencies-archive": "dependenciesArchive", "--dependencies-sha256": "dependenciesSha256" };
      result[keys[arg]] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runText(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  assert(result.status === 0, `${command} ${args.join(" ")} failed (${result.status ?? result.error?.message ?? "unknown"})${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return String(result.stdout ?? "").trim();
}

function git(repoRoot, ...args) {
  return runText("git", ["-C", repoRoot, ...args]);
}

async function sha256(filePath) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("error", reject);
    input.on("data", chunk => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function fileRecord(filePath, relativePath) {
  const file = await stat(filePath);
  return { path: relativePath.split(sep).join("/"), bytes: file.size, sha256: await sha256(filePath) };
}

async function walkFiles(root) {
  const found = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const fullPath = join(folder, entry.name);
      const item = await lstat(fullPath);
      assert(!item.isSymbolicLink(), `Refusing a symlink/reparse point in generated resources: ${fullPath}`);
      if (item.isDirectory()) await visit(fullPath);
      else if (item.isFile()) found.push(fullPath);
      else throw new Error(`Refusing a non-file resource: ${fullPath}`);
    }
  }
  await visit(root);
  return found.sort((a, b) => a.localeCompare(b));
}

async function runNativeBuild(repoRoot, cargoTarget, logPath) {
  const log = createWriteStream(logPath, { flags: "wx" });
  const command = "npm.cmd run tauri:build -- --no-bundle";
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
    cwd: repoRoot,
    env: { ...process.env, CARGO_TARGET_DIR: cargoTarget },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { log.write(chunk); process.stdout.write(chunk); });
  child.stderr.on("data", chunk => { log.write(chunk); process.stderr.write(chunk); });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", code => resolveExit(code));
  });
  await new Promise((resolveClose, reject) => log.end(error => error ? reject(error) : resolveClose()));
  return { command, exitCode };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = runText("hostname", []).toLowerCase();
  assert(host === "dans1", `Refusing staging on host '${host}'; expected DANS1.`);

  const repoRoot = resolve(args.repoRoot);
  const stageRoot = resolve(args.stageRoot);
  const evidenceRoot = resolve(PIN.evidenceRoot);
  const stageRelative = relative(evidenceRoot, stageRoot);
  assert(stageRelative && !stageRelative.startsWith(`..${sep}`) && stageRelative !== ".." && !isAbsolute(stageRelative), "Stage root must be a child of PerfectPlannerEvidence.");
  await access(join(repoRoot, ".git"));
  try { await access(stageRoot); throw new Error(`Refusing to overwrite existing stage: ${stageRoot}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const branch = git(repoRoot, "branch", "--show-current");
  const head = git(repoRoot, "rev-parse", "HEAD");
  const tree = git(repoRoot, "rev-parse", "HEAD^{tree}");
  const dirty = git(repoRoot, "status", "--porcelain=v1");
  assert(branch === PIN.branch, `Unexpected branch '${branch}'.`);
  assert(head === PIN.checkoutHead, `Unexpected checkout HEAD '${head}'.`);
  assert(dirty === "", "DANS1 checkout is dirty; refusing to build or stage.");
  runText("git", ["-C", repoRoot, "cat-file", "-e", `${PIN.qualifiedReleaseHead}^{commit}`]);
  const productDiff = spawnSync("git", ["-C", repoRoot, "diff", "--quiet", PIN.qualifiedReleaseHead, head, "--", ".", ":(exclude)LEDGER.json", ":(exclude)LEDGER.md", ":(exclude).ledger/logs/**"], { windowsHide: true });
  assert(productDiff.status === 0, "Product/source files differ from the qualified release revision.");

  const evidencePath = join(repoRoot, ".cache", "release-evidence.json");
  const approvalPath = join(repoRoot, ".cache", "release-approval.json");
  const releaseEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const releaseApproval = JSON.parse(await readFile(approvalPath, "utf8"));
  const { releaseRecordDigest } = await import(pathToFileURL(join(repoRoot, "src", "node", "ciDerivation.mjs")));
  assert(releaseEvidence.digest && releaseRecordDigest(releaseEvidence) === releaseEvidence.digest, "Release evidence digest is invalid.");
  assert(releaseApproval.digest && releaseRecordDigest(releaseApproval) === releaseApproval.digest, "Release approval digest is invalid.");
  assert(releaseEvidence.state === "passed" && releaseEvidence.profile === "release", "Recorded release run is not a passed release profile.");
  assert(releaseEvidence.revision?.head === PIN.qualifiedReleaseHead, "Release evidence is bound to a different source revision.");
  assert(releaseEvidence.revision?.treeDigest === PIN.qualifiedTreeDigest, "Release evidence tree digest differs from the pinned value.");
  assert(releaseApproval.revision?.head === PIN.qualifiedReleaseHead, "Saved owner approval is bound to a different source revision.");
  assert(releaseApproval.revision?.treeDigest === PIN.qualifiedTreeDigest, "Saved owner approval tree digest differs from the pinned value.");
  assert(releaseApproval.approvedBy === "Daniel Sivyer", "Release approval is not attributed to the recorded owner.");
  assert(Array.isArray(releaseEvidence.steps) && releaseEvidence.steps.length === 13, "Release proof does not contain all 13 recorded steps.");
  assert(releaseEvidence.steps.every(step => Number(step.exitCode) === 0), "At least one recorded release step did not exit 0.");

  const desktopHostSource = join(repoRoot, "dist", "desktop-host");
  await access(join(desktopHostSource, "desktop-host.json"));
  const packageLockSha256 = await sha256(join(repoRoot, "package-lock.json"));
  assert(packageLockSha256 === PIN.packageLockSha256, "The package-lock differs from the exact lockfile used for the local dependency snapshot.");
  assert(/^[a-f0-9]{64}$/i.test(args.dependenciesSha256), "Pass the SHA-256 of the prepared local dependency snapshot.");
  await access(args.dependenciesArchive);
  const dependenciesSha256 = await sha256(args.dependenciesArchive);
  assert(dependenciesSha256 === args.dependenciesSha256.toLowerCase(), "Dependency archive SHA-256 mismatch.");
  const disk = await import("node:fs").then(({ statfsSync }) => statfsSync(evidenceRoot));
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  assert(freeBytes >= 6 * 1024 ** 3, "Less than 6 GiB is free on the stage volume; refusing a fresh native build.");

  const plan = {
    host,
    branch,
    checkoutHead: head,
    checkoutTree: tree,
    qualifiedReleaseHead: PIN.qualifiedReleaseHead,
    qualifiedTreeDigest: PIN.qualifiedTreeDigest,
    releaseRunId: releaseEvidence.runId,
    releaseApprovalBy: releaseApproval.approvedBy,
    stageRoot,
    packageLockSha256,
    dependenciesArchive: args.dependenciesArchive,
    dependenciesSha256,
    freeBytes,
    mode: "fresh no-bundle build; isolated copy only; no install, launch, login, database, or production action",
  };
  if (args.planOnly) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  await mkdir(stageRoot, { recursive: false });
  const appDirectory = join(stageRoot, "app");
  const proofDirectory = join(stageRoot, "proof");
  await mkdir(appDirectory);
  await mkdir(proofDirectory);
  const buildRoot = join(stageRoot, "build-source");
  runText("git", ["clone", "--local", "--shared", "--branch", PIN.branch, repoRoot, buildRoot]);
  assert(git(buildRoot, "rev-parse", "HEAD") === head, "The isolated build checkout is not at the pinned DANS1 HEAD.");
  assert(git(buildRoot, "status", "--porcelain=v1") === "", "The isolated build checkout is dirty before dependencies are staged.");
  runText("tar.exe", ["-xzf", args.dependenciesArchive, "-C", buildRoot]);
  assert(await sha256(join(buildRoot, "package-lock.json")) === PIN.packageLockSha256, "The isolated build checkout package-lock changed.");
  const lock = JSON.parse(await readFile(join(buildRoot, "package-lock.json"), "utf8"));
  const packageManifest = JSON.parse(await readFile(join(buildRoot, "package.json"), "utf8"));
  for (const packageName of [...Object.keys(packageManifest.dependencies ?? {}), ...Object.keys(packageManifest.devDependencies ?? {})]) {
    const expectedVersion = lock.packages?.[`node_modules/${packageName}`]?.version;
    const installedPath = join(buildRoot, "node_modules", packageName, "package.json");
    const installedVersion = JSON.parse(await readFile(installedPath, "utf8")).version;
    assert(expectedVersion && installedVersion === expectedVersion, `Installed top-level dependency does not match package-lock: ${packageName}`);
  }
  const scriptPath = fileURLToPath(import.meta.url);
  await copyFile(scriptPath, join(stageRoot, "stage-r26-dans1.mjs"));
  await copyFile(evidencePath, join(proofDirectory, "release-evidence.json"));
  await copyFile(approvalPath, join(proofDirectory, "release-approval.json"));

  const cargoTarget = join(stageRoot, "cargo-target");
  const buildLog = join(proofDirectory, "tauri-no-bundle-build.log");
  const build = await runNativeBuild(buildRoot, cargoTarget, buildLog);
  assert(build.exitCode === 0, `tauri:build -- --no-bundle failed with exit ${build.exitCode}; log retained at ${buildLog}`);

  const builtExecutable = join(cargoTarget, "release", "perfect-planner-desktop.exe");
  await access(builtExecutable);
  const stagedExecutablePath = join(appDirectory, "perfect-planner-desktop.exe");
  await copyFile(builtExecutable, stagedExecutablePath, 0);
  const generatedHost = join(buildRoot, "dist", "desktop-host");
  const generatedFiles = await walkFiles(generatedHost);
  const stagedHost = join(appDirectory, "desktop-host");
  await cp(generatedHost, stagedHost, { recursive: true, errorOnExist: true, force: false, dereference: false });

  const desktopHostFiles = [];
  for (const sourceFile of generatedFiles) {
    const suffix = relative(generatedHost, sourceFile);
    const stagedFile = join(stagedHost, suffix);
    const sourceHash = await sha256(sourceFile);
    const stagedHash = await sha256(stagedFile);
    assert(sourceHash === stagedHash, `Desktop-host hash mismatch after copy: ${suffix}`);
    desktopHostFiles.push(await fileRecord(stagedFile, join("app", "desktop-host", suffix)));
  }
  const executable = await fileRecord(stagedExecutablePath, join("app", "perfect-planner-desktop.exe"));

  const manifest = {
    schemaVersion: 1,
    kind: "perfect-planner-dans1-stage",
    createdAtUtc: new Date().toISOString(),
    host,
    checkout: { path: repoRoot, branch, head, tree, buildCopy: buildRoot, isolated: true },
    qualifiedRelease: {
      head: PIN.qualifiedReleaseHead,
      treeDigest: PIN.qualifiedTreeDigest,
      runId: releaseEvidence.runId,
      approvalBy: releaseApproval.approvedBy,
      approvalAt: releaseApproval.approvedAt,
    },
    build: {
      command: build.command,
      exitCode: build.exitCode,
      target: cargoTarget,
      packageLockSha256,
      dependenciesArchiveSha256: dependenciesSha256,
      nodeVersion: process.version,
      npmVersion: runText(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd --version"]),
    },
    output: {
      path: appDirectory,
      executable,
      desktopHostFiles,
      mode: "side-by-side stage only; no installer, launch, login, database, or production action",
    },
    proof: {
      releaseEvidence: await fileRecord(join(proofDirectory, "release-evidence.json"), join("proof", "release-evidence.json")),
      releaseApproval: await fileRecord(join(proofDirectory, "release-approval.json"), join("proof", "release-approval.json")),
      buildLog: await fileRecord(buildLog, join("proof", "tauri-no-bundle-build.log")),
    },
    stageScriptSha256: await sha256(join(stageRoot, "stage-r26-dans1.mjs")),
  };
  const manifestPath = join(stageRoot, "stage-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", encoding: "utf8" });
  process.stdout.write(`STAGED: ${stageRoot}\n`);
  process.stdout.write(`Executable SHA256: ${executable.sha256}\n`);
  process.stdout.write(`Desktop-host files: ${desktopHostFiles.length}\n`);
  process.stdout.write(`Manifest SHA256: ${await sha256(manifestPath)}\n`);
  process.stdout.write("No installer was built, and the staged app was not launched.\n");
}

main().catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
