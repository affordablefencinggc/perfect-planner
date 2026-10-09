import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectArgsProblem, connectPlan, detectAgent, installSkill, keepOutOfGit, parseArgs, SKILL_PROGRAM_PLACEHOLDER } from "./agentConnect";

describe("connect line", () => {
  it("replaces this folder's registration and adds the server with the token file, never the token", () => {
    const here = path.join("/pp", "dist", "core-host");
    const plan = connectPlan({ bridgeUrl: "http://127.0.0.1:5555", tokenFile: "/data/tokens/C-1.token", here, home: "/home/me" });
    expect(plan.remove).toEqual(["mcp", "remove", "perfect-planner-core", "-s", "local"]);
    expect(plan.add).toEqual(["mcp", "add", "perfect-planner-core", "-s", "local", "--env", "PP_BRIDGE_URL=http://127.0.0.1:5555", "--env", "PP_AGENT_TOKEN_FILE=/data/tokens/C-1.token", "--", process.execPath, path.join(here, "agent.mjs")]);
    expect(plan.skillFrom).toBe(path.join(here, "skill", "SKILL.md"));
    expect(plan.skillTo).toEqual([
      path.join("/home/me", ".claude", "skills", "perfect-planner-connect", "SKILL.md"),
      path.join("/home/me", ".agents", "skills", "perfect-planner-connect", "SKILL.md"),
    ]);
  });

  it("registers with Gemini CLI for this folder (project scope) and Codex CLI (user-wide), with the token file, never the token", () => {
    const here = path.join("/pp", "dist", "core-host");
    const base = { bridgeUrl: "http://127.0.0.1:5555", tokenFile: "/data/tokens/C-1.token", here, home: "/home/me" };
    const agent = path.join(here, "agent.mjs");
    const gemini = connectPlan({ ...base, agent: "gemini" });
    expect(gemini.remove).toEqual(["mcp", "remove", "perfect-planner-core", "-s", "project"]);
    // env after the command, so gemini's -e array option cannot swallow the positionals
    expect(gemini.add).toEqual(["mcp", "add", "-s", "project", "perfect-planner-core", process.execPath, agent, "-e", "PP_BRIDGE_URL=http://127.0.0.1:5555", "-e", "PP_AGENT_TOKEN_FILE=/data/tokens/C-1.token"]);
    const codex = connectPlan({ ...base, agent: "codex" });
    expect(codex.remove).toEqual(["mcp", "remove", "perfect-planner-core"]);
    expect(codex.add).toEqual(["mcp", "add", "perfect-planner-core", "--env", "PP_BRIDGE_URL=http://127.0.0.1:5555", "--env", "PP_AGENT_TOKEN_FILE=/data/tokens/C-1.token", "--", process.execPath, agent]);
  });

  it("picks the first installed agent in order claude, gemini, codex, or none", () => {
    expect(detectAgent((a) => a !== "claude")).toBe("gemini");
    expect(detectAgent((a) => a === "codex")).toBe("codex");
    expect(detectAgent(() => true)).toBe("claude");
    expect(detectAgent(() => false)).toBeNull();
  });

  it("reads --agent anywhere on the line and leaves the rest for the line checks", () => {
    expect(parseArgs(["--agent", "gemini", "http://127.0.0.1:1", "/t/C-1.token"])).toEqual({ agent: "gemini", rest: ["http://127.0.0.1:1", "/t/C-1.token"] });
    expect(parseArgs(["http://127.0.0.1:1", "/t/C-1.token", "--agent=codex"])).toEqual({ agent: "codex", rest: ["http://127.0.0.1:1", "/t/C-1.token"] });
    expect(parseArgs(["--skill-only"])).toEqual({ agent: undefined, rest: ["--skill-only"] });
  });

  it("keeps Gemini's settings file out of git, once, and does nothing outside a checkout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-git-"));
    spawnSync("git", ["init", "-q", dir]);
    expect(keepOutOfGit(dir)).toBe(true);
    expect(keepOutOfGit(dir)).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8").match(/\/\.gemini\/settings\.json/g)).toHaveLength(1);
    fs.mkdirSync(path.join(dir, ".gemini"));
    fs.writeFileSync(path.join(dir, ".gemini", "settings.json"), "{}");
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pp-nogit-"));
    expect(keepOutOfGit(plain)).toBe(false);
    fs.rmSync(plain, { recursive: true, force: true });
  });

  it("accepts only a loopback bridge and an absolute .token file, and refuses a pasted key", () => {
    expect(connectArgsProblem(["http://127.0.0.1:5555", "/data/tokens/C-1.token"], "linux")).toBeNull();
    expect(connectArgsProblem(["http://evil.example:80", "/data/tokens/C-1.token"], "linux")).toMatch(/loopback/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "pp_c_0123456789abcdefghij"], "linux")).toMatch(/key/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "relative/C-1.token"], "linux")).toMatch(/token file/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "/data/tokens/C-1.token", "--extra"], "linux")).toMatch(/whole line/);
  });

  it("refuses a token file on a network share, so nothing reaches out over SMB", () => {
    expect(connectArgsProblem(["http://127.0.0.1:5555", "\\\\host\\share\\C-1.token"], "win32")).toMatch(/this computer/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "//host/share/C-1.token"], "win32")).toMatch(/this computer/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "//host/share/C-1.token"], "linux")).toMatch(/this computer/);
  });

  it("refuses characters cmd.exe would expand or split on Windows", () => {
    expect(connectArgsProblem(["http://127.0.0.1:5555", "C:\\Users\\%USERNAME%\\C-1.token"], "win32")).toMatch(/%/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "C:\\Users\\a\"b\\C-1.token"], "win32")).toMatch(/"/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "C:\\Users\\me\\C-1.token"], "win32")).toBeNull();
  });

  it("installs the skill in Claude's and the shared Agent Skills folder, names this program as the only line it may run, and replaces an older copy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-skill-"));
    const here = path.join(dir, "core-host");
    fs.mkdirSync(path.join(here, "skill"), { recursive: true });
    fs.writeFileSync(path.join(here, "skill", "SKILL.md"), `run only ${SKILL_PROGRAM_PLACEHOLDER}`);
    const plan = connectPlan({ bridgeUrl: "", tokenFile: "", here, home: path.join(dir, "home") });
    fs.mkdirSync(path.dirname(plan.skillTo[0]), { recursive: true });
    fs.writeFileSync(plan.skillTo[0], "old");
    installSkill(plan, here);
    for (const to of plan.skillTo) expect(fs.readFileSync(to, "utf8")).toBe(`run only ${path.join(here, "connect.mjs")}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the skill's own rules", () => {
  const skill = fs.readFileSync(path.resolve("core/mcp/skill/SKILL.md"), "utf8");
  it("runs only the exact connect program, after showing the line and getting a yes", () => {
    expect(skill).toContain(SKILL_PROGRAM_PLACEHOLDER);
    expect(skill).toMatch(/reply \*\*yes\*\*/i);
    expect(skill).toMatch(/never run anything else/i);
    expect(skill).not.toMatch(/run it yourself/i);
    expect(skill).not.toContain("claude mcp add perfect-planner-core");
  });
});
