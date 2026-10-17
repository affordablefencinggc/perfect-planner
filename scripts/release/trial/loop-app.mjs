// Runs the whole loop THROUGH THE INSTALLED WINDOW of a Perfect Planner build, the way a person does:
// open a git folder, start its history, plan and approve, connect an agent, start a worker, then the
// worker (a SCRIPTED STAND-IN, not an AI agent: a real MCP session on the app's own Node, started from the app's own set-up command) proposes a
// test and builds, and the person approves the test, checks, reads and approves the diff, and merges.
//
//   node scripts/release/trial/loop-app.mjs --app <installed binary> --repo <git folder, one commit>
//        --out <dir> [--label nsis] [--attach 127.0.0.1:9222] [--driver http://127.0.0.1:4444]
//
// Each step is recorded as pass/fail with what was seen (checks.jsonl, same shape as smoke-app.mjs) and
// a screenshot is taken at every step. A failed step stops the loop (the later steps depend on it).
// Window actions only: nothing here calls the service API except to read what the window already shows.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkAgentConnect, fakeClaude } from "../check-agent-connect.mjs";
import { mcpWorker } from "../check-desktop-host.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const { app, repo } = args;
const out = args.out || "loop-out";
const label = args.label || process.platform;
const driverUrl = args.driver || "http://127.0.0.1:4444";
if (!app || !repo) throw new Error("--app and --repo are required");
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const record = (name, pass, seen) => {
  checks.push({ name, pass, seen });
  appendFileSync(path.join(out, "checks.jsonl"), `${JSON.stringify({ label, name, pass, seen })}\n`);
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${seen}`);
};

async function wd(method, route, body, timeoutMs = 60_000) {
  const response = await fetch(`${driverUrl}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${JSON.stringify(json.value ?? json).slice(0, 300)}`);
  return json.value;
}

let session;
const run = (script, ...scriptArgs) => wd("POST", `/session/${session}/execute/sync`, { script, args: scriptArgs });
const text = () => run("return document.body ? document.body.innerText : ''").catch(() => "");
let shots = 0;
async function shot(name) {
  try {
    const png = await wd("GET", `/session/${session}/screenshot`);
    writeFileSync(path.join(out, `${label}-loop-${String(++shots).padStart(2, "0")}-${name}.png`), Buffer.from(png, "base64"));
  } catch (error) {
    console.log(`screenshot ${name} failed: ${error.message}`);
  }
}
async function waitFor(predicate, timeoutMs = 30_000, stepMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch (error) { last = error; }
    await sleep(stepMs);
  }
  return false;
}
const waitText = (needle, timeoutMs) => waitFor(async () => (await text()).includes(needle), timeoutMs);

// Window actions. A control is found by its visible text or aria-label, optionally inside one region.
const clickIn = (scope, needle) => run(
  `const [scope, needle] = arguments;
   const root = scope ? [...document.querySelectorAll(scope)].find((e) => e.offsetParent !== null) : document;
   if (!root) return "no region";
   const b = [...root.querySelectorAll("button, [role=tab], a, [role=button]")].find((e) => e.offsetParent !== null && !e.disabled && ((e.innerText || "") + " " + (e.getAttribute("aria-label") || "")).includes(needle));
   if (!b) return "no control";
   b.click(); return "clicked";`, scope, needle);
const click = async (needle, scope = "") => { const r = await clickIn(scope, needle); if (r !== "clicked") throw new Error(`${r}: "${needle}"${scope ? ` in ${scope}` : ""}`); };
const setValue = async (labelText, value, scope = "") => {
  const r = await run(
    `const [scope, l, v] = arguments;
     const root = scope ? [...document.querySelectorAll(scope)].find((e) => e.offsetParent !== null) : document;
     if (!root) return "no region";
     const el = [...root.querySelectorAll("input, textarea")].find((e) => e.getAttribute("aria-label") === l || (e.labels && [...e.labels].some((x) => x.innerText.trim().startsWith(l))));
     if (!el) return "no field";
     const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
     Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
     el.dispatchEvent(new Event("input", { bubbles: true })); return "set";`, scope, labelText, value);
  if (r !== "set") throw new Error(`${r}: "${labelText}"`);
};
const pressEscape = () => wd("POST", `/session/${session}/actions`, { actions: [{ type: "key", id: "kbd", actions: [{ type: "keyDown", value: "\uE00C" }, { type: "keyUp", value: "\uE00C" }] }] }).catch(() => {});
const task = (id) => `article[aria-label^="${id} "]`;
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=Trial worker", "-c", "user.email=worker@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();

/** Runs one step: records pass/fail and a screenshot; a throw is a failure and stops the loop. */
async function step(name, fn) {
  try {
    const seen = await fn();
    record(name, true, String(seen ?? "ok").slice(0, 300));
    await shot(name.replace(/\W+/g, "-").toLowerCase());
    return true;
  } catch (error) {
    const alerts = await run(`return [...document.querySelectorAll("[role=alert], [class*=error], [class*=warn]")].filter((e) => e.offsetParent !== null).map((e) => (e.innerText || "").trim()).filter(Boolean).slice(0, 3).join(" | ")`).catch(() => "");
    const buttons = await run(`return [...document.querySelectorAll("button")].filter((e) => e.offsetParent !== null).map((e) => (e.innerText || e.getAttribute("aria-label") || "").trim().slice(0, 28)).filter(Boolean).slice(0, 40).join(" | ")`).catch(() => "");
    const size = await run(`return innerWidth + "x" + innerHeight`).catch(() => "?");
    record(name, false, `${error.message}${alerts ? ` Window says: ${alerts}` : ""} [window ${size}; visible buttons: ${buttons}]`.slice(0, 900));
    await shot(`failed-${name.replace(/\W+/g, "-").toLowerCase()}`);
    return false;
  }
}

/** The Set-up command the window shows for a worker, run as copied with a `claude` stand-in; returns the MCP server it registers. */
function registerWorker(line) {
  const dir = mkdtempSync(path.join(tmpdir(), "pp-loop-worker-"));
  const record_ = path.join(dir, "claude-calls.jsonl");
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  fakeClaude(bin, record_);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const env = { ...process.env, HOME: home, USERPROFILE: home, [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ""}` };
  delete env.NODE_OPTIONS;
  try {
    const ran = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", line], { env, encoding: "utf8", timeout: 60_000 })
      : spawnSync("/bin/sh", ["-c", line], { env, encoding: "utf8", timeout: 60_000 });
    if (ran.status !== 0) throw new Error(`The set-up command failed (${ran.status}): ${String(ran.stderr).slice(0, 300)}`);
    const add = readFileSync(record_, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((a) => a[0] === "mcp" && a[1] === "add");
    if (!add) throw new Error("The set-up command did not register an MCP server.");
    const sep = add.indexOf("--");
    const [command, ...serverArgs] = add.slice(sep + 1);
    const serverEnv = {};
    for (let i = 0; i < sep; i++) if (add[i] === "--env") { const [k, ...v] = add[i + 1].split("="); serverEnv[k] = v.join("="); }
    return { command, args: serverArgs, env: { ...env, ...serverEnv } };
  } finally {
    // The registration (and its home) is only needed to read the server; the worker runs below.
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 120_000).unref();
  }
}

