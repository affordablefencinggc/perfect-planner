// npm run tauri:dev: starts the desktop shell and its dev server with one shared, one-time
// launch secret. The core host (in the dev server) accepts it; the shell reads it once at
// startup and hands it to its window over IPC (src-tauri/src/core_launch.rs), so the window
// can make changes without the secret ever being served over HTTP.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const env = { ...process.env, PP_CORE_DESKTOP_LAUNCH: randomBytes(32).toString("base64url") };
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tauri", "dev", ...process.argv.slice(2)], { stdio: "inherit", env, shell: process.platform === "win32" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
