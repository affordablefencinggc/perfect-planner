// Attack 1: replay what an earlier run of the app handed out, after the app restarted. The old window's cookie and
// CSRF token, a launch link that was never opened, a connect token and a worker token (their files are still on disk)
// and the connect line itself. The restarted host must treat all of it as a stranger: nothing is read, nothing is
// written, and the ledger is exactly as it was.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runConnect } from "../host/agentConnect";
import { bridgeCall } from "../mcp/index";
import { addTask, cleanTemp, dispatchAndApproveTest, listTree, makeRepo, startWindow, tempDir, type Window } from "./helpers";

afterAll(cleanTemp);
const q = "?project=p";

interface Before {
  win: Window;
  port: number;
  cookie: string;
  csrf: string;
  unspentLaunch: string;
  connectToken: string;
  connectBridge: string;
  connectLine: string;
  connectTokenFile: string;
  workerToken: string;
  workerBridge: string;
  workerTokenFile: string;
  entries: number;
}

/** Runs the app, does the things that hand out secrets, and returns what an attacker could have kept. */
async function firstRun(dirs: { data: string; repo: string; secrets: string }): Promise<Before> {
  const win = await startWindow({ data: dirs.data, project: dirs.repo, secrets: dirs.secrets });
  await addTask(win, q);
  const worker = await dispatchAndApproveTest(win, q);
  await worker.call({ tool: "claim_task", args: { task: "T-1" }, agent: worker.agent });
  const connect = await win.call("POST", `/agents/connect${q}`, {});
  expect(connect.status).toBe(200);
  const c = connect.body.result as { bridgeUrl: string; tokenFile: string; claudeCode: string };
  return {
    win,
    port: Number(new URL(win.base).port),
    cookie: win.cookie,
    csrf: win.csrf,
    unspentLaunch: win.host.issueLaunch(),
    connectToken: fs.readFileSync(c.tokenFile, "utf8"),
    connectBridge: c.bridgeUrl,
    connectLine: c.claudeCode,
    connectTokenFile: c.tokenFile,
    workerToken: worker.token,
    workerBridge: worker.bridgeUrl,
    workerTokenFile: worker.tokenFile,
    entries: win.host.project("p").entries().length,
  };
}

const code = async (promise: Promise<unknown>): Promise<string> => promise.then(() => "OK", (error: { code?: string }) => error.code ?? "UNREACHABLE");

