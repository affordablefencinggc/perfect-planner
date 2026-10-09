#!/usr/bin/env node
// Windows release smoke test of the real installer, the way a person uses it:
//   1. install the NSIS setup silently into a folder whose path has spaces;
//   2. check the installed local service headless (check-desktop-host.mjs);
//   3. open the installed app; its WebView2 window is driven over the DevTools protocol:
//      the window must land on the local service, Connect agent is clicked, and the exact
//      line it shows is run (check-agent-connect.mjs) until the window says Connected;
//   4. kill the app hard and check its service went with it.
// Screenshots and summary.json go to --out. Exits non-zero on any failure.
//   node scripts/release/smoke-installed-app.mjs --installer <setup.exe> --out <folder>
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentConnect } from "./check-agent-connect.mjs";
import { checkDesktopHost } from "./check-desktop-host.mjs";

const DEVTOOLS_PORT = 9333;
const SERVICE_ORIGIN = "http://127.0.0.1:41730";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arg = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } }); }).on("error", reject);
  });
}
const reachable = (url) => new Promise((resolve) => { const req = http.get(url, (res) => { res.resume(); resolve(true); }); req.on("error", () => resolve(false)); req.setTimeout(2000, () => { req.destroy(); resolve(false); }); });

async function until(what, fn, timeoutMs = 60_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? ` (${last.message})` : ""}.`);
}

/** A minimal DevTools protocol client over Node's built-in WebSocket. */
async function devtools(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("DevTools connection failed.")); });
  let id = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
    if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    socket.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  const screenshot = async (file) => writeFileSync(file, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  return { send, evaluate, screenshot, close: () => socket.close() };
}

// Runs in the page: click the first button whose text is exactly `label`, inside `scope` when given.
const clickButton = (label, scope) => `(() => {
  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : "document"};
  if (!root) return false;
  const button = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled);
  if (!button) return false;
  button.click();
  return true;
})()`;

function install(installer, dir) {
  // NSIS wants /D last and unquoted, even with spaces.
  const result = spawnSync(`"${installer}" /S /D=${dir}`, { shell: true, windowsVerbatimArguments: true, stdio: "inherit", timeout: 300_000 });
  if (result.status !== 0) throw new Error(`The installer exited with ${result.status}.`);
  const exe = readdirSync(dir).find((name) => name.toLowerCase().endsWith(".exe") && !/^uninstall/i.test(name) && name.toLowerCase() !== "node.exe");
  if (!exe) throw new Error(`No app executable in ${dir}: ${readdirSync(dir).join(", ")}`);
  return path.join(dir, exe);
}

export async function smokeInstalledApp({ installer, out, installDir = "C:\\PP Smoke\\Perfect Planner" }) {
  mkdirSync(out, { recursive: true });
  const summary = { installer: path.basename(installer), installDir };
  const exe = install(installer, installDir);
  summary.exe = path.basename(exe);
  summary.serviceFiles = existsSync(path.join(installDir, "desktop-host", "desktop-host.json"));
  if (!summary.serviceFiles) throw new Error("The installer did not ship desktop-host.");
  summary.headless = await checkDesktopHost(path.join(installDir, "desktop-host"));

  const app = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEVTOOLS_PORT}` }, stdio: "ignore", detached: false });
  summary.appPid = app.pid;
  let client;
  try {
    const target = await until("the app window on the local service", async () => {
      const targets = await getJson(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`);
      return targets.find((t) => t.type === "page" && String(t.url).startsWith(`${SERVICE_ORIGIN}/`));
    }, 120_000);
    summary.windowUrl = target.url.replace(/#.*/, "");
    client = await devtools(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await until("the app to render", () => client.evaluate(`document.readyState === "complete" && document.body.innerText.includes("Connect agent")`), 60_000);
    await client.screenshot(path.join(out, "1-installed-app-opened.png"));

    await until("the Connect agent drawer", () => client.evaluate(`document.querySelector(".core-screen-connect") !== null || ${clickButton("Connect agent")}`), 30_000);
    await until("the Connect agent card", () => client.evaluate(`document.querySelector(".core-screen-connect button.primary") !== null`), 30_000);
    await client.evaluate(clickButton("Connect agent", ".core-screen-connect"));
    const line = await until("the connect line", () => client.evaluate(`document.querySelector("[data-connect-command]")?.innerText?.trim() || ""`), 30_000);
    summary.lineUsesBundledNode = line.startsWith(`& "${installDir}\\desktop-host\\node.exe"`);
    await client.screenshot(path.join(out, "2-connect-line.png"));
    const agent = await checkAgentConnect(line);
    summary.agent = { checkedInAs: agent.checkedInAs, registeredWithBundledNode: agent.registered.usesLineNode, skillInstalled: agent.skillInstalled };
    await until("the window to say the agent connected", () => client.evaluate(`document.querySelector(".core-screen-connect")?.innerText?.includes("Connected:")`), 30_000);
    await client.screenshot(path.join(out, "3-agent-connected.png"));
    summary.windowSaysConnected = true;
  } finally {
    client?.close();
    spawnSync("taskkill", ["/PID", String(app.pid), "/F"], { stdio: "ignore" });
  }
  // The service must not outlive the app, even when the app is killed.
  summary.serviceStoppedWithApp = await until("the service to stop after the app was killed", async () => !(await reachable(`${SERVICE_ORIGIN}/`)), 30_000).then(() => true, () => false);
  if (!summary.serviceStoppedWithApp) throw new Error("The local service kept running after the app was killed.");
  if (!summary.lineUsesBundledNode) throw new Error("The connect line does not use the bundled Node.");
  summary.ok = true;
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(arg("--out") ?? "smoke-out");
  smokeInstalledApp({ installer: path.resolve(arg("--installer")), out }).then(
    (summary) => { writeFileSync(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`); console.log(JSON.stringify(summary, null, 2)); },
    (error) => { mkdirSync(out, { recursive: true }); writeFileSync(path.join(out, "summary.json"), `${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`); console.error(error.stack ?? error.message); process.exit(1); },
  );
}
