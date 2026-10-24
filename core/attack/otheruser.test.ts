// Attack 2: a second OS user on the same machine. Loopback ports and the project folder are visible to every account,
// so the only things between a stranger and the person's app are the session secrets, the bridge tokens and the file
// modes the app sets. A real second account ("nobody") is started as a child process with its own uid and does what
// a hostile local account would: reads the secret files, writes into the ledger and token folders, calls every route
// of the local service with no credentials, with forged browser headers and with guessed secrets, and calls the
// agent bridge with no token and with made-up ones.
//
// The marker: the approved test of T-1 writes a file when it runs. It runs only inside Check and Merge, which only the
// person can start. If the stranger could start either, the marker would appear (or main would move).
//
// Needs the ability to run a process as another user: root, or passwordless sudo, and a "nobody" account. Linux only.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTask, buildCheckApprove, cleanTemp, dispatchAndApproveTest, git, listTree, makeRepo, startWindow, tempDir, TEST_FILE, type Dispatched, type Window } from "./helpers";

afterAll(cleanTemp);
const q = "?project=p";

const NOBODY = 65534;
function canRunAsOtherUser(): boolean {
  if (process.platform !== "linux") return false;
  try {
    if (!/^nobody:/m.test(fs.readFileSync("/etc/passwd", "utf8"))) return false;
  } catch {
    return false;
  }
  if (process.getuid?.() === 0) return true;
  return spawnSync("sudo", ["-n", "-u", "nobody", "true"], { stdio: "ignore" }).status === 0;
}
const CAN = canRunAsOtherUser();

/** The stranger's whole script. Plain Node, no access to anything of ours except what a local account has. */
const STRANGER = `
const fs = require("node:fs");
const cfg = JSON.parse(process.argv[2]);
const out = { uid: process.getuid(), read: {}, list: {}, write: {}, http: [], claims: { statuses: {}, cookies: 0 }, bridge: [] };
for (const f of cfg.read) { try { fs.readFileSync(f); out.read[f] = "READ"; } catch (e) { out.read[f] = e.code; } }
for (const d of cfg.list) { try { fs.readdirSync(d); out.list[d] = "LISTED"; } catch (e) { out.list[d] = e.code; } }
for (const f of cfg.write) { try { fs.appendFileSync(f, "x"); out.write[f] = "WROTE"; } catch (e) { out.write[f] = e.code; } }
const post = (url, headers, body) => fetch(url, { method: "POST", headers, body });
(async () => {
  const kinds = {
    bare: {},
    forged: { origin: cfg.origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    guessed: { origin: cfg.origin, cookie: "pp_session=" + "a".repeat(43), "x-pp-csrf": "b".repeat(43) },
  };
  for (const r of cfg.routes) {
    for (const [kind, extra] of Object.entries(kinds)) {
      const headers = { "content-type": "application/json", ...extra };
      try {
        const res = r.method === "GET" ? await fetch(cfg.base + r.path + cfg.query, { headers }) : await post(cfg.base + r.path + cfg.query, headers, JSON.stringify({ title: "Planted by a stranger", idea: "x", commit: cfg.commit, test: "x" }));
        const text = await res.text();
        out.http.push({ method: r.method, path: r.path, kind, status: res.status, cookie: res.headers.get("set-cookie") !== null, leaked: cfg.secrets.filter((s) => text.includes(s)) });
      } catch (e) { out.http.push({ method: r.method, path: r.path, kind, status: 0, error: String(e) }); }
    }
  }
  const random = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  for (let batch = 0; batch < cfg.guesses / 25; batch++) {
    await Promise.all(Array.from({ length: 25 }, async () => {
      const res = await post(cfg.base + "/session/claim", { origin: cfg.origin, "content-type": "application/json" }, JSON.stringify({ launch: random() }));
      out.claims.statuses[res.status] = (out.claims.statuses[res.status] || 0) + 1;
      if (res.headers.get("set-cookie")) out.claims.cookies += 1;
      await res.text();
    }));
  }
  const tools = [["hello", { name: "Stranger" }], ["list_tasks", {}], ["claim_task", { task: "T-1" }], ["answer", { question: "Q-1", text: "yes" }], ["check_inbox", {}], ["release_task", { task: "T-1", reason: "stranger" }]];
  const tokens = [undefined, "", "x", "Bearer", "a".repeat(37), "A".repeat(10000), "C-" + "0".repeat(8), "T-1", "../tokens/T-1.token", "null", "undefined"];
  for (const url of cfg.bridges) {
    for (const token of tokens) {
      for (const [tool, args] of tools) {
        const headers = { "content-type": "application/json", ...(token === undefined ? {} : { authorization: "Bearer " + token }) };
        try {
          const res = await post(url + "/call", headers, JSON.stringify({ tool, args, agent: "main-0000" }));
          const body = await res.json().catch(() => null);
          out.bridge.push({ url, token: token === undefined ? "(none)" : token.slice(0, 12), tool, status: res.status, ok: !!(body && body.ok) });
        } catch (e) { out.bridge.push({ url, token: String(token).slice(0, 12), tool, status: 0, error: String(e) }); }
      }
    }
    for (const [method, p] of [["GET", "/call"], ["GET", "/"], ["POST", "/"], ["PUT", "/call"]]) {
      const res = await fetch(url + p, { method, ...(method === "GET" ? {} : { body: "{}" }) });
      out.bridge.push({ url, token: "(route)", tool: method + " " + p, status: res.status, ok: false });
    }
    const big = await post(url + "/call", { authorization: "Bearer x", "content-type": "application/json" }, "x".repeat(200000)).then((r) => r.status, () => 0);
    out.bridge.push({ url, token: "(big)", tool: "200KB body", status: big, ok: false });
  }
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stdout.write(JSON.stringify({ crashed: String(e) })); });
`;

