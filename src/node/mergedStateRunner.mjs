import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readlink, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProof } from "./proofRunner.mjs";
import { runGuardedGit } from "./guardedGitRunner.mjs";
import { createMergeTransactionIntent, appendMergeTransactionTransition } from "./mergeTransactionStore.mjs";

const REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]+$/;
function isWithin(root, candidate) { const relative = path.relative(root, candidate); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
async function ensureUnredirectedDirectory(root, target) {
  const resolvedRoot = await realpath(root); const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Directory escapes its approved root.");
  let cursor = resolvedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); const info = await lstat(cursor).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) break;
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(cursor, await realpath(cursor)) !== "") throw new Error("Directory ancestor is redirected or not a directory.");
  }
  await mkdir(target, { recursive: true });
  const canonical = await realpath(target);
  if (!isWithin(resolvedRoot, canonical) || path.relative(target, canonical) !== "") throw new Error("Directory creation was redirected outside its approved root.");
  return canonical;
}
async function git(cwd, args, options={}) { const result = await runGuardedGit(cwd, args, { timeoutMs: 10_000, maxBytes: 65_536, ...options }); return result.reason || result.cleanupComplete === false ? { ...result, exit: result.exit === 0 ? 1 : result.exit } : result; }
function assertRef(name, value) { if (!REF_PATTERN.test(String(value ?? ""))) throw new Error(`${name} is not a safe Git ref.`); }
function validCiGates(gates) {
  if (!Array.isArray(gates) || gates.length === 0 || gates.length > 64) return false;
  let commandCount = 0; const jobs = new Set();
  return Array.from(gates).every((gate) => {
    if (!gate || typeof gate.job !== "string" || !gate.job.trim() || gate.job !== gate.job.trim() || jobs.has(gate.job) || gate.job.length > 128 || gate.supported !== true || !Array.isArray(gate.commands) || gate.commands.length === 0 || gate.commands.length > 64) return false;
    jobs.add(gate.job);
    commandCount += gate.commands.length;
    return commandCount <= 256 && Array.from(gate.commands).every((command) => command && typeof command.executable === "string" && command.executable.trim().length > 0 && command.executable.length <= 4096 && !command.executable.includes("\0") && Array.isArray(command.args) && command.args.length <= 128 && Array.from(command.args).every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\0")));
  });
}
async function captureCandidateSnapshot(cwd, gitRun, checkpoint=()=>{}) {
  checkpoint();
  const snapshotRoot = await realpath(cwd);
  const commands = [
    ["ls-files", "--stage", "-z"],
    ["ls-files", "--cached", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
  ];
  const results = [];
  for (const args of commands) { const result = await gitRun(cwd, args); if (result.exit !== 0) return { valid: false, reason: "candidate inventory failed" }; results.push(result.stdout); }
  const files = [...new Set(results.slice(1).flatMap((output) => output.split("\0").filter(Boolean)))].sort();
  if (files.length > 100_000) return { valid: false, reason: "candidate file inventory exceeded limit" };
  let bytes = 0; const entries = [], observedFiles = [];
  for (const relative of files) {
    checkpoint();
    const target = path.resolve(snapshotRoot, relative);
    if (!isWithin(snapshotRoot, target)) return { valid: false, reason: "candidate path escaped worktree" };
    let info;
    try { info = await lstat(target); } catch (error) { if (error.code === "ENOENT") { entries.push([relative, "missing"]); continue; } return { valid: false, reason: "candidate file inspection failed" }; }
    if (info.isSymbolicLink()) { const link = await readlink(target); entries.push([relative, "link", createHash("sha256").update(link).digest("hex")]); continue; }
    if (!info.isFile()) return { valid: false, reason: "candidate contains non-regular entry" };
    bytes += info.size; if (bytes > 2 * 1024 * 1024 * 1024) return { valid: false, reason: "candidate byte inventory exceeded limit" };
    let canonical;
    try { canonical = await realpath(target); } catch { return { valid: false, reason: "candidate path resolution failed" }; }
    if (path.relative(target, canonical) !== "" || !isWithin(snapshotRoot, canonical)) return { valid: false, reason: "candidate path was redirected" };
    let handle;
    try { handle = await open(target, "r"); } catch { return { valid: false, reason: "candidate file open failed" }; }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size || before.mtimeMs !== info.mtimeMs) return { valid: false, reason: "candidate file changed before read" };
      const buffer = Buffer.alloc(64 * 1024), contentHash = createHash('sha256'); let length = 0;
      for (;;) { checkpoint(); const part = await handle.read(buffer, 0, buffer.length, null); checkpoint(); if (!part.bytesRead) break; length += part.bytesRead; if (length > before.size) return { valid: false, reason: "candidate file grew during read" }; contentHash.update(buffer.subarray(0, part.bytesRead)); }
      const after = await handle.stat();
      const current = await lstat(target);
      if (length !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs || await realpath(target) !== canonical) return { valid: false, reason: "candidate file changed during read" };
      entries.push([relative, "file", before.size, before.mode, contentHash.digest('hex')]);
      observedFiles.push({target,canonical,info:after});
    } finally { await handle.close(); }
  }
  // Detect inventory/index movement across the read. This is a bounded
  // observation, not an atomic filesystem snapshot or permission to execute.
  for (let index = 0; index < commands.length; index++) {
    const current = await gitRun(cwd, commands[index]);
    if (current.exit !== 0 || current.stdout !== results[index]) return { valid: false, reason: "candidate inventory changed during read" };
  }
  for (const observed of observedFiles) {
    checkpoint();
    const current=await lstat(observed.target),before=observed.info;
    if(!current.isFile()||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mode!==before.mode||current.mtimeMs!==before.mtimeMs||current.ctimeMs!==before.ctimeMs||await realpath(observed.target)!==observed.canonical)return {valid:false,reason:'candidate file changed after read'};
  }
  const body = JSON.stringify({ schemaVersion: 2, index: createHash("sha256").update(results[0]).digest("hex"), entries });
  return { valid: true, snapshotSchemaVersion: 2, digest: createHash("sha256").update(body).digest("hex"), files: files.length, bytes };
}
export async function candidateSnapshot(cwd, gitRun = git, {signal,timeoutMs=120000}={}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||(signal!==undefined&&!(signal instanceof AbortSignal)))return {valid:false,reason:'candidate capture options invalid'};
  const controller=new AbortController(),deadline=performance.now()+timeoutMs;
  let stopReason=null;
  const stop=reason=>{stopReason??=reason;controller.abort();};
  const onAbort=()=>stop('candidate cancelled');
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted)onAbort();
  const timer=setTimeout(()=>stop('candidate time limit'),timeoutMs);
  const checkpoint=()=>{if(performance.now()>=deadline)stop('candidate time limit');if(stopReason)throw Error(stopReason);};
  try {
    const result=await captureCandidateSnapshot(cwd,async(root,args)=>{
      checkpoint();
      const value=await gitRun(root,args,{signal:controller.signal,timeoutMs:Math.max(1,Math.min(10000,Math.ceil(deadline-performance.now()))),maxBytes:8_000_000});
      if(value.cleanupComplete===false)throw Object.assign(Error('candidate process cleanup uncertain'),{cleanupComplete:false,code:'GIT_PROCESS_UNCERTAIN'});
      checkpoint();return value;
    },checkpoint);
    checkpoint();return result;
  } catch(error) {
    if(error.cleanupComplete===false||error.code==='GIT_PROCESS_UNCERTAIN')return {valid:false,reason:'candidate process cleanup uncertain',cleanupComplete:false,code:'GIT_PROCESS_UNCERTAIN'};
    return { valid: false, reason:stopReason??'candidate inventory failed unexpectedly' };
  }
  finally {clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
  // File I/O cancellation is cooperative: await outstanding I/O and handle
  // closure. Never race-return while it continues under released authority.
}
async function writeReceipt(directory, receipt) { await mkdir(directory, { recursive: true }); const body = { ...receipt, digest: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") }; const target = path.join(directory, `${receipt.rehearsalId}.json`); const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" }); await rename(temporary, target); return { path: target, digest: body.digest }; }

