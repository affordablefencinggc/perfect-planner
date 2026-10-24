// How to start an agent CLI without a shell. Kept apart from agentConnect.ts because that file runs
// as a program when it is the entry point, so the host must never bundle it.
import fs from "node:fs";
import path from "node:path";
import { findExecutable, isWithin, registeredRoots, type ExecutableIo } from "../exec/index";
import { AGENTS, type AgentKind } from "./agentKinds";

export interface Launch {
  command: string;
  args: string[];
}

/**
 * How to start an agent CLI (claude, gemini, codex) without a shell, by core/exec's finder, so one planted in the project,
 * the picked repo or a PATH folder that links into either never runs. On Windows a claude.exe runs as
 * itself; on macOS and Linux an npm-installed claude (a node script) runs under this Node, never
 * through its `env node` shebang; an npm shim (claude.cmd) is never run: its package entry runs under this Node instead, and only
 * when that entry also lies outside every protected folder. Null when no usable Claude Code is found.
 */
export function agentLaunch(
  agent: AgentKind,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  protect: readonly string[],
  platform: NodeJS.Platform = process.platform,
  io: ExecutableIo = {},
): Launch | null {
  const { cli, npmEntry } = AGENTS[agent];
  const program = findExecutable(cli, env, cwd, platform, protect, { ...io, windowsExtensions: [".exe", ".cmd"] });
  if (!program) return null;
  if (platform !== "win32") return nodeScript(program) ? { command: process.execPath, args: [program, ...args] } : { command: program, args };
  if (!/\.cmd$/i.test(program)) return { command: program, args };
  const viaShim = shimLaunch(program, args, cwd, protect, npmEntry);
  if (viaShim) return viaShim;
  // A shim whose package is gone (an npm folder earlier on PATH than a standalone install) must not hide a real
  // claude.exe further down PATH: look again for an .exe only, which is run as itself.
  const exe = findExecutable(cli, env, cwd, platform, protect, { ...io, windowsExtensions: [".exe"] });
  return exe ? { command: exe, args } : null;
}

function shimLaunch(program: string, args: string[], cwd: string, protect: readonly string[], npmEntry: string): Launch | null {
  // The npm package entry the shim (claude.cmd, gemini.cmd, codex.cmd) starts; it runs under this Node instead.
  const entry = path.join(path.dirname(program), "node_modules", ...npmEntry.split("/"));
  let real: string;
  try {
    if (!fs.statSync(entry).isFile()) return null;
    real = fs.realpathSync.native(entry);
  } catch {
    return null;
  }
  const roots = [cwd, ...protect, ...registeredRoots()];
  if (roots.some((root) => isWithin(root, entry) || isWithin(root, real) || isWithin(safeReal(root), real))) return null;
  return { command: process.execPath, args: [entry, ...args] };
}

/** Claude Code's launch (kept for callers that only start Claude Code). */
export function claudeLaunch(args: string[], env: NodeJS.ProcessEnv, cwd: string, protect: readonly string[], platform: NodeJS.Platform = process.platform): Launch | null {
  return agentLaunch("claude", args, env, cwd, protect, platform);
}

/**
 * True for an npm-installed claude on macOS and Linux: a link to a .js file or a script starting
 * `#!/usr/bin/env node`. Its shebang would look node up on PATH, where a planted node could sit, so
 * it runs under this Node instead.
 */
function nodeScript(program: string): boolean {
  try {
    if (/\.[cm]?js$/i.test(fs.realpathSync.native(program))) return true;
    const fd = fs.openSync(program, "r");
    try {
      const head = Buffer.alloc(128);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      return /^#!\s*\S*\/env\s+(?:-S\s+)?node(?:\s|$)/.test(head.subarray(0, read).toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function safeReal(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