interface Stranger {
  uid: number;
  read: Record<string, string>;
  list: Record<string, string>;
  write: Record<string, string>;
  http: { method: string; path: string; kind: string; status: number; cookie: boolean; leaked: string[]; error?: string }[];
  claims: { statuses: Record<string, number>; cookies: number };
  bridge: { url: string; token: string; tool: string; status: number; ok: boolean; error?: string }[];
  crashed?: string;
}

/** Async on purpose: the host under attack runs in this process, so it must keep answering while the stranger runs. */
function runAsStranger(scriptDir: string, config: unknown): Promise<Stranger> {
  const script = path.join(scriptDir, "stranger.cjs");
  fs.writeFileSync(script, STRANGER, { mode: 0o644 });
  const args = [script, JSON.stringify(config)];
  const child = process.getuid?.() === 0 ? spawn(process.execPath, args, { uid: NOBODY, gid: NOBODY, stdio: ["ignore", "pipe", "pipe"] }) : spawn("sudo", ["-n", "-u", "nobody", process.execPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the stranger's script timed out"));
    }, 90_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`the stranger's script failed (${code}): ${stderr}`));
      else resolve(JSON.parse(stdout) as Stranger);
    });
  });
}

/** Every route the host registered, as a concrete path (":name" segments filled with T-1). */
function routesOf(win: Window): { method: "GET" | "POST"; path: string }[] {
  const routes = (win.host as unknown as { router: { routes: { method: "GET" | "POST"; pattern: RegExp }[] } }).router.routes;
  return routes.map((r) => ({ method: r.method, path: r.pattern.source.replace(/^\^/, "").replace(/\\\/\?\$$/, "").replace(/\(\[\^\/\]\+\)/g, "T-1").replace(/\\(.)/g, "$1") }));
}

const ledgerBytes = (repo: string) => {
  const dir = path.join(repo, ".perfect-planner", "ledger");
  return fs.readdirSync(dir).filter((f) => f !== ".writer.lock").sort().map((f) => `${f}:${fs.readFileSync(path.join(dir, f), "utf8")}`);
};

