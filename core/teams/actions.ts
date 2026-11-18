// Writing team records. Each change is a signed person `decision.made` entry
// (numbered D-n) with the record in `data.teams`; a role change also uses the
// existing people action changeMember whenever the People role has to move.
import type { Actor, Ledger, LedgerEntry } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import { changeMember, isSlug, ownerOf, replayRoster } from "../people/index";
import {
  HANDOVER_NOTE_MAX,
  HANDOVER_NOTE_MIN,
  TEAM_ROLES,
  TeamsError,
  isTeamRole,
  peopleRoleFor,
  type TeamRole,
} from "./model";

const ROLE_WORD: Record<TeamRole, string> = {
  owner: "owner",
  maintainer: "maintainer",
  builder: "builder",
  reviewer: "reviewer",
  "release-manager": "release manager",
  observer: "observer",
};

function assertActor(actor: Actor): void {
  if (actor.kind !== "person") throw new TeamsError("BAD_ACTOR", "Only a person can change the team.");
}

/**
 * Sets a member's team role. The People role moves with it where the two
 * differ (an observer becomes a viewer, every working role a helper), through
 * changeMember, so the existing roster rules decide whether the actor may do
 * it. A project keeps its one owner. The signed team record is written after
 * the People change: if that change is refused, nothing is written.
 */
export function changeTeamRole(ledger: Ledger, actor: Actor, person: string, role: TeamRole, reason?: string): LedgerEntry {
  assertActor(actor);
  if (!isSlug(person)) throw new TeamsError("BAD_PERSON", `"${String(person)}" is not a person id (lowercase letters, digits and dashes).`);
  if (!isTeamRole(role)) throw new TeamsError("BAD_ROLE", `The role must be one of ${TEAM_ROLES.join(", ")}.`);
  const roster = replayRoster(ledger.entries(), ledger.owner);
  const member = roster.members.get(person);
  if (!member) throw new TeamsError("UNKNOWN_MEMBER", `${person} is not on this project's roster.`);
  const owner = ownerOf(roster);
  if (owner && owner.person !== actor.id) throw new TeamsError("OWNER_LOCKED", "Only the project's owner changes team roles.");
  if (role === "owner" && member.role !== "owner") throw new TeamsError("OWNER_LOCKED", "A project has one owner; another member cannot be made owner here.");
  if (member.role === "owner" && role !== "owner") throw new TeamsError("OWNER_LOCKED", "The owner's role cannot be changed.");

  const summary = `${member.name} is now ${ROLE_WORD[role]}`;
  const why = reason?.trim() || summary;
  const peopleRole = peopleRoleFor(role);
  if (member.role !== peopleRole) changeMember(ledger, actor, person, { role: peopleRole }, why);
  return appendNumbered(ledger, {
    actor,
    type: "decision.made",
    summary,
    reason: why,
    evidence: [],
    refs: [],
    data: { teams: { op: "member.role.changed", person, role } },
  });
}

export interface HandoverAcceptanceInput {
  task: string;
  incoming: string;
  note: string;
  /** The digest of the receipt the incoming person read (handoverReceipt). */
  receiptDigest: string;
  receiptGeneratedAt: string;
}

/**
 * Records that the incoming person accepted a task's cold-start handover.
 * The entry is signed by the person at this computer (`actor`); `incoming`
 * names who takes over, and must be on the roster. It neither dispatches a
 * worker nor releases a claim: those stay separate, explicit actions.
 */
export function acceptHandover(ledger: Ledger, actor: Actor, acceptance: HandoverAcceptanceInput): LedgerEntry {
  assertActor(actor);
  const task = String(acceptance.task).trim().replace(/\.a\d+$/, "");
  if (!/^T-\d+$/.test(task)) throw new TeamsError("BAD_TASK", `"${acceptance.task}" is not a task number like T-14.`);
  if (!isSlug(acceptance.incoming)) throw new TeamsError("BAD_PERSON", `"${String(acceptance.incoming)}" is not a person id (lowercase letters, digits and dashes).`);
  const note = String(acceptance.note ?? "").replace(/\s+/g, " ").trim();
  if (note.length < HANDOVER_NOTE_MIN) {
    throw new TeamsError("BAD_NOTE", `Say what you are taking over and what you will do next (at least ${HANDOVER_NOTE_MIN} characters); a handover without a note is just a dropped task.`);
  }
  if (note.length > HANDOVER_NOTE_MAX) throw new TeamsError("BAD_NOTE", `The note is too long (${HANDOVER_NOTE_MAX} characters at most).`);
  if (!/^[0-9a-f]{64}$/.test(acceptance.receiptDigest)) throw new TeamsError("BAD_RECEIPT", "The handover receipt digest is missing or malformed.");
  if (!Number.isFinite(Date.parse(acceptance.receiptGeneratedAt))) throw new TeamsError("BAD_RECEIPT", "The handover receipt has no readable generation time.");
  const roster = replayRoster(ledger.entries(), ledger.owner);
  if (roster.members.size > 0 && !roster.members.has(acceptance.incoming)) {
    throw new TeamsError("NOT_A_MEMBER", `${acceptance.incoming} is not on this project's roster.`);
  }
  return appendNumbered(ledger, {
    actor,
    type: "decision.made",
    summary: acceptance.incoming === actor.id
      ? `${acceptance.incoming} accepted the handover of ${task}`
      : `${acceptance.incoming} accepted the handover of ${task}, recorded by ${actor.id}`,
    reason: note,
    evidence: [`receipt:${acceptance.receiptDigest}`],
    refs: [],
    data: {
      teams: {
        op: "task.handover.accepted",
        task,
        incoming: acceptance.incoming,
        note,
        receiptDigest: acceptance.receiptDigest,
        receiptGeneratedAt: acceptance.receiptGeneratedAt,
      },
    },
  });
}
