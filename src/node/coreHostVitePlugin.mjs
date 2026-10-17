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
        // npm run tauri:dev gives this host and the desktop shell the same one-time secret.
        host.acceptDesktopLaunch();
      }
      return host;
    };
    server.middlewares.use((req, res, next) => {
      if (!String(req.url).startsWith("/api/core")) return next();
      load().then((loaded) => loaded.middleware(req, res, next), next);
    });
    server.httpServer?.once("close", () => { host?.close(); });
    // The dev window proves it is the person's with a one-time launch secret (core/host/session.ts).
    const printLaunch = async () => {
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") return;
      const loaded = await load();
      server.config.logger.info(`  Perfect Planner (one-time link, can make changes): http://${address.address === "::1" ? "[::1]" : address.address}:${address.port}/#pp-launch=${loaded.issueLaunch()}`);
    };
    server.httpServer?.once("listening", () => { printLaunch().catch(() => undefined); });
    // A closed window can only be replaced from the terminal: "l + enter" prints a new one-time link.
    // Only the person at this terminal can do that; no HTTP route hands out links.
    const bind = server.bindCLIShortcuts.bind(server);
    server.bindCLIShortcuts = (options = {}) => bind({
      ...options,
      customShortcuts: [...(options.customShortcuts ?? []), { key: "l", description: "print a new one-time Perfect Planner link (can make changes)", action: () => printLaunch() }],
    });

  },
});
