import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectPlan } from "./agentConnect";

describe("connect line", () => {
  it("replaces this folder's registration, then adds the server with the bridge and token, and installs the skill for the user", () => {
    const here = path.join("/pp", "dist", "core-host");
    const plan = connectPlan({ bridgeUrl: "http://127.0.0.1:5555", token: "pp_c_abc", here, home: "/home/me" });
    expect(plan.remove).toEqual(["mcp", "remove", "perfect-planner-core", "-s", "local"]);
    expect(plan.add).toEqual(["mcp", "add", "perfect-planner-core", "-s", "local", "--env", "PP_BRIDGE_URL=http://127.0.0.1:5555", "--env", "PP_AGENT_TOKEN=pp_c_abc", "--", process.execPath, path.join(here, "agent.mjs")]);
    expect(plan.skillFrom).toBe(path.join(here, "skill", "SKILL.md"));
    expect(plan.skillTo).toBe(path.join("/home/me", ".claude", "skills", "perfect-planner-connect", "SKILL.md"));
  });
});
