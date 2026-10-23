// Smoke-tests an INSTALLED Perfect Planner build through tauri-driver (WebDriver).
// Used by .github/workflows/installer-trial.yml on Windows and Linux runners; macOS has no
// WKWebView driver, so the workflow checks the Mac app at the process and screenshot level.
//
//   node scripts/release/trial/smoke-app.mjs --app <path to installed binary>
//        --folder <project folder to open> --out <dir for screenshots + result.json> [--label nsis] [--attach 127.0.0.1:9222]
//
// Every check is recorded as pass/fail with what was actually seen; the script exits 1 if any
// check failed, after writing result.json, so the workflow can still upload the evidence.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const app = args.app;
const folder = args.folder;
const out = args.out || "smoke-out";
const label = args.label || process.platform;
const driverUrl = args.driver || "http://127.0.0.1:4444";
if (!app || !folder) throw new Error("--app and --folder are required");
mkdirSync(out, { recursive: true });

const ELEMENT = "element-6066-11e4-a52f-4a5d6b6c6a20";
const checks = [];
const record = (name, pass, seen) => {
  checks.push({ name, pass, seen });
  appendFileSync(path.join(out, "checks.jsonl"), JSON.stringify({ label, name, pass, seen }) + "\n");
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${seen}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function wd(method, route, body, timeoutMs = 60_000) {
  const response = await fetch(`${driverUrl}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${JSON.stringify(json.value ?? json).slice(0, 400)}`);
  return json.value;
}

let session;
const run = (script, ...scriptArgs) => wd("POST", `/session/${session}/execute/sync`, { script, args: scriptArgs });
const bodyText = () => run("return document.body ? document.body.innerText : ''").catch(() => "");
async function shot(name) {
  try {
    const png = await wd("GET", `/session/${session}/screenshot`);
    writeFileSync(path.join(out, `${label}-${name}.png`), Buffer.from(png, "base64"));
  } catch (error) {
    console.log(`screenshot ${name} failed: ${error.message}`);
  }
}
async function waitFor(predicate, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate().catch((error) => ({ error: error.message }));
    if (last && !last.error) return last;
    await sleep(stepMs);
  }
  return null;
}

// Clicks the first visible button/link/menu item whose text or aria-label matches. Returns its label or null.
const CLICK_BY_TEXT = `
  const pattern = new RegExp(arguments[0], "i");
  const nodes = [...document.querySelectorAll("button, a, [role=button], [role=menuitem], [role=tab]")];
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest("[inert]"); };
  // Match a control's first line of text (its name, not its subtitle) or its aria-label.
  const firstLine = (el) => (el.innerText || "").trim().split("\\n")[0].trim();
  const hit = nodes.find((el) => visible(el) && (pattern.test(firstLine(el)) || pattern.test((el.getAttribute("aria-label") || "").trim())));
  if (!hit) return null;
  hit.scrollIntoView({ block: "center" });
  hit.click();
  return (hit.innerText || hit.getAttribute("aria-label") || "").trim().slice(0, 120);
`;
const clickText = (pattern) => run(CLICK_BY_TEXT, pattern);
const pressEscape = () => run(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`).catch(() => false);

// Types the folder path into the page's own "type or paste the folder path" box (React-safe value set).
const TYPE_FOLDER_PATH = `
  const label = [...document.querySelectorAll("label")].find((l) => /type (or paste )?the folder path/i.test(l.innerText || ""));
  const input = label && label.querySelector("input");
  if (!input) return null;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, arguments[0]);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
