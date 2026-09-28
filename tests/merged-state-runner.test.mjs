import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { rehearseMergedState, candidateSnapshot } from "../src/node/mergedStateRunner.mjs";
import { inspectMergeTransaction } from "../src/node/mergeTransactionStore.mjs";

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("close", (exit) => exit === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
}

function rawGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true }); let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject);
    child.on("close", (exit, signal) => resolve({ exit, signal, stdout, stderr }));
  });
}

test('candidate snapshot hashes full multi-chunk content and rejects inventory movement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-candidate-capture-'));
  const file = path.join(root, 'large.bin'); await writeFile(file, Buffer.alloc(200000, 65));
  const inventory = async (_cwd, args) => ({exit:0,stdout:args.includes('--stage')?'index-v1':args.includes('--cached')?'large.bin\0':''});
  const first = await candidateSnapshot(root, inventory); assert.equal(first.valid,true);assert.equal(first.bytes,200000);
  assert.equal(first.snapshotSchemaVersion,2);
  assert.equal((await candidateSnapshot(root, inventory)).digest,first.digest);
  const changed = Buffer.alloc(200000,65);changed[150000]=66;await writeFile(file,changed);
  assert.notEqual((await candidateSnapshot(root,inventory)).digest,first.digest);
  let calls=0;
  const moving=async(cwd,args)=>{calls++;const result=await inventory(cwd,args);return calls===7?{...result,stdout:'new-file\0'}:result;};
  const refused=await candidateSnapshot(root,moving);assert.equal(refused.valid,false);assert.match(refused.reason,/inventory changed/);
  let lateCalls=0;
  const lateChange=async(cwd,args)=>{lateCalls++;if(lateCalls===8)await writeFile(file,'changed after hashing');return inventory(cwd,args);};
  const late=await candidateSnapshot(root,lateChange);assert.equal(late.valid,false);assert.match(late.reason,/file changed after read/);
});

async function repositoryFixture({ conflict = false, failing = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "pp-merge-"));
  const repo = path.join(base, "repo"); await mkdir(repo);
  await git(repo, ["init", "-b", "main"]); await git(repo, ["config", "user.email", "proof@example.invalid"]); await git(repo, ["config", "user.name", "Proof Fixture"]);
  await writeFile(path.join(repo, "shared.txt"), "base\n");
  await writeFile(path.join(repo, "verify.mjs"), "import { existsSync } from 'node:fs'; process.exit(existsSync('feature.txt') ? 0 : 7);\n");
  await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "base"]); await git(repo, ["switch", "-c", "feature"]);
  await writeFile(path.join(repo, "feature.txt"), "feature\n");
  if (conflict) await writeFile(path.join(repo, "shared.txt"), "feature edit\n");
  if (failing) await writeFile(path.join(repo, "verify.mjs"), "process.exit(9);\n");
  await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "feature"]); await git(repo, ["switch", "main"]);
  if (conflict) { await writeFile(path.join(repo, "shared.txt"), "main edit\n"); await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "main edit"]); }
  return { base, repo, worktrees: path.join(base, "worktrees") };
}

const plan = { state: "derived", gates: [{ job: "verify", supported: true, commands: [{ executable: process.execPath, args: ["verify.mjs"] }] }] };

test("derived gates run against an isolated simulated merge and produce proof", async () => {
  const fixture = await repositoryFixture();
  const result = await rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: fixture.worktrees, targetRef: "main", sourceRef: "feature", ciPlan: plan, allowedExecutables: [process.execPath] });
  assert.equal(result.state, "green");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].proven, true);
  assert.equal(result.cleanup.state, "retained-for-review"); assert.equal(result.cleanup.forced, false);
  assert.equal(result.proofScope, "local-rehearsal"); assert.equal(result.promotionAuthority, false);
  assert.match(result.candidateSnapshotDigest, /^[a-f0-9]{64}$/); assert.equal(result.testedCandidateSnapshotDigest, result.candidateSnapshotDigest);
  assert.match(result.ciCommandContractDigest, /^[a-f0-9]{64}$/);
  assert.match(result.cleanup.receiptDigest, /^[a-f0-9]{64}$/); assert.equal(JSON.parse(await readFile(result.cleanup.receiptPath, "utf8")).state, "retained-for-review");
  assert.equal((await git(fixture.repo, ["worktree", "list", "--porcelain"])).split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length, 2);
});

