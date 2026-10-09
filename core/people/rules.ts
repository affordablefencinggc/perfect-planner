import type { EntryDraft, Ledger, LedgerEntry } from "../ledger/index";
import { claimsPeople, memberForActor, ownerOf, parsePeopleEvent, replayRoster, type Roster } from "./model";
import { isPhotoFile } from "./photos";
import { APPROVAL_TYPES, PHOTO_DIR, type Approval } from "./types";

/**
 * Ledger rules for spec §9: who may change membership, photos and shared
 * documents, and what each role may write. Returns a function that removes
 * the rules.
 *
 * Solo first: until the first member is added nobody is restricted, so a
 * project that never adds helpers behaves exactly as before.
 */
export function installPeopleRules(ledger: Ledger): () => void {
  return ledger.addRule((draft, current) => peopleRefusal(draft, current.entries()));
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
    // Unlisted agents, Jev and the watcher report into the one project ledger (§9.5);
    // an unlisted person is not on the project.
    return actor.kind === "person" ? `${actor.id} is not a member of this project` : null;
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

function peopleOpRefusal(draft: EntryDraft, roster: Roster): string | null {
  const event = parsePeopleEvent(draft.data?.people);
  if (!event) return "data.people is not a valid people event";
  const { actor } = draft;
  if (actor.kind !== "person") return "only a person can change who is on the project";
  const owner = ownerOf(roster);
  const isOwner = owner?.person === actor.id;
  const bootstrap = roster.members.size === 0;

  switch (event.op) {
    case "member.added":
      if (bootstrap) {
        if (event.role !== "owner") return "the first member of a project is its owner";
        if (event.person !== actor.id) return "the owner adds themselves first";
        return null;
      }
      if (!isOwner) return "only the owner adds people";
      if (roster.members.has(event.person)) return `${event.person} is already on the project`;
      if (event.role === "owner") return "a project has one owner";
      if (event.role === "viewer" && event.approves?.length) return "a viewer cannot approve anything";
      return null;
    case "member.changed": {
      if (!isOwner) return "only the owner changes people";
      const target = roster.members.get(event.person);
      if (!target) return `${event.person} is not on the project`;
      if (target.role === "owner" && event.role !== undefined && event.role !== "owner") return "the owner's role cannot be changed";
      if (target.role !== "owner" && event.role === "owner") return "a project has one owner";
      const role = event.role ?? target.role;
      if (role !== "helper" && event.approves?.length) return `a ${role} has no approvals to set`;
      return null;
    }
    case "member.removed": {
      if (!isOwner) return "only the owner removes people";
      const target = roster.members.get(event.person);
      if (!target) return `${event.person} is not on the project`;
      if (target.role === "owner") return "the owner cannot be removed";
      return null;
    }
    case "photo.set":
    case "photo.cleared": {
      if (bootstrap) return "add the owner before setting photos";
      if (!roster.members.has(event.person)) return `${event.person} is not on the project`;
      if (event.person !== actor.id && !isOwner) return "people set their own photo";
      if (event.op === "photo.set") {
        if (!isPhotoFile(event.file) || !event.file.startsWith(`${PHOTO_DIR}/${event.person}-`)) {
          return `a photo lives at ${PHOTO_DIR}/${event.person}-<hash>.<ext>`;
        }
        if (!event.file.includes(`-${event.sha256.slice(0, 12)}.`)) return "the photo file name does not match its fingerprint";
      }
      return null;
    }
    case "doc.shared":
    case "doc.removed":
      if (!bootstrap && !isOwner) return "only the owner shares documents";
      if (event.op === "doc.removed" && !roster.docs.has(event.doc)) return `${event.doc} is not shared`;
      return null;
  }
}
