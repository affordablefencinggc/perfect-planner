import type { Actor, Ledger, LedgerEntry } from "../ledger/index";
import { releases, releaseStamp, rollbackRelease, type ReleaseRecord } from "../numbering/index";

// One-click rollback (plan: "Every merge can be rolled back in one click, so
// the worst case is always back to the last good state"). A rollback is a NEW
// release with the next R- number and a patch bump (core/numbering), never a
// rewrite of history. The deploy runs first; the ledger only records a
// rollback that actually went out.

export interface RollbackCandidate {
  release: string;
  version: string;
  commit: string;
  stamp: string;
  at: string;
  /** The release that was live just before the current one: what one click restores. */
  isDefault: boolean;
}

/** Releases a person can roll back to, newest first. The current release is not a candidate. */
export function rollbackCandidates(entries: readonly LedgerEntry[]): RollbackCandidate[] {
  const list = releases(entries);
  const earlier = list.slice(0, -1).reverse();
  return earlier.map((record, index) => ({
    release: record.release,
    version: record.version,
    commit: record.commit,
    stamp: releaseStamp(entries, record.release) ?? record.release,
    at: record.at,
    isDefault: index === 0,
  }));
}

export class RollbackError extends Error {
  constructor(
    readonly code: "NOT_A_PERSON" | "NOTHING_TO_ROLL_BACK" | "UNKNOWN_RELEASE" | "DEPLOY_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "RollbackError";
  }
}

/** Puts a commit into production; the app supplies it (tag + deploy, Tauri updater channel, ...). */
export type Deployer = (target: { commit: string; release: ReleaseRecord }) => Promise<void>;

export interface OneClickOptions {
  reason: string;
  /** Release to restore; defaults to the one live before the current release. */
  to?: string;
  deploy?: Deployer;
}

export interface RollbackResult {
  entry: LedgerEntry;
  restored: ReleaseRecord;
  stamp: string;
}

/**
 * The one click: pick the release to restore, deploy its commit, then write
 * release.rollback as a new R- number. If the deploy fails nothing is
 * written and the error says what happened, so the ledger never claims a
 * rollback that did not reach production.
 */
export async function oneClickRollback(ledger: Ledger, actor: Actor, options: OneClickOptions): Promise<RollbackResult> {
  if (actor.kind !== "person") {
    throw new RollbackError("NOT_A_PERSON", "Only a person can roll back production");
  }
  const entries = ledger.entries();
  const candidates = rollbackCandidates(entries);
  if (candidates.length === 0) {
    throw new RollbackError("NOTHING_TO_ROLL_BACK", "There is no earlier release to go back to");
  }
  const target = options.to ?? candidates[0].release;
  const restored = releases(entries).find((record) => record.release === target);
  if (!restored || !candidates.some((candidate) => candidate.release === target)) {
    throw new RollbackError("UNKNOWN_RELEASE", `${target} is not an earlier release`);
  }
  if (options.deploy) {
    try {
      await options.deploy({ commit: restored.commit, release: restored });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RollbackError("DEPLOY_FAILED", `Deploying ${target} (${restored.commit}) failed, nothing was rolled back: ${detail}`);
    }
  }
  const entry = rollbackRelease(ledger, actor, { to: target, reason: options.reason });
  return { entry, restored, stamp: releaseStamp(ledger.entries(), entry.subject) ?? entry.subject };
}
