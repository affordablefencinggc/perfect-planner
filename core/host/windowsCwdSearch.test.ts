// Evidence for the Gemini CLI / Codex CLI Windows note in the perfect-planner-connect skill: an agent
// shell that runs the connect line's bare `node` must not pick up a node.cmd planted in the project
// folder. PowerShell (what Gemini CLI and Codex CLI use on Windows) never runs commands from the
// current folder; cmd.exe does, unless NoDefaultCurrentDirectoryInExePath is set.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");

describe.skipIf(process.platform !== "win32")("a node.cmd planted in the project folder (Windows)", () => {
  let project: string;
  const marker = () => path.join(project, "planted-ran.txt");

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "pp-planted-"));
    fs.writeFileSync(path.join(project, "node.cmd"), `@echo off\r\necho planted> "%~dp0planted-ran.txt"\r\n`);
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it("never runs from PowerShell, the shell Gemini CLI and Codex CLI use", () => {
    const powershell = path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "node --version"], { cwd: project, encoding: "utf8", windowsHide: true });
    expect(result.stdout.trim()).toMatch(/^v\d+\./);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it("runs from cmd.exe, which searches the current folder first, unless NoDefaultCurrentDirectoryInExePath is set", () => {
    const cmd = path.join(system32, "cmd.exe");
    spawnSync(cmd, ["/d", "/c", "node --version"], { cwd: project, encoding: "utf8", windowsHide: true });
    expect(fs.existsSync(marker())).toBe(true);
    fs.rmSync(marker());
    const safe = spawnSync(cmd, ["/d", "/c", "node --version"], { cwd: project, encoding: "utf8", windowsHide: true, env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" } });
    expect(safe.stdout.trim()).toMatch(/^v\d+\./);
    expect(fs.existsSync(marker())).toBe(false);
  });
});
