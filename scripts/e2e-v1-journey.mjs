#!/usr/bin/env node
// End-to-end v1 journey: drives the production build in headless system Chrome (or Edge)
// over the DevTools protocol, with no test-framework dependency.
//
//   npm run test:e2e            (builds dist/client first when it is missing or out of date)
//   PP_E2E_BROWSER=<path>       use another Chromium-based browser
//   PP_E2E_PEEK_AFTER=<step> PP_E2E_PEEK=<workspace>   debugging: print a workspace's text after a step
//
// This journey runs the release build, where the folder picker cannot be automated. To test intake
// itself, use the dev server or a PP_TEST_INTAKE=1 build: queue a folder with
// window.__ppTestIntake.queueFolder(manifest from scripts/folder-manifest.mjs) and click
// "Choose app folder" (see src/browser/scriptedIntake.js). Here the imported project is seeded with the app's
// own APIs: the project session comes from createImportedProjectSession + the project
// registry, and the saved architecture, folder and component records are published to an
// isolated save folder with the same Node stores the local server uses. Everything after
// that is done by clicking and typing in the real UI. Screenshots go to tests-e2e/screenshots/.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createImportedProjectSession } from "../src/project/projectSession.js";
import { createMemoryStorage, createProjectRegistry, DEFAULT_PROJECT_REGISTRY_KEY } from "../src/project/projectRegistry.js";
import { createImportedProjectId } from "../src/project/projectIds.js";
import { currentComponentPlanInput } from "../src/engine/componentPlanSeed.js";
import { publishComponentPlans } from "../src/node/componentPlanStore.mjs";
import { bindComponentParents } from "../tests/fixtures/componentParents.mjs";
import { clientBuildIsCurrent } from "./serve-local.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(projectRoot, "tests-e2e", "screenshots");
const STEP_TIMEOUT = Number(process.env.PP_E2E_TIMEOUT ?? 20000);
const BROWSERS = [
  process.env.PP_E2E_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[e2e]", ...args);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function waitFor(check, { timeout = STEP_TIMEOUT, interval = 150, label = "condition" } = {}) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? ` (${last.message})` : ""}`);
}

// ---------- DevTools protocol ----------
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = new Set(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error("DevTools socket failed")); });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id); this.pending.delete(message.id);
        message.error ? reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ""}`)) : resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch { /* closing */ } }
}

class Page {
  constructor(cdp, sessionId) { this.cdp = cdp; this.sessionId = sessionId; this.errors = []; this.loads = 0;
    cdp.listeners.add((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.exceptionThrown") this.errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
      if (message.method === "Page.loadEventFired") this.loads++;
    });
  }
  send(method, params) { return this.cdp.send(method, params, this.sessionId); }
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  // Runs fn(helpers, ...args) in the page; helpers locate elements by accessible text.
  async run(fn, ...args) { return this.eval(`(${fn})(${HELPERS}, ...${JSON.stringify(args)})`); }
  async goto(url) {
    const before = this.loads;
    await this.send("Page.navigate", { url });
    await waitFor(() => this.loads > before, { label: `load of ${url}` });
    await this.settle();
  }
  async reload() { const before = this.loads; await this.send("Page.reload", {}); await waitFor(() => this.loads > before, { label: "reload" }); await this.settle(); }
  async settle(ms = 400) { await sleep(ms); }
  async text() { return this.eval("document.body.innerText"); }
  async expectText(pattern, label = String(pattern)) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(escape(pattern));
    return waitFor(async () => regex.test(await this.text()), { label: `text ${label}` });
  }
  // Locates an element in the page and clicks its centre with real mouse events.
  async click(locator, label = JSON.stringify(locator)) {
    const box = await waitFor(() => this.run((h, loc) => {
      const el = h.find(loc); if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, locator), { label: `clickable ${label}` });
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    await this.settle(250);
  }
  // Focuses a field and types into it with real key/text input.
  async type(locator, text, { clear = true } = {}) {
    await waitFor(() => this.run((h, loc, clearIt) => {
      const el = h.find(loc); if (!el || el.disabled) return false;
      el.scrollIntoView({ block: "center" }); el.focus();
      if (clearIt && "value" in el && el.value) { el.select?.(); }
      return document.activeElement === el;
    }, locator, clear), { label: `field ${JSON.stringify(locator)}` });
    if (clear) await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }).then(() => this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }));
    await this.send("Input.insertText", { text });
    await this.settle(150);
  }
  // Chooses an option in a native <select> the way a user's choice reaches React.
  async select(locator, optionText) {
    await waitFor(() => this.run((h, loc, wanted) => {
      const el = h.find(loc); if (!el || el.tagName !== "SELECT" || el.disabled) return false;
      const option = [...el.options].find((o) => o.value === wanted || h.norm(o.textContent) === wanted || h.norm(o.textContent).includes(wanted));
      if (!option) return false;
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, option.value);
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, locator, optionText), { label: `option ${optionText}` });
    await this.settle(200);
  }
  // Puts a real file into an <input type="file"> the way a file chooser would.
  async setFiles(css, files) {
    await waitFor(() => this.eval(`Boolean(document.querySelector(${JSON.stringify(css)}))`), { label: `file input ${css}` });
    const { result } = await this.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(css)})` });
    await this.send("DOM.setFileInputFiles", { objectId: result.objectId, files });
    await this.settle(300);
  }
  async screenshot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(SHOTS, `${name}.png`); await writeFile(file, Buffer.from(data, "base64")); return file;
  }
}