const capabilities = args.attach
  ? { browserName: "MicrosoftEdge", "ms:edgeOptions": { debuggerAddress: args.attach } }
  : { browserName: "wry", "tauri:options": { application: app } };

let worker;
async function main() {
  const created = await wd("POST", "/session", { capabilities: { alwaysMatch: capabilities } }, 120_000);
  session = created.sessionId;
  if (args.size) { const [width, height] = args.size.split("x").map(Number); await wd("POST", `/session/${session}/window/rect`, { width, height }).catch(() => {}); }
  if (!(await waitText("Connect agent", 90_000))) throw new Error("The installed window never showed the app (Connect agent).");
  const folder = path.resolve(repo);
  const task1 = "T-1";
  const world = {};

  let ok = true;

  if (ok) ok = await step("plan: idea and recommended answers", async () => {
    await click("01Define"); await click("Deep planning");
    if (!(await waitFor(async () => /Start a new history for this folder|Your idea/.test(await text()), 20_000))) throw new Error("Deep planning showed no idea box.");
    if ((await text()).includes("Start a new history for this folder")) {
      await click("Start a new history for this folder");
      if (!(await waitFor(async () => !(await text()).includes("Start a new history for this folder"), 20_000))) throw new Error("The history did not start.");
    }
    if (!(await waitText("Your idea", 20_000))) throw new Error("No idea box.");
    await setValue("Your idea", "Notes helper: a small tool that saves a person's notes to a local file. One person, one laptop, no accounts, no cloud.");
    await click("Start planning");
    if (!(await waitFor(async () => /questions\s+answered|No blocking questions are open/.test(await text()), 90_000))) throw new Error("Planning showed no questions within 90 s.");
    let clicks = 0;
    for (let i = 0; i < 120; i++) {
      if ((await text()).includes("No blocking questions are open")) break;
      const r = await clickIn("", "Use recommendation");
      if (r !== "clicked") { await sleep(500); continue; }
      clicks += 1;
      await sleep(900);
    }
    if (!(await text()).includes("No blocking questions are open")) throw new Error(`Blocking questions are still open after ${clicks} recommendations.`);
    return `${clicks} recommendations used; no blocking questions`;
  });

  if (ok) ok = await step("plan: approve", async () => {
    await click("Approve plan");
    if (!(await waitText("Plan approved", 30_000))) throw new Error(`The plan was not approved. Page: ${(await text()).slice(0, 200)}`);
    return "Plan approved";
  });

  if (ok) ok = await step("open git folder in Tasks", async () => {
    await click("03Build"); await click("Tasks");
    if (!(await waitText("Choose your project's git folder", 20_000))) throw new Error("Tasks showed no git folder form.");
    await setValue("Git folder", folder);
    await click("Use this folder");
    if (!(await waitFor(async () => /No tasks yet|Workers branch from/.test(await text()), 20_000))) throw new Error("The folder was not accepted.");
    return (await text()).split("\n").find((l) => /Workers branch from|No tasks yet/.test(l));
  });

  if (ok) ok = await step("connect agent: line runs as copied, agent checks in", async () => {
    await click("Connect agent");
    if (!(await waitFor(() => run(`return document.querySelector(".core-screen-connect button.primary") !== null`), 20_000))) throw new Error("The Connect agent drawer did not open.");
    await click("Connect agent", ".core-screen-connect");
    const line = await waitFor(() => run(`return document.querySelector("[data-connect-command]")?.innerText?.trim() || ""`), 30_000);
    if (!line) throw new Error("No connect line appeared.");
    const result = await checkAgentConnect(line);
    world.connect = result;
    await pressEscape();
    if (!(await waitFor(() => run(`return document.querySelector(".core-screen-connect") === null`), 10_000))) throw new Error("Connect agent drawer stayed open after Escape.");
    return `checked in as ${result.checkedInAs}; line on the app's own Node`;
  });

  if (ok) ok = await step("start worker on T-1 (window gives the set-up command)", async () => {
    await click("03Build"); await click("Tasks");
    if (!(await waitFor(async () => (await run(`return document.querySelector(${JSON.stringify(task(task1))}) !== null`)), 20_000))) throw new Error("T-1 is not on the board.");
    await setValue("Worker model", "claude-trial", task(task1));
    await click("Start worker", task(task1));
    const setup = await waitFor(() => run(`return document.querySelector('[aria-label="Set-up command for T-1"]')?.innerText?.trim() || ""`), 30_000);
    if (!setup) throw new Error("No set-up command for T-1.");
    world.setup = setup;
    return `set-up command shown (${setup.length} chars, private key not logged)`;
  });

  if (ok) ok = await step("stand-in worker checks in over MCP and proposes a test", async () => {
    const worktree = path.join(folder, ".perfect-planner", "worktrees", task1);
    if (!existsSync(worktree)) throw new Error(`The window started a worker but its folder does not exist: ${worktree}. Worktrees now: ${git(folder, "worktree", "list").replace(/\n/g, "; ")}`);
    const server = registerWorker(world.setup);
    world.worktree = worktree;
    worker = mcpWorker(server, worktree);
    await worker.start();
    const hello = await worker.tool("hello", { name: "Trial worker", model: "claude-trial" });
    if (hello.role !== "worker" || hello.task !== task1) throw new Error(`Checked in as ${hello.role} on ${hello.task}.`);
    world.agent = hello.agent;
    mkdirSync(path.join(worktree, "tests"), { recursive: true });
    writeFileSync(path.join(worktree, "tests", "notes.check.mjs"), 'import { existsSync } from "node:fs";\nif (!existsSync("src/notes.mjs")) { console.error("src/notes.mjs does not exist yet"); process.exit(1); }\nconsole.log("notes are saved");\n');
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "Test: notes are saved");
    await worker.tool("propose_test", { task: task1, command: "node tests/notes.check.mjs", files: ["tests/notes.check.mjs"], agent: hello.agent });
    if (!(await waitText("Test to approve", 30_000))) throw new Error("The window never showed the proposed test.");
    return `${hello.agent} checked in as worker on ${task1}; window shows "Test to approve"`;
  });

  if (ok) ok = await step("approve test in the window (it fails first)", async () => {
    await click("Approve test", task(task1));
    if (!(await waitFor(async () => !/Test to approve/.test(await run(`return document.querySelector(${JSON.stringify(task(task1))})?.innerText || ""`)), 60_000))) throw new Error("The test stayed unapproved.");
    return (await run(`return (document.querySelector(${JSON.stringify(task(task1))})?.innerText || "").split("\\n").slice(0, 6).join(" | ")`));
  });

  if (ok) ok = await step("stand-in worker builds, commits, attaches proof", async () => {
    await worker.tool("claim_task", { task: task1, agent: world.agent });
    mkdirSync(path.join(world.worktree, "src"), { recursive: true });
    writeFileSync(path.join(world.worktree, "src", "notes.mjs"), 'import { writeFileSync } from "node:fs";\n\nexport const saveNotes = (file, notes) => writeFileSync(file, JSON.stringify(notes));\n');
    git(world.worktree, "add", "-A");
    git(world.worktree, "commit", "-q", "-m", "Save notes to a local file");
    world.head = git(world.worktree, "rev-parse", "HEAD");
    await worker.tool("attach_proof", { task: task1, kind: "commit", link: world.head, agent: world.agent });
    worker.stop(); worker = null;
    return `proof attached at ${world.head.slice(0, 12)}`;
  });

  if (ok) ok = await step("check the work in the window", async () => {
    // The window follows the worker's claim on its own; if it has not yet, the Tasks tab refreshes it.
    if (!(await waitFor(async () => (await clickIn(task(task1), "Check the work")) === "clicked", 20_000))) {
      await click("02Coordinate"); await click("03Build"); await click("Tasks");
      await click("Check the work", task(task1));
    }
    if (!(await waitFor(async () => /Ready to merge|Check passed|passed/i.test(await run(`return document.querySelector(${JSON.stringify(task(task1))})?.innerText || ""`)), 120_000))) throw new Error(`The check did not pass: ${(await run(`return (document.querySelector(${JSON.stringify(task(task1))})?.innerText || "").slice(0, 300)`))}`);
    return "check passed";
  });

  if (ok) ok = await step("read the diff and approve it", async () => {
    await click("Show diff", task(task1));
    if (!(await waitFor(async () => /Approve diff at/.test(await run(`return document.querySelector(${JSON.stringify(task(task1))})?.innerText || ""`)), 30_000))) throw new Error("No diff approval control appeared.");
    // The diff holds a test file that runs code on this computer, so the window asks for a confirmation.
    await run(`const a = document.querySelector(${JSON.stringify(task(task1))}); const box = a.querySelector('[role=alert] input[type=checkbox]'); if (box && !box.checked) box.click(); return !!box;`);
    await sleep(400);
    await click("Approve diff at", task(task1));
    return "diff approved";
  });

  if (ok) ok = await step("merge into main", async () => {
    if (!(await waitFor(async () => (await clickIn(task(task1), "Merge into")) === "clicked", 40_000))) throw new Error(`No merge button after approving the diff. Task says: ${(await run(`return (document.querySelector(${JSON.stringify(task(task1))})?.innerText || "").slice(0, 300)`))}`);
    const merged = await waitFor(() => {
      try { return execFileSync("git", ["show", "main:src/notes.mjs"], { cwd: folder, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).includes("saveNotes"); } catch { return false; }
    }, 60_000, 1000);
    if (!merged) throw new Error(`main does not hold src/notes.mjs. Window says: ${(await run(`return (document.querySelector(${JSON.stringify(task(task1))})?.innerText || "").slice(0, 200)`))}`);
    await waitFor(async () => /Merged|Done(?!-when)/.test(await run(`return document.querySelector(${JSON.stringify(task(task1))})?.innerText || ""`)), 20_000);
    return `main now holds src/notes.mjs (${git(folder, "log", "--oneline", "-1", "main")})`;
  });
}

try {
  await main();
} catch (error) {
  record("loop crashed", false, error.message.slice(0, 400));
} finally {
  worker?.stop();
  if (args.attach) await wd("DELETE", `/session/${session}`).catch(() => {});
  else if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  writeFileSync(path.join(out, `${label}-loop-result.json`), JSON.stringify({ label, checks }, null, 2));
}
process.exit(checks.some((c) => !c.pass) ? 1 : 0);
