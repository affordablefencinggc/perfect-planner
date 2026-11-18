// Teams screen: the roster as a team (roles, availability, what each person
// holds), a role change, and the incoming person's acceptance of a cold-start
// handover. Everything is read from and written to the ledger through
// core/teams; the board supplies each task's stage and health. No route here
// dispatches a worker or releases a claim.
import { isSlug, replayRoster } from "../../people/index";
import { TeamsError, acceptHandover, buildTeamsView, changeTeamRole, isTeamRole, type TeamBoardTask, type TeamsView } from "../../teams/index";
import { boardView } from "./board";
import { localPerson, localPersonId } from "./people";
import { handoverReceipt } from "./tasks";
import type { CoreProject } from "../project";
import { HttpError, type Router } from "../router";

/** The team view for one project: the roster, the team records and the board's own stage/health. */
export function teamsViewOf(project: CoreProject): TeamsView {
  // The signed task fold is the authority for which tasks exist; the board
  // view supplies the same tasks' derived stage and health.
  const board = project.service.board();
  const view = boardView({
    activeKey: project.key,
    activeLabel: project.key,
    activeRoot: project.root,
    activeEntries: project.entries(),
    agents: project.service.liveAgents().map((agent) => ({ id: agent.id })),
    tokenBudget: null,
  });
  const tasks: TeamBoardTask[] = view.tasks
    .filter((task) => board.has(task.id))
    .map((task) => ({ id: task.id, title: task.title, stage: task.stage, health: task.health, status: task.status }));
  return buildTeamsView(project.entries(), { owner: project.ledger.owner, board: tasks });
}

function body(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Turns a core/teams refusal into the screen's status: 404 for an unknown member, 409 for the owner, 400 otherwise. */
function refused(error: unknown): never {
  if (error instanceof TeamsError) {
    const status = error.code === "UNKNOWN_MEMBER" || error.code === "NOT_A_MEMBER" ? 404 : error.code === "OWNER_LOCKED" ? 409 : 400;
    throw new HttpError(status, error.code, error.message);
  }
  throw error;
}

/** Runs a ledger write and turns its refusal into the route's answer. */
function attempt<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    return refused(error);
  }
}

export function registerTeamsRoutes(router: Router): void {
  /** GET /teams: who is on the project, what they hold and what is free. */
  router.get("/teams", ({ project }) => teamsViewOf(project));

  /** POST /teams/:id/role { role }: the owner sets a member's team role. */
  router.post("/teams/:id/role", ({ project, params, body: raw }) => {
    const b = body(raw);
    const role = b.role;
    if (!isTeamRole(role)) throw new HttpError(400, "BAD_ROLE", "The role must be owner, maintainer, builder, reviewer, release-manager or observer.");
    const person = params.id!;
    const entry = attempt(() => changeTeamRole(project.ledger, localPerson(project), person, role));
    const member = teamsViewOf(project).members.find((item) => item.id === person);
    if (!member) throw new HttpError(404, "NOT_FOUND", `${person} is not on this project's roster.`);
    // The updated member, both on its own (the route's answer) and under `member` beside the entry.
    return { entry: entry.n, member, ...member };
  });

  /**
   * POST /tasks/:id/handover/accept { note, person? }: the incoming person
   * accepts the cold-start brief. The receipt is read now, so the entry pins
   * the exact brief that was accepted; a second acceptance gets a new receipt.
   * Nothing is dispatched and nothing is released.
   */
  router.post("/tasks/:id/handover/accept", async ({ project, params, body: raw }) => {
    const b = body(raw);
    const id = params.id!;
    if (!/^T-\d+(?:\.a\d+)?$/.test(id)) throw new HttpError(400, "INVALID", `"${id}" is not a task number like T-14.`);
    const task = id.replace(/\.a\d+$/, "");
    if (!project.service.board().has(task)) throw new HttpError(404, "NOT_FOUND", `${task} is not on the board. Approve the plan or add the task first.`);
    if (typeof b.note !== "string" || !b.note.trim()) {
      throw new HttpError(400, "EMPTY_NOTE", "Say what you are taking over; an acceptance without a note is just a dropped task.");
    }
    const note = b.note;
    let incoming = localPersonId(project);
    if (b.person !== undefined && b.person !== null && b.person !== "") {
      if (!isSlug(b.person)) throw new HttpError(400, "BAD_PERSON", "A person id uses lowercase letters, digits and dashes.");
      const roster = replayRoster(project.entries(), project.ledger.owner);
      if (!roster.members.has(b.person)) throw new HttpError(404, "NOT_A_MEMBER", `${b.person} is not on this project's roster.`);
      incoming = b.person;
    }
    const receipt = await handoverReceipt(project, task);
    const entry = attempt(() =>
      acceptHandover(project.ledger, localPerson(project), {
        task,
        incoming,
        note,
        receiptDigest: receipt.digest,
        receiptGeneratedAt: receipt.generatedAt,
      }),
    );
    return {
      accepted: true,
      task,
      incoming,
      at: entry.at,
      receiptDigest: receipt.digest,
      nextAction: receipt.nextAction,
    };
  });
}
