// GET /summary: what the app header and Home show about the core project when no
// imported v1 project is selected (trial finding F7). Read-only, plain facts from
// the ledger and the agent service: no verification is implied.
import type { Router } from "../router";
import type { CoreProject } from "../project";
import { buildPeopleView } from "../../people/index";

export interface CoreSummary {
  project: string;
  /** True once anything is in this project's ledger. */
  started: boolean;
  people: { members: number; owner?: string; ownerMissing: boolean };
  /** Agents that checked in over MCP since the app started. Checked in, not verified. */
  agents: { checkedIn: number; names: string[] };
  plan: { approved: boolean; latest?: string; tasks: number; idea?: string };
}

export function coreSummary(project: CoreProject): CoreSummary {
  const entries = project.entries();
  const view = buildPeopleView(entries, { owner: project.ledger.owner });
  const approved = entries.filter((e) => e.type === "plan.approved");
  const latest = approved[approved.length - 1];
  const idea = typeof latest?.data?.idea === "string" ? latest.data.idea : undefined;
  const agents = project.service.listAgents();
  return {
    project: project.key,
    started: entries.length > 0,
    people: {
      members: view.members.length,
      ...(view.owner ? { owner: view.owner.name } : {}),
      ownerMissing: !project.ledger.ownerKeyPinned,
    },
    agents: { checkedIn: agents.length, names: agents.map((a) => a.name).slice(0, 8) },
    plan: {
      approved: approved.length > 0,
      ...(latest ? { latest: latest.subject } : {}),
      tasks: entries.filter((e) => e.type === "task.created").length,
      ...(idea ? { idea } : {}),
    },
  };
}

export function registerSummaryRoutes(router: Router): void {
  router.get("/summary", ({ project }) => coreSummary(project));
}
