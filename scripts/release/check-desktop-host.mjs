#!/usr/bin/env node
// Release check for the desktop app's bundled local service, run against the files an
// installer ships (dist/desktop-host, or the installed app's desktop-host folder):
//   1. start core-host/desktop.mjs with the bundled Node, the way the shell does;
//   2. check that nothing without the window's one-time launch secret can write (forged headers,
//      the old /session cookie, a guessed or replayed secret), then claim it as the window does;
//   3. press Connect agent over HTTP and run the line it hands out (check-agent-connect.mjs);
//   4. run the whole loop the way the person and a worker do (runLoop): open a project folder,
//      plan and approve, start a worker (the bundled Node runs it, from the app's own MCP JSON),
//      approve its failing test, let it build and attach proof, check, approve the diff, merge;
//      test commands and the commit hook run with no Node on PATH but the app's own;
//   5. close its stdin, as the shell does when the app quits, and check that it stopped.
//   node scripts/release/check-desktop-host.mjs [desktop-host folder]
// Prints a JSON summary; exits non-zero on any failure. No secret is printed.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The person's credentials for writes, exactly as the app window gets them: claim the one-time
 * launch secret from the window link (core/host/session.ts) for an HttpOnly cookie and a CSRF token.
 */
export async function personHeaders(origin, open) {
  const base = { origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
  const launch = new URL(open).hash.match(/pp-launch=([\w-]+)/)?.[1];
  if (!launch) throw new Error("The window link carries no one-time launch secret.");
  const claim = await request(`${origin}/api/core/session/claim`, { method: "POST", headers: base, body: { launch } });
  if (claim.status !== 200 || !claim.json?.result?.csrf) throw new Error(`Claiming the window link failed (${claim.status}).`);
  const cookie = String([claim.headers["set-cookie"] ?? []].flat()[0] ?? "").split(";")[0];
  return { headers: { ...base, cookie, "x-pp-csrf": claim.json.result.csrf }, launch };
}

/**
 * What any other local program can try against the service, all of which must be refused:
 * a write with forged browser headers, the old GET /session cookie, a guessed launch secret,
 * and (after the window claimed it) a replay of the real one.
 */
export async function refusedWithoutTheWindow(origin, replayLaunch) {
  const forged = { origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
  const results = {};
  results.forgedWrite = (await request(`${origin}/api/core/agents/connect?project=default`, { method: "POST", headers: forged, body: {} })).status;
  const session = await request(`${origin}/api/core/session`, { headers: forged });
  results.oldSessionCookie = session.headers["set-cookie"] ? "issued" : session.status;
  results.guessedLaunch = (await request(`${origin}/api/core/session/claim`, { method: "POST", headers: forged, body: { launch: "A".repeat(43) } })).status;
  if (replayLaunch) results.replayedLaunch = (await request(`${origin}/api/core/session/claim`, { method: "POST", headers: forged, body: { launch: replayLaunch } })).status;
  const refused = Object.values(results).every((v) => typeof v === "number" && v >= 400);
  if (!refused) throw new Error(`An unauthenticated caller got through: ${JSON.stringify(results)}`);
  return results;
}

/** A worker's MCP session over stdio, started exactly as the app's MCP JSON says. */
function mcpWorker({ command, args, env }, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let buffer = "";
  let stderr = "";
  let id = 0;
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`The worker's ${method} got no answer. ${stderr.trim()}`)), 60_000);
    waiting.set(n, (m) => { clearTimeout(timer); m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
  });
  return {
    async start() {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-check-worker", version: "1" } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async tool(name, args = {}) {
      const result = await rpc("tools/call", { name, arguments: args });
      const text = result?.content?.[0]?.text ?? "";
      if (result?.isError) throw new Error(`${name}: ${text}`);
      return result.structuredContent ?? JSON.parse(text);
    },
    stop() { child.kill(); },
  };
}

/** PATH without any folder that holds a Node of its own, so only the app's Node can run `node`. */
export function pathWithoutNode(env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const names = process.platform === "win32" ? ["node.exe", "node.cmd"] : ["node"];
  const kept = String(env[key] ?? "").split(path.delimiter).filter((dir) => dir && !names.some((n) => existsSync(path.join(dir, n))));
  return { key, value: kept.join(path.delimiter) };
}

