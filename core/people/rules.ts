import { isAuthoritative, Ledger, type EntryDraft, type LedgerEntry, type LedgerStore, type OpenOptions } from "../ledger/index";
import { PeopleError } from "./errors";
import { applyEntry, claimsPeople, emptyRoster, memberForActor, peopleOpRefusal, replayRoster, type Roster } from "./model";
import { APPROVAL_TYPES, type Approval } from "./types";

/**
 * Ledger rules for spec §9: who may change membership, photos and shared
 * documents, and what each role may write. Returns a function that removes
 * the rules.
 *
 * Solo first: until the first member is added nobody is restricted, so a
 * project that never adds helpers behaves exactly as before.
 */
const installed = new WeakMap<Ledger, () => void>();

/** Idempotent: a ledger gets the people rules once. The write helpers in actions.ts and openPeopleLedger call it. */
export function installPeopleRules(ledger: Ledger): () => void {
  const existing = installed.get(ledger);
  if (existing) return existing;
  const remove = ledger.addRule((draft, current) => peopleRefusal(draft, current.entries(), current.owner, current.ownerKeyPinned));
  const uninstall = () => {
    remove();
    installed.delete(ledger);
  };
  installed.set(ledger, uninstall);
  return uninstall;
}

export interface PeopleViolation {
  /** The stored entry that breaks the rules. */
  n: string;
  reason: string;
}

/**
 * Re-checks every stored entry against the people rules as they stood when
 * it was written, for entries appended by a process that never installed
 * them. A solo project's history (before the first member) is always clean.
 */
export function auditPeople(entries: readonly LedgerEntry[], owner?: string): PeopleViolation[] {
  const roster = emptyRoster(owner);
  const violations: PeopleViolation[] = [];
  for (const entry of entries) {
    const reason = claimsPeople(entry)
      ? isAuthoritative(entry, { personOnly: true })
        ? peopleOpRefusal(entry, roster)
        : "only a person can change who is on the project"
      : roleRefusal(entry, roster);
    if (reason) violations.push({ n: entry.n, reason });
    applyEntry(roster, entry);
  }
  return violations;
}

/**
 * Opens a project's ledger with the people rules in force: the stored
 * entries are audited first and a writable open is refused (PeopleError
 * STORED_VIOLATION) when any breaks the rules, so a project is never written
 * to on top of a roster it cannot trust. A read-only open (asked for, or
 * because another process holds the writer lock) still succeeds, so the app
 * can show `auditPeople(ledger.entries(), ledger.owner)`. The app opens project ledgers
 * through this rather than `Ledger.open`.
 */
export async function openPeopleLedger(store: LedgerStore, options: OpenOptions = {}): Promise<Ledger> {
  const ledger = await Ledger.open(store, options);
  const violations = auditPeople(ledger.entries(), ledger.owner);
  if (violations.length > 0 && ledger.status.writable) {
    ledger.close();
    const [first] = violations;
    const more = violations.length > 1 ? ` (and ${violations.length - 1} more)` : "";
    throw new PeopleError("STORED_VIOLATION", `${first!.n} breaks the people rules: ${first!.reason}${more}`);
  }
  installPeopleRules(ledger);
  return ledger;
}

/**
 * `owner` is `ledger.owner`; `pinned` is `ledger.ownerKeyPinned`, which lets
 * the very first person entry claim the project (the ledger makes the owner
 * key sign it).
 */
export function peopleRefusal(draft: EntryDraft, entries: readonly LedgerEntry[], owner?: string, pinned = false): string | null {
  const roster = replayRoster(entries, owner);
  if (pinned && roster.pinnedOwner === undefined && !entries.some((e) => e.actor?.kind === "person")) roster.ownerPending = true;
  if (claimsPeople(draft)) return peopleOpRefusal(draft, roster);
  return roleRefusal(draft, roster);
}

function approvalFor(type: EntryDraft["type"]): Approval | undefined {
  for (const [approval, types] of Object.entries(APPROVAL_TYPES) as [Approval, readonly string[]][]) {
    if (types.includes(type)) return approval;
  }
  return undefined;
}

function roleRefusal(draft: Pick<EntryDraft, "actor" | "type">, roster: Roster): string | null {
  if (roster.members.size === 0) return null;
  const { actor } = draft;
  const member = memberForActor(roster, actor);
  if (!member && actor.kind !== "person" && roster.retiredAgents.has(actor.id)) {
    return `${actor.id} worked for someone who has left the project`;
  }
  if (!member) {
    // Once there is a roster, every person and agent must be on it (agents
    // through a member's `agents` list). Jev and the system actors (gate,
    // watcher) are governed by the ledger's own permission table.
    if (actor.kind === "person") return `${actor.id} is not a member of this project`;
    if (actor.kind === "agent") return `${actor.id} is not listed as anyone's agent on this project`;
    return null;
  }
  const who = actor.kind === "person" ? member.person : `${actor.id} (working for ${member.person})`;
  if (member.role === "viewer") return `${who} is a viewer and cannot write to the ledger`;
  if (member.role === "helper") {
    const approval = approvalFor(draft.type);
    if (approval && !member.approves.includes(approval)) {
      return `${who} is a helper without ${approval} approval, so cannot write ${draft.type}`;
    }
  }
  return null;
}