`;

// The folder picker is a native OS dialog the webview cannot see, so it is answered from outside.
function answerFolderDialog() {
  const title = "Choose an app folder for read-only analysis";
  if (process.platform === "win32") {
    const ps = `
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${title}')
      $dialog = $null
      for ($i = 0; $i -lt 60 -and -not $dialog; $i++) { $dialog = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond); if (-not $dialog) { Start-Sleep -Milliseconds 500 } }
      if (-not $dialog) { Write-Output 'dialog-not-found'; exit 2 }
      $editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1152')
      $edit = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond)
      if (-not $edit) { Write-Output 'folder-box-not-found'; exit 3 }
      $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('${folder.replace(/'/g, "''")}')
      $okCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1')
      $ok = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $okCond)
      if (-not $ok) { Write-Output 'select-button-not-found'; exit 4 }
      $ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      Write-Output 'answered'
    `;
    return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 60_000 });
  }
  // Linux: rfd asks xdg-desktop-portal, whose GTK backend shows a GtkFileChooser.
  const sh = `
    for i in $(seq 1 60); do id=$(xdotool search --name '${title}' 2>/dev/null | head -n1); [ -n "$id" ] && break; sleep 0.5; done
    [ -z "$id" ] && { echo dialog-not-found; xdotool search --name '.' getwindowname %@ 2>/dev/null | sort -u | head -n 20; exit 2; }
    xdotool windowactivate --sync "$id" 2>/dev/null || xdotool windowfocus --sync "$id"
    sleep 1; xdotool key --clearmodifiers ctrl+l; sleep 0.5
    xdotool type --delay 20 '${folder.replace(/'/g, "'\\''")}/'; sleep 0.5
    xdotool key Return; sleep 1
    xdotool search --name '${title}' >/dev/null 2>&1 && { xdotool key Return; sleep 1; }
    echo answered
  `;
  return spawnSync("bash", ["-c", sh], { encoding: "utf8", timeout: 60_000 });
}

async function main() {
  const started = Date.now();
  // --attach host:port: the app was started with WebView2's DevTools port open (Windows), so
  // msedgedriver attaches to it instead of launching it. Otherwise tauri-driver launches the app.
  const capabilities = args.attach
    ? { browserName: "MicrosoftEdge", "ms:edgeOptions": { debuggerAddress: args.attach } }
    : { browserName: "wry", "tauri:options": { application: app } };
  const created = await wd("POST", "/session", { capabilities: { alwaysMatch: capabilities } }, 120_000);
  session = created.sessionId;
  record("launch", true, `WebDriver session up after ${Date.now() - started} ms`);

  // 1. First-run screen renders real content (not a blank or error page).
  const firstText = await waitFor(async () => {
    const text = await bodyText();
    return text && text.trim().length > 40 ? text : null;
  }, 60_000);
  await shot("01-first-run");
  const firstOk = Boolean(firstText) && /Perfect Planner|Bring in your existing app|Drop your app|Choose app folder|Local Collaboration Workspace|Add project|Choose a local folder|Project Home/i.test(firstText) && !/Something went wrong|Unhandled|TypeError/i.test(firstText);
  record("first-run screen", firstOk, firstText ? JSON.stringify(firstText.trim().replace(/\s+/g, " ").slice(0, 220)) : "no text within 60 s");

  // 2. Settings opens (top bar, or inside More actions).
  let settingsLabel = await clickText("^(open )?settings$");
  if (!settingsLabel) {
    await clickText("^more actions$");
    await sleep(500);
    settingsLabel = await clickText("^(open )?settings$");
  }
  let settingsText = null;
  if (settingsLabel) {
    settingsText = await waitFor(async () => {
      const text = await bodyText();
      // "Opening settings…" is the loading placeholder, not the page; wait it out.
      return /settings/i.test(text) && !/opening settings/i.test(text) && /keychain|reviewer key|api key|theme|preferences|appearance/i.test(text) ? text : null;
    }, 10_000);
  }
  await shot("02-settings");
  record("settings opens", Boolean(settingsLabel && settingsText),
    settingsLabel ? (settingsText ? `opened via "${settingsLabel}": ${JSON.stringify(settingsText.slice(settingsText.search(/settings/i), settingsText.search(/settings/i) + 160).replace(/\s+/g, " "))}` : `clicked "${settingsLabel}" but no settings page appeared within the wait; page shows ${JSON.stringify((await bodyText()).replace(/\s+/g, " ").slice(0, 200))}`) : "no Settings control in the top bar or More actions");
  await pressEscape();
  await clickText("^open perfect planner home$");
  await sleep(500);

  // 3. A project folder can be opened through the native picker.
  // Reach the Structure page's "Choose app folder" by whichever route this build offers.
  // Home's "Choose app folder" only navigates to Structure; the picker opens from Structure's own
  // button, which sits under "Drop your app folder here". Click until we are on that page.
  const onStructure = async () => /drop (your|the) app folder/i.test(await bodyText());
  let chooser = null;
  for (let i = 0; i < 3 && !chooser; i++) {
    const there = await onStructure();
    const hit = await clickText("^choose app folder$");
    if (hit && there) chooser = hit;
    else await sleep(1500);
  }
  const route = [];
  for (const step of ["drop your app|review intake|^add project$", "^(0?1\\s*)?define$", "^structure$"]) {
    if (chooser) break;
    const hit = await clickText(step);
    if (hit) route.push(hit);
    await sleep(1000);
    if (await onStructure()) chooser = await clickText("^choose app folder$");
  }
  const toStructure = route.join(" > ") || null;
  let folderOk = false;
  let folderSeen = chooser ? "" : `no "Choose app folder" button (navigated via ${JSON.stringify(toStructure)})`;
  if (chooser) {
    let answer = answerFolderDialog();
    if (answer.status !== 0) {
      // No native dialog to answer (Linux builds have no native picker). The page offers a typed
      // path for that case; use it like a person would.
      const filled = await run(TYPE_FOLDER_PATH, folder).catch(() => null);
      if (filled) {
        await sleep(300);
        const submit = await clickText("^(scan folder|use this folder)$");
        answer = { status: submit ? 0 : 1, stdout: `typed the folder path (${(answer.stdout || "").trim().split("\n")[0] || "no dialog"}); pressed ${submit || "nothing"}`, stderr: "" };
      }
    }
    folderSeen = `dialog: ${(answer.stdout || "").trim().split("\n").pop()} ${answer.status !== 0 ? `(exit ${answer.status}) ${(answer.stderr || "").trim().slice(0, 200)}` : ""}`.trim();
    const base = path.basename(folder);
    const after = await waitFor(async () => {
      const text = await bodyText();
      return text.includes(base) || /approve read-only|read-only scan|files captured/i.test(text) ? text : null;
    }, 30_000);
    folderOk = answer.status === 0 && Boolean(after);
    if (after) folderSeen += `; app shows: ${JSON.stringify(after.slice(Math.max(0, after.indexOf(base) - 60), after.indexOf(base) + 120).replace(/\s+/g, " "))}`;
    else {
      const text = await bodyText();
      const err = text.split("\n").filter((l) => /error|couldn't|could not|failed|denied|blocked/i.test(l)).slice(0, 4).join(" / ");
      folderSeen += `; app never showed "${base}" or a read-only scan step${err ? `; page says: ${JSON.stringify(err.slice(0, 240))}` : ""}`;
    }
  }
  await shot("03-folder-opened");
  record("open project folder", folderOk, folderSeen);

  // 4. Connect agent panel shows a line to run. The drawer may lead with its own "Connect agent"
  // button that writes the real line; press it, then read every copyable block in the drawer.
  await pressEscape();
  const connect = await clickText("^connect agent$");
  const READ_DRAWER = `
    const dialogs = [...document.querySelectorAll("[role=dialog], aside, .side-drawer")].filter((d) => d.getAttribute("aria-hidden") !== "true" && /connect|agent/i.test(d.innerText || ""));
    const d = dialogs.pop(); if (!d) return null;
    if (arguments[0]) {
      const inner = [...d.querySelectorAll("button")].find((b) => /^connect agent$/i.test((b.innerText || "").trim()) && !b.disabled);
      if (inner) inner.click();
    }
    const code = [...d.querySelectorAll("code, pre, input[readonly], textarea")].map((n) => (n.value || n.innerText || "").trim()).filter((c) => c.length > 10);
    return { text: d.innerText.trim(), code: [...new Set(code)] };
  `;
  let panel = connect ? await waitFor(() => run(READ_DRAWER, false), 15_000) : null;
  if (panel) {
    const before = panel.code.length;
    await run(READ_DRAWER, true).catch(() => null);
    panel = (await waitFor(async () => { const p = await run(READ_DRAWER, false); return p && p.code.length > before ? p : null; }, 15_000)) || (await run(READ_DRAWER, false));
  }
  await shot("04-connect-agent");
  const lines = panel?.code || [];
  const line = lines[0] || "";
  const panelError = panel && /couldn't|could not|failed|unavailable|not running|error/i.test(panel.text) ? panel.text.match(/[^\n]*(couldn't|could not|failed|unavailable|not running|error)[^\n]*/i)?.[0] : null;
  record("connect agent shows a line", Boolean(line) && !panelError,
    !connect ? "no Connect agent button" : !panel ? "panel did not open" : line ? `first line: ${JSON.stringify(line.slice(0, 240))}${panelError ? `; but panel says ${JSON.stringify(panelError)}` : ""}` : `no line; panel says ${JSON.stringify(panel.text.replace(/\s+/g, " ").slice(0, 240))}`);

  // 4b. Every line the drawer offers must be runnable as copied: no <placeholders> to fill in by hand.
  if (lines.length) {
    const bad = lines.filter((c) => /<[^<>\s][^<>]*>|\{\{[^}]+\}\}/.test(c));
    record("connect lines runnable as copied", bad.length === 0,
      `${lines.length} copyable block(s); ${bad.length ? `with placeholders: ${bad.map((c) => JSON.stringify(c.slice(0, 160))).join(" | ")}` : "none has placeholders"}`);
  }

  // 5. Closes cleanly: ending the session closes the window; the workflow then checks no process is left.
  // When attached, ending the session only detaches; the caller closes the window like a person.
  if (args.attach) { await wd("DELETE", `/session/${session}`).catch(() => {}); session = null; return; }
  const closeStart = Date.now();
  await wd("DELETE", `/session/${session}`).then(
    () => record("close", true, `session closed in ${Date.now() - closeStart} ms`),
    (error) => record("close", false, error.message),
  );
  session = null;
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error.message;
  record("smoke run", false, error.message);
  if (session) { await shot("99-at-failure"); await wd("DELETE", `/session/${session}`).catch(() => {}); }
}
writeFileSync(path.join(out, `${label}-result.json`), JSON.stringify({ label, app, platform: process.platform, checks, fatal }, null, 2));
const failed = checks.filter((check) => !check.pass).length;
console.log(`${label}: ${checks.length - failed}/${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
