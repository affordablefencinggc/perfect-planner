import type { EntryDraft, Ledger, LedgerEntry } from "../ledger/index";
import { claimsPeople, memberForActor, peopleOpRefusal, replayRoster, type Roster } from "./model";
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

/** Idempotent: a ledger gets the people rules once. The write helpers in actions.ts call it. */
export function installPeopleRules(ledger: Ledger): () => void {
  const existing = installed.get(ledger);
  if (existing) return existing;
  const remove = ledger.addRule((draft, current) => peopleRefusal(draft, current.entries()));
  const uninstall = () => {
    remove();
    installed.delete(ledger);
  };
  installed.set(ledger, uninstall);
  return uninstall;
}

export function peopleRefusal(draft: EntryDraft, entries: readonly LedgerEntry[]): string | null {
  const roster = replayRoster(entries);
  if (claimsPeople(draft)) return peopleOpRefusal(draft, roster);
  return roleRefusal(draft, roster);
}

function approvalFor(type: EntryDraft["type"]): Approval | undefined {
  for (const [approval, types] of Object.entries(APPROVAL_TYPES) as [Approval, readonly string[]][]) {
    if (types.includes(type)) return approval;
  }
  return undefined;
}

function roleRefusal(draft: EntryDraft, roster: Roster): string | null {
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