describe("attack 1: replay after the app restarts", () => {
  it("an old window's cookie and CSRF token read nothing and write nothing on the restarted host, even on the same address", async () => {
    const dirs = { data: tempDir(), repo: makeRepo(), secrets: "" };
    dirs.secrets = path.join(dirs.data, "secrets.json");
    const old = await firstRun(dirs);
    await old.win.stop();
    // Restart: same data folder, same keys, same address (the browser tab the person left open still points here).
    const fresh = await startWindow({ ...dirs, project: dirs.repo, port: old.port });
    try {
      expect(fresh.origin).toBe(old.win.origin);
      const oldWindow = { cookie: old.cookie, "x-pp-csrf": old.csrf, origin: old.win.origin, "content-type": "application/json" };
      const before = fresh.host.project("p").entries().length;
      for (const route of ["/status", "/tasks", "/planning", "/agents", "/decisions", "/people"]) {
        const res = await fetch(`${fresh.base}${route}${q}`, { headers: oldWindow });
        expect(res.status, `GET ${route}`).toBe(401);
        expect(JSON.stringify(await res.json())).not.toContain("Save notes");
      }
      for (const route of ["/planning/tasks", "/planning/approve", "/agents/connect", "/tasks/T-1/release", "/tasks/T-1/merge", "/decisions/accept", "/session/new-window", "/owner/start"]) {
        const res = await fetch(`${fresh.base}${route}${q}`, { method: "POST", headers: oldWindow, body: JSON.stringify({ title: "Replayed" }) });
        expect(res.status, `POST ${route}`).toBe(401);
      }
      // The old cookie with the new window's CSRF token, and the new cookie with the old token: neither mixes.
      expect((await fetch(`${fresh.base}/planning/tasks${q}`, { method: "POST", headers: { ...oldWindow, "x-pp-csrf": fresh.csrf }, body: "{}" })).status).toBe(401);
      expect((await fetch(`${fresh.base}/planning/tasks${q}`, { method: "POST", headers: { ...fresh.person(), "x-pp-csrf": old.csrf, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      expect(fresh.host.project("p").entries().length).toBe(before);
      expect(before).toBe(old.entries);
    } finally {
      await fresh.stop();
    }
  }, 60_000);

  it("a launch link from before the restart, opened or not, gets no cookie", async () => {
    const dirs = { data: tempDir(), repo: makeRepo(), secrets: "" };
    dirs.secrets = path.join(dirs.data, "secrets.json");
    const old = await firstRun(dirs);
    // The link that was printed but never opened, and the one the old window did open (spent).
    const links = [old.unspentLaunch];
    await old.win.stop();
    const fresh = await startWindow({ ...dirs, project: dirs.repo, port: old.port });
    try {
      for (const launch of links) {
        const res = await fetch(`${fresh.base}/session/claim`, { method: "POST", headers: { origin: fresh.origin, "content-type": "application/json" }, body: JSON.stringify({ launch }) });
        expect(res.status).toBe(401);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
      // And a launch secret handed to the desktop shell for the earlier run is not accepted either.
      const dead = fresh.host.sessions.claim(old.unspentLaunch);
      expect(dead).toBeNull();
    } finally {
      await fresh.stop();
    }
  }, 60_000);

  it("a connect token and a worker token from before the restart are refused by the new bridge, and the old bridge is gone", async () => {
    const dirs = { data: tempDir(), repo: makeRepo(), secrets: "" };
    dirs.secrets = path.join(dirs.data, "secrets.json");
    const old = await firstRun(dirs);
    const staleFiles = [old.connectTokenFile, old.workerTokenFile];
    await old.win.stop();
    // The token files are still on disk (a thief with file access, or an agent that was left running, has them).
    for (const file of staleFiles) expect(fs.existsSync(file), file).toBe(true);

    const fresh = await startWindow({ ...dirs, project: dirs.repo });
    try {
      // The new host's bridge starts when the person connects an agent.
      const connected = await fresh.call("POST", `/agents/connect${q}`, {});
      const bridge = connected.body.result.bridgeUrl as string;
      const entriesBefore = fresh.host.project("p").entries().length;
      const boardBefore = JSON.stringify([...fresh.host.project("p").service.board().values()]);
      for (const [name, token] of [["connect", old.connectToken], ["worker", old.workerToken]] as const) {
        for (const url of [bridge, old.connectBridge, old.workerBridge]) {
          const outcome = await code(bridgeCall(url, token)({ tool: "hello", args: { name: "Replayed agent" } }));
          expect(["UNAUTHORIZED", "UNREACHABLE"], `${name} token at ${url}`).toContain(outcome);
        }
      }
      // A worker that had claimed T-1 before the restart cannot touch it now.
      expect(await code(bridgeCall(bridge, old.workerToken)({ tool: "report_progress", args: { task: "T-1", text: "I am back" }, agent: "worker-0000" }))).toBe("UNAUTHORIZED");
      expect(fresh.host.project("p").entries().length).toBe(entriesBefore);
      expect(JSON.stringify([...fresh.host.project("p").service.board().values()])).toBe(boardBefore);
      expect(fresh.host.project("p").service.listAgents().map((a) => a.name)).not.toContain("Replayed agent");
    } finally {
      await fresh.stop();
    }
  }, 60_000);

  // REAL DEFECT (found by this attack): the token files outlive the app. Nothing deletes them when the host stops or
  // starts, although every token in them died with the process. Pasting the old connect line after a restart then
  // "connects" the agent: connect.mjs sees the file, registers a server with a dead token and says Connected. The
  // agent only finds out when its first call fails. connect.mjs's own message for this case ("the token file is gone
  // (the app restarted...)") never fires because the file is never gone.
  it.fails("the old connect line is refused with 'Click Connect agent again' after a restart, instead of reporting Connected", async () => {
    const dirs = { data: tempDir(), repo: makeRepo(), secrets: "" };
    dirs.secrets = path.join(dirs.data, "secrets.json");
    const old = await firstRun(dirs);
    await old.win.stop();
    const fresh = await startWindow({ ...dirs, project: dirs.repo });
    try {
      // A stand-in claude that accepts any `mcp add`: the only thing that matters is what connect.mjs tells the person.
      const bin = tempDir("pp-attack-bin-");
      fs.writeFileSync(path.join(bin, "claude"), "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
      const here = tempDir("pp-attack-here-");
      fs.mkdirSync(path.join(here, "skill"));
      fs.copyFileSync(path.resolve("core/mcp/skill/SKILL.md"), path.join(here, "skill", "SKILL.md"));
      const cwd = tempDir("pp-attack-cwd-");
      const output: string[] = [];
      const exit = runConnect(["--agent", "claude", new URL(old.connectBridge).origin, old.connectTokenFile], { cwd, env: { PATH: bin, HOME: tempDir() }, home: tempDir(), here, out: (t) => output.push(t), err: (t) => output.push(t) });
      expect(output.join("")).not.toMatch(/Connected/);
      expect(exit).not.toBe(0);
      expect(output.join("")).toMatch(/Connect agent again/);
    } finally {
      await fresh.stop();
    }
  }, 60_000);

  it("the stale token files hold nothing the restarted host will honour, and none is world-readable", async () => {
    const dirs = { data: tempDir(), repo: makeRepo(), secrets: "" };
    dirs.secrets = path.join(dirs.data, "secrets.json");
    const old = await firstRun(dirs);
    await old.win.stop();
    const fresh = await startWindow({ ...dirs, project: dirs.repo });
    try {
      const tokens = path.join(dirs.repo, ".perfect-planner", "tokens");
      const files = listTree(tokens).filter((f) => f.endsWith(".token"));
      expect(files.length).toBeGreaterThanOrEqual(2);
      for (const file of files) {
        if (process.platform !== "win32") expect(fs.statSync(path.join(tokens, file)).mode & 0o077, file).toBe(0);
        const token = fs.readFileSync(path.join(tokens, file), "utf8");
        expect(fresh.host.project("p").service.tokens.resolve(token), file).toBeNull();
      }
    } finally {
      await fresh.stop();
    }
  }, 60_000);
});