test("merge conflicts are red and CI is not run", async () => {
  const fixture = await repositoryFixture({ conflict: true });
  const result = await rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: fixture.worktrees, targetRef: "main", sourceRef: "feature", ciPlan: plan });
  assert.equal(result.state, "red"); assert.equal(result.reason, "merge conflict"); assert.equal(result.evidence.length, 0);
});

test("a failing derived gate is captured as red, never green", async () => {
  const fixture = await repositoryFixture({ failing: true });
  const result = await rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: fixture.worktrees, targetRef: "main", sourceRef: "feature", ciPlan: plan, allowedExecutables: [process.execPath] });
  assert.equal(result.state, "red"); assert.match(result.reason, /CI gate/); assert.equal(result.evidence[0].proven, false);
});

test("unsafe refs are refused before any Git operation", async () => {
  const fixture = await repositoryFixture();
  await assert.rejects(() => rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, targetRef: "main; rm", sourceRef: "feature", ciPlan: plan }), /safe Git ref/);
});

test("the rehearsal path cannot enter the developer checkout", async () => {
  const fixture = await repositoryFixture();
  await assert.rejects(() => rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: path.join(fixture.repo, "unsafe"), targetRef: "main", sourceRef: "feature", ciPlan: plan }), /must be a sibling/);
});

test("successful rehearsal never attempts removal and leaves a durable retained-candidate receipt", async () => {
  const fixture = await repositoryFixture(); const commands = [];
  const gitRunner = async (cwd, args) => { commands.push(args); if (args[0] === "worktree" && args[1] === "remove") return { exit: 1, signal: null, stdout: "", stderr: "fixture retained" }; return rawGit(cwd, args); };
  const result = await rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: fixture.worktrees, targetRef: "main", sourceRef: "feature", ciPlan: plan, allowedExecutables: [process.execPath], gitRunner });
  assert.equal(result.state, "green"); assert.equal(result.cleanup.state, "retained-for-review"); assert.equal(result.cleanup.forced, false);
  assert.equal(commands.some((args) => args.includes("--force") || args.includes("--abort") || (args[0] === "worktree" && args[1] === "remove")), false);
  const receipt = JSON.parse(await readFile(result.cleanup.receiptPath, "utf8")); assert.equal(receipt.state, "retained-for-review"); assert.deepEqual(receipt.recovery.command.slice(0, 3), ["git", "-C", result.cleanup.worktreePath]);
});

test("gate-created tracked and untracked work is retained even when forced cleanup is requested", async () => {
  const fixture = await repositoryFixture();
  const gateScript = path.join(fixture.repo, "feature-gate.mjs");
  await writeFile(gateScript, "import { writeFileSync } from 'node:fs'; writeFileSync('shared.txt', 'gate edit\\n'); writeFileSync('gate-untracked.txt', 'preserve me\\n');\n");
  await git(fixture.repo, ["add", "feature-gate.mjs"]); await git(fixture.repo, ["commit", "-m", "add dirty gate"]);
  const dirtyPlan = { state: "derived", gates: [{ job: "dirty", supported: true, commands: [{ executable: process.execPath, args: ["feature-gate.mjs"] }] }] };
  const result = await rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: fixture.worktrees, targetRef: "main", sourceRef: "feature", ciPlan: dirtyPlan, allowedExecutables: [process.execPath], allowForcedCleanup: true });
  assert.equal(result.state, "grey"); assert.equal(result.cleanup.state, "manual-recovery-required"); assert.equal(result.cleanup.forced, false); assert.equal(result.cleanup.abort.attempted, false);
  assert.equal(await readFile(path.join(result.cleanup.worktreePath, "gate-untracked.txt"), "utf8"), "preserve me\n");
  assert.match(await readFile(path.join(result.cleanup.worktreePath, "shared.txt"), "utf8"), /gate edit/);
  const receipt = JSON.parse(await readFile(result.cleanup.receiptPath, "utf8")); assert.equal(receipt.preservation.safeToDiscard, false); assert.match(receipt.recovery.note, /preserve commits/);
});

