import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalWorkUnit } from "../engine/conveyorEngine.js";
import { runGuardedGit } from "./guardedGitRunner.mjs";

const REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]+$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const samePath = (left, right) => process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const isWithin = (root, candidate) => { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
async function ensureUnredirectedDirectory(root, target) {
  const relative = path.relative(root, target); if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Worktree directory escapes its approved root.");
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); const info = await lstat(cursor).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error)); if (!info) break; if (!info.isDirectory() || info.isSymbolicLink() || !samePath(cursor, await realpath(cursor))) throw new Error("Worktree directory ancestor is redirected."); }
  await mkdir(target, { recursive: true }); const canonical = await realpath(target); if (!isWithin(root, canonical) || !samePath(target, canonical)) throw new Error("Worktree directory creation was redirected."); return canonical;
}

async function requiredGit(runGit, cwd, args, message) {
  const result = await runGit(cwd, args);
  if (result.exit !== 0 || result.reason || result.cleanupComplete === false) throw new Error(`${message}: ${result.reason ?? (String(result.stderr ?? "").trim() || "git command failed")}`);
  return result.stdout.trim();
}

function validateAuthority(reservation, authority) {
  const blockers = [];
  if (authority?.session?.current !== true || authority.session.state !== "active" || authority.session.planId !== reservation.planId || authority.session.taskId !== reservation.taskId || authority.session.owner !== reservation.owner) blockers.push("A current active exact session must own the conveyor reservation.");
  if (authority?.collision?.current !== true || authority.collision.clear !== true || !String(authority.collision.censusDigest ?? "").trim()) blockers.push("Current collision authority and census digest must be clear.");
  if (authority?.dependencies?.current !== true || authority.dependencies.complete !== true || !String(authority.dependencies.digest ?? "").trim()) blockers.push("Current dependency authority must be complete and digest-bound.");
  if (blockers.length) throw new Error(`Git materialization refused: ${blockers.join(" ")}`);
}

function validateReservation(input) {
  const canonicalReservation = canonicalWorkUnit({ planId: input.planId, taskId: input.taskId, slug: input.slug, owner: input.owner, claims: input.claims ?? [] });
  if (!canonicalReservation.valid) throw new Error(`Git materialization requires a canonical conveyor reservation: ${canonicalReservation.errors.join(" ")}`);
  const expected = canonicalReservation.unit;
  if (input.branch !== expected.branch || input.worktree !== expected.worktree) throw new Error("Git branch and worktree names must exactly match the conveyor reservation.");
  return expected;
}

export async function materializeConveyorGitReservation(input, adapters = {}) {
  const reservation = validateReservation(input?.reservation ?? {});
  validateAuthority(reservation, input?.authority);
  if (input?.mode === "private" || input?.mode === "no-git") {
    const body = { schemaVersion: 1, state: "NOT_APPLICABLE", mode: input.mode, planId: reservation.planId, taskId: reservation.taskId, branch: reservation.branch, worktree: reservation.worktree, claims: reservation.claims, fileReservationsPreserved: true, gitCommandsRun: 0, reason: "Private/no-Git mode keeps file reservations but does not create Git state." };
    return Object.freeze({ ...body, receiptHash: sha256(JSON.stringify(canonical(body))) });
  }
  if (input?.mode !== "git") throw new Error("Git materialization mode must be git, private, or no-git.");
  if (!REF_PATTERN.test(String(input.targetRef ?? ""))) throw new Error("Git target ref is unsafe.");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(input.expectedTargetSha ?? ""))) throw new Error("Git materialization requires an exact expected target commit SHA.");
  const requestedRoot = path.resolve(input.repositoryRoot);
  const repositoryRoot = await realpath(requestedRoot);
  if (!samePath(requestedRoot, repositoryRoot)) throw new Error("Git materialization requires the exact real repository root, not an alias.");
  const runGit = adapters.runGit ?? ((cwd, args) => runGuardedGit(cwd, args, { maxBytes: adapters.maxBytes, timeoutMs: adapters.timeoutMs }));
  const top = await requiredGit(runGit, repositoryRoot, ["rev-parse", "--show-toplevel"], "Unable to inspect repository root");
  if (!samePath(top, repositoryRoot)) throw new Error("Git materialization requires the exact repository root.");
  const status = await requiredGit(runGit, repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"], "Unable to inspect repository status");
  if (status) throw new Error("Git materialization refuses a dirty or untracked repository.");
  const targetSha = await requiredGit(runGit, repositoryRoot, ["rev-parse", "--verify", `${input.targetRef}^{commit}`], "Target ref does not resolve");
  if (input.expectedTargetSha !== targetSha) throw new Error("Target ref moved from the expected commit.");
  const branchProbe = await requiredGit(runGit, repositoryRoot, ["for-each-ref", "--format=%(refname)", `refs/heads/${reservation.branch}`], "Unable to prove reserved branch absence");
  if (branchProbe.split(/\r?\n/).includes(`refs/heads/${reservation.branch}`)) throw new Error("Reserved branch already exists.");
  const allowedWorktreeRoot = await realpath(path.resolve(input.allowedWorktreeRoot));
  const worktreePath = path.resolve(path.dirname(repositoryRoot), reservation.worktree);
  if (!isWithin(allowedWorktreeRoot, worktreePath) || isWithin(repositoryRoot, worktreePath)) throw new Error("Reserved worktree must be a sibling inside the exact approved worktree root.");
  try { await lstat(worktreePath); throw new Error("Reserved worktree path already exists."); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const listed = await requiredGit(runGit, repositoryRoot, ["worktree", "list", "--porcelain"], "Unable to inspect existing worktrees");
  if (listed.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).some((line) => samePath(line.slice(9), worktreePath))) throw new Error("Reserved worktree is already registered.");
  await ensureUnredirectedDirectory(allowedWorktreeRoot, path.dirname(worktreePath));
  await requiredGit(runGit, repositoryRoot, ["worktree", "add", "-b", reservation.branch, worktreePath, targetSha], "Unable to materialize reserved branch/worktree");
  const branchSha = await requiredGit(runGit, repositoryRoot, ["rev-parse", "--verify", `${reservation.branch}^{commit}`], "Created branch cannot be verified");
  const createdRoot = await requiredGit(runGit, worktreePath, ["rev-parse", "--show-toplevel"], "Created worktree cannot be verified");
  if (branchSha !== targetSha || !samePath(createdRoot, worktreePath)) throw new Error("Created Git state does not match the reservation.");
  const body = { schemaVersion: 1, state: "MATERIALIZED", mode: "git", planId: reservation.planId, taskId: reservation.taskId, owner: reservation.owner, branch: reservation.branch, worktree: reservation.worktree, worktreePath, targetRef: input.targetRef, targetSha, claims: reservation.claims, fileReservationsPreserved: true, authority: { sessionId: input.authority.session.id ?? null, collisionCensusDigest: input.authority.collision.censusDigest, dependencyDigest: input.authority.dependencies.digest }, createdAt: adapters.timestamp ?? new Date().toISOString() };
  return Object.freeze({ ...body, receiptHash: sha256(JSON.stringify(canonical(body))) });
}

export const conveyorGitAdapterContract = Object.freeze({ executable: "git", shell: false, modes: ["git", "private", "no-git"] });