/**
 * The loop end to end against the running service, as the person (HTTP with the window's
 * session) and a worker (the app's MCP JSON, on the bundled Node) do it.
 */
export async function runLoop(origin, headers, work, appNode) {
  const api = async (method, route, body) => {
    const res = await request(`${origin}/api/core${route}${route.includes("?") ? "&" : "?"}project=default`, { method, headers, body });
    if (res.status !== 200) throw new Error(`${method} ${route} failed (${res.status}): ${res.json?.message ?? res.text.slice(0, 300)}`);
    return res.json.result;
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const steps = {};

  // Open a project: a git folder with one commit, chosen as the workers' repository.
  const repo = realpathSync.native(path.join(work, "notes-app"));
  git(repo, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Owner"], ["user.email", "owner@example.invalid"], ["commit.gpgsign", "false"]]) git(repo, "config", k, v);
  writeFileSync(path.join(repo, "README.md"), "# Pocket notes\n");
  writeFileSync(path.join(repo, ".gitignore"), ".perfect-planner/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial");
  steps.openProject = (await api("POST", "/tasks/repo", { root: repo })).repo?.ok === true;

  // Plan from an idea, settle every blocking question with its recommendation, approve.
  await api("POST", "/planning/start", { idea: "Pocket notes: a notes app for one person on one laptop. No accounts, no cloud sync. Notes are saved to a local file." });
  for (let i = 0; i < 200; i++) {
    const view = await api("GET", "/planning");
    const blocker = view.blockers[0];
    if (!blocker) break;
    const question = view.areas.flatMap((a) => a.questions).find((x) => x.q === blocker.q);
    const choice = blocker.recommendation?.option || question?.options?.[0]?.id;
    await api("POST", "/planning/answer", choice ? { q: blocker.q, choice } : { q: blocker.q, text: "Keep it as simple as possible." });
  }
  const plan = await api("GET", "/planning");
  if (!plan.approval.canApprove) throw new Error(`The plan cannot be approved: ${plan.approval.message}`);
  await api("POST", "/planning/approve", { fingerprint: plan.fingerprint });
  steps.planApproved = (await api("GET", "/planning")).approval.current === true;

  // Start a worker on the first task; it runs from the app's own MCP JSON (the bundled Node).
  const board = await api("GET", "/tasks");
  const task = board.tasks[0];
  if (!task) throw new Error("Approving the plan put no task on the board.");
  steps.task = task.id;
  const d = await api("POST", `/tasks/${task.id}/dispatch`, { model: "release-check" });
  const server = Object.values(JSON.parse(d.json).mcpServers)[0];
  steps.workerOnBundledNode = path.resolve(server.command) === path.resolve(appNode);
  if (!steps.workerOnBundledNode) throw new Error(`The worker's MCP JSON runs ${server.command}, not the app's Node.`);
  const workerEnv = { ...process.env, ...server.env };
  delete workerEnv.NODE_OPTIONS;
  const worker = mcpWorker({ command: server.command, args: server.args, env: workerEnv }, d.worktree);
  try {
    await worker.start();
    const hello = await worker.tool("hello", { name: "Release check worker", model: "release-check" });
    if (hello.role !== "worker" || hello.task !== task.id) throw new Error(`The worker checked in as ${hello.role} on ${hello.task}.`);
    const agent = hello.agent;
    // Test first: it fails until the work exists.
    mkdirSync(path.join(d.worktree, "tests"), { recursive: true });
    writeFileSync(path.join(d.worktree, "tests", "save.check.mjs"), 'import { existsSync } from "node:fs";\nif (!existsSync("src/save.js")) { console.error("src/save.js does not exist yet"); process.exit(1); }\nconsole.log("notes are saved");\n');
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Test: notes are saved");
    await worker.tool("propose_test", { task: task.id, command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"], agent });
    const proposed = (await api("GET", "/tasks")).tasks.find((t) => t.id === task.id).test.entry;
    const approved = await api("POST", `/tasks/${task.id}/approve-test`, { test: proposed });
    if (!approved.failsFirst) throw new Error(`The approved test did not fail first: ${JSON.stringify(approved).slice(0, 300)}`);
    steps.testApprovedFailsFirst = true;
    // The worker claims, builds, commits (through the commit-time secret scan) and attaches proof.
    await worker.tool("claim_task", { task: task.id, agent });
    mkdirSync(path.join(d.worktree, "src"), { recursive: true });
    writeFileSync(path.join(d.worktree, "src", "save.js"), 'import { writeFileSync } from "node:fs";\n\nexport const saveNotes = (file, notes) => writeFileSync(file, JSON.stringify(notes));\n');
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "Save notes to a local file");
    const head = git(d.worktree, "rev-parse", "HEAD");
    await worker.tool("attach_proof", { task: task.id, kind: "commit", link: head, agent });
    steps.proofAttached = head;
  } finally {
    worker.stop();
  }
  // The person checks, reads the diff, approves it and merges.
  const checked = await api("POST", `/tasks/${task.id}/check`);
  if (!checked.passed) throw new Error(`The check did not pass: ${JSON.stringify(checked).slice(0, 300)}`);
  steps.checkPassed = true;
  const diff = await api("GET", `/tasks/${task.id}/diff`);
  await api("POST", `/tasks/${task.id}/approve-diff`, { commit: diff.commit });
  await api("POST", `/tasks/${task.id}/merge`, { commit: steps.proofAttached });
  const done = (await api("GET", "/tasks")).tasks.find((t) => t.id === task.id);
  steps.merged = done.status === "done" && git(repo, "show", "main:src/save.js").includes("saveNotes");
  if (!steps.merged) throw new Error(`The task did not finish: ${done.status}/${done.stage}.`);
  steps.tokenFileRemoved = !existsSync(d.tokenFile);
  return steps;
}

export async function checkDesktopHost(folder = path.join(projectRoot, "dist", "desktop-host"), { port = "0" } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(folder, "desktop-host.json"), "utf8"));
  const node = path.join(folder, manifest.node.binary);
  const data = mkdtempSync(path.join(tmpdir(), "pp-desktop-check-"));
  const work = path.join(data, "work");
  mkdirSync(path.join(work, "notes-app"), { recursive: true });
  const env = { ...process.env, PP_PORT: port, PP_DATA_DIR: path.join(data, "app"), PP_CORE_KEYS: "memory" };
  delete env.NODE_OPTIONS;
  delete env.PP_NODE_BINARY;
  // The person may have no Node at all: the service's test runs and commit hooks must manage with the app's own.
  const noNode = pathWithoutNode(env);
  env[noNode.key] = noNode.value;
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
    const before = await refusedWithoutTheWindow(ready.origin);
    const { headers, launch } = await personHeaders(ready.origin, ready.open);
    const after = await refusedWithoutTheWindow(ready.origin, launch);
    const connect = await request(`${ready.origin}/api/core/agents/connect?project=default`, { method: "POST", headers, body: {} });
    if (connect.status !== 200 || !connect.json?.result?.claudeCode) throw new Error(`Connect agent failed (${connect.status}): ${connect.json?.message ?? ""}`);
    const agent = await checkAgentConnect(connect.json.result.claudeCode);
    const loop = await runLoop(ready.origin, headers, work, node);
    const agents = await request(`${ready.origin}/api/core/agents?project=default`, { headers: { "sec-fetch-site": "same-origin" } });
    const listed = agents.json?.result?.agents ?? [];
    if (!listed.some((a) => a.name === "Release check agent" && a.role === "main")) throw new Error("The app does not list the agent that checked in.");
    child.stdin.end();
    const stopped = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))]);
    if (!stopped) throw new Error("The service did not stop when its stdin closed.");
    return { ok: true, target: manifest.target, node: manifest.node.version, origin: ready.origin, launchLink: true, refusedWithoutTheWindow: { before, after }, agent: { skillAcceptsLine: agent.skillAcceptsLine, usesBundledNode: agent.registered.usesLineNode, checkedInAs: agent.checkedInAs, skillInstalled: agent.skillInstalled }, appListsAgent: true, loop, stoppedWithStdin: true };
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