test("a gate-created commit is retained and never automatically aborted or forced away", async () => {
  const fixture = await repositoryFixture();
  const gateScript = path.join(fixture.repo, "commit-gate.mjs");
  await writeFile(gateScript, "import { writeFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; writeFileSync('gate-commit.txt', 'committed work\\n'); spawnSync('git', ['add', 'gate-commit.txt']); const result=spawnSync('git',['commit','-m','gate-created']); process.exit(result.status ?? 1);\n");
  await git(fixture.repo, ["add", "commit-gate.mjs"]); await git(fixture.repo, ["commit", "-m", "add commit gate"]);
  const commitPlan = { state: "derived", gates: [{ job: "commit", supported: true, commands: [{ executable: process.execPath, args: ["commit-gate.mjs"] }] }] };
  const result = await rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: fixture.worktrees, targetRef: "main", sourceRef: "feature", ciPlan: commitPlan, allowedExecutables: [process.execPath], allowForcedCleanup: true });
  assert.equal(result.state, "grey"); assert.equal(result.cleanup.state, "manual-recovery-required"); assert.equal(result.cleanup.abort.attempted, false); assert.equal(result.cleanup.forced, false);
  assert.notEqual(await git(result.cleanup.worktreePath, ["rev-parse", "HEAD"]), result.targetSha); assert.equal((await lstat(path.join(result.cleanup.worktreePath, "gate-commit.txt"))).isFile(), true);
});

test("restaging different bytes for an already-merged file cannot preserve by porcelain disguise", async () => {
  const fixture = await repositoryFixture();
  const gateScript = path.join(fixture.repo, "restage-gate.mjs");
  await writeFile(gateScript, "import { writeFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; writeFileSync('feature.txt', 'different staged bytes\\n'); const result=spawnSync('git',['add','feature.txt']); process.exit(result.status ?? 1);\n");
  await git(fixture.repo, ["add", "restage-gate.mjs"]); await git(fixture.repo, ["commit", "-m", "add restage gate"]);
  const restagePlan = { state: "derived", gates: [{ job: "restage", supported: true, commands: [{ executable: process.execPath, args: ["restage-gate.mjs"] }] }] };
  const result = await rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: fixture.worktrees, targetRef: "main", sourceRef: "feature", ciPlan: restagePlan, allowedExecutables: [process.execPath], allowForcedCleanup: true });
  assert.equal(result.state, "grey"); assert.equal(result.cleanup.state, "manual-recovery-required"); assert.equal(result.cleanup.abort.attempted, false); assert.equal(result.cleanup.forced, false);
  assert.equal(await readFile(path.join(result.cleanup.worktreePath, "feature.txt"), "utf8"), "different staged bytes\n");
  assert.notEqual(result.testedCandidateSnapshotDigest, result.candidateSnapshotDigest);
});

test("an ignored file created by a gate is preserved and blocks automatic cleanup", async () => {
  const fixture = await repositoryFixture();
  await writeFile(path.join(fixture.repo, ".gitignore"), "gate-output.log\n");
  await writeFile(path.join(fixture.repo, "ignored-gate.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('gate-output.log', 'ignored but valuable\\n');\n");
  await git(fixture.repo, ["add", ".gitignore", "ignored-gate.mjs"]); await git(fixture.repo, ["commit", "-m", "add ignored gate"]);
  const ignoredPlan = { state: "derived", gates: [{ job: "ignored", supported: true, commands: [{ executable: process.execPath, args: ["ignored-gate.mjs"] }] }] };
  const result = await rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: fixture.worktrees, targetRef: "main", sourceRef: "feature", ciPlan: ignoredPlan, allowedExecutables: [process.execPath], allowForcedCleanup: true });
  assert.equal(result.state, "grey"); assert.equal(result.cleanup.state, "manual-recovery-required"); assert.equal(result.cleanup.abort.attempted, false); assert.equal(result.cleanup.forced, false);
  assert.equal(await readFile(path.join(result.cleanup.worktreePath, "gate-output.log"), "utf8"), "ignored but valuable\n");
});