describe.skipIf(!CAN)("attack 2: a second OS user (needs root or passwordless sudo, and a 'nobody' account; Linux only)", () => {
  let win: Window;
  let repo: string;
  let data: string;
  let scriptDir: string;
  let marker: string;
  let worker: Dispatched;
  let connectBridge: string;
  let connectTokenFile: string;
  let mainBefore: string;
  let stranger: Stranger;
  let ledgerBefore: string[];
  let branchesBefore: string;
  let secretsInUse: string[];

  beforeAll(async () => {
    data = tempDir();
    scriptDir = tempDir();
    marker = path.join(tempDir(), "marker");
    repo = makeRepo();
    // Like a normal machine: the home and project folders can be walked through by other accounts. What the app creates
    // inside them is what is under test.
    for (const dir of [data, scriptDir, repo, path.dirname(marker)]) fs.chmodSync(dir, 0o755);
    win = await startWindow({ data, project: repo, secrets: path.join(data, "secrets.json") });
    await addTask(win, q, "Save notes");
    const test = { file: TEST_FILE, source: `import { existsSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "the approved test ran");\nprocess.exit(existsSync("src/save.js") ? 0 : 1);\n`, command: `node ${TEST_FILE}` };
    worker = await dispatchAndApproveTest(win, q, "T-1", test);
    await buildCheckApprove(win, q, worker);
    const connect = (await win.call("POST", `/agents/connect${q}`, {})).body.result as { bridgeUrl: string; tokenFile: string };
    connectBridge = connect.bridgeUrl;
    connectTokenFile = connect.tokenFile;
    // The approved test ran during approval and Check. From here on it must not run again until the person merges.
    fs.rmSync(marker, { force: true });
    mainBefore = git(repo, "rev-parse", "main");
    ledgerBefore = ledgerBytes(repo);
    branchesBefore = git(repo, "branch", "--list");
    secretsInUse = [win.cookie.split("=")[1]!, win.csrf, fs.readFileSync(worker.tokenFile, "utf8"), fs.readFileSync(connectTokenFile, "utf8")];

    const tokens = path.join(repo, ".perfect-planner", "tokens");
    const witness = path.join(data, "witness");
    const owners = path.join(data, "owners");
    const ownerFiles = fs.readdirSync(owners).filter((f) => f.endsWith(".json")).map((f) => path.join(owners, f));
    const month = fs.readdirSync(path.join(repo, ".perfect-planner", "ledger")).find((f) => f.endsWith(".jsonl"))!;
    stranger = await runAsStranger(scriptDir, {
      base: win.base,
      origin: win.origin,
      query: q,
      commit: mainBefore,
      secrets: secretsInUse,
      guesses: 300,
      routes: [...routesOf(win), { method: "GET", path: "/session" }, { method: "POST", path: "/session/claim" }],
      bridges: [worker.bridgeUrl, connectBridge],
      read: [path.join(repo, "README.md"), ...fs.readdirSync(tokens).map((f) => path.join(tokens, f)), ...fs.readdirSync(witness).map((f) => path.join(witness, f))],
      list: [tokens],
      write: [
        path.join(repo, ".perfect-planner", "ledger", month),
        path.join(repo, ".perfect-planner", "ledger", "HEAD"),
        path.join(repo, ".perfect-planner", "tokens", "T-1.token"),
        path.join(repo, ".perfect-planner", "tokens", "planted.token"),
        path.join(worker.worktree, TEST_FILE),
        path.join(worker.worktree, "src", "save.js"),
        path.join(repo, ".git", "refs", "heads", "main"),
        path.join(repo, ".git", "HEAD"),
        ...ownerFiles,
        path.join(data, "owners", "planted.json"),
      ],
    });
  }, 120_000);
  afterAll(async () => win?.stop());

  it("runs as a different user", () => {
    expect(stranger.crashed).toBeUndefined();
    expect(stranger.uid).toBe(NOBODY);
    expect(process.getuid?.()).not.toBe(NOBODY);
  });

  it("cannot read a token file or the head copy, or list the folder that holds the tokens", () => {
    expect(Object.keys(stranger.read).length).toBeGreaterThanOrEqual(6);
    // Control: the stranger can walk to the project (the folder is readable), so the refusals below come from the file modes.
    expect(stranger.read[path.join(repo, "README.md")]).toBe("READ");
    for (const [file, outcome] of Object.entries(stranger.read)) if (!file.endsWith("README.md")) expect(outcome, file).toBe("EACCES");
    for (const [dir, outcome] of Object.entries(stranger.list)) expect(outcome, dir).toBe("EACCES");
  });

  it("cannot write into the ledger, the tokens, a worker's folder, the git refs or the owner pins", () => {
    expect(Object.keys(stranger.write).length).toBeGreaterThanOrEqual(8);
    for (const [file, outcome] of Object.entries(stranger.write)) expect(["EACCES", "ENOENT"], `${file}: ${outcome}`).toContain(outcome);
    expect(Object.values(stranger.write).filter((o) => o === "WROTE")).toEqual([]);
    expect(fs.existsSync(path.join(repo, ".perfect-planner", "tokens", "planted.token"))).toBe(false);
    expect(fs.existsSync(path.join(data, "owners", "planted.json"))).toBe(false);
    expect(ledgerBytes(repo)).toEqual(ledgerBefore);
  });

  it("gets no answer, no cookie and no data from any route of the local service, with no credentials, forged browser headers or guessed secrets", () => {
    expect(stranger.http.length).toBeGreaterThanOrEqual(3 * 40);
    const dataLeaks = stranger.http.filter((r) => r.leaked.length > 0);
    expect(dataLeaks, "a secret came back to a stranger").toEqual([]);
    expect(stranger.http.filter((r) => r.cookie), "a stranger was handed a cookie").toEqual([]);
    expect(stranger.http.filter((r) => r.status === 0 || r.error)).toEqual([]);
    const open = stranger.http.filter((r) => r.status < 400);
    expect(open, `these answered a stranger with success: ${JSON.stringify(open)}`).toEqual([]);
    // The stranger's calls are refused as "not signed in" (401), not by accident of a missing project, bad body or crash.
    const notSignedIn = stranger.http.filter((r) => r.status === 401).length;
    expect(notSignedIn).toBeGreaterThanOrEqual(stranger.http.length * 0.9);
  });

  it("guessing launch secrets gets nothing: 300 wrong guesses, all refused, no cookie", () => {
    expect(stranger.claims.cookies).toBe(0);
    expect(Object.keys(stranger.claims.statuses)).toEqual(["401"]);
    expect(stranger.claims.statuses["401"]).toBe(300);
  });

  it("is refused by the agent bridge with no token, a made-up token, a token-looking string or a path, on every tool", () => {
    const answered = stranger.bridge.filter((r) => r.ok);
    expect(answered, `the bridge answered a stranger: ${JSON.stringify(answered)}`).toEqual([]);
    const calls = stranger.bridge.filter((r) => r.tool !== undefined && !r.token.startsWith("("));
    expect(calls.length).toBeGreaterThanOrEqual(2 * 10 * 6);
    // Bearer-less, empty and bogus tokens are 401 (not a 500, not a hang). A token with a bad shape is refused before it can reach the tool.
    for (const r of calls) expect([401, 400], `${r.token} ${r.tool}`).toContain(r.status);
    // An oversized body is cut off (the connection is dropped, status 0) or refused; never accepted, never a crash.
    const big = stranger.bridge.filter((r) => r.token === "(big)");
    expect(big.length).toBe(2);
    for (const r of big) expect(r.status === 0 || (r.status >= 400 && r.status < 500), JSON.stringify(r)).toBe(true);
    expect(stranger.bridge.filter((r) => r.token !== "(big)" && (r.status >= 500 || r.status === 0 || r.error))).toEqual([]);
  });

  it("started nothing: the approved test never ran again (marker absent), main did not move, no new branch or worktree, the ledger is byte for byte the same", async () => {
    expect(fs.existsSync(marker), "the stranger made the approved test run").toBe(false);
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(git(repo, "branch", "--list")).toBe(branchesBefore);
    expect(ledgerBytes(repo)).toEqual(ledgerBefore);
    // And the host is still the person's: it answers them, the worker's token still works for the worker.
    expect((await win.call("GET", `/status${q}`)).status).toBe(200);
    await expect(worker.call({ tool: "list_tasks", args: {}, agent: worker.agent })).resolves.toBeDefined();
  });

  it("none of the session secrets or tokens is stored in any file of the project or the app's data folder, except the 0600 token files", () => {
    const hits: string[] = [];
    const scan = (root: string) => {
      for (const rel of listTree(root)) {
        const full = path.join(root, rel);
        if (rel.startsWith(`.git${path.sep}`) || rel.includes(`${path.sep}worktrees${path.sep}`) || rel.startsWith(`.perfect-planner${path.sep}worktrees`)) continue;
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || stat.size > 5_000_000) continue;
        const text = fs.readFileSync(full, "utf8");
        for (const secret of secretsInUse) if (text.includes(secret)) hits.push(`${rel} holds a secret`);
      }
    };
    scan(repo);
    scan(data);
    // The token files hold the two bridge tokens by design; the cookie and CSRF token (index 0, 1) are in memory only.
    const allowed = new Set(["tokens/T-1.token", `tokens/${path.basename(connectTokenFile)}`].map((f) => path.join(".perfect-planner", f)));
    const unexpected = hits.filter((h) => !allowed.has(h.replace(/ holds a secret$/, "")));
    expect(unexpected).toEqual([]);
    expect(fs.readFileSync(worker.tokenFile, "utf8")).toBe(secretsInUse[2]);
    for (const cookieOrCsrf of secretsInUse.slice(0, 2)) expect(hits.join("\n")).not.toContain(cookieOrCsrf);
  });

  it("control: the person (cookie, CSRF token, Origin) can still do the very thing the stranger could not — merge the approved task, which runs the test (marker appears)", async () => {
    const head = git(worker.worktree, "rev-parse", "HEAD");
    const merged = await win.call("POST", `/tasks/T-1/merge${q}`, { commit: head });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(fs.existsSync(marker), "the merge runs the approved test").toBe(true);
    expect(git(repo, "rev-parse", "main")).not.toBe(mainBefore);
  });
});
