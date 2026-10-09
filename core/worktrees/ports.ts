import type { Actor, EntryDraft, LedgerEntry } from "../ledger/index";

/**
 * The slice of core/ledger's Ledger this module uses. The real Ledger satisfies it;
 * keeping it narrow lets the loop run against a read-only or remote ledger later.
 */
export interface LedgerPort {
  append(draft: EntryDraft): LedgerEntry;
  entries(): readonly LedgerEntry[];
  bySubject(subject: string): LedgerEntry[];
}

export const WATCHER_ACTOR: Actor = { kind: "system", id: "watcher" };
export const GATE_ACTOR: Actor = { kind: "system", id: "gate" };
export const WORKTREES_ACTOR: Actor = { kind: "system", id: "worktrees" };

/** Evidence strings are "kind:value"; this reads the first value of a kind. */
export function evidenceValue(entry: { evidence?: string[] }, kind: string): string | undefined {
  const prefix = `${kind}:`;
  return entry.evidence?.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

export type { Actor, EntryDraft, LedgerEntry };
