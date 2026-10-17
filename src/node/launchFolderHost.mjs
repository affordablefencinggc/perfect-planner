// Read-only view of the folder `npm start` was launched for, so the app can scan it in one click
// without the browser's folder picker. Only the local loopback page can call it: requests need the
// x-pp-launch-folder header (a cross-site page cannot send it without a preflight this host never
// answers) and a loopback Host (blocks DNS rebinding). Symlinks are never followed or listed.
import os from "node:os";
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

const MAX_BODY = 8192;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

// A folder the person typed or pasted. Same stops as choosing a project's git folder (core/host/protectedRoots.ts):
// a full local path only (a drive letter on Windows, never a network share or \\?\ form), a real folder,
// never a whole drive or the home folder itself. Returns the real path, or a plain-language reason.
export async function checkTypedFolder(value, { platform = process.platform, home = os.homedir() } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 4096 || text.includes("\0")) return { error: "Type the full path of one folder." };
  const windows = platform === "win32";
  if (windows ? !WINDOWS_DRIVE_PATH.test(text) : !text.startsWith("/")) {
    return { error: windows ? "Type the full path starting with a drive letter, for example C:\\projects\\my-app." : "Type the full path starting with /, for example /home/you/my-app." };
  }
  let real;
  try {
    real = await realpath(text);
    if (!(await stat(real)).isDirectory()) return { error: "That path is a file, not a folder." };
  } catch {
    return { error: "That folder does not exist or cannot be read." };
  }
  const same = (a, b) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(path.dirname(real), real)) return { error: "That is a whole drive. Choose your app's own folder." };
  const realHome = await realpath(home).catch(() => home);
  if (same(real, realHome)) return { error: "That is your home folder. Choose your app's own folder." };
  return { real };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

export function createLaunchFolderMiddleware({ folder = null } = {}) {
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
    const guarded = LOOPBACK_HOST.test(req.headers.host ?? "") && req.headers["x-pp-launch-folder"] === "1";
    if (req.method === "POST" && url.pathname === `${PREFIX}/choose`) {
      if (!guarded) return json(res, 403, { error: "Forbidden." });
      const body = await readBody(req);
      const checked = await checkTypedFolder(body?.path);
      if (checked.error) return json(res, 400, { error: checked.error });
      folder = checked.real;
      rootPromise = null;
      const base = await root();
      return json(res, 200, base ? { available: true, name: path.basename(base) || base, path: base } : { available: false });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Read only." });
    if (!guarded) return json(res, 403, { error: "Forbidden." });
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