// Element lookup inside the page. A locator is { role?, name?, text?, label?, css?, within? }.
const HELPERS = `(() => {
  const norm = (s) => String(s ?? "").replace(/\\s+/g, " ").trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const roleOf = (el) => el.getAttribute("role") || ({ BUTTON: "button", A: "link", SELECT: "combobox", TEXTAREA: "textbox", ARTICLE: "article", LI: "listitem", SECTION: "region", H1: "heading", H2: "heading", H3: "heading" })[el.tagName] || (el.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button" })[el.type] || "textbox" : "");
  const labelText = (el) => {
    const parts = [];
    if (el.getAttribute("aria-label")) return norm(el.getAttribute("aria-label"));
    const by = el.getAttribute("aria-labelledby"); if (by) parts.push(by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
    if (el.id) for (const l of document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]')) parts.push(l.textContent);
    const wrap = el.closest("label"); if (wrap) parts.push(wrap.textContent);
    if (el.placeholder) parts.push(el.placeholder);
    return norm(parts.join(" "));
  };
  const nameOf = (el) => norm(el.getAttribute("aria-label") || labelText(el) || el.textContent || el.value || el.title);
  const match = (value, wanted) => wanted instanceof Object && wanted.re ? new RegExp(wanted.re, wanted.flags || "").test(value) : value === wanted || (typeof wanted === "string" && wanted.startsWith("~") && value.toLowerCase().includes(wanted.slice(1).toLowerCase()));
  const scope = (loc) => loc.within ? findAll(loc.within)[0] ?? null : document;
  function findAll(loc) {
    const root = scope(loc); if (!root) return [];
    let nodes = [...root.querySelectorAll(loc.css || "*")].filter(visible);
    if (loc.role) nodes = nodes.filter((el) => roleOf(el) === loc.role);
    if (loc.name !== undefined) nodes = nodes.filter((el) => match(nameOf(el), loc.name));
    if (loc.label !== undefined) nodes = nodes.filter((el) => ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && match(labelText(el), loc.label));
    if (loc.text !== undefined) nodes = nodes.filter((el) => match(norm(el.textContent), loc.text));
    return loc.last ? nodes.reverse() : nodes;
  }
  return { norm, find: (loc) => findAll(loc)[loc.index ?? 0] ?? null, findAll, nameOf, labelText };
})()`;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = (source, flags = "i") => ({ re: source, flags });

// ---------- environment ----------
async function launchBrowser(executable) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "pp-e2e-profile-"));
  const child = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu", "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  const [port] = (await waitFor(async () => existsSync(portFile) && (await readFile(portFile, "utf8")).split(/\r?\n/), { label: "DevTools port" }));
  const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), { label: "DevTools endpoint" });
  const cdp = new Cdp(version.webSocketDebuggerUrl); await cdp.open();
  const close = async () => { cdp.close(); child.kill(); await sleep(500); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}); };
  return { cdp, close };
}

