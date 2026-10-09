import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectPlan, installSkill } from "./agentConnect";

describe("connect line", () => {
  it("replaces this folder's registration, then adds the server with the bridge and token, and installs the skill for the user", () => {
    const here = path.join("/pp", "dist", "core-host");
    const plan = connectPlan({ bridgeUrl: "http://127.0.0.1:5555", token: "pp_c_abc", here, home: "/home/me" });
    expect(plan.remove).toEqual(["mcp", "remove", "perfect-planner-core", "-s", "local"]);
    expect(plan.add).toEqual(["mcp", "add", "perfect-planner-core", "-s", "local", "--env", "PP_BRIDGE_URL=http://127.0.0.1:5555", "--env", "PP_AGENT_TOKEN=pp_c_abc", "--", process.execPath, path.join(here, "agent.mjs")]);
    expect(plan.skillFrom).toBe(path.join(here, "skill", "SKILL.md"));
    expect(plan.skillTo).toBe(path.join("/home/me", ".claude", "skills", "perfect-planner-connect", "SKILL.md"));
  });

  it("installs the skill in the user's own Claude folder and replaces an older copy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-skill-"));
    const here = path.join(dir, "core-host");
    fs.mkdirSync(path.join(here, "skill"), { recursive: true });
    fs.writeFileSync(path.join(here, "skill", "SKILL.md"), "new");
    const plan = connectPlan({ bridgeUrl: "", token: "", here, home: path.join(dir, "home") });
    fs.mkdirSync(path.dirname(plan.skillTo), { recursive: true });
    fs.writeFileSync(plan.skillTo, "old");
    installSkill(plan);
    expect(fs.readFileSync(plan.skillTo, "utf8")).toBe("new");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
