// Teams: the records this module owns on top of the People roster.
//
// The ledger's ENTRY_TYPES is a closed list, so team records ride on
// `decision.made` (numbered D-n, exactly like people events) under
// `data.teams`. The op names below are the record types. Only an entry the
// ledger verified as written by a person counts: a hand-edited line, an
// agent's entry or a payload field can never name a role or an acceptance.
import { isAuthoritative, type LedgerEntry } from "../ledger/index";
import { baseNumber } from "../numbering/index";
import { isSlug, type Role } from "../people/index";

/** The team roles the Teams screen offers, in display order. */
export const TEAM_ROLES = ["owner", "maintainer", "builder", "reviewer", "release-manager", "observer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export function isTeamRole(value: unknown): value is TeamRole {
  return (TEAM_ROLES as readonly unknown[]).includes(value);
}

/** The shortest note a person may accept a handover with. */
export const HANDOVER_NOTE_MIN = 8;
/** A note longer than this is refused rather than silently cut: it is signed as written. */
export const HANDOVER_NOTE_MAX = 2000;

export const TEAM_OPS = ["member.role.changed", "task.handover.accepted"] as const;
export type TeamOp = (typeof TEAM_OPS)[number];

/** A member's team role, as the latest signed record says. */
export interface MemberRoleChanged {
  op: "member.role.changed";
  person: string;
  role: TeamRole;
}

/**
 * The incoming person's acceptance of a cold-start handover. `receiptDigest`
 * and `receiptGeneratedAt` pin the exact receipt they read (core/host/routes/
 * tasks.ts handoverReceipt): a later receipt has a different digest.
 */
export interface HandoverAccepted {
  op: "task.handover.accepted";
  task: string;
  incoming: string;
  note: string;
  receiptDigest: string;
  receiptGeneratedAt: string;
}

export type TeamsEvent = MemberRoleChanged | HandoverAccepted;

/** An acceptance with the ledger facts that make it attributable. */
export type TeamAcceptance = HandoverAccepted & { entry: string; at: string; by: string };

export type TeamsErrorCode =
  | "BAD_ACTOR"
  | "BAD_PERSON"
  | "BAD_ROLE"
  | "BAD_TASK"
  | "BAD_NOTE"
  | "BAD_RECEIPT"
  | "UNKNOWN_MEMBER"
  | "NOT_A_MEMBER"
  | "OWNER_LOCKED";

export class TeamsError extends Error {
  readonly code: TeamsErrorCode;
  constructor(code: TeamsErrorCode, message: string) {
    super(message);
    this.name = "TeamsError";
    this.code = code;
  }
}

const isText = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= max;
const isTask = (value: unknown): value is string => typeof value === "string" && /^T-\d+$/.test(value);
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Validates the shape of a `data.teams` payload. Permission checks live in the ledger rules and actions.ts. */
export function parseTeamsEvent(raw: unknown): TeamsEvent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const event = raw as Record<string, unknown>;
  if (!(TEAM_OPS as readonly unknown[]).includes(event.op)) return undefined;
  switch (event.op) {
    case "member.role.changed":
      return isSlug(event.person) && isTeamRole(event.role) ? (raw as MemberRoleChanged) : undefined;
    case "task.handover.accepted":
      if (!isTask(event.task) || !isSlug(event.incoming)) return undefined;
      if (!isText(event.note, HANDOVER_NOTE_MAX) || event.note.trim().length < HANDOVER_NOTE_MIN) return undefined;
      if (!isDigest(event.receiptDigest) || !isText(event.receiptGeneratedAt, 40)) return undefined;
      if (!Number.isFinite(Date.parse(event.receiptGeneratedAt))) return undefined;
      return raw as HandoverAccepted;
  }
  return undefined;
}

/** The team record an entry carries, or undefined when it is not a valid team entry. */
export function teamsEvent(entry: Pick<LedgerEntry, "type" | "data">): TeamsEvent | undefined {
  if (entry.type !== "decision.made") return undefined;
  return parseTeamsEvent(entry.data?.teams);
}

/** True when the entry claims to be a team entry, valid or not. */
export function claimsTeams(entry: Pick<LedgerEntry, "type" | "data">): boolean {
  return entry.type === "decision.made" && entry.data !== undefined && "teams" in entry.data;
}

export interface TeamsState {
  /** Person -> their latest signed team role. People with no record use the roster's default. */
  roles: Map<string, TeamRole>;
  /** Every signed acceptance, in ledger order. */
  acceptances: TeamAcceptance[];
}

/**
 * Replays the team records from the ledger. Entries the ledger did not verify
 * as a person's, and payloads that do not parse, are ignored: the team view's
 * authority comes from the ledger's history, never from a payload alone.
 */
export function foldTeams(entries: readonly LedgerEntry[]): TeamsState {
  const roles = new Map<string, TeamRole>();
  const acceptances: TeamAcceptance[] = [];
  for (const entry of entries) {
    const event = teamsEvent(entry);
    if (!event || !isAuthoritative(entry, { personOnly: true })) continue;
    if (event.op === "member.role.changed") roles.set(event.person, event.role);
    else acceptances.push({ ...event, entry: entry.n, at: entry.at, by: entry.actor.id });
  }
  return { roles, acceptances };
}

/** The team role a member has: their signed record, else the default the People role implies. */
export function teamRoleOf(role: Role, recorded?: TeamRole): TeamRole {
  if (recorded) return recorded;
  if (role === "owner") return "owner";
  return role === "viewer" ? "observer" : "builder";
}

/**
 * The People role a team role writes. `observer` becomes a viewer (read-only);
 * every other working role is a helper. The owner stays the owner.
 */
export function peopleRoleFor(role: TeamRole): Role {
  if (role === "owner") return "owner";
  return role === "observer" ? "viewer" : "helper";
}

/**
 * File claims recorded on the ledger for one task, in order: the latest
 * `worktree.created` lists them, and a signed release removes them again.
 * Claims added only to a live worktree registry (core/worktrees) are not on
 * the ledger, so they are not shown here: the view never invents a claim.
 */
export function recordedClaims(entries: readonly LedgerEntry[], task: string): string[] {
  const base = baseNumber(task);
  let claims: string[] = [];
  for (const entry of entries) {
    if (baseNumber(entry.subject) !== base || !isAuthoritative(entry)) continue;
    if (entry.type === "worktree.created") {
      const listed = entry.data?.claims;
      if (Array.isArray(listed)) claims = listed.filter((file): file is string => isText(file, 500));
    } else if (entry.type === "task.progress") {
      const released = entry.data?.claimsReleased;
      if (Array.isArray(released)) {
        const gone = new Set(released.filter((file): file is string => typeof file === "string"));
        claims = claims.filter((file) => !gone.has(file));
      }
    }
  }
  return [...new Set(claims)].sort();
}
