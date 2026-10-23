import { statSync } from "node:fs";
import path from "node:path";
import { findExecutable, isLocalWindowsPath } from "./executable";

/** The operating system helpers the key stores start. Each one handles a signing or API key. */
export type KeyStoreTool = "powershell" | "security" | "secret-tool";

export interface KeyStoreToolOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Folder to exclude from a PATH search (default: the current folder). */
  cwd?: string;
  /** More folders to exclude: the project folder, repo and worktrees the host registered. */
  protect?: readonly string[];
  /** For tests: whether a fixed system path holds a file. */
  isFile?: (file: string) => boolean;
}

/** Fixed Linux locations for secret-tool, tried before PATH. */
const SECRET_TOOL_PATHS = ["/usr/bin/secret-tool", "/bin/secret-tool"];

/**
 * The Windows system folder. SystemRoot is set by Windows itself, so anything but a local drive-letter
 * path (empty, relative, network, device) is ignored and C:\\Windows is used. Every system program the
 * core starts by full path (taskkill, icacls, cmd, PowerShell) takes its folder from here.
 */
export function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  const value = Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
  return value && isLocalWindowsPath(value) ? value : "C:\\Windows";
}

/** Full path of a program in the Windows System32 folder, e.g. system32Tool("taskkill.exe"). */
export function system32Tool(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(systemRoot(env), "System32", name);
}

/**
 * Absolute path of a key-store helper, never a bare name, so a program called powershell.exe,
 * security or secret-tool in the current folder (Windows searches it first) or early on PATH can
 * never see or swap a key. Windows PowerShell 5.1 and macOS `security` ship at fixed system paths;
 * secret-tool is taken from /usr/bin or /bin, else from PATH through findExecutable (never a
 * relative, network or protected folder). Returns null when the helper cannot be found.
 */
export function keyStoreTool(tool: KeyStoreTool, options: KeyStoreToolOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? fileExists;
  if (tool === "powershell") {
    if (platform !== "win32") return null;
    return path.win32.join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  if (tool === "security") return platform === "darwin" ? "/usr/bin/security" : null;
  if (platform !== "linux") return null;
  const fixed = SECRET_TOOL_PATHS.find((file) => isFile(file));
  if (fixed) return fixed;
  return findExecutable("secret-tool", env, options.cwd ?? process.cwd(), platform, options.protect ?? []);
}

function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
