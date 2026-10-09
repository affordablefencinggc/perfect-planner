import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectArgsProblem, connectPlan, installSkill, SKILL_PROGRAM_PLACEHOLDER } from "./agentConnect";

describe("connect line", () => {
  it("replaces this folder's registration and adds the server with the token file, never the token", () => {
    const here = path.join("/pp", "dist", "core-host");
    const plan = connectPlan({ bridgeUrl: "http://127.0.0.1:5555", tokenFile: "/data/tokens/C-1.token", here, home: "/home/me" });
    expect(plan.remove).toEqual(["mcp", "remove", "perfect-planner-core", "-s", "local"]);
    expect(plan.add).toEqual(["mcp", "add", "perfect-planner-core", "-s", "local", "--env", "PP_BRIDGE_URL=http://127.0.0.1:5555", "--env", "PP_AGENT_TOKEN_FILE=/data/tokens/C-1.token", "--", process.execPath, path.join(here, "agent.mjs")]);
    expect(plan.skillFrom).toBe(path.join(here, "skill", "SKILL.md"));
    expect(plan.skillTo).toBe(path.join("/home/me", ".claude", "skills", "perfect-planner-connect", "SKILL.md"));
  });

  it("accepts only a loopback bridge and an absolute .token file, and refuses a pasted key", () => {
    expect(connectArgsProblem(["http://127.0.0.1:5555", "/data/tokens/C-1.token"], "linux")).toBeNull();
    expect(connectArgsProblem(["http://evil.example:80", "/data/tokens/C-1.token"], "linux")).toMatch(/loopback/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "pp_c_0123456789abcdefghij"], "linux")).toMatch(/key/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "relative/C-1.token"], "linux")).toMatch(/token file/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "/data/tokens/C-1.token", "--extra"], "linux")).toMatch(/whole line/);
  });

  it("refuses characters cmd.exe would expand or split on Windows", () => {
    expect(connectArgsProblem(["http://127.0.0.1:5555", "C:\\Users\\%USERNAME%\\C-1.token"], "win32")).toMatch(/%/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "C:\\Users\\a\"b\\C-1.token"], "win32")).toMatch(/"/);
    expect(connectArgsProblem(["http://127.0.0.1:5555", "C:\\Users\\me\\C-1.token"], "win32")).toBeNull();
  });

  it("installs the skill in the user's own Claude folder, names this program as the only line it may run, and replaces an older copy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-skill-"));
    const here = path.join(dir, "core-host");
    fs.mkdirSync(path.join(here, "skill"), { recursive: true });
    fs.writeFileSync(path.join(here, "skill", "SKILL.md"), `run only ${SKILL_PROGRAM_PLACEHOLDER}`);
    const plan = connectPlan({ bridgeUrl: "", tokenFile: "", here, home: path.join(dir, "home") });
    fs.mkdirSync(path.dirname(plan.skillTo), { recursive: true });
    fs.writeFileSync(plan.skillTo, "old");
    installSkill(plan, here);
    expect(fs.readFileSync(plan.skillTo, "utf8")).toBe(`run only ${path.join(here, "connect.mjs")}`);
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
