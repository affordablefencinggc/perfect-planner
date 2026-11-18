// The Teams view: a fold over the signed ledger (roster, team records, file
// claims) plus the board's own stage and health for each task. Nothing here
// writes, and nothing is invented: a member comes from the roster, an
// assignment from a signed task.assigned, a claim from a signed worktree
// record, and an active task from the board.
import type { LedgerEntry } from "../ledger/index";
import { parseNumber } from "../numbering/index";
import { buildPeopleView, replayRoster } from "../people/index";
import { TEAM_ROLES, foldTeams, recordedClaims, teamRoleOf, type TeamRole } from "./model";

/** A member who has done something in the last half hour is shown as online; older is offline. */
export const TEAM_ONLINE_MS = 30 * 60 * 1000;

export type TeamAvailability = "online" | "busy" | "offline";

/** The board facts the Teams view uses. core/host/routes/board.ts supplies them (stage, health). */
export interface TeamBoardTask {
  id: string;
  title: string;
  stage: string;
  health: string;
  status: string;
}

export interface TeamMemberView {
  id: string;
  name: string;
  role: TeamRole;
  availability: TeamAvailability;
  /** Tasks (T-n) a signed task.assigned gave this member. */
  assignments: string[];
  /** File claims recorded on the ledger for those tasks, less any signed release. */
  claims: string[];
  /** The task they hold now, from the board; null when they hold none. */
  activeTask: { id: string; title: string; stage: string; health: string } | null;
  /** The ledger time of their latest work entry (or their own last people entry), or null. */
  lastActivity: string | null;
}

export interface TeamsView {
  generatedAt: string;
  roles: TeamRole[];
  members: TeamMemberView[];
}

export interface TeamsViewOptions {
  /** `ledger.owner`, so the roster replay knows whose project this is. */
  owner?: string;
  /** The board's tasks for this project (core/host/routes/board.ts boardView). */
  board?: readonly TeamBoardTask[];
  now?: number;
  onlineMs?: number;
}

function byTaskNumber(left: string, right: string): number {
  return (parseNumber(left)?.n ?? 0) - (parseNumber(right)?.n ?? 0) || left.localeCompare(right);
}

/** A held task first, then a blocked one, then anything else still open. */
function holdRank(task: TeamBoardTask): number {
  return task.status === "claimed" ? 0 : task.status === "blocked" ? 1 : 2;
}

/** Rebuilds the team from the ledger and the board. Read-only. */
export function buildTeamsView(entries: readonly LedgerEntry[], options: TeamsViewOptions = {}): TeamsView {
  const now = options.now ?? Date.now();
  const onlineMs = options.onlineMs ?? TEAM_ONLINE_MS;
  const roster = replayRoster(entries, options.owner);
  const people = buildPeopleView(entries, options.owner === undefined ? {} : { owner: options.owner });
  const teams = foldTeams(entries);
  const board = new Map((options.board ?? []).map((task) => [task.id, task]));
  const assignedTo = new Map<string, string[]>();
  for (const [task, person] of roster.assignments) {
    const list = assignedTo.get(person) ?? [];
    list.push(task);
    assignedTo.set(person, list);
  }

  const members: TeamMemberView[] = people.members.map((member) => {
    const assignments = [...(assignedTo.get(member.person) ?? [])].sort(byTaskNumber);
    const held = assignments
      .map((id) => board.get(id))
      .filter((task): task is TeamBoardTask => task !== undefined && task.status !== "done")
      .sort((left, right) => holdRank(left) - holdRank(right) || byTaskNumber(left.id, right.id));
    // Work observed on a task nobody was assigned is theirs to show; a task
    // assigned to someone else is a collision, not this member's active task.
    const observed = member.presence?.task ? board.get(member.presence.task) : undefined;
    const active =
      held[0] ?? (observed && observed.status !== "done" && !roster.assignments.has(observed.id) ? observed : undefined);
    const claims = assignments
      .filter((id) => board.get(id)?.status !== "done")
      .flatMap((id) => recordedClaims(entries, id));
    const lastActivity = member.presence?.at ?? null;
    const fresh = lastActivity !== null && Number.isFinite(Date.parse(lastActivity)) && now - Date.parse(lastActivity) < onlineMs;
    const availability: TeamAvailability = active ? "busy" : fresh ? "online" : "offline";
    return {
      id: member.person,
      name: member.name,
      role: teamRoleOf(member.role, teams.roles.get(member.person)),
      availability,
      assignments,
      claims: [...new Set(claims)].sort(),
      activeTask: active ? { id: active.id, title: active.title, stage: active.stage, health: active.health } : null,
      lastActivity,
    };
  });

  return { generatedAt: new Date(now).toISOString(), roles: [...TEAM_ROLES], members };
}
