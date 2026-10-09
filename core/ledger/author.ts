import type { ActorKind, LedgerEntry } from "./types";

/**
 * Who wrote an entry, as the ledger checked it at write time and re-checks
 * on every open against the permission table. Consumers decide trust from
 * this, never from a payload field such as data.by or data.confirmedBy.
 */
export function authorKind(entry: LedgerEntry): ActorKind {
  return entry.actor.kind;
}

/**
 * True when a person (or, unless personOnly, the system: the gate or the
 * watcher) wrote the entry. Agent and Jev entries are never authoritative:
 * an agent's answer or a Jev verdict is information, not a decision.
 */
export function isAuthoritative(entry: LedgerEntry, options: { personOnly?: boolean } = {}): boolean {
  const kind = entry.actor.kind;
  return kind === "person" || (!options.personOnly && kind === "system");
}