async function openPage(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  await page.send("Page.enable"); await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  return page;
}

async function startServer(appData, launchFolder) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(projectRoot, "scripts", "serve-local.mjs")], { cwd: projectRoot, env: { ...process.env, LOCALAPPDATA: appData, PORT: String(port), PP_OPEN: "0", PP_FOLDER: launchFolder }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; });
  const url = await waitFor(() => output.match(/running at (http:\/\/\S+)/)?.[1], { label: `server start (${output.trim()})` });
  return { url: url.endsWith("/") ? url : `${url}/`, stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill(); setTimeout(resolve, 2000); }), output: () => output };
}

// ---------- seed ----------
const AT = new Date().toISOString();
const ROOT_IDENTITY = "e2e0".repeat(16);
const CENSUS_DIGEST = "c3".repeat(32);

async function seedAuthorities(authorityRoot, projectId) {
  // Same parents the store tests publish, bound to this project's id.
  const seed = structuredClone(currentComponentPlanInput); seed.planId = projectId;
  seed.components = seed.components.slice(0, 2).map((component) => ({ ...component, dependencies: [], fileClaims: component.fileClaims.map((file) => ({ ...file, access: "read" })) }));
  seed.inventory = seed.inventory.slice(0, 2);
  const input = await bindComponentParents(authorityRoot, seed);
  await publishComponentPlans(authorityRoot, input, { planId: projectId, expectedRevision: 0, expectedHeadDigest: "GENESIS" }, { actor: "e2e-owner", timestamp: AT });
}

function seedRegistryValue() {
  const session = createImportedProjectSession({
    name: "E2E Notes App",
    adapter: "native",
    now: AT,
    registration: { access: "metadata-read-only", canonicalRoot: "C:\\e2e\\notes-app", registryRevision: 1, rootIdentity: ROOT_IDENTITY, workspaceId: "e2e-notes" },
    census: { digest: CENSUS_DIGEST, fileCount: 12, generatedEpochMs: Date.parse(AT), registryRevision: 1, rootIdentity: ROOT_IDENTITY, skipped: [], totalBytesHashed: 4096, workspaceId: "e2e-notes" },
    discovery: {
      state: "generated", generatedAt: AT, counts: { observed: 6, signals: 1, unanswered: 1 },
      categories: [
        ...Array.from({ length: 6 }, (_, index) => ({ id: `A0${index + 1}`, state: "observed", findings: [{ id: `S00${index + 1}` }] })),
        { id: "A07", state: "signal", findings: [{ id: "S013" }] },
        { id: "A08", state: "unanswered", findings: [] },
      ],
    },
  });
  const storage = createMemoryStorage();
  const registry = createProjectRegistry({ storage });
  registry.upsert(session);
  return { projectId: session.projectId, value: storage.getItem(DEFAULT_PROJECT_REGISTRY_KEY) };
}

