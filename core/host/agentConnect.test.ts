import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectPlan, detectAgent, installSkill, keepOutOfGit, parseArgs } from "./agentConnect";

const here = path.join("/pp", "dist", "core-host");
const base = { bridgeUrl: "http://127.0.0.1:5555", token: "pp_c_abc", here, home: "/home/me" };
const agent = path.join(here, "agent.mjs");

describe("connect line", () => {
  it("replaces this folder's Claude Code registration, then adds the server with the bridge and token", () => {
    const plan = connectPlan(base);
    expect(plan.agent).toBe("claude");
    expect(plan.remove).toEqual(["mcp", "remove", "perfect-planner-core", "-s", "local"]);
    expect(plan.add).toEqual(["mcp", "add", "perfect-planner-core", "-s", "local", "--env", "PP_BRIDGE_URL=http://127.0.0.1:5555", "--env", "PP_AGENT_TOKEN=pp_c_abc", "--", process.execPath, agent]);
  });

  it("registers with Gemini CLI for this folder (project scope), env after the command so yargs keeps the positionals", () => {
    const plan = connectPlan({ ...base, agent: "gemini" });
    expect(plan.remove).toEqual(["mcp", "remove", "perfect-planner-core", "-s", "project"]);
    expect(plan.add).toEqual(["mcp", "add", "-s", "project", "perfect-planner-core", process.execPath, agent, "-e", "PP_BRIDGE_URL=http://127.0.0.1:5555", "-e", "PP_AGENT_TOKEN=pp_c_abc"]);
  });

  it("registers with Codex CLI, replacing its one user-wide entry", () => {
    const plan = connectPlan({ ...base, agent: "codex" });
    expect(plan.remove).toEqual(["mcp", "remove", "perfect-planner-core"]);
    expect(plan.add).toEqual(["mcp", "add", "perfect-planner-core", "--env", "PP_BRIDGE_URL=http://127.0.0.1:5555", "--env", "PP_AGENT_TOKEN=pp_c_abc", "--", process.execPath, agent]);
  });

  it("copies the one SKILL.md to Claude's folder and the shared Agent Skills folder Gemini and Codex read", () => {
    for (const kind of ["claude", "gemini", "codex"] as const) {
      const plan = connectPlan({ ...base, agent: kind });
      expect(plan.skillFrom).toBe(path.join(here, "skill", "SKILL.md"));
      expect(plan.skillTo).toEqual([
        path.join("/home/me", ".claude", "skills", "perfect-planner-connect", "SKILL.md"),
        path.join("/home/me", ".agents", "skills", "perfect-planner-connect", "SKILL.md"),
      ]);
    }
  });

  it("installs the skill in every folder and replaces older copies", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-skill-"));
    const from = path.join(dir, "core-host");
    fs.mkdirSync(path.join(from, "skill"), { recursive: true });
    fs.writeFileSync(path.join(from, "skill", "SKILL.md"), "new");
    const plan = connectPlan({ bridgeUrl: "", token: "", here: from, home: path.join(dir, "home") });
    fs.mkdirSync(path.dirname(plan.skillTo[0]), { recursive: true });
    fs.writeFileSync(plan.skillTo[0], "old");
    installSkill(plan);
    for (const to of plan.skillTo) expect(fs.readFileSync(to, "utf8")).toBe("new");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("picks the first installed agent in order claude, gemini, codex, or none", () => {
    expect(detectAgent((a) => a !== "claude")).toBe("gemini");
    expect(detectAgent((a) => a === "codex")).toBe("codex");
    expect(detectAgent(() => true)).toBe("claude");
    expect(detectAgent(() => false)).toBeNull();
  });

  it("reads --agent anywhere on the line", () => {
    expect(parseArgs(["--agent", "gemini", "http://127.0.0.1:1", "pp_c_x"])).toEqual({ agent: "gemini", skillOnly: false, rest: ["http://127.0.0.1:1", "pp_c_x"] });
    expect(parseArgs(["http://127.0.0.1:1", "pp_c_x", "--agent=codex"])).toEqual({ agent: "codex", skillOnly: false, rest: ["http://127.0.0.1:1", "pp_c_x"] });
    expect(parseArgs(["--skill-only"])).toEqual({ agent: undefined, skillOnly: true, rest: [] });
  });

  it("keeps Gemini's settings file (it holds the key) out of git, once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-git-"));
    spawnSync("git", ["init", "-q", dir]);
    expect(keepOutOfGit(dir)).toBe(true);
    expect(keepOutOfGit(dir)).toBe(true);
    const exclude = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/\/\.gemini\/settings\.json/g)).toHaveLength(1);
    fs.mkdirSync(path.join(dir, ".gemini"));
    fs.writeFileSync(path.join(dir, ".gemini", "settings.json"), "{}");
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing outside a git checkout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-nogit-"));
    expect(keepOutOfGit(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
