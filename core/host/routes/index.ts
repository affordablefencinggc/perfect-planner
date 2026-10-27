// Every screen registers its routes here. One module per screen, owned by that screen.
import type { Router } from "../router";
import { registerAgentRoutes } from "./agents";
import { registerCodexLoginRoutes } from "./codexLogin";
import { registerCostRoutes } from "./cost";
import { registerDecisionRoutes } from "./decisions";
import { registerKeyRoutes } from "./keys";
import { registerMvpRoutes } from "./mvp";
import { registerPeopleRoutes } from "./people";
import { registerPlanRoutes } from "./plan";
import { registerPlanningRoutes } from "./planning";
import { registerSearchRoutes } from "./search";
import { registerShareRoutes } from "./share";
import { registerRepoRoutes } from "./repos";
import { registerTaskRoutes } from "./tasks";
import { registerSummaryRoutes } from "./summary";
import { registerTerminalRoutes } from "./terminal";

export function registerRoutes(router: Router): void {
  registerPlanningRoutes(router);
  registerMvpRoutes(router);
  registerDecisionRoutes(router);
  registerPeopleRoutes(router);
  registerSearchRoutes(router);
  registerAgentRoutes(router);
  registerCodexLoginRoutes(router);
  registerTaskRoutes(router);
  registerRepoRoutes(router);
  registerCostRoutes(router);
  registerPlanRoutes(router);
  registerKeyRoutes(router);
  registerSummaryRoutes(router);
  registerTerminalRoutes(router);
  registerShareRoutes(router);
}
