// Real Git below: run hermetically regardless of the caller's Git config or GIT_* env.
import "./helpers/hermetic-git.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { canonicalWorkUnit } from "../src/engine/conveyorEngine.js";
import { materializeConveyorGitReservation } from "../src/node/conveyorGitAdapter.mjs";

function git(cwd, args) { return new Promise((resolve, reject) => { const child = spawn("git", args, { cwd, shell: false, windowsHide: true }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("close", (exit, signal) => resolve({ exit, signal, stdout, stderr })); }); }
async function mustGit(cwd, args) { const result = await git(cwd, args); if (result.exit !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
async function fixture({ autocrlf = "false" } = {}) { const base = await mkdtemp(path.join(os.tmpdir(), "pp-conveyor-git-")); const repo = path.join(base, "repo"); const worktrees = path.join(base, "pp-worktrees"); await mkdir(repo); await mkdir(worktrees); await mustGit(repo, ["init", "-b", "main"]); await mustGit(repo, ["config", "user.email", "proof@example.invalid"]); await mustGit(repo, ["config", "user.name", "Proof Fixture"]); await mustGit(repo, ["config", "core.autocrlf", autocrlf]); await writeFile(path.join(repo, "base.txt"), "base\n"); await mustGit(repo, ["add", "base.txt"]); await mustGit(repo, ["commit", "-m", "base"]); return { base, repo, worktrees, head: await mustGit(repo, ["rev-parse", "HEAD"]) }; }
const reservation = canonicalWorkUnit({ planId: "PP-014", taskId: "B07", slug: "collision-engine", owner: "Agent A", claims: [{ kind: "file", surface: "src/collision/**", access: "write" }] }).unit;
const authority = { session: { id: "SESSION-1", current: true, state: "active", planId: "PP-014", taskId: "B07", owner: "Agent A" }, collision: { current: true, clear: true, censusDigest: "c".repeat(64) }, dependencies: { current: true, complete: true, digest: "d".repeat(64) } };

test("exact clean reservation creates one branch and sibling worktree with a hashed receipt", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const result = await materializeConveyorGitReservation({ mode: "git", reservation, authority, repositoryRoot: f.repo, allowedWorktreeRoot: f.worktrees, targetRef: "main", expectedTargetSha: f.head }, { timestamp: "2026-09-02T00:00:00.000Z" });
  assert.equal(result.state, "MATERIALIZED"); assert.match(result.receiptHash, /^[a-f0-9]{64}$/); assert.equal(result.targetSha, f.head); assert.equal(result.fileReservationsPreserved, true);
  assert.equal(await mustGit(f.repo, ["rev-parse", reservation.branch]), f.head); assert.equal((await readFile(path.join(result.worktreePath, "base.txt"), "utf8")), "base\n");
});

test("dirty repositories and moved target heads are refused before creation", async (t) => {
  const dirty = await fixture(); t.after(() => rm(dirty.base, { recursive: true, force: true })); await writeFile(path.join(dirty.repo, "untracked.txt"), "dirty\n");
  await assert.rejects(() => materializeConveyorGitReservation({ mode: "git", reservation, authority, repositoryRoot: dirty.repo, allowedWorktreeRoot: dirty.worktrees, targetRef: "main", expectedTargetSha: dirty.head }), /dirty or untracked/);
  const moved = await fixture(); t.after(() => rm(moved.base, { recursive: true, force: true })); await assert.rejects(() => materializeConveyorGitReservation({ mode: "git", reservation, authority, repositoryRoot: moved.repo, allowedWorktreeRoot: moved.worktrees, targetRef: "main", expectedTargetSha: "0".repeat(40) }), /moved/);
});

test("reservation respects explicit CRLF checkout policy without rewriting the source working copy", async (t) => {
  const f = await fixture({ autocrlf: "true" }); t.after(() => rm(f.base, { recursive: true, force: true }));
  const original = await readFile(path.join(f.repo, "base.txt"));
  const result = await materializeConveyorGitReservation({ mode: "git", reservation, authority, repositoryRoot: f.repo, allowedWorktreeRoot: f.worktrees, targetRef: "main", expectedTargetSha: f.head });
  assert.equal(result.state, "MATERIALIZED");
  assert.equal(result.targetSha, f.head);
  assert.equal(await readFile(path.join(result.worktreePath, "base.txt"), "utf8"), "base\r\n");
  assert.deepEqual(await readFile(path.join(f.repo, "base.txt")), original);
  assert.equal(await mustGit(result.worktreePath, ["status", "--porcelain"]), "");
});

test("Git materialization refuses a missing or malformed expected target binding", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  for (const expectedTargetSha of [undefined, "main", "A".repeat(40), "0".repeat(39)]) await assert.rejects(() => materializeConveyorGitReservation({ mode: "git", reservation, authority, repositoryRoot: f.repo, allowedWorktreeRoot: f.worktrees, targetRef: "main", expectedTargetSha }), /exact expected target/);
  await assert.rejects(() => mustGit(f.repo, ["rev-parse", reservation.branch]));
});

test("session, collision, and dependency authority are all mandatory", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  for (const changed of [{ ...authority, session: { ...authority.session, state: "stale" } }, { ...authority, collision: { ...authority.collision, clear: false } }, { ...authority, dependencies: { ...authority.dependencies, complete: false } }]) await assert.rejects(() => materializeConveyorGitReservation({ mode: "git", reservation, authority: changed, repositoryRoot: f.repo, allowedWorktreeRoot: f.worktrees, targetRef: "main" }), /refused/);
});