export async function rehearseMergedState(options) {
  assertRef("targetRef", options.targetRef); assertRef("sourceRef", options.sourceRef);
  const gitRun = options.gitRunner ?? git;
  const repositoryRoot = await realpath(path.resolve(options.repositoryRoot));
  const top = await gitRun(repositoryRoot, ["rev-parse", "--show-toplevel"]);
  if (top.exit !== 0 || path.resolve(top.stdout.trim()) !== repositoryRoot) throw new Error("Merged-state rehearsal requires the exact Git repository root.");
  const allowedBase = await realpath(path.resolve(options.allowedBase ?? path.dirname(repositoryRoot)));
  const worktreeParent = path.resolve(options.worktreeParent ?? path.join(allowedBase, ".pp-merge-rehearsals"));
  if (!isWithin(allowedBase, worktreeParent) || isWithin(repositoryRoot, worktreeParent)) throw new Error("Rehearsal worktree must be a sibling inside the approved base, never inside the source checkout.");
  await ensureUnredirectedDirectory(allowedBase, worktreeParent);
  const rehearsalId = randomUUID(); const worktreePath = path.join(worktreeParent, `merge-${rehearsalId}`);
  const target = await gitRun(repositoryRoot, ["rev-parse", "--verify", `${options.targetRef}^{commit}`]); const source = await gitRun(repositoryRoot, ["rev-parse", "--verify", `${options.sourceRef}^{commit}`]);
  if (target.exit !== 0) throw new Error(`Target ref does not resolve to a commit: ${options.targetRef}`); if (source.exit !== 0) throw new Error(`Source ref does not resolve to a commit: ${options.sourceRef}`);
  const targetSha = target.stdout.trim(); const sourceSha = source.stdout.trim();
  const transactionStoreRoot = path.resolve(options.transactionStoreRoot ?? path.join(allowedBase, ".pp-merge-transactions"));
  if (isWithin(repositoryRoot, transactionStoreRoot) || isWithin(worktreePath, transactionStoreRoot) || isWithin(transactionStoreRoot, worktreePath)) throw new Error("Merge transaction store must be external to the source checkout and candidate worktree.");
  await ensureUnredirectedDirectory(allowedBase, transactionStoreRoot);
  const ownerInput = String(options.actor ?? "merge-rehearsal");
  const transactionOwner = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,95}$/.test(ownerInput) ? ownerInput : `actor-${createHash("sha256").update(ownerInput).digest("hex").slice(0, 32)}`;
  const store = { createIntent: createMergeTransactionIntent, appendTransition: appendMergeTransactionTransition, ...options.transactionStore };
  let transactionSnapshot = await store.createIntent({ storeRoot: transactionStoreRoot, transactionId: rehearsalId, repositoryRoot,
    repositoryIdentity: createHash("sha256").update(repositoryRoot).digest("hex"), baseSha: targetSha, sourceSha, targetRef: options.targetRef, sourceRef: options.sourceRef,
    allowedWorktreeRoot: worktreeParent, worktreePath, owner: transactionOwner, operation: "merge-rehearsal" });
  const transaction = { transactionId: rehearsalId, storeRoot: transactionStoreRoot, directory: transactionSnapshot.directory, revision: transactionSnapshot.revision, head: transactionSnapshot.head, state: transactionSnapshot.state, owner: transactionOwner, ownerNormalized: transactionOwner !== ownerInput, journalHealthy: true, pending: true };
  const recordTransition = async (state, evidenceDigest = null) => {
    if (!transaction.journalHealthy) throw new Error("merge-transaction-journal-unavailable");
    try {
      transactionSnapshot = await store.appendTransition({ storeRoot: transactionStoreRoot, transactionId: rehearsalId, expectedRevision: transactionSnapshot.revision, expectedHead: transactionSnapshot.head, state, owner: transactionOwner, evidenceDigest });
      Object.assign(transaction, { revision: transactionSnapshot.revision, head: transactionSnapshot.head, state: transactionSnapshot.state, pending: transactionSnapshot.pending });
    } catch {
      transaction.journalHealthy = false;
      transaction.pending = true;
      throw new Error("merge-transaction-journal-unavailable");
    }
  };
  const hashEvidence = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const cleanup = { state: "pending", forced: false, receiptPath: null, receiptDigest: null, worktreePath, transactionId: rehearsalId, transactionPath: transaction.directory }; let added = false; let addAttempted = false; let outcome; let baselineHead = null; let baselineStatus = null; let baselineCandidate = null; let testedCandidate = null; let ciCommandContractDigest = null;
  const finish = (value) => { outcome = { ...value, proofScope: "local-rehearsal", promotionAuthority: false, candidateSnapshotDigest: baselineCandidate?.valid ? baselineCandidate.digest : null, testedCandidateSnapshotDigest: testedCandidate?.valid ? testedCandidate.digest : null, ciCommandContractDigest, cleanup, transaction }; return outcome; }; const evidence = [];
  try {
    addAttempted = true;
    const add = await gitRun(repositoryRoot, ["worktree", "add", "--detach", worktreePath, targetSha]); if (add.exit !== 0) throw new Error("Unable to create isolated rehearsal worktree; inspect the pending transaction."); added = true;
    await recordTransition("WORKTREE_CREATED", hashEvidence({ targetSha, worktreePath }));
    await recordTransition("MERGE_STARTED", hashEvidence({ targetSha, sourceSha }));
    const merge = await gitRun(worktreePath, ["merge", "--no-commit", "--no-ff", sourceSha]);
    const initialHead = await gitRun(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const initialStatus = await gitRun(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
    if (initialHead.exit !== 0 || initialStatus.exit !== 0) return finish({ state: "grey", reason: "unable to bind the simulated merge candidate", evidence, targetSha, sourceSha });
    baselineHead = initialHead.stdout.trim(); baselineStatus = initialStatus.stdout;
    baselineCandidate = await candidateSnapshot(worktreePath, gitRun);
    if (!baselineCandidate.valid) return finish({ state: "grey", reason: baselineCandidate.reason, evidence, targetSha, sourceSha });
    await recordTransition("MERGE_OBSERVED", hashEvidence({ exit: merge.exit, baselineHead, candidateDigest: baselineCandidate.digest }));
    if (merge.exit !== 0) return finish({ state: "red", reason: "merge conflict", merge: { exit: merge.exit, stdout: merge.stdout, stderr: merge.stderr }, evidence, targetSha, sourceSha });
    const gates = options.ciPlan?.gates ?? []; if (options.ciPlan?.state !== "derived" || !validCiGates(gates)) return finish({ state: "grey", reason: "no valid nonempty supported CI gate contract", evidence, targetSha, sourceSha });
    ciCommandContractDigest = hashEvidence({ gates, allowedExecutables: options.allowedExecutables ?? [process.execPath, "node", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"], allowPackageScripts: options.allowPackageScripts === true, timeoutMs: options.timeoutMs ?? 90_000 });
    const expectedProofCount = gates.reduce((sum, gate) => sum + gate.commands.length, 0);
    await recordTransition("CHECKS_STARTED", ciCommandContractDigest);
    for (const gate of gates) {
      if (!gate.supported) return finish({ state: "grey", reason: `unsupported CI gate ${gate.job}`, evidence, targetSha, sourceSha });
      for (let index = 0; index < gate.commands.length; index += 1) {
        const command = gate.commands[index]; const evidenceDirectory = path.join(worktreeParent, "evidence", rehearsalId);
        const proof = await runProof({ allowedRoot: worktreeParent, cwd: worktreePath, evidenceDirectory, journalPath: path.join(evidenceDirectory, "journal.jsonl"), command: command.executable, args: command.args, policy: { allowedExecutables: options.allowedExecutables ?? [process.execPath, "node", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"], allowPackageScripts: options.allowPackageScripts === true }, planId: options.planId ?? "MERGE-REHEARSAL", itemId: `${gate.job}-${index + 1}`, actor: options.actor ?? "merge-rehearsal", timeoutMs: options.timeoutMs ?? 90_000 });
        evidence.push({ gate: gate.job, commandIndex: index, proven: proof.proven, artifact: proof.artifactName, sha256: proof.sha256, exit: proof.exit, timedOut: proof.timedOut }); if (!proof.proven) return finish({ state: "red", reason: `CI gate ${gate.job} failed`, evidence, targetSha, sourceSha });
      }
    }
    if (evidence.length !== expectedProofCount || !evidence.every((proof) => proof.proven === true)) return finish({ state: "grey", reason: "CI evidence does not cover the exact command contract", evidence, targetSha, sourceSha });
    const [freshTarget, freshSource, testedHead, testedStatus] = await Promise.all([
      gitRun(repositoryRoot, ["rev-parse", "--verify", `${options.targetRef}^{commit}`]),
      gitRun(repositoryRoot, ["rev-parse", "--verify", `${options.sourceRef}^{commit}`]),
      gitRun(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      gitRun(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]),
    ]);
    if ([freshTarget, freshSource, testedHead, testedStatus].some((result) => result.exit !== 0)) return finish({ state: "grey", reason: "candidate freshness could not be reverified", evidence, targetSha, sourceSha });
    if (freshTarget.stdout.trim() !== targetSha || freshSource.stdout.trim() !== sourceSha) return finish({ state: "grey", reason: "target or source ref moved during rehearsal", evidence, targetSha, sourceSha });
    testedCandidate = await candidateSnapshot(worktreePath, gitRun);
    if (!testedCandidate.valid || testedCandidate.digest !== baselineCandidate.digest || testedHead.stdout.trim() !== baselineHead || testedStatus.stdout !== baselineStatus) return finish({ state: "grey", reason: "gate changed the tested candidate; rehearsal worktree retained", evidence, targetSha, sourceSha });
    await recordTransition("CHECKS_FINISHED", hashEvidence({ evidence, targetSha, sourceSha, baselineCandidateDigest: baselineCandidate.digest, testedCandidateDigest: testedCandidate.digest, ciCommandContractDigest }));
    return finish({ state: "green", reason: "all derived gates passed in isolated simulated merge", evidence, targetSha, sourceSha });
  } catch (error) {
    return finish({ state: "grey", reason: error.message === "merge-transaction-journal-unavailable" ? "Durable transaction journal failed; candidate retained for inspection." : "Merged-state operation interrupted; inspect the pending transaction before recovery.", evidence, targetSha, sourceSha });
  } finally {
    let normalRemoval = { attempted: false, exit: null, stderr: "" }; let forcedRemoval = { attempted: false, exit: null, stderr: "" }; let abort = { attempted: false, exit: null, stderr: "" }; let preservation = { inspected: false, safeToDiscard: false, head: null, status: null, reason: null };
    try {
      if (added && transaction.journalHealthy && transactionSnapshot.state === "CHECKS_FINISHED") {
        const inspectedHead = await gitRun(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]); const inspectedStatus = await gitRun(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
        const inspectedCandidate = inspectedHead.exit === 0 && inspectedStatus.exit === 0 ? await candidateSnapshot(worktreePath, gitRun) : { valid: false, reason: "candidate inspection failed" };
        const candidateUnchanged = inspectedHead.exit === 0 && inspectedStatus.exit === 0 && inspectedCandidate.valid && baselineHead !== null && baselineStatus !== null && baselineCandidate?.valid && inspectedHead.stdout.trim() === baselineHead && inspectedStatus.stdout === baselineStatus && inspectedCandidate.digest === baselineCandidate.digest;
        preservation = { inspected: inspectedHead.exit === 0 && inspectedStatus.exit === 0 && inspectedCandidate.valid, candidateUnchanged, safeToDiscard: false, head: inspectedHead.exit === 0 ? inspectedHead.stdout.trim() : null, status: inspectedStatus.exit === 0 ? inspectedStatus.stdout : null, candidateDigest: inspectedCandidate.digest ?? null, baselineCandidateDigest: baselineCandidate?.digest ?? null, reason: candidateUnchanged ? "exact tested candidate retained for review; automatic discard is not authorized" : "candidate changed or could not be inspected" };
        cleanup.state = candidateUnchanged && outcome?.state === "green" ? "retained-for-review" : "manual-recovery-required";
      } else cleanup.state = addAttempted ? "manual-recovery-required" : "not-created";
    } catch {
      cleanup.state = "manual-recovery-required";
      preservation.reason = "candidate inspection failed unexpectedly; all work is retained";
    }
    cleanup.recovery = cleanup.state !== "not-created" ? { command: ["git", "-C", worktreePath, "status", "--short"], note: cleanup.state === "retained-for-review" ? "The exact tested candidate is retained for review. Storage disposition and any later promotion require a separate preservation-safe workflow." : "Inspect and preserve commits plus tracked and untracked work in the retained worktree before any removal." } : null;
    cleanup.abort = abort; cleanup.preservation = preservation;
    try {
      const durable = await writeReceipt(path.join(worktreeParent, "cleanup-receipts"), { schemaVersion: 1, rehearsalId, transactionId: rehearsalId, transactionPath: transaction.directory, transactionHead: transaction.head, createdAt: new Date().toISOString(), state: cleanup.state, forced: cleanup.forced, proofScope: "local-rehearsal", promotionAuthority: false, candidateSnapshotDigest: baselineCandidate?.digest ?? null, testedCandidateSnapshotDigest: testedCandidate?.digest ?? null, ciCommandContractDigest, repositoryRoot, worktreePath, targetRef: options.targetRef, sourceRef: options.sourceRef, targetSha, sourceSha, abort, preservation, normalRemoval, forcedRemoval, recovery: cleanup.recovery }); cleanup.receiptPath = durable.path; cleanup.receiptDigest = durable.digest;
      if (transaction.journalHealthy) await recordTransition("RETAINED", durable.digest);
    } catch {
      cleanup.state = "manual-recovery-required"; transaction.pending = true;
      const supersededReceipt = cleanup.receiptPath ? { path: cleanup.receiptPath, digest: cleanup.receiptDigest } : null;
      cleanup.receiptPath = null; cleanup.receiptDigest = null;
      cleanup.recovery = { command: ["git", "-C", worktreePath, "status", "--short"], note: "The retention receipt or journal could not be finalized. Inspect the pending transaction and preserve all candidate work; no promotion or cleanup is authorized." };
      try {
        const recovery = await writeReceipt(path.join(worktreeParent, "cleanup-receipts"), { schemaVersion: 1, rehearsalId: `${rehearsalId}-recovery-${randomUUID()}`, originalRehearsalId: rehearsalId, transactionId: rehearsalId, transactionPath: transaction.directory, transactionHead: transaction.head, createdAt: new Date().toISOString(), state: "manual-recovery-required", forced: false, proofScope: "local-rehearsal", promotionAuthority: false, supersededReceipt, journalHealthy: transaction.journalHealthy, candidateSnapshotDigest: baselineCandidate?.digest ?? null, testedCandidateSnapshotDigest: testedCandidate?.digest ?? null, ciCommandContractDigest, repositoryRoot, worktreePath, targetSha, sourceSha, abort, preservation, normalRemoval, forcedRemoval, recovery: cleanup.recovery });
        cleanup.receiptPath = recovery.path; cleanup.receiptDigest = recovery.digest;
        if (transaction.journalHealthy) await recordTransition("RETAINED", recovery.digest);
      } catch { cleanup.receiptUnavailable = cleanup.receiptPath === null; }
    }
    if (cleanup.state === "manual-recovery-required" && !cleanup.recovery) cleanup.recovery = {
      command: ["git", "-C", repositoryRoot, "worktree", "list", "--porcelain"],
      note: "Inspect the durable transaction and actual worktree registration. A failed final journal write cannot establish cleanup completion.",
    };
    if (cleanup.state === "manual-recovery-required" && outcome?.state === "green") { outcome.state = "grey"; outcome.reason = "merged-state gates passed but retained candidate or journal requires inspection"; }
  }
}


