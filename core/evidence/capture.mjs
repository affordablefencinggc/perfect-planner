// Fast screenshot capture over the Chrome DevTools Protocol, for evidence.
//   node core/evidence/capture.mjs --url "http://127.0.0.1:4173/#pp-launch=..." --out evidence/run1
//        [--plan plan.json] [--sizes desktop,tablet,phone] [--themes light,dark] [--parallel 4] [--allow-problems]
// One private Chrome, one browser context (so the launch link is claimed once and every page shares the
// session), N pages at once. Each shot also checks the page: console errors, failed requests, horizontal
// overflow, broken images, an empty page. Writes PNGs, sha256 per file and manifest.json.
// A capture is not proof until a person has looked at it: the manifest says viewingAttested: false.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchChrome } from "./cdp.mjs";

export const SIZES = {
  desktop: { width: 1440, height: 900, mobile: false, scale: 1 },
  tablet: { width: 820, height: 1180, mobile: true, scale: 2 },
  phone: { width: 390, height: 844, mobile: true, scale: 2 },
};

/** Every top-level page of the app, by its workspace name. */
export const DEFAULT_PLAN = [
  "home", "define", "structure", "planning", "tasks", "plan", "ledger", "collision", "allocation", "build",
  "integrity", "evidence", "release", "index", "people", "decisions", "mvp", "lookup", "settings",
].map((workspace) => ({ name: workspace, path: `/?workspace=${workspace}` }));

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Runs inside the page: what is wrong with how it looks right now. */
const PAGE_CHECKS = `(() => {
  const problems = [];
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1) {
    const wide = [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > root.clientWidth + 1 && getComputedStyle(el).position !== "fixed").slice(0, 3).map((el) => el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""));
    problems.push("sideways scroll: page is " + root.scrollWidth + " px wide in a " + root.clientWidth + " px window" + (wide.length ? " (" + wide.join(", ") + ")" : ""));
  }
  for (const img of document.images) if (img.complete && img.naturalWidth === 0 && img.src) problems.push("broken image: " + img.src.slice(0, 80));
  if ((document.body?.innerText ?? "").trim().length < 20) problems.push("the page is empty");
  return problems;
})()`;

