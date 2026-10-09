import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runBoundedProcess, runGuardedGit } from "../src/node/guardedGitRunner.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pp-guarded-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function repository(t) {
  const root = await fixture(t);
  git(root, ["init", "-b", "main"]); git(root, ["config", "user.name", "Fixture"]); git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(root, "source.txt"), "base\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "base"]);
  return root;
}
const quote = (text) => "'" + text.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
const absent = async (file) => { try { await lstat(file); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } };

test("managed worktree checkout and fast-forward merge never execute hostile repository hooks", async (t) => {
  const root = await repository(t);
  git(root, ["checkout", "-b", "feature"]); await writeFile(path.join(root, "feature.txt"), "feature\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "feature"]); git(root, ["checkout", "main"]);
  const marker = path.join(root, ".git", "hostile-hook-marker");
  for (const name of ["post-checkout", "post-merge"]) {
    const file = path.join(root, ".git", "hooks", name);
    await writeFile(file, "#!/bin/sh\necho touched > " + quote(marker) + "\n"); await chmod(file, 0o755);
  }
  const parent = await fixture(t); const worktree = path.join(parent, "managed");
  const added = await runGuardedGit(root, ["worktree", "add", "--detach", worktree, "main"]);
  assert.equal(added.exit, 0, JSON.stringify(added));
  assert.equal(await absent(marker), true);
  const merged = await runGuardedGit(worktree, ["merge", "--ff-only", "feature"]);
  assert.equal(merged.exit, 0, JSON.stringify(merged));
  assert.equal(await readFile(path.join(worktree, "feature.txt"), "utf8"), "feature\n");
  assert.equal(await absent(marker), true);
  assert.equal((await runGuardedGit(root, ["worktree", "remove", worktree])).exit, 0);
});

test("Git environment routing/config redirects and command overrides fail before execution", async (t) => {
  const root = await repository(t);
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_PARAMETERS", "GIT_EXEC_PATH"]) {
    await assert.rejects(runGuardedGit(root, ["status", "--porcelain"], { env: { ...process.env, [key]: "" } }), /git-environment-override-refused/);
  }
  await assert.rejects(runGuardedGit(root, ["-c", "core.hooksPath=foreign", "status"]), /git-command-refused/);
  await assert.rejects(runGuardedGit(root, ["diff", "--ext-diff"]), /git-command-override-refused/);
  for (const key of ["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "COR_ENABLE_PROFILING", "CORECLR_PROFILER_PATH", "COMPLUS_ProfAPI_ProfilerCompatibilitySetting", "DOTNET_STARTUP_HOOKS"]) {
    await assert.rejects(runGuardedGit(root, ["rev-parse", "HEAD"], { env: { ...process.env, [key]: root } }), /git-loader-environment-refused/);
  }
});

test("managed Git ignores PATH and refuses repo-local, relative and missing executables", async (t) => {
  const root = await repository(t);
  const expected = git(root, ["rev-parse", "HEAD"]);
  const marker = path.join(root, "substituted-program-ran");
  const fake = path.join(root, process.platform === "win32" ? "git.cmd" : "git");
  await writeFile(fake, process.platform === "win32" ? `@echo substituted>${marker}\r\nexit /b 77\r\n` : `#!/bin/sh\necho substituted > ${quote(marker)}\nexit 77\n`);
  await chmod(fake, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  env.PATH = root;
  const result = await runGuardedGit(root, ["rev-parse", "HEAD"], { env });
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.stdout.trim(), expected);
  assert.equal(await absent(marker), true);
  await assert.rejects(runGuardedGit(root, ["rev-parse", "HEAD"], { gitExecutable: fake }), /git-executable-inside-repository-refused/);
  await assert.rejects(runGuardedGit(root, ["rev-parse", "HEAD"], { gitExecutable: "git" }), /git-executable-path-refused/);
  const external = await fixture(t);
  await assert.rejects(runGuardedGit(root, ["rev-parse", "HEAD"], { gitExecutable: path.join(external, "missing-git") }), /git-executable-unavailable/);
});

test("external diff, fsmonitor and checkout filters cannot execute; custom merge drivers are refused", async (t) => {
  const root = await repository(t); const marker = path.join(root, ".git", "external-marker");
  await writeFile(path.join(root, ".gitattributes"), "*.txt filter=hostile diff=hostile\n");
  git(root, ["add", ".gitattributes"]); git(root, ["commit", "-m", "fixture attributes"]);
  const command = "echo touched > " + quote(marker);
  git(root, ["config", "diff.external", command]); git(root, ["config", "diff.hostile.textconv", command]); git(root, ["config", "filter.hostile.clean", command]); git(root, ["config", "core.fsmonitor", command]);
  await writeFile(path.join(root, "source.txt"), "changed\n");
  const diff = await runGuardedGit(root, ["diff"]);
  assert.equal(diff.exit, 0, JSON.stringify(diff)); assert.match(diff.stdout, /changed/); assert.equal(await absent(marker), true);
  git(root, ["config", "filter.hostile.smudge", command]);
  const parent = await fixture(t);
  await assert.rejects(runGuardedGit(root, ["worktree", "add", "--detach", path.join(parent, "managed"), "HEAD"]), /git-candidate-filter-required/);
  assert.equal(await absent(path.join(parent, "managed")), true);
  assert.equal(await absent(marker), true);
  git(root, ["config", "merge.hostile.driver", command]);
  await assert.rejects(runGuardedGit(root, ["merge", "--ff-only", "HEAD"]), /git-external-merge-driver-refused/);
});

test("aggregate stdout plus stderr is bounded, including when each stream individually fits", async (t) => {
  const root = await fixture(t);
  const result = await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('a'.repeat(700));process.stderr.write('b'.repeat(700));setInterval(()=>{},1000)"], { cwd: root, maxBytes: 1000, timeoutMs: 5000 });
  assert.equal(result.reason, "git-output-limit"); assert.equal(result.exit, null); assert.equal(result.outputComplete, false);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1000);
  assert.equal(result.cleanupComplete, true);
});

