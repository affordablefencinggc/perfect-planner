import os from "node:os";
import path from "node:path";
import { createCollisionAuthorityMiddleware } from "./collisionAuthorityHttp.mjs";
import { createFolderContractMiddleware } from "./folderContractHttp.mjs";
import { createArchitectureContractMiddleware } from "./architectureContractStore.mjs";
import { createComponentPlanMiddleware } from "./componentPlanHttp.mjs";
import { createPlanningLedgerMiddleware } from "./planningLedgerHttp.mjs";
import { initializePlanningLedgerHostRoot } from "./planningLedgerHostRoot.mjs";
import { createTaskObservationHost } from "./taskObservationVitePlugin.mjs";

// One composition of the local saving APIs, shared by the Vite dev server and the
// production server (scripts/serve-local.mjs) so both save to the same place the same way.
export const localAuthorityRoot = (env = process.env) => path.join(env.LOCALAPPDATA ?? os.tmpdir(), "PerfectPlannerCleanroom", "authority");

const planningLedgerUnavailable = (req, res, next) => {
  if (!String(req.url).startsWith("/api/planning-ledger/")) return next();
  res.statusCode = 503; res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ error: "Planning ledger host root unavailable." }));
};

// Ordered middleware list for one host. A planning-ledger host-root failure disables only
// that API (explicit 503), never the whole host. getAddress/isHttps describe the listening
// server for the task-run observation origin check; observations defaults to PP_TASK_OBSERVATION_BINDINGS.
export async function createLocalAuthorityMiddlewares({ root = localAuthorityRoot(), logger = console, getAddress = () => null, isHttps = () => false, observations = createTaskObservationHost() } = {}) {
  const middlewares = [
    createCollisionAuthorityMiddleware({ root }),
    createArchitectureContractMiddleware({ root }),
    createFolderContractMiddleware({ root }),
    createComponentPlanMiddleware({ root }),
  ];
  try { middlewares.push(createPlanningLedgerMiddleware({ root: await initializePlanningLedgerHostRoot(root) })); }
  catch (error) { logger.warn?.(`[perfect-planner] Planning ledger API disabled: ${error.message} for ${root}`); middlewares.push(planningLedgerUnavailable); }
  const observationHost = observations.attach({ getAddress, isHttps });
  middlewares.push(observationHost.middleware);
  return { middlewares, close: observationHost.close, observations };
}

// Runs the list connect-style; `final` handles requests no middleware claimed. Errors become 500.
export function runMiddlewares(middlewares, req, res, final) {
  let index = 0;
  const fail = (error) => { if (res.headersSent) { res.destroy(error); return; } res.statusCode = 500; res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify({ error: "Local host error." })); };
  const next = (error) => {
    if (error) return fail(error);
    const middleware = middlewares[index++];
    if (!middleware) return final(req, res);
    try { const result = middleware(req, res, next); if (result && typeof result.catch === "function") result.catch(fail); }
    catch (thrown) { fail(thrown); }
  };
  next();
}

// Vite dev plugin built on the same composition.
export const localAuthorityVitePlugin = (options = {}) => ({
  name: "perfect-planner-local-authority",
  async configureServer(server) {
    const { middlewares, close } = await createLocalAuthorityMiddlewares({ ...options, logger: { warn: (message) => server.config.logger.warn(message) }, getAddress: () => server.httpServer?.address(), isHttps: () => Boolean(server.config.server.https) });
    for (const middleware of middlewares) server.middlewares.use(middleware);
    server.httpServer?.once("close", close);
  },
});