async function waitForIdle(connection, session, { settleMs = 350, timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  let lastActivity = Date.now();
  let open = 0;
  const bump = () => { lastActivity = Date.now(); };
  connection.on(session, "Network.requestWillBeSent", () => { open += 1; bump(); });
  connection.on(session, "Network.loadingFinished", () => { open -= 1; bump(); });
  connection.on(session, "Network.loadingFailed", () => { open -= 1; bump(); });
  return async () => {
    while (Date.now() - started < timeoutMs) {
      if (open <= 0 && Date.now() - lastActivity >= settleMs) return true;
      await sleep(40);
    }
    return false;
  };
}

async function evaluate(connection, session, expression) {
  const { result, exceptionDetails } = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

/** One screenshot in its own page: size, theme, steps, then checks and the picture. */
export async function shoot(connection, { context, baseUrl, step, sizeName, theme, outDir, fullPage = true }) {
  const size = SIZES[sizeName];
  const started = Date.now();
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank", browserContextId: context });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  const problems = [];
  const send = (method, params) => connection.send(method, params, sessionId);
  try {
    await Promise.all(["Page", "Runtime", "Network", "Log"].map((domain) => send(`${domain}.enable`)));
    connection.on(sessionId, "Runtime.exceptionThrown", (p) => problems.push(`script error: ${String(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split("\n")[0].slice(0, 160)}`));
    connection.on(sessionId, "Runtime.consoleAPICalled", (p) => { if (p.type === "error") problems.push(`console error: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 160)}`); });
    connection.on(sessionId, "Log.entryAdded", (p) => { if (p.entry.level === "error" && p.entry.source !== "network") problems.push(`log error: ${p.entry.text.slice(0, 160)}`); });
    connection.on(sessionId, "Network.responseReceived", (p) => { if (p.response.status >= 400 && p.type !== "Other" && new URL(p.response.url).origin === new URL(baseUrl).origin) problems.push(`${p.response.status} on ${new URL(p.response.url).pathname}`); });
    connection.on(sessionId, "Network.loadingFailed", (p) => { if (!p.canceled) problems.push(`request failed: ${p.errorText}`); });
    await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: size.mobile });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
    const idle = await waitForIdle(connection, sessionId);
    await send("Page.navigate", { url: new URL(step.path, baseUrl).href });
    await new Promise((resolve) => { connection.on(sessionId, "Page.loadEventFired", resolve); setTimeout(resolve, 15_000); });
    if (!(await idle())) problems.push("the page was still loading after 15 s");
    if (step.waitFor) {
      const ok = await evaluate(connection, sessionId, `new Promise((resolve) => { const t = Date.now(); const look = () => { const hit = ${JSON.stringify(step.waitFor)}.startsWith("text:") ? document.body.innerText.includes(${JSON.stringify(String(step.waitFor).slice(5))}) : Boolean(document.querySelector(${JSON.stringify(step.waitFor)})); if (hit) resolve(true); else if (Date.now() - t > 8000) resolve(false); else setTimeout(look, 50); }; look(); })`);
      if (!ok) problems.push(`never saw ${step.waitFor}`);
    }
    for (const click of step.clicks ?? []) {
      const hit = await evaluate(connection, sessionId, `(() => { const text = ${JSON.stringify(click)}; const el = [...document.querySelectorAll("button, a, [role=tab], [role=button]")].find((e) => e.innerText?.trim() === text || e.getAttribute("aria-label") === text); if (!el) return false; el.click(); return true; })()`);
      if (!hit) problems.push(`no button called "${click}"`);
      await sleep(250);
    }
    await sleep(120);
    problems.push(...(await evaluate(connection, sessionId, PAGE_CHECKS)));
    const metrics = await evaluate(connection, sessionId, "({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })");
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage, fromSurface: true, ...(fullPage ? { clip: { x: 0, y: 0, width: size.width, height: Math.min(metrics.h, 12_000), scale: 1 } } : {}) });
    const buffer = Buffer.from(shot.data, "base64");
    const file = `${slug(step.name)}.${sizeName}.${theme}.png`;
    writeFileSync(path.join(outDir, file), buffer);
    return { name: step.name, size: sizeName, theme, url: step.path, file, sha256: sha256(buffer), bytes: buffer.length, pageHeight: metrics.h, ms: Date.now() - started, problems: [...new Set(problems)] };
  } finally {
    await connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

/** Claims the launch link once, in the shared context, so every later page is signed in. */
export async function signIn(connection, context, launchUrl) {
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank", browserContextId: context });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  await connection.send("Page.enable", {}, sessionId);
  await connection.send("Page.navigate", { url: launchUrl }, sessionId);
  await sleep(2500);
  await connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
}

/** Runs every step at every size and theme, `parallel` at a time, and writes the manifest. */
export async function captureAll({ launchUrl, plan = DEFAULT_PLAN, sizes = ["desktop"], themes = ["light"], parallel = 4, outDir, fullPage = true, onShot }) {
  mkdirSync(outDir, { recursive: true });
  const chrome = await launchChrome();
  const started = Date.now();
  try {
    const { connection } = chrome;
    const { browserContextId: context } = await connection.send("Target.createBrowserContext");
    const baseUrl = new URL(launchUrl).origin + "/";
    if (new URL(launchUrl).hash) await signIn(connection, context, launchUrl);
    const jobs = plan.flatMap((step) => sizes.flatMap((sizeName) => themes.map((theme) => ({ step, sizeName, theme }))));
    const shots = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        try {
          shots[i] = await shoot(connection, { context, baseUrl, ...jobs[i], outDir, fullPage });
        } catch (error) {
          shots[i] = { name: jobs[i].step.name, size: jobs[i].sizeName, theme: jobs[i].theme, url: jobs[i].step.path, file: null, problems: [`capture failed: ${error.message}`] };
        }
        onShot?.(shots[i]);
      }
    }));
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      browser: chrome.version,
      app: baseUrl,
      // A picture on disk is not proof until a person has looked at it.
      viewingAttested: false,
      totals: { shots: shots.length, withProblems: shots.filter((s) => s.problems.length).length, ms: Date.now() - started },
      shots,
    };
    writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await chrome.stop();
  }
}

function parseArgs(argv) {
  const args = { sizes: ["desktop"], themes: ["light"], parallel: 4, allowProblems: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--plan") args.plan = argv[++i];
    else if (a === "--sizes") args.sizes = argv[++i].split(",");
    else if (a === "--themes") args.themes = argv[++i].split(",");
    else if (a === "--parallel") args.parallel = Number(argv[++i]);
    else if (a === "--allow-problems") args.allowProblems = true;
    else throw new Error(`Unknown option ${a}.`);
  }
  if (!args.url || !args.out) throw new Error("Usage: capture.mjs --url <app link> --out <folder> [--plan plan.json] [--sizes desktop,tablet,phone] [--themes light,dark] [--parallel 4] [--allow-problems]");
  for (const s of args.sizes) if (!SIZES[s]) throw new Error(`Unknown size ${s}; use ${Object.keys(SIZES).join(", ")}.`);
  for (const t of args.themes) if (!["light", "dark"].includes(t)) throw new Error(`Unknown theme ${t}; use light or dark.`);
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  const { readFileSync } = await import("node:fs");
  const plan = args.plan ? JSON.parse(readFileSync(args.plan, "utf8")) : DEFAULT_PLAN;
  const manifest = await captureAll({ launchUrl: args.url, plan, sizes: args.sizes, themes: args.themes, parallel: args.parallel, outDir: args.out, onShot: (s) => console.log(`${s.problems.length ? "!" : "."} ${s.name} ${s.size} ${s.theme}${s.ms ? ` ${s.ms} ms` : ""}${s.problems.length ? `\n    ${s.problems.join("\n    ")}` : ""}`) });
  console.log(`${manifest.totals.shots} shots in ${(manifest.totals.ms / 1000).toFixed(1)} s, ${manifest.totals.withProblems} with problems. ${path.join(args.out, "manifest.json")}`);
  process.exit(manifest.totals.withProblems && !args.allowProblems ? 1 : 0);
}
