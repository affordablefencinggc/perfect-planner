// The desktop app's local service. The Tauri shell (src-tauri/src/native_core_host.rs)
// starts this file with the Node runtime it ships, from its resources folder:
//   <resources>/desktop-host/node[.exe] <resources>/desktop-host/core-host/desktop.mjs
// It serves the built client and the core host (/api/core, Connect agent's bridge) on
// loopback, exactly like npm start, then writes ONE line to stdout for the shell:
//   {"event":"ready","origin":"http://127.0.0.1:41730","open":"http://127.0.0.1:41730/#pp-launch=..."}
// stdout is a private pipe to the shell, so the one-time launch link (when the core host
// issues one) reaches the app window without a terminal, a log or the clipboard. Logs go
// to stderr. When the shell closes stdin (the app quit, or crashed) this process stops.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalServer } from "../../scripts/serve-local.mjs";
import { localAuthorityRoot } from "./localAuthorityHost.mjs";

// A fixed first port keeps the window's origin, and so its saved browser state, the same
// from one launch to the next. Busy ports fall through to the next ones.
export const DESKTOP_PORT = 41730;

/** Where the bundled files are and where the data goes, from the shell's environment. */
export function desktopHostConfig(env = process.env, here = path.dirname(fileURLToPath(import.meta.url))) {
  const port = env.PP_PORT === undefined || env.PP_PORT === "" ? DESKTOP_PORT : Number(env.PP_PORT);
  return {
    clientDirectory: env.PP_CLIENT_DIR ? path.resolve(env.PP_CLIENT_DIR) : path.join(here, "..", "client"),
    coreHostBundle: path.join(here, "index.mjs"),
    // Windows keeps npm start's folder (%LOCALAPPDATA%), so both ways of running share one ledger.
    // macOS and Linux get the app's own data folder from the shell instead of a temp folder.
    root: env.PP_DATA_DIR ? path.join(path.resolve(env.PP_DATA_DIR), "PerfectPlannerCleanroom", "authority") : localAuthorityRoot(env),
    port,
  };
}

export function readyLine(started) {
  const open = typeof started.launchUrl === "function" ? started.launchUrl() : started.url;
  return `${JSON.stringify({ event: "ready", origin: new URL(started.url).origin, open })}\n`;
}

const stderrLogger = { log: (...a) => console.error(...a), info: (...a) => console.error(...a), warn: (...a) => console.error(...a), error: (...a) => console.error(...a) };

/**
 * Starts the service and reports it. Connect agent's lines and the worktrees' commit hook
 * run this same Node (PP_NODE_BINARY), so the person needs no Node install of their own.
 */
export async function startDesktopHost({ env = process.env, here, input = process.stdin, output = process.stdout, logger = stderrLogger, onStop = () => process.exit(0) } = {}) {
  if (!env.PP_NODE_BINARY) env.PP_NODE_BINARY = process.execPath;
  const started = await startLocalServer({ ...desktopHostConfig(env, here), logger });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    started.close().finally(onStop);
  };
  input.on("end", stop);
  input.on("close", stop);
  input.on("error", stop);
  input.resume();
  output.write(readyLine(started));
  logger.log(`[perfect-planner] Desktop service on ${started.url} (data in ${started.root})`);
  return { ...started, stop };
}

if (process.argv[1] && path.basename(fileURLToPath(import.meta.url)) === "desktop.mjs" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(0));
  startDesktopHost().catch((error) => {
    process.stdout.write(`${JSON.stringify({ event: "failed", message: String(error?.message ?? error) })}\n`);
    process.exit(1);
  });
}