test("Windows containment ignores poisoned and conflicting SystemRoot spellings", { skip: process.platform !== "win32" && "Windows-only (SystemRoot / Job Object containment)" }, async (t) => {
  const root = await fixture(t);
  const env = { ...process.env, SystemRoot: root, SYSTEMROOT: path.join(root, "other"), systemroot: root, WINDIR: root };
  const result = await runBoundedProcess(process.execPath, ["-e", "console.log(process.env.SystemRoot);console.log(process.env.WINDIR)"], { cwd: root, env });
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["C:\\Windows", "C:\\Windows"]);
  assert.equal(result.cleanupComplete, true);
});

async function assertStopped(pid) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Descendant remained alive after bounded process settled");
}
for (const ending of ["timeout", "parent-exit"]) test(`descendants are terminated after ${ending}, even when they inherit output pipes`, async (t) => {
  const root = await fixture(t);
  const code = "const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});console.log(child.pid);" + (ending === "timeout" ? "setInterval(()=>{},1000)" : "setTimeout(()=>process.exit(0),100)");
  const result = await runBoundedProcess(process.execPath, ["-e", code], { cwd: root, timeoutMs: ending === "timeout" ? 2000 : 5000 });
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, JSON.stringify(result));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  assert.equal(result.reason, ending === "timeout" ? "git-time-limit" : null, JSON.stringify(result));
  assert.equal(result.cleanupComplete, true);
  await assertStopped(pid);
});

test("command failure and unavailable executable settle without invented successful output", async (t) => {
  const root = await fixture(t);
  const failure = await runBoundedProcess(process.execPath, ["-e", "process.exit(7)"], { cwd: root });
  assert.equal(failure.exit, 7); assert.equal(failure.reason, null);
  const unavailable = await runBoundedProcess(path.join(root, "missing-executable"), [], { cwd: root });
  assert.notEqual(unavailable.exit, 0); assert.ok(unavailable.reason); assert.equal(unavailable.outputComplete, false);
});

test("uncertain preflight process termination propagates a typed cleanup failure", async (t) => {
  const root = await repository(t);
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => false;
  const intercepted = t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  try {
    await assert.rejects(runGuardedGit(root, ["worktree", "list", "--porcelain", "-z"], { timeoutMs: 1000 }),
      (error) => error.code === "GIT_PROCESS_UNCERTAIN" && error.cleanupComplete === false);
    assert.equal(intercepted.mock.callCount(), 1);
    assert.ok(intercepted.mock.calls[0].arguments[0].includes(process.platform === "win32" ? "powershell.exe" : "git"));
  } finally {
    intercepted.mock.restore(); syncBuiltinESMExports();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
});
