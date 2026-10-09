#!/usr/bin/env node
// Release check for the desktop app's bundled local service, run against the files an
// installer ships (dist/desktop-host, or the installed app's desktop-host folder):
//   1. start core-host/desktop.mjs with the bundled Node, the way the shell does;
//   2. read its ready line and sign in as the person, the way the window does
//      (claims the one-time launch link when the core host issues one);
//   3. press Connect agent over HTTP and run the line it hands out (check-agent-connect.mjs);
//   4. close its stdin, as the shell does when the app quits, and check that it stopped.
//   node scripts/release/check-desktop-host.mjs [desktop-host folder]
// Prints a JSON summary; exits non-zero on any failure. No secret is printed.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentConnect } from "./check-agent-connect.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** The person's credentials for writes, exactly as the app window gets them. */
export async function personHeaders(origin, open) {
  const base = { origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
  const cookieOf = (res) => String([res.headers["set-cookie"] ?? []].flat()[0] ?? "").split(";")[0];
  const launch = new URL(open).hash.match(/pp-launch=([\w-]+)/)?.[1];
  if (launch) {
    const claim = await request(`${origin}/api/core/session/claim`, { method: "POST", headers: base, body: { launch } });
    if (claim.status !== 200 || !claim.json?.result?.csrf) throw new Error(`Claiming the window link failed (${claim.status}).`);
    return { ...base, cookie: cookieOf(claim), "x-pp-csrf": claim.json.result.csrf };
  }
  const session = await request(`${origin}/api/core/session`, { headers: base });
  if (session.status !== 200) throw new Error(`Signing in as the person failed (${session.status}).`);
  return { ...base, cookie: cookieOf(session) };
}

export async function checkDesktopHost(folder = path.join(projectRoot, "dist", "desktop-host"), { port = "0" } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(folder, "desktop-host.json"), "utf8"));
  const node = path.join(folder, manifest.node.binary);
  const data = mkdtempSync(path.join(tmpdir(), "pp-desktop-check-"));
  const env = { ...process.env, PP_PORT: port, PP_DATA_DIR: data, PP_CORE_KEYS: "memory" };
  delete env.NODE_OPTIONS;
  delete env.PP_NODE_BINARY;
  const child = spawn(node, [path.join(folder, manifest.entry)], { cwd: path.dirname(path.join(folder, manifest.entry)), env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  try {
    const line = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`The service did not report ready. ${stderr.trim()}`)), 60_000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const nl = out.indexOf("\n");
        if (nl >= 0) { clearTimeout(timer); resolve(out.slice(0, nl)); }
      });
      exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`The service exited (${code}) before it was ready. ${stderr.trim()}`)); });
    });
    const ready = JSON.parse(line);
    if (ready.event !== "ready" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.origin)) throw new Error(`Unexpected ready line event ${ready.event}.`);
    const page = await request(`${ready.origin}/`);
    if (page.status !== 200 || !/<div id="root"|<script/i.test(page.text)) throw new Error(`The app page did not load (${page.status}).`);
    const headers = await personHeaders(ready.origin, ready.open);
    const connect = await request(`${ready.origin}/api/core/agents/connect?project=default`, { method: "POST", headers, body: {} });
    if (connect.status !== 200 || !connect.json?.result?.claudeCode) throw new Error(`Connect agent failed (${connect.status}): ${connect.json?.message ?? ""}`);
    const agent = await checkAgentConnect(connect.json.result.claudeCode);
    const agents = await request(`${ready.origin}/api/core/agents?project=default`, { headers: { "sec-fetch-site": "same-origin" } });
    const listed = agents.json?.result?.agents ?? [];
    if (!listed.some((a) => a.name === "Release check agent" && a.role === "main")) throw new Error("The app does not list the agent that checked in.");
    child.stdin.end();
    const stopped = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))]);
    if (!stopped) throw new Error("The service did not stop when its stdin closed.");
    return { ok: true, target: manifest.target, node: manifest.node.version, origin: ready.origin, launchLink: Boolean(new URL(ready.open).hash), agent: { usesBundledNode: agent.registered.usesLineNode, checkedInAs: agent.checkedInAs, skillInstalled: agent.skillInstalled }, appListsAgent: true, stoppedWithStdin: true };
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(data, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkDesktopHost(process.argv[2] ? path.resolve(process.argv[2]) : undefined).then(
    (summary) => { console.log(JSON.stringify(summary, null, 2)); },
    (error) => { console.log(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exit(1); },
  );
}