test("authority explicitly marked stale is refused before repository inspection", async () => {
  let calls = 0;
  for (const changed of [{ ...authority, session: { ...authority.session, current: false } }, { ...authority, collision: { ...authority.collision, current: false } }, { ...authority, dependencies: { ...authority.dependencies, current: false } }]) {
    await assert.rejects(() => materializeConveyorGitReservation({ mode: "git", reservation, authority: changed, repositoryRoot: "unused", allowedWorktreeRoot: "unused", targetRef: "main" }, { runGit: async () => { calls += 1; } }), /refused/);
  }
  assert.equal(calls, 0);
});

test("unsafe refs, altered reservations, existing branches, and in-repository worktrees fail closed", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await assert.rejects(() => materializeConveyorGitReservation({ mode: "git", reservation, authority, repositoryRoot: f.repo, allowedWorktreeRoot: f.worktrees, targetRef: "main;evil" }), /unsafe/);
  await assert.rejects(() => materializeConveyorGitReservation({ mode: "git", reservation: { ...reservation, branch: "other" }, authority, repositoryRoot: f.repo, allowedWorktreeRoot: f.worktrees, targetRef: "main" }), /exactly match/);
  await mustGit(f.repo, ["branch", reservation.branch]); await assert.rejects(() => materializeConveyorGitReservation({ mode: "git", reservation, authority, repositoryRoot: f.repo, allowedWorktreeRoot: f.worktrees, targetRef: "main", expectedTargetSha: f.head }), /already exists/);
  const contained = await fixture(); t.after(() => rm(contained.base, { recursive: true, force: true }));
  await assert.rejects(() => materializeConveyorGitReservation({ mode: "git", reservation, authority, repositoryRoot: contained.repo, allowedWorktreeRoot: contained.repo, targetRef: "main", expectedTargetSha: contained.head }), /approved worktree root/);
});

test("direct Git capture refuses output beyond the configured byte ceiling", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await assert.rejects(() => materializeConveyorGitReservation({ mode: "git", reservation, authority, repositoryRoot: f.repo, allowedWorktreeRoot: f.worktrees, targetRef: "main", expectedTargetSha: f.head }, { maxBytes: 1 }), /git-output-limit/);
});

test("private mode runs no Git command and preserves exact file reservations", async () => {
  let calls = 0; const result = await materializeConveyorGitReservation({ mode: "private", reservation, authority }, { runGit: async () => { calls += 1; throw new Error("must not run"); }, timestamp: "2026-09-02T00:00:00.000Z" });
  assert.equal(result.state, "NOT_APPLICABLE"); assert.equal(result.fileReservationsPreserved, true); assert.deepEqual(result.claims, reservation.claims); assert.equal(result.gitCommandsRun, 0); assert.equal(calls, 0); assert.match(result.receiptHash, /^[a-f0-9]{64}$/);
});

test("repository checkout hooks are disabled during worktree materialization", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true })); const marker = path.join(f.base, "post-checkout-ran.txt");
  const hook = path.join(f.repo, ".git", "hooks", "post-checkout");
  await writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker).replaceAll("\\", "/")}\n`); if (process.platform !== "win32") await chmod(hook, 0o755);
  const result = await materializeConveyorGitReservation({ mode: "git", reservation, authority, repositoryRoot: f.repo, allowedWorktreeRoot: f.worktrees, targetRef: "main", expectedTargetSha: f.head }, { timestamp: "2026-09-02T00:00:00.000Z" });
  assert.equal(result.state, "MATERIALIZED"); assert.equal(await lstat(marker).then(() => true, () => false), false);
});
