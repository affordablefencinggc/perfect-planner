// A small Chrome DevTools Protocol client with no dependencies: one browser connection, flat sessions per
// page, so many pages can be driven at once. Used by the screenshot capture tool (capture.mjs).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = [
  process.env.PP_CHROME,
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** The first Chrome or Chromium found on this computer, or undefined. */
export function findChrome() {
  for (const candidate of CANDIDATES) if (candidate && existsSync(candidate)) return candidate;
  const bundled = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (bundled && existsSync(bundled)) {
    for (const dir of readdirSync(bundled).filter((name) => name.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux/chrome", "chrome-win/chrome.exe", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const full = path.join(bundled, dir, rel);
        if (existsSync(full)) return full;
      }
    }
  }
  return undefined;
}

export class CdpConnection {
  #ws;
  #next = 1;
  #pending = new Map();
  #listeners = new Map();

  static async open(url) {
    const connection = new CdpConnection();
    connection.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      connection.#ws.addEventListener("open", resolve, { once: true });
      connection.#ws.addEventListener("error", () => reject(new Error(`Could not connect to the browser at ${url}.`)), { once: true });
    });
    connection.#ws.addEventListener("message", (event) => connection.#onMessage(JSON.parse(String(event.data))));
    connection.#ws.addEventListener("close", () => {
      for (const { reject } of connection.#pending.values()) reject(new Error("The browser closed the connection."));
      connection.#pending.clear();
    });
    return connection;
  }

  #onMessage(message) {
    if (message.id) {
      const waiting = this.#pending.get(message.id);
      if (!waiting) return;
      this.#pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
      return;
    }
    for (const listener of this.#listeners.get(`${message.sessionId ?? ""}|${message.method}`) ?? []) listener(message.params);
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(sessionId, method, listener) {
    const key = `${sessionId ?? ""}|${method}`;
    this.#listeners.set(key, [...(this.#listeners.get(key) ?? []), listener]);
  }

  close() {
    try { this.#ws.close(); } catch { /* already closed */ }
  }
}

/** Starts a private headless Chrome and connects to it. `stop()` closes it and removes its profile. */
export async function launchChrome({ executable = findChrome(), headless = true } = {}) {
  if (!executable) throw new Error("No Chrome or Chromium found. Install one or set PP_CHROME to its path.");
  const profile = mkdtempSync(path.join(os.tmpdir(), "pp-capture-"));
  const args = [`--remote-debugging-port=0`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "about:blank"];
  // Chrome refuses to run its sandbox as root (containers, CI); everywhere else it stays on.
  if (process.getuid?.() === 0 || process.env.PP_CHROME_NO_SANDBOX) args.unshift("--no-sandbox");
  if (headless) args.unshift("--headless=new");
  const child = spawn(executable, args, { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  const started = Date.now();
  while (!existsSync(portFile)) {
    if (child.exitCode !== null) throw new Error("Chrome exited before it was ready.");
    if (Date.now() - started > 20_000) { child.kill(); throw new Error("Chrome did not start within 20 seconds."); }
    await new Promise((r) => setTimeout(r, 40));
  }
  const [port, browserPath] = readFileSync(portFile, "utf8").trim().split("\n");
  const connection = await CdpConnection.open(`ws://127.0.0.1:${port}${browserPath}`);
  const version = await connection.send("Browser.getVersion");
  return {
    connection,
    version: version.product,
    async stop() {
      connection.close();
      child.kill();
      await new Promise((r) => setTimeout(r, 150));
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
