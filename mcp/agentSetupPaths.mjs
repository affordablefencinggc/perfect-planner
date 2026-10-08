// Paths an outside agent needs to start the read-only stdio MCP server from this checkout.
// Shared by vite.config.mjs (embedded only for local development) and `npm run mcp`.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DESKTOP_IDENTIFIER = "com.perfectplanner.desktop";
export const mcpServerPath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "perfectPlannerMcpServer.mjs");

// Mirrors Tauri's app_data_dir() + "workspace-registry-v1" (src-tauri/src/workspace_census.rs).
export function defaultRegistryRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const base = platform === "win32" ? env.APPDATA
    : platform === "darwin" ? join(home, "Library", "Application Support")
    : env.XDG_DATA_HOME || join(home, ".local", "share");
  return base ? join(base, DESKTOP_IDENTIFIER, "workspace-registry-v1") : null;
}
