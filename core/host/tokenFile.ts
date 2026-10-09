// Agent token files and the agent CLI, handled safely on Windows as well as
// macOS and Linux. Mode 0600 means nothing on NTFS, so on Windows the file and
// its folder get an owner-only ACL instead; a token path on a network share is
// refused before anything opens it (opening \\host\share leaks the NTLM hash);
// and the agent CLI is found by absolute path on PATH, never in the project
// folder, so a claude.cmd planted in a repo cannot run.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** UNC (\\host\share), device (\\?\, \\.\) and //host paths: anything that is not a plain local path. */
export function isNetworkPath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (value.startsWith("//")) return true;
  return platform === "win32" && value.startsWith("\\\\");
}

export function icaclsPath(): string {
  return path.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "icacls.exe");
}

/** Removes inherited entries and grants full control to the current user alone. */
function ownerOnlyAcl(target: string): void {
  const user = os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  const who = domain ? `${domain}\\${user}` : user;
  execFileSync(icaclsPath(), [target, "/inheritance:r", "/grant:r", `${who}:F`], { stdio: "ignore", windowsHide: true });
}

/**
 * Writes text to a file only this OS user can read. An older file (or a link planted in its place)
 * is removed first, and the new one is created exclusively, so the write never follows a link.
 */
export function writeOwnerOnlyFile(file: string, text: string, platform: NodeJS.Platform = process.platform): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === "win32") ownerOnlyAcl(dir);
  else fs.chmodSync(dir, 0o700);
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  if (platform === "win32") ownerOnlyAcl(file);
}

/**
 * The absolute path of a program on PATH. Relative PATH entries and the project folder itself are
 * skipped, so a program dropped into a repo is never picked. On Windows PATHEXT decides the order.
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): string | null {
  const windows = platform === "win32";
  const p = path; // the running system's paths; platform only picks the PATH separator and PATHEXT
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const here = p.resolve(cwd);
  const exts = windows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const entry of pathValue.split(windows ? ";" : ":")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !p.isAbsolute(dir) || isNetworkPath(dir, platform)) continue;
    if (p.resolve(dir) === here) continue;
    for (const ext of exts) {
      const candidate = p.join(dir, `${name}${ext.toLowerCase()}`);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export interface Launch {
  command: string;
  args: string[];
  /** Only for a .cmd/.bat that is not a known npm shim: run through cmd.exe by absolute path. */
  verbatim?: boolean;
}

/**
 * How to start a CLI found by findExecutable without a shell. An npm shim (claude.cmd next to
 * node_modules/<pkg>/<entry>) runs as node <entry> directly; an .exe runs as itself; any other
 * .cmd/.bat runs through cmd.exe by absolute path with the current folder left out of its search.
 */
export function launchFor(program: string, args: string[], npmEntry: string | null, platform: NodeJS.Platform = process.platform): Launch {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(program)) return { command: program, args };
  if (npmEntry) {
    const entry = path.win32.join(path.win32.dirname(program), "node_modules", ...npmEntry.split("/"));
    if (fs.existsSync(entry)) return { command: process.execPath, args: [entry, ...args] };
  }
  const comspec = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  const quoted = [program, ...args].map((a) => `"${a}"`).join(" ");
  return { command: comspec, args: ["/d", "/s", "/c", `"${quoted}"`], verbatim: true };
}