// ---------- journey ----------
async function main() {
  const executable = BROWSERS.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("No Chrome or Edge executable found. Set PP_E2E_BROWSER.");
  if (!(await clientBuildIsCurrent())) {
    log("dist/client is missing or older than its sources; building it first");
    await new Promise((resolve, reject) => spawn(process.execPath, [path.join(projectRoot, "node_modules", "vite", "bin", "vite.js"), "build"], { cwd: projectRoot, stdio: "inherit" })
      .on("error", reject).on("exit", (code) => code === 0 ? resolve() : reject(new Error(`vite build exited with ${code}`))));
  }
  await rm(SHOTS, { recursive: true, force: true }); await mkdir(SHOTS, { recursive: true });

  const appData = await mkdtemp(path.join(os.tmpdir(), "pp-e2e-appdata-"));
  const authorityRoot = path.join(appData, "PerfectPlannerCleanroom", "authority");
  const projectId = createImportedProjectId(ROOT_IDENTITY);
  await mkdir(authorityRoot, { recursive: true });
  await seedAuthorities(authorityRoot, projectId);
  const seeded = seedRegistryValue();
  if (seeded.projectId !== projectId) throw new Error("Seeded project id mismatch.");

  // A tiny app folder the server offers for the one-click scan (the picker itself cannot be automated).
  const launchFolder = path.join(appData, "notes-app");
  await mkdir(path.join(launchFolder, "src"), { recursive: true });
  await writeFile(path.join(launchFolder, "package.json"), JSON.stringify({ name: "notes-app", private: true }));
  await writeFile(path.join(launchFolder, "README.md"), "# Notes app\n");
  await writeFile(path.join(launchFolder, "src", "main.js"), "export const notes = [];\n");
  const server = await startServer(appData, launchFolder);
  log(`server ${server.url} using ${executable}`);
  const browser = await launchBrowser(executable);
  const steps = []; let failure = null;
  const page = await openPage(browser.cdp);
  const at = (workspace) => `${server.url}?project=${projectId}&workspace=${workspace}`;
  const step = async (name, body) => {
    const started = Date.now();
    try { await body(); const shot = await page.screenshot(`${String(steps.length + 1).padStart(2, "0")}-${name}`); steps.push({ name, ok: true, ms: Date.now() - started, shot }); log(`PASS ${name}`); if (process.env.PP_E2E_PEEK_AFTER === name) await peek(page, at); }
    catch (error) {
      const shot = await page.screenshot(`${String(steps.length + 1).padStart(2, "0")}-${name}-FAILED`).catch(() => null);
      await writeFile(path.join(SHOTS, `${name}-FAILED.txt`), await page.text().catch(() => "")).catch(() => {});
      steps.push({ name, ok: false, ms: Date.now() - started, shot, error: error.message }); log(`FAIL ${name}: ${error.message}`); throw error;
    }
  };

  try {
    await step("seed-imported-project", async () => {
      await page.goto(server.url);
      await page.eval(`localStorage.setItem(${JSON.stringify(DEFAULT_PROJECT_REGISTRY_KEY)}, ${JSON.stringify(seeded.value)}); true`);
      await page.goto(at("home"));
      await page.expectText("E2E Notes App");
    });
    await journey(page, at, step);
    await step("launch-folder-scan", async () => {
      await page.goto(at("structure"));
      await page.click({ role: "button", name: re("^Use launch folder · notes-app") });
      await page.click({ role: "button", name: "Approve read-only scan" });
      await page.expectText("3 files indexed");
      await page.expectText(/notes-app/);
    });
  } catch (error) { failure = error; }
  finally {
    if (page.errors.length) log(`page errors:\n  ${page.errors.join("\n  ")}`);
    await browser.close(); await server.stop();
    await rm(appData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
  const passed = steps.filter((s) => s.ok).length;
  console.log(`\n[e2e] ${failure ? "FAILED" : "PASSED"}: ${passed}/${steps.length} steps`);
  for (const s of steps) console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.name} (${s.ms} ms) ${path.relative(projectRoot, s.shot ?? "")}${s.error ? `\n       ${s.error}` : ""}`);
  if (failure) { console.error(failure.stack); process.exitCode = 1; }
}

const TASKS = [
  { title: "Add note editor", description: "Rich text editor for a single note.", owner: "Ana", acceptance: "A note can be edited and saved.", recovery: "Revert the editor commit.", scope: ["write src/notes/editor.js", "read package.json"].join(String.fromCharCode(10)) },
  { title: "Note storage", description: "Persist notes on this device.", owner: "Bo", acceptance: "Notes survive a reload.", recovery: "Restore the previous store module.", scope: ["write src/notes", "read package.json"].join(String.fromCharCode(10)) },
];

async function peek(page, at) {
  const workspace = process.env.PP_E2E_PEEK; if (!workspace) return;
  await page.goto(at(workspace)); await page.settle(1500); console.log(await page.text()); await page.screenshot("peek");
  if (process.env.PP_E2E_EVAL) console.log("EVAL", JSON.stringify(await page.eval(process.env.PP_E2E_EVAL), null, 1));
  throw new Error(`peek ${workspace} done`);
}

async function journey(page, at, step) {
  await step("structure-discovery-review", async () => {
    await page.goto(at("structure"));
    await page.expectText("Review what we found");
    const rows = await page.run((h) => h.findAll({ css: "li.discovery-review-row" }).map((el) => el.getAttribute("aria-label")));
    if (rows.length < 2) throw new Error(`expected discovery rows, saw ${rows.length}`);
    for (const name of rows) await page.click({ role: "button", name: re("^Looks right"), within: { css: "li.discovery-review-row", name } }, `Looks right in ${name}`);
    await page.expectText(/All \d+ areas? that needed a look have your answer/);
  });

  await step("ledger-add-two-overlapping-tasks", async () => {
    await page.goto(at("ledger"));
    await page.expectText("No task drafts yet");
    for (const task of TASKS) {
      await page.type({ label: "~Task title" }, task.title);
      await page.type({ label: "~Full description" }, task.description);
      await page.type({ label: "~Proposed owner" }, task.owner);
      await page.type({ label: "~Acceptance criteria" }, task.acceptance);
      await page.type({ label: "~Recovery plan" }, task.recovery);
      await page.type({ css: "textarea", label: "~File scope" }, task.scope);
      await page.click({ role: "button", name: "Save task draft" });
      await page.expectText(task.title);
    }
    await page.expectText(/2 tasks/);
  });

  await step("plan-approve", async () => {
    await page.goto(at("plan"));
    await page.expectText("Approve this plan");
    await page.click({ role: "button", name: "Approve this plan" });
    await page.expectText(/2 tasks approved on this device/);
  });

  await step("collision-evaluate-and-resolve", async () => {
    await page.goto(at("collision"));
    await page.click({ role: "button", name: re("^Check tasks now") });
    const card = { role: "article", name: "T0001 and T0002 overlap" };
    await page.expectText(/2 tasks checked · 1 overlap/);
    await page.select({ css: "select", label: "~Decision", within: card }, "first:T0001");
    await page.click({ role: "button", name: "Mark resolved", within: card });
    await page.expectText(/Decided: Do T0001 · Add note editor first/);
  });

  await step("allocation-assign-owners", async () => {
    await page.goto(at("allocation"));
    await page.expectText("Owners and order");
    await page.type({ label: "Owner for T0001" }, "Ana");
    await page.type({ label: "Owner for T0002" }, "agent: builder");
    await page.click({ role: "button", name: "Use suggested waves" });
    await page.click({ role: "button", name: "Save assignments" });
    await page.expectText(/Saved\. Every task has an owner|Saved\./);
    const waves = await page.run((h) => [h.find({ label: "Wave for T0001" })?.value, h.find({ label: "Wave for T0002" })?.value]);
    if (waves[0] !== "1" || waves[1] !== "2") throw new Error(`waves should follow the collision decision, saw ${waves}`);
  });

  await step("build-mark-done", async () => {
    await page.goto(at("build"));
    await page.expectText(/0 of 2 done/);
    const board = await page.text();
    if (/Unresolved overlap/.test(board)) throw new Error("Build board still reports the decided overlap as unresolved");
    for (const id of ["T0001", "T0002"]) {
      await page.select({ label: `Status for ${id}` }, "done");
      await page.type({ label: `Note for ${id}` }, `${id} finished in the e2e journey`);
      await page.click({ role: "button", name: "Save status", within: { role: "article", name: re(`^${id} `) } });
    }
    await page.expectText(/2 of 2 done/);
  });

  await step("evidence-add-proof-per-task", async () => {
    await page.goto(at("evidence"));
    await page.expectText("Proof for each task");
    // A real screenshot from earlier in this run is the screenshot proof.
    const image = path.join(SHOTS, (await readdir(SHOTS)).find((name) => name.endsWith("-build-mark-done.png")));
    for (const id of ["T0001", "T0002"]) {
      const form = { css: "form", name: `Add proof to ${id}` };
      const open = async (kind) => {
        await page.click({ role: "button", name: `Add proof to ${id}`, css: "button" });
        await page.select({ css: "select", label: "What are you adding?", within: form }, kind);
      };
      await open("screenshot");
      await page.setFiles(`#proof-${id}-file`, [image]);
      await waitFor(() => page.run((h, f) => Boolean(h.find(f)?.querySelector("img.proof-preview")), form), { label: `screenshot preview for ${id}` });
      await page.type({ label: "Added by", within: form }, "Ana");
      await page.click({ role: "button", name: "Save proof", within: form });

      await open("diff");
      await page.click({ css: "label", text: "Paste text", within: form });
      await page.type({ css: "textarea", within: form }, `diff --git a/src/notes/x.js b/src/notes/x.js
+// ${id}`);
      await page.type({ label: "Added by", within: form }, "Ana");
      await page.click({ role: "button", name: "Save proof", within: form });

      await open("test");
      await page.type({ css: "textarea", within: form }, `${id}: 4 passed, 0 failed`);
      await page.click({ css: "label.proof-merged", within: form });
      await page.type({ label: "Added by", within: form }, "Ana");
      await page.click({ role: "button", name: "Save proof", within: form });
    }
    await page.expectText(/Complete\s*2/);
  });

  await step("integrity-sign-off", async () => {
    await page.goto(at("integrity"));
    await page.expectText("2 of 2 tasks have complete proof.");
    await page.expectText("1 of 1 conflict resolved");
    await page.expectText("2 of 2 tasks have an owner assigned in Allocation.");
    await page.type({ label: "Reviewer name" }, "Rae Reviewer");
    await page.click({ role: "button", name: "Sign off this plan version" });
    await page.expectText(/Signed off by Rae Reviewer|Rae Reviewer/);
    await page.expectText("Sign off again");
  });

  const homeAction = () => page.eval(`document.querySelector("[data-home-next-action]")?.dataset.homeNextAction ?? null`);
  await step("home-confirm-ready", async () => {
    await page.goto(at("home"));
    await waitFor(async () => (await homeAction()) === "confirm-project-ready", { label: "Home offering 'Confirm project is ready'" });
    await page.click({ css: "[data-home-next-action]" }, "Confirm project is ready");
    await page.expectText("Project status ready");
    if ((await homeAction()) !== "open-authoritative-plan") throw new Error(`Home next action is ${await homeAction()}`);
  });

  await step("reload-state-persists", async () => {
    await page.reload();
    await page.expectText("Project status ready");
    const checks = [
      [at("plan"), "2 tasks approved"],
      [at("collision"), "Decided: Do T0001 · Add note editor first"],
      [at("build"), "2 of 2 done"],
      [at("evidence"), /Complete\s*2/],
      [at("integrity"), "Rae Reviewer"],
    ];
    for (const [url, text] of checks) { await page.goto(url); await page.expectText(text); }
    const owner = await page.goto(at("allocation")).then(() => waitFor(() => page.run((h) => h.find({ label: "Owner for T0002" })?.value), { label: "saved owner" }));
    if (owner !== "agent: builder") throw new Error(`owner after reload: ${owner}`);
    await page.goto(at("home"));
    await page.expectText("Project status ready");
  });

  // Every page must agree with Home once the project is Ready (screen tour, 9 Oct 2026).
  await step("screens-agree-with-ready", async () => {
    await page.goto(at("build"));
    await page.expectText(/2 of 2 done/);
    const attached = (await page.text()).match(/Proof\s*3 attached/g) ?? [];
    if (attached.length !== 2) throw new Error(`Build cards should each show 3 proof items, saw ${attached.length} cards with proof`);
    await page.goto(at("index"));
    await page.expectText(/6\s*proof items/);
    await page.goto(at("plan"));
    await page.expectText(/Plan approved: 2 tasks approved on this device/);
    const map = await page.run((h) => h.findAll({ css: ".draft-map-node" }).map((el) => el.textContent));
    if (map.length !== 2 || map.some((text) => !/Approved/.test(text) || /Draft/.test(text))) throw new Error(`Plan map tasks should read Approved, saw ${JSON.stringify(map)}`);
    if (/could not be checked/.test(await page.text())) throw new Error("Plan still says the approval could not be checked");
    await page.goto(at("structure"));
    await page.expectText("NO FOLDER PLAN");
    const header = await page.eval(`document.querySelector(".structure-state")?.textContent ?? ""`);
    if (/BLOCKED|blockers/.test(header)) throw new Error(`Structure header says blocked on a Ready project: ${header}`);
  });
  await peek(page, at);
}

main().catch((error) => { console.error(error); process.exit(1); });
