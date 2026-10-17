#!/usr/bin/env node
// Zero-dependency production host: serves the built client (dist/client) with SPA fallback
// plus the same local saving APIs as the Vite dev server, bound to loopback only.
//   npm run serve  -> serve the existing build
//   npm run start  -> build the client first when dist/client is missing or older than its sources
// PORT picks the first port to try (default 4173; busy ports fall through to the next one).
// PP_OPEN=1 opens the default browser once listening.
// npm start -- C:\path\to\app offers that folder for a one-click read-only scan (default: the folder
// npm was run from; PP_FOLDER also works).
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLocalAuthorityMiddlewares, localAuthorityRoot, runMiddlewares } from "../src/node/localAuthorityHost.mjs";
import { coreHostOptions } from "../src/node/coreHostVitePlugin.mjs";
import { createLaunchFolderMiddleware, resolveLaunchFolder } from "../src/node/launchFolderHost.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CLIENT_DIRECTORY = path.join(projectRoot, "dist", "client");
export const DEFAULT_CORE_HOST_BUNDLE = path.join(projectRoot, "dist", "core-host", "index.mjs");
export const LOOPBACK_HOST = "127.0.0.1";
const PORT_ATTEMPTS = 20;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json" };

const fileAt = async (file) => { try { const info = await stat(file); return info.isFile() ? info : null; } catch { return null; } };

function sendFile(req, res, file, info, { immutable = false } = {}) {
  res.statusCode = 200;
  res.setHeader("content-type", TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("content-length", info.size);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  if (req.method === "HEAD") return res.end();
  createReadStream(file).on("error", (error) => res.destroy(error)).pipe(res);
}

const plain = (res, status, text, type = "text/plain; charset=utf-8") => { res.statusCode = status; res.setHeader("content-type", type); res.setHeader("cache-control", "no-store"); res.end(text); };

// Static files and SPA fallback; only GET/HEAD, only inside the client directory.
export function createStaticHandler(clientDirectory) {
  const base = path.resolve(clientDirectory);
  const index = path.join(base, "index.html");
  return async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { return plain(res, 400, "Bad request"); }
    if (pathname.startsWith("/api/")) return plain(res, 404, JSON.stringify({ error: "Not found." }), "application/json; charset=utf-8");
    if (req.method !== "GET" && req.method !== "HEAD") { res.setHeader("allow", "GET, HEAD"); return plain(res, 405, "Method not allowed"); }
    if (pathname.includes("\0")) return plain(res, 400, "Bad request");
    const file = path.resolve(base, `.${pathname}`);
    if (file !== base && !file.startsWith(base + path.sep)) return plain(res, 403, "Forbidden");
    const info = file === base ? null : await fileAt(file);
    if (info) return sendFile(req, res, file, info, { immutable: pathname.startsWith("/assets/") });
    // Missing files with an extension are real 404s; app routes fall back to the client shell.
    if (path.extname(pathname)) return plain(res, 404, "Not found");
    const shell = await fileAt(index);
    if (!shell) return plain(res, 503, "The app has not been built yet. Run npm run start.");
    return sendFile(req, res, index, shell);
  };
}

const listenOnce = (server, port, host) => new Promise((resolve, reject) => {
  const onError = (error) => { server.off("listening", onListening); reject(error); };
  const onListening = () => { server.off("error", onError); resolve(); };
  server.once("error", onError); server.once("listening", onListening);
  server.listen(port, host);
});

// Starts the host. port 0 asks the OS for any free port; otherwise busy ports are skipped upward.
async function loadCoreHost(bundle, root, logger) {
  if (!bundle || !(await fileAt(bundle))) { logger.warn?.(`[perfect-planner] Core host bundle not found (${bundle}); run npm run build:core-host.`); return null; }
  try { const { createCoreHost } = await import(pathToFileURL(bundle).href); const host = createCoreHost(coreHostOptions(process.env, root)); host.acceptDesktopLaunch?.(); return host; }
  catch (error) { logger.warn?.(`[perfect-planner] Core host disabled: ${error.message}`); return null; }
}

