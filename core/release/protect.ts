import { fileURLToPath } from "node:url";
import { isAuthoritative, type Actor, type Ledger, type LedgerEntry } from "../ledger/index";
import { nextNumber } from "../numbering/index";
import { installPrePushHook, removePrePushHook } from "./layers";
import { installReleaseRules } from "./pipeline";
import { RELEASE_SAFETY_TOPIC } from "./presets";
import { safeRunner } from "./run";
import type { CommandRunner } from "./types";

// Shipping safety on by default. The host calls protectProject when it opens a
// project, so the release rules (person-only settings, the budget stop) hold
// before the first review, and the whole-branch secret scan runs before every
// push. The rules cannot be switched off; the local pre-push scan can, but only
// by a person's signed decision in the ledger (setPrePushScan).

/** The dependency-free pre-push scan this module ships; the hook shim runs it with node. */
export const DEFAULT_PRE_PUSH_SCRIPT = fileURLToPath(new URL("./hooks/pre-push.mjs", import.meta.url));

/** Whether the pre-push scan should be on: yes, unless a person's latest signed decision turned it off. */
export function prePushScanWanted(entries: readonly LedgerEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "decision.made" && isAuthoritative(entry, { personOnly: true }) && entry.data?.topic === RELEASE_SAFETY_TOPIC && typeof entry.data?.prePush === "boolean") {
      return entry.data.prePush;
    }
  }
  return true;
}

/** Records a person's choice to switch the pre-push scan off or back on (decision.made D-n). */
export function setPrePushScan(ledger: Ledger, actor: Actor, on: boolean, reason: string): LedgerEntry {
  if (actor.kind !== "person") throw new Error("Only a person can change the pre-push secret scan");
  installReleaseRules(ledger);
  return ledger.append({
    actor,
    type: "decision.made",
    subject: nextNumber(ledger.entries(), "D"),
    summary: on ? "Pre-push secret scan switched on" : "Pre-push secret scan switched off",
    reason,
    evidence: [],
    refs: [],
    data: { topic: RELEASE_SAFETY_TOPIC, prePush: on },
  });
}

export type PrePushState = "installed" | "opted-out" | "foreign-hook" | "not-a-repo";

export interface ProtectionReport {
  /** The release rules are always installed; there is no opt-out. */
  rules: "on";
  prePush: { state: PrePushState; path?: string; reason: string };
}

/**
 * Switches on shipping safety for an open project: installs the release rules
 * on its ledger and the pre-push scan in its repository (or removes our own
 * hook when a person opted out). Never touches a hook that is not ours, and
 * reports a folder that is not a git repository instead of throwing, so
 * opening a project never fails on it.
 */
export async function protectProject(
  ledger: Ledger,
  options: { run?: CommandRunner; cwd: string; hookScript?: string; now?: () => Date },
): Promise<ProtectionReport> {
  installReleaseRules(ledger, options.now ? { now: options.now } : {});
  const wanted = prePushScanWanted(ledger.entries());
  // Default: git by absolute path, never one planted in the repo (core/exec).
  const run = options.run ?? safeRunner;
  try {
    if (!wanted) {
      const removed = await removePrePushHook(run, { cwd: options.cwd });
      return { rules: "on", prePush: { state: "opted-out", path: removed.path, reason: "A person switched the pre-push secret scan off in the ledger" } };
    }
    const result = await installPrePushHook(run, { cwd: options.cwd, hookScript: options.hookScript ?? DEFAULT_PRE_PUSH_SCRIPT });
    if (!result.installed) return { rules: "on", prePush: { state: "foreign-hook", path: result.path, reason: result.reason ?? "The repository has its own pre-push hook" } };
    return { rules: "on", prePush: { state: "installed", path: result.path, reason: "The whole-branch secret scan runs before every push" } };
  } catch (error) {
    return { rules: "on", prePush: { state: "not-a-repo", reason: error instanceof Error ? error.message : String(error) } };
  }
}
