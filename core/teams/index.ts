// Teams: who is on the project, what role each person holds, what they are
// holding now, and the incoming person's signed acceptance of a handover.
// The view is rebuilt from the ledger and the board; nothing is invented.
export {
  TEAM_ROLES,
  TEAM_OPS,
  HANDOVER_NOTE_MIN,
  HANDOVER_NOTE_MAX,
  TeamsError,
  isTeamRole,
  parseTeamsEvent,
  teamsEvent,
  claimsTeams,
  foldTeams,
  teamRoleOf,
  peopleRoleFor,
  recordedClaims,
  type TeamRole,
  type TeamOp,
  type MemberRoleChanged,
  type HandoverAccepted,
  type TeamsEvent,
  type TeamAcceptance,
  type TeamsState,
  type TeamsErrorCode,
} from "./model";
export { TEAM_ONLINE_MS, buildTeamsView, type TeamAvailability, type TeamBoardTask, type TeamMemberView, type TeamsView, type TeamsViewOptions } from "./view";
export { changeTeamRole, acceptHandover, type HandoverAcceptanceInput } from "./actions";
