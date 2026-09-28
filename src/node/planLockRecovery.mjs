import { createHash } from "node:crypto";
import { appendJournalEvent } from "./journalStore.mjs";
import { clearInspectedStalePlanLock, inspectPlanLock } from "./planLock.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function inspectStalePlanLockForOperator(targetPath, options = {}) {
  const inspection = await inspectPlanLock(targetPath, options);
  return { inspection, view: { state: inspection.state, lockDirectory: inspection.lockDirectory, ageMs: inspection.ageMs, holder: inspection.holder && { actor: inspection.holder.actor, pid: inspection.holder.pid, acquiredAt: inspection.holder.acquiredAt, target: inspection.holder.target, token: "REDACTED" } } };
}

export async function recoverInspectedStalePlanLock(targetPath, inspected, input, options = {}) {
  const operator = String(input?.operator ?? "").trim(); const reason = String(input?.reason ?? "").trim(); const recoveryJournalPath = String(input?.recoveryJournalPath ?? "").trim();
  if (!operator || !reason || !recoveryJournalPath) throw new Error("Stale-lock recovery requires a named operator, reason, and separate recovery journal.");
  if (inspected?.view?.state !== "STALE" || inspected.view.holder?.token !== "REDACTED") throw new Error("Stale-lock recovery requires the exact redacted operator inspection.");
  const authorized = await appendJournalEvent(recoveryJournalPath, { action: "plan-lock.stale-clearance-authorized", payload: { targetPath, lockDirectory: inspected.view.lockDirectory, holder: inspected.view.holder, reason } }, { actor: operator, timestamp: options.timestamp });
  const cleared = await clearInspectedStalePlanLock(targetPath, inspected.inspection, { actor: operator, now: options.now, staleMs: options.staleMs });
  const body = { schemaVersion: 1, state: "CLEARED", operator, reason, targetPath, lockDirectory: cleared.lockDirectory, authorizationJournalHash: authorized.hash, clearedHolder: cleared.clearedHolder };
  return { ...body, receiptHash: hash(body) };
}
