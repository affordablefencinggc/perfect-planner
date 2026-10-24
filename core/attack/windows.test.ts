// Attack 12: the Windows-only list from the flawless map: a planted .cmd found through PATHEXT, taskkill without
// SystemRoot, and key-store errors that are reported as "missing" (the known vault follow-up).
//
// The first two need a Windows machine and are skipped everywhere else (their names say so). They were written without
// being run on Windows: the first run of this file on the Windows CI job (ready PRs, main, tags) is their first run,
// and a red result there should be read as "check the test" as well as "check the code".
//
// The other groups run on every system: taskkill is driven with a stand-in spawn, and the Windows key-store code with
// a made-up platform and made-up helper programs, so the failure paths can be seen without a Credential Locker.
// Both were once marked it.fails (known gaps); the owner approved the fixes on 2026-10-23 and they are plain tests now.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { killTree, killWindowsTree } from "../gate/run";
import { createJevTransport, createOsKeyProvider, type RunResult } from "../jev/index";
import { osSecretStore } from "../ledger/keychain";
import { addTask, buildCheckApprove, cleanTemp, dispatchAndApproveTest, makeRepo, sleep, startWindow, tempDir } from "./helpers";

afterAll(cleanTemp);
const q = "?project=p";
const WINDOWS = process.platform === "win32";
const ON_WINDOWS_ONLY = "needs a Windows machine (cmd.exe, PATHEXT, taskkill.exe); skipped on other systems";

