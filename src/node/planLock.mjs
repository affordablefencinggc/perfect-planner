import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const staleInspectionIdentity = new WeakMap();

async function readHolder(lockDirectory) {
  try { return JSON.parse(await readFile(path.join(lockDirectory, "holder.json"), "utf8")); }
  catch { return { actor: "unknown", acquiredAt: null, token: null }; }
}

async function assertSafeLockDirectory(lockDirectory) {
  const stat = await lstat(lockDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Plan lock path is not a safe regular directory: ${lockDirectory}.`);
  return stat;
}

async function inspectPlanLockRaw(targetPath, options = {}) {
  const lockDirectory = `${path.resolve(targetPath)}.pp-lock`;
  try { await assertSafeLockDirectory(lockDirectory); }
  catch (error) { if (error.code === "ENOENT") return { state: "MISSING", lockDirectory, holder: null, ageMs: null }; throw error; }
  const holder = await readHolder(lockDirectory);
  const now = Number(options.now ?? Date.now()); const staleMs = Number(options.staleMs ?? 2 * 60 * 1000);
  const ageMs = holder.acquiredAt ? now - new Date(holder.acquiredAt).getTime() : Number.POSITIVE_INFINITY;
  return { state: ageMs > staleMs ? "STALE" : "ACTIVE", lockDirectory, holder, ageMs };
}

export async function inspectPlanLock(targetPath, options = {}) {
  const raw = await inspectPlanLockRaw(targetPath, options);
  if (!raw.holder) return raw;
  const inspection = { ...raw, holder: { actor: raw.holder.actor ?? "unknown", pid: raw.holder.pid ?? null, acquiredAt: raw.holder.acquiredAt ?? null, target: raw.holder.target ?? null, token: "REDACTED" } };
  if (raw.state === "STALE") staleInspectionIdentity.set(inspection, { token: raw.holder.token, acquiredAt: raw.holder.acquiredAt, lockDirectory: raw.lockDirectory });
  return inspection;
}

export async function clearInspectedStalePlanLock(targetPath, inspection, options = {}) {
  const actor = String(options.actor ?? "").trim();
  const inspectedIdentity = staleInspectionIdentity.get(inspection);
  if (!actor || inspection?.state !== "STALE" || !inspectedIdentity?.token || !inspection?.holder?.acquiredAt) throw new Error("Stale lock clearance requires a named actor and an exact prior STALE inspection from this process.");
  const current = await inspectPlanLockRaw(targetPath, { now: options.now, staleMs: options.staleMs });
  if (current.state !== "STALE") throw new Error("Refusing stale lock clearance because the current holder is not stale.");
  if (current.lockDirectory !== inspectedIdentity.lockDirectory || current.holder.token !== inspectedIdentity.token || current.holder.acquiredAt !== inspectedIdentity.acquiredAt) throw new Error("Refusing stale lock clearance because holder identity changed after inspection.");
  await rm(current.lockDirectory, { recursive: true, force: false });
  staleInspectionIdentity.delete(inspection);
  return { state: "CLEARED", actor, lockDirectory: current.lockDirectory, clearedHolder: { actor: current.holder.actor, acquiredAt: current.holder.acquiredAt, token: "REDACTED" } };
}

export async function acquirePlanLock(targetPath, options = {}) {
  const lockDirectory = `${path.resolve(targetPath)}.pp-lock`;
  const actor = String(options.actor ?? `pid-${process.pid}`);
  const timeoutMs = Number(options.timeoutMs ?? 2 * 60 * 1000);
  const staleMs = Number(options.staleMs ?? 2 * 60 * 1000);
  const retryMs = Math.max(5, Number(options.retryMs ?? 20));
  const startedAt = Date.now();
  const token = randomUUID();
  while (true) {
    try {
      await mkdir(lockDirectory);
      const holder = { token, actor, pid: process.pid, acquiredAt: new Date().toISOString(), target: path.resolve(targetPath) };
      await writeFile(path.join(lockDirectory, "holder.json"), JSON.stringify(holder, null, 2), { flag: "wx" });
      return { lockDirectory, holder };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const inspection = await inspectPlanLockRaw(targetPath, { staleMs }); const holder = inspection.holder; const ageMs = inspection.ageMs;
      if (Date.now() - startedAt >= timeoutMs) {
        const state = ageMs > staleMs ? "STALE" : "ACTIVE";
        throw new Error(`Plan lock timeout: ${state} holder ${holder.actor ?? "unknown"} owns ${lockDirectory}; inspect before clearing.`);
      }
      await delay(retryMs);
    }
  }
}

export async function releasePlanLock(lock) {
  await assertSafeLockDirectory(lock.lockDirectory);
  const current = await readHolder(lock.lockDirectory);
  if (!current.token || current.token !== lock.holder.token) throw new Error("Refusing to release a plan lock owned by another session.");
  await rm(lock.lockDirectory, { recursive: true, force: false });
}

export async function withPlanLock(targetPath, options, operation) {
  const lock = await acquirePlanLock(targetPath, options);
  try { return await operation(lock.holder); }
  finally { await releasePlanLock(lock); }
}