export async function startLocalServer({ clientDirectory = DEFAULT_CLIENT_DIRECTORY, coreHostBundle = DEFAULT_CORE_HOST_BUNDLE, root = localAuthorityRoot(), launchFolder = null, port = Number(process.env.PORT ?? 4173), host = LOOPBACK_HOST, logger = console } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT: ${port}`);
  const server = http.createServer();
  const { middlewares, close: closeAuthority } = await createLocalAuthorityMiddlewares({ root, logger, getAddress: () => server.address(), isHttps: () => false });
  // The core loop screens (/api/core) run from the bundled core host; without a bundle they show their error state.
  const coreHost = await loadCoreHost(coreHostBundle, root, logger);
  if (coreHost) middlewares.unshift(coreHost.middleware);
  const serveStatic = createStaticHandler(clientDirectory);
  // Always on: with no folder it offers none until the person types one (POST /api/launch-folder/choose).
  const handlers = [createLaunchFolderMiddleware({ folder: launchFolder }), ...middlewares];
  server.on("request", (req, res) => runMiddlewares(handlers, req, res, (request, response) => serveStatic(request, response).catch(() => { if (!response.headersSent) plain(response, 500, "Server error"); else response.destroy(); })));
  for (let attempt = 0, candidate = port; ; attempt++, candidate++) {
    try { await listenOnce(server, candidate, host); break; }
    catch (error) { if (error.code !== "EADDRINUSE" || port === 0 || attempt + 1 >= PORT_ATTEMPTS || candidate >= 65535) { closeAuthority(); throw error; } }
  }
  const address = server.address();
  const url = `http://${host}:${address.port}/`;
  const close = () => new Promise((resolve) => { closeAuthority(); coreHost?.close(); server.close(() => resolve()); server.closeAllConnections?.(); });
  // The person's window proves itself with a one-time launch secret in the URL fragment
  // (core/host/session.ts). Fragments never reach a server, a proxy or a log.
  const launchUrl = () => (coreHost ? `${url}#pp-launch=${coreHost.issueLaunch()}` : url);
  return { server, url, port: address.port, root, close, launchUrl };
}

// Newest modification time under the client's sources (generated truth output excluded).
async function newestSourceTime(entries) {
  let newest = 0;
  const visit = async (target) => {
    let info; try { info = await stat(target); } catch { return; }
    if (info.isFile()) { newest = Math.max(newest, info.mtimeMs); return; }
    if (!info.isDirectory()) return;
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "generated") continue;
      await visit(path.join(target, entry.name));
    }
  };
  for (const entry of entries) await visit(path.join(projectRoot, entry));
  return newest;
}

export async function clientBuildIsCurrent(clientDirectory = DEFAULT_CLIENT_DIRECTORY) {
  const built = await fileAt(path.join(clientDirectory, "index.html"));
  if (!built) return false;
  if (!(await fileAt(DEFAULT_CORE_HOST_BUNDLE))) return false;
  return (await newestSourceTime(["src", "core", "public", "index.html", "package.json", "vite.config.mjs"])) <= built.mtimeMs;
}

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))));
});

function openBrowser(url) {
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* opening a browser is optional */ }
}

async function main(argv) {
  if (argv.includes("--build")) {
    if (await clientBuildIsCurrent()) console.log("[perfect-planner] Client build is current.");
    else {
      console.log("[perfect-planner] Building the app (dist/client is missing or older than its sources)...");
      // Same steps as npm run build:client. The build status report is supplementary: if it cannot be
      // written the app still runs and shows that report as unavailable, so only the client build is fatal.
      await run(process.execPath, [path.join(projectRoot, "node_modules", "vite", "bin", "vite.js"), "build"]);
      await run(process.execPath, [path.join(projectRoot, "scripts", "build-core-host.mjs")]);
      // One retry: on Windows a scanner can briefly hold the freshly written folder (EPERM on rename).
      const report = () => run(process.execPath, [path.join(projectRoot, "scripts", "generate-truth-report.mjs"), "--release"]);
      try { await report().catch(() => report()); }
      catch (error) { console.warn(`[perfect-planner] The build status report was not generated (${error.message}); the app will show it as unavailable.`); }
    }
  }
  const launchFolder = resolveLaunchFolder({ argv: argv.filter((value) => value !== "--build") });
  const { url, root, close, launchUrl } = await startLocalServer({ launchFolder });
  console.log(`[perfect-planner] Perfect Planner is running at ${url}`);
  if (launchFolder) console.log(`[perfect-planner] One-click scan offered for ${launchFolder} (read only)`);
  console.log(`[perfect-planner] Saving to ${root}`);
  // A window opened from this link can make changes as you; the link works once, for 10 minutes.
  const open = launchUrl();
  console.log(`[perfect-planner] Open Perfect Planner (one-time link): ${open}`);
  if (process.stdin.isTTY) {
    console.log("[perfect-planner] Press Enter for a new one-time link.");
    process.stdin.on("data", () => console.log(`[perfect-planner] Open Perfect Planner (one-time link): ${launchUrl()}`));
  }
  if (process.env.PP_OPEN === "1") openBrowser(open);
  const stop = () => { close().finally(() => process.exit(0)); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}

// The basename check keeps main() from running when this file is bundled into the desktop app (src/node/desktopHost.mjs).
if (process.argv[1] && path.basename(fileURLToPath(import.meta.url)) === "serve-local.mjs" && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(`[perfect-planner] ${error.message}`); process.exit(1); });
}
