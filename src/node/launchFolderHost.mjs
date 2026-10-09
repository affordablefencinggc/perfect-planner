// Read-only view of the folder `npm start` was launched for, so the app can scan it in one click
// without the browser's folder picker. Only the local loopback page can call it: requests need the
// x-pp-launch-folder header (a cross-site page cannot send it without a preflight this host never
// answers) and a loopback Host (blocks DNS rebinding). Symlinks are never followed or listed.
import path from "node:path";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isSecretFileName } from "../shared/secretFiles.js";

const PREFIX = "/api/launch-folder";
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
const MAX_ENTRIES = 20_000;

// Explicit path argument wins, then PP_FOLDER, then the folder npm was run from (INIT_CWD).
export function resolveLaunchFolder({ argv = [], env = process.env, cwd = process.cwd() } = {}) {
  const positional = argv.find((value) => value && !value.startsWith("-"));
  const chosen = positional || env.PP_FOLDER || env.INIT_CWD || cwd;
  return chosen ? path.resolve(cwd, chosen) : null;
}

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
};

// "" is the root; every other value is a "/"-separated relative path with no "." or ".." parts.
function relativeParts(value) {
  if (value === "" || value == null) return [];
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || value.includes("\\")) return null;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") ? parts : null;
}

export function createLaunchFolderMiddleware({ folder }) {
  let rootPromise = null;
  const root = () => rootPromise ??= (async () => {
    if (!folder) return null;
    try {
      const real = await realpath(folder);
      return (await stat(real)).isDirectory() ? real : null;
    } catch { return null; }
  })();
  // Resolves a relative path inside the root without following any symlink on the way.
  const inside = async (relative) => {
    const base = await root();
    const parts = relativeParts(relative);
    if (!base || !parts) return null;
    let current = base;
    for (const part of parts) {
      current = path.join(current, part);
      const info = await lstat(current).catch(() => null);
      if (!info || info.isSymbolicLink()) return null;
    }
    return current;
  };
  return async (req, res, next) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return next(); }
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Read only." });
    if (!LOOPBACK_HOST.test(req.headers.host ?? "") || req.headers["x-pp-launch-folder"] !== "1") return json(res, 403, { error: "Forbidden." });
    const base = await root();
    if (url.pathname === PREFIX) {
      return json(res, 200, base ? { available: true, name: path.basename(base) || base, path: base } : { available: false });
    }
    if (!base) return json(res, 404, { error: "No launch folder." });
    const target = await inside(url.searchParams.get("path") ?? "");
    if (!target) return json(res, 404, { error: "Not found." });
    if (url.pathname === `${PREFIX}/list`) {
      let entries;
      try { entries = await readdir(target, { withFileTypes: true }); } catch { return json(res, 403, { error: "Folder unreadable." }); }
      const listed = entries
        .filter((entry) => entry.isFile() || entry.isDirectory())
        .slice(0, MAX_ENTRIES)
        .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }));
      return json(res, 200, { entries: listed });
    }
    // Credential files are never served, even though the census already skips them.
    if (url.pathname !== `${PREFIX}/list` && isSecretFileName(path.basename(target))) return json(res, 403, { error: "Secret files are never read." });
    if (url.pathname === `${PREFIX}/stat`) {
      try {
        const info = await stat(target);
        if (!info.isFile()) return json(res, 404, { error: "Not a file." });
        return json(res, 200, { size: info.size, lastModified: Math.trunc(info.mtimeMs) });
      } catch { return json(res, 403, { error: "File unreadable." }); }
    }
    if (url.pathname === `${PREFIX}/file`) {
      let info;
      try { info = await stat(target); } catch { return json(res, 403, { error: "File unreadable." }); }
      if (!info.isFile()) return json(res, 404, { error: "Not a file." });
      res.statusCode = 200;
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-length", info.size);
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      if (req.method === "HEAD") return res.end();
      createReadStream(target).on("error", (error) => res.destroy(error)).pipe(res);
      return undefined;
    }
    return json(res, 404, { error: "Not found." });
  };
}
