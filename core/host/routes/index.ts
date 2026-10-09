// Every screen registers its routes here. One module per screen, owned by that screen.
import type { Router } from "../router";
import { registerAgentRoutes } from "./agents";
import { registerDecisionRoutes } from "./decisions";
import { registerKeyRoutes } from "./keys";
import { registerMvpRoutes } from "./mvp";
import { registerPeopleRoutes } from "./people";
import { registerPlanRoutes } from "./plan";
import { registerPlanningRoutes } from "./planning";
import { registerSearchRoutes } from "./search";
import { registerTaskRoutes } from "./tasks";

export function registerRoutes(router: Router): void {
  registerPlanningRoutes(router);
  registerMvpRoutes(router);
  registerDecisionRoutes(router);
  registerPeopleRoutes(router);
  registerSearchRoutes(router);
  registerAgentRoutes(router);
  registerTaskRoutes(router);
  registerPlanRoutes(router);
  registerKeyRoutes(router);
}