describe.skipIf(!WINDOWS)(`attack 12: a .cmd planted in the worker's folder is never started through PATHEXT (${ON_WINDOWS_ONLY})`, () => {
  it("the whole flow runs the real node; node.cmd and npm.cmd committed at the root of the worktree never run", async () => {
    const marker = path.join(tempDir("pp-attack-marker-"), "planted-cmd-ran");
    const before = process.env.PATHEXT;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    const repo = makeRepo();
    const data = tempDir();
    const win = await startWindow({ data, project: repo, secrets: path.join(data, "secrets.json") });
    try {
      const task = await addTask(win, q);
      const w = await dispatchAndApproveTest(win, q, task);
      const planted = `@echo planted %0>>"${marker}"\r\n@exit /b 0\r\n`;
      const head = await buildCheckApprove(win, q, w, { "node.cmd": planted, "npm.cmd": planted, "git.cmd": planted });
      const merged = await win.call("POST", `/tasks/${task}/merge${q}`, { commit: head });
      expect(merged.status, JSON.stringify(merged.body)).toBe(200);
      expect(fs.existsSync(marker), "a planted .cmd was started").toBe(false);
    } finally {
      if (before === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = before;
      await win.stop();
    }
  }, 120_000);
});

describe.skipIf(!WINDOWS)(`attack 12: killing a test that hangs, with SystemRoot missing from the environment (${ON_WINDOWS_ONLY})`, () => {
  // Was red on windows-latest (run 39034322787): the hung process was still running after killTree with SystemRoot removed.
  // killTree now gives taskkill SystemRoot in its own environment and falls back to child.kill() when taskkill fails.
  // Written without a Windows machine: the first run on the ready PR's Windows job decides.
  it("killTree still ends the whole process tree (it falls back to C:\\Windows\\System32\\taskkill.exe)", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { windowsHide: true, stdio: "ignore" });
    const pid = child.pid!;
    const saved = process.env.SystemRoot;
    const savedUpper = process.env.SYSTEMROOT;
    delete process.env.SystemRoot;
    delete process.env.SYSTEMROOT;
    try {
      await Promise.race([killTree(child), sleep(15_000)]);
    } finally {
      if (saved !== undefined) process.env.SystemRoot = saved;
      if (savedUpper !== undefined) process.env.SYSTEMROOT = savedUpper;
    }
    let alive = true;
    for (let i = 0; i < 30 && alive; i += 1) {
      try {
        process.kill(pid, 0);
        await sleep(200);
      } catch {
        alive = false;
      }
    }
    if (alive) child.kill();
    expect(alive, "the hung test is still running after killTree").toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------- taskkill rules (#41), on any system, with a stand-in spawn

describe("attack 12: killWindowsTree starts only the system taskkill and never leaves the tree running", () => {
  const stand = (exitCode: number | "error") => {
    const started: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const spawnImpl = ((file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      started.push({ file, args, env: options.env });
      const killer = new EventEmitter();
      queueMicrotask(() => (exitCode === "error" ? killer.emit("error", new Error("ENOENT")) : killer.emit("exit", exitCode)));
      return killer;
    }) as unknown as typeof spawn;
    const killed: number[] = [];
    const child = { pid: 777, kill: () => killed.push(1) } as unknown as ChildProcess;
    return { started, spawnImpl, killed, child };
  };

  it("ignores a SystemRoot that is not a local drive-letter path, and hands taskkill a good one", async () => {
    for (const root of ["\\\\evil\\share", "//evil/share", "relative", ""]) {
      const s = stand(0);
      await killWindowsTree(s.child, s.spawnImpl, { SystemRoot: root });
      expect(s.started[0]!.file, root).toBe("C:\\Windows\\System32\\taskkill.exe");
      expect(s.started[0]!.env.SystemRoot).toBe("C:\\Windows");
      expect(s.started[0]!.args).toEqual(["/pid", "777", "/T", "/F"]);
      expect(s.killed).toEqual([]);
    }
  });

  it("falls back to killing the child when taskkill cannot start or fails, but not when the process is already gone (128)", async () => {
    for (const [code, expected] of [["error", 1], [1, 1], [5, 1], [0, 0], [128, 0]] as const) {
      const s = stand(code);
      await killWindowsTree(s.child, s.spawnImpl, {});
      expect(s.killed.length, String(code)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------- key-store errors, on any system

const JEV_REQUEST = { model: "jev-latest", state: {}, questions: { q: { type: "choice" as const, instructions: "?", criteria: { a: "a" } } } };
const WIN_LOCATE = () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

describe("attack 12: a key store that errors must not look like a key that was never saved", () => {
  const sent: string[] = [];
  const neverFetch = (async (url: string | URL | Request) => {
    sent.push(String(url));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const brokenStore = (result: RunResult) => createOsKeyProvider({ platform: "win32", run: async () => result, locate: WIN_LOCATE });

  it("control: with the store broken or PowerShell missing, no request goes to Jev (the review fails closed)", async () => {
    for (const result of [{ code: 1, stdout: "", stderr: "Access is denied" }, { code: null, stdout: "", stderr: "spawn powershell ENOENT", missing: true }]) {
      const out = await createJevTransport({ keys: brokenStore(result), fetchImpl: neverFetch })(JEV_REQUEST);
      expect(out.ok).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  // REAL DEFECT 6 (known vault follow-up): the transport turns every key-store failure into "No Jev key is saved. Add
  // your TypeSafe key in Settings." A person whose Credential Manager is locked or broken is told to add a key they
  // already saved, and pasting it again hits the same error. Fail-closed holds; the message is the wrong one.
  it("a Credential Manager that answers with an error is reported as a store problem, not as 'No Jev key is saved'", async () => {
    const out = await createJevTransport({ keys: brokenStore({ code: 1, stdout: "", stderr: "Access is denied" }), fetchImpl: neverFetch })(JEV_REQUEST);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).not.toMatch(/No Jev key is saved/i);
    expect(out.detail).toMatch(/credential manager|access is denied|could not/i);
  });

  it("PowerShell missing is reported as a store problem, not as 'No Jev key is saved'", async () => {
    const out = await createJevTransport({ keys: brokenStore({ code: null, stdout: "", stderr: "spawn powershell ENOENT", missing: true }), fetchImpl: neverFetch })(JEV_REQUEST);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).not.toMatch(/No Jev key is saved/i);
  });

  // The signing-key vault has the same shape: its PowerShell helper swallows every error while looking an item up
  // (`try { ... } catch { $null }`) and then prints "missing", so a locked or failing Credential Locker reads as "this
  // key does not exist" and the app may make a new one. Checked on the script the app sends, with a stand-in powershell.
  it.skipIf(WINDOWS)("the signing-key vault's lookup script does not turn an error into 'missing'", () => {
    const dir = tempDir("pp-attack-fakeps-");
    const log = path.join(dir, "scripts.txt");
    const fake = path.join(dir, os.platform() === "win32" ? "powershell.cmd" : "powershell");
    // Records the decoded -EncodedCommand script and answers like a Locker that has nothing for the account.
    fs.writeFileSync(
      fake,
      os.platform() === "win32"
        ? "@echo off\r\nexit /b 0\r\n"
        : `#!/usr/bin/env node\nconst a = process.argv.slice(2); const i = a.indexOf("-EncodedCommand");\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, Buffer.from(a[i + 1], "base64").toString("utf16le") + "\\n=====\\n");\nprocess.stdout.write("missing");\n`,
      { mode: 0o755 },
    );
    const store = osSecretStore("attack-vault", "win32", () => fake);
    expect(store.get("signing")).toBeUndefined();
    const scripts = fs.readFileSync(log, "utf8");
    expect(scripts).toContain("Find-Item");
    expect(scripts, "an error while looking an item up is hidden as 'missing'").not.toMatch(/catch\s*\{\s*\$null\s*\}/);
  });
});
