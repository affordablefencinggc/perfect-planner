// Mounts the core host (core/host, TypeScript) on the Vite dev server under /api/core.
// The production server loads the same host from the bundle scripts/build-core-host.mjs writes.
import path from "node:path";
import { localAuthorityRoot } from "./localAuthorityHost.mjs";
import { isSameOriginLoopbackRequest } from "./loopbackRequestHttp.mjs";

export const coreHostRoot = (authorityRoot = localAuthorityRoot()) => path.join(authorityRoot, "core");

export const coreHostOptions = (env = process.env, authorityRoot = localAuthorityRoot(env)) => ({
  root: coreHostRoot(authorityRoot),
  ...(env.PP_CORE_PROJECT_ROOT ? { projectRootOverride: path.resolve(env.PP_CORE_PROJECT_ROOT) } : {}),
  guard: isSameOriginLoopbackRequest,
});

export const coreHostVitePlugin = () => ({
  name: "perfect-planner-core-host",
  configureServer(server) {
    let host;
    const load = async () => {
      if (!host) {
        const { createCoreHost } = await server.ssrLoadModule("/core/host/index.ts");
        host = createCoreHost(coreHostOptions());
      }
      return host;
    };
    server.middlewares.use((req, res, next) => {
      if (!String(req.url).startsWith("/api/core")) return next();
      load().then((loaded) => loaded.middleware(req, res, next), next);
    });
    server.httpServer?.once("close", () => { host?.close(); });
  },
});
