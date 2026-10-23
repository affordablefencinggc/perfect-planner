// GET /summary: what the app header and Home show about the core project when no
// imported v1 project is selected (trial finding F7). Read-only, plain facts from
// the ledger and the agent service: no verification is implied.
import type { Router } from "../router";
import type { CoreProject } from "../project";
import { isAuthoritative } from "../../ledger/index";
import { buildPeopleView } from "../../people/index";
import { ownerMissing } from "./people";
import { planApprovalView } from "./plan";

export interface CoreSummary {
  project: string;
  /** True once anything is in this project's ledger. */
  started: boolean;
  people: { members: number; owner?: string; ownerMissing: boolean };
  /** Agents heard from in the last 10 minutes with a token that still works. Checked in, not verified. */
  agents: { checkedIn: number; names: string[] };
  plan: { approved: boolean; latest?: string; tasks: number; idea?: string };
}

export function coreSummary(project: CoreProject): CoreSummary {
  const entries = project.entries();
  const view = buildPeopleView(entries, { owner: project.ledger.owner });
  // The same answer as GET /plan: only a person-signed approval counts.
  const plan = planApprovalView(entries);
  const latest = plan.latest ? entries.find((e) => e.n === plan.latest!.entry) : undefined;
  const idea = typeof latest?.data?.idea === "string" ? latest.data.idea : undefined;
  const agents = project.service.liveAgents();
  return {
    project: project.key,
    started: entries.length > 0,
    people: {
      members: view.members.length,
      ...(view.owner ? { owner: view.owner.name } : {}),
      ownerMissing: ownerMissing(project),
    },
    agents: { checkedIn: agents.length, names: agents.map((a) => a.name).slice(0, 8) },
    plan: {
      approved: plan.approved,
      ...(plan.latest ? { latest: plan.latest.plan } : {}),
      tasks: entries.filter((e) => e.type === "task.created" && isAuthoritative(e)).length,
      ...(idea ? { idea } : {}),
    },
  };
}

export function registerSummaryRoutes(router: Router): void {
  router.get("/summary", ({ project }) => coreSummary(project));
}