test("moving either candidate ref during a gate prevents green proof", async () => {
  for (const ref of ["main", "feature"]) {
    const fixture = await repositoryFixture();
    const gateScript = path.join(fixture.repo, "move-ref.mjs");
    const destination = ref === "main" ? "feature" : "main";
    await writeFile(gateScript, `import { spawnSync } from 'node:child_process'; const result=spawnSync('git',['-C',${JSON.stringify(fixture.repo)},'update-ref','refs/heads/${ref}',${JSON.stringify(destination)}]); process.exit(result.status ?? 1);\n`);
    await git(fixture.repo, ["add", "move-ref.mjs"]); await git(fixture.repo, ["commit", "-m", "add ref mover"]);
    const movingPlan = { state: "derived", gates: [{ job: "move", supported: true, commands: [{ executable: process.execPath, args: ["move-ref.mjs"] }] }] };
    const result = await rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: fixture.worktrees, targetRef: "main", sourceRef: "feature", ciPlan: movingPlan, allowedExecutables: [process.execPath] });
    assert.equal(result.state, "grey"); assert.match(result.reason, /ref moved/);
    const transaction = await inspectMergeTransaction({ storeRoot: result.transaction.storeRoot, transactionId: result.transaction.transactionId });
    assert.equal(transaction.state, "RETAINED"); assert.equal(transaction.pending, true);
    assert.equal(transaction.entries.some((entry) => entry.state === "CHECKS_FINISHED" || entry.state === "COMPLETED"), false);
  }
});

test("repository merge hooks are disabled during rehearsal", async () => {
  const fixture = await repositoryFixture(); const marker = path.join(fixture.base, "post-merge-ran.txt");
  const hook = path.join(fixture.repo, ".git", "hooks", "post-merge");
  await writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker).replaceAll("\\", "/")}\n`); if (process.platform !== "win32") await chmod(hook, 0o755);
  const result = await rehearseMergedState({ repositoryRoot: fixture.repo, allowedBase: fixture.base, worktreeParent: fixture.worktrees, targetRef: "main", sourceRef: "feature", ciPlan: plan, allowedExecutables: [process.execPath] });
  assert.equal(result.state, "green"); assert.equal(await lstat(marker).then(() => true, () => false), false);
});

test('candidate capture gives bounded inventory room to installed dependencies', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-candidate-budget-'));
  const file='dependency-entry.txt';await writeFile(path.join(root,file),'dependency bytes');
  let calls=0;
  const inventory=async (_cwd,args,options)=>{
    calls++;assert.equal(options.maxBytes,8_000_000);
    return {exit:0,stdout:args.includes('--ignored')?file+'\0':''};
  };
  const result=await candidateSnapshot(root,inventory);
  assert.equal(result.valid,true);assert.equal(result.files,1);assert.equal(calls,8);
  await writeFile(path.join(root,file),'changed dependency');
  assert.notEqual((await candidateSnapshot(root,inventory)).digest,result.digest);
});

test('candidate capture refuses inventory above the new finite file bound', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-candidate-budget-refuse-'));
  const files=Array.from({length:100001},(_,i)=>`entry-${i}`).join('\0')+'\0';
  const result=await candidateSnapshot(root,async(_cwd,args)=>({exit:0,stdout:args.includes('--cached')?files:''}));
  assert.equal(result.valid,false);assert.equal(result.reason,'candidate file inventory exceeded limit');
});

test('larger candidate budget still settles cancellation before returning',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-candidate-cancel-'));
 const controller=new AbortController();let calls=0;
 const result=await candidateSnapshot(root,async()=>{calls++;controller.abort();return {exit:0,stdout:''};},{signal:controller.signal});
 assert.equal(result.valid,false);assert.equal(result.reason,'candidate cancelled');assert.equal(calls,1);
});
