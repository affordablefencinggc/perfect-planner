// Plan approval: the one answer every screen shows (Deep planning, Build,
// project home, the Plan page). The truth is the latest plan.approved entry a
// person wrote and signed (isAuthoritative, personOnly); unsigned, agent or
// system entries never count. Approving from the Plan page writes the same
// kind of entry Deep planning writes, through the person's own request.
import { isAuthoritative, type LedgerEntry } from "../../ledger/index";
import { appendNumbered } from "../../numbering/index";
import { openBlockers } from "../../planning/index";
import { HttpError, type Router } from "../router";
import { localPerson } from "./people";

const MAX_TASKS = 500;

export interface PlanApprovalView {
  approved: boolean;
  latest: { plan: string; entry: string; at: string; by: string; summary: string; source: string | null } | null;
  /** How many authoritative approvals there are (each one is a new plan version P-n). */
  count: number;
  /** Roadmap tasks (T-n) written when the plan was approved in Deep planning. */
  tasks: string[];
}

export function planApprovalView(entries: readonly LedgerEntry[]): PlanApprovalView {
  const approvals = entries.filter((e) => e.type === "plan.approved" && isAuthoritative(e, { personOnly: true }));
  const last = approvals[approvals.length - 1];
  const tasks = entries.filter((e) => e.type === "task.created" && e.data?.source === "planning" && isAuthoritative(e)).map((e) => e.subject);
  return {
    approved: Boolean(last),
    latest: last ? { plan: last.subject, entry: last.n, at: last.at, by: last.actor.id, summary: last.summary, source: typeof last.data?.source === "string" ? last.data.source : null } : null,
    count: approvals.length,
    tasks,
  };
}

function planTasks(raw: unknown): { id: string; title: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "INVALID", "tasks must be a list.");
  return raw
    .filter((t): t is { id: string; title: string } => Boolean(t) && typeof t.id === "string" && /^T[-\w]{1,40}$/.test(t.id) && typeof t.title === "string")
    .slice(0, MAX_TASKS)
    .map((t) => ({ id: t.id, title: t.title.replace(/\s+/g, " ").trim().slice(0, 200) }));
}

export function registerPlanRoutes(router: Router): void {
  /** GET /plan: is the plan approved, by whom, and which entry says so. */
  router.get("/plan", ({ project }) => planApprovalView(project.entries()));

  /**
   * POST /plan/approve { tasks?: [{ id, title }] }: the Plan page's approve.
   * Writes plan.approved P-n in the person's name; refused while a blocking
   * planning question is open (the ledger's planning rule refuses it too).
   */
  router.post("/plan/approve", ({ project, body }) => {
    const tasks = planTasks((body as { tasks?: unknown } | undefined)?.tasks);
    const open = openBlockers(project.entries());
    if (open.length) {
      throw new HttpError(409, "BLOCKERS_OPEN", open.length === 1
        ? `The plan cannot be approved yet: 1 blocking question is still open (${open[0]}). Answer it in Deep planning first.`
        : `The plan cannot be approved yet: ${open.length} blocking questions are still open (${open.join(", ")}). Answer them in Deep planning first.`);
    }
    const entry = appendNumbered(project.ledger, {
      actor: localPerson(project),
      type: "plan.approved",
      summary: tasks.length ? `Plan approved on the Plan page: ${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "Plan approved on the Plan page",
      refs: ["plan"],
      data: { source: "plan-page", tasks },
    });
    return { plan: entry.subject, entry: entry.n, approval: planApprovalView(project.entries()) };
  });
}
