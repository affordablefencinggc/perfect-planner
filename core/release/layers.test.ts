import { describe, expect, it } from "vitest";
import { prePushShim, secretPosture } from "./layers";
import { withRequiredIgnores } from "./secrets";

const goodIgnore = withRequiredIgnores("node_modules/\n");

describe("secret posture", () => {
  it("is ok only when all four layers are checked and on", () => {
    const posture = secretPosture({
      worktreeEnvFiles: [{ file: ".env", text: "API_KEY=PLACEHOLDER\n" }],
      commitScanInstalled: true,
      prePushInstalled: true,
      gitignoreText: goodIgnore,
      pushProtection: { status: "enabled", detail: "Push protection is on" },
    });
    expect(posture.ok).toBe(true);
    expect(posture.layers.map((layer) => layer.state)).toEqual(["on", "on", "on", "on"]);
  });

  it("reports unchecked layers instead of claiming them", () => {
    const posture = secretPosture({});
    expect(posture.ok).toBe(false);
    expect(posture.layers.every((layer) => layer.state === "unchecked")).toBe(true);
  });

  it("flags a real-looking key in a worktree env file without printing it", () => {
    const key = "ghp_" + "Z9y8X7w6".repeat(5).slice(0, 36);
    const posture = secretPosture({ worktreeEnvFiles: [{ file: "T-1/.env", text: `GH_TOKEN=${key}\n` }] });
    expect(posture.layers[0]).toMatchObject({ state: "off" });
    expect(JSON.stringify(posture)).not.toContain(key);
  });

  it("names what layer 3 is missing", () => {
    const posture = secretPosture({ prePushInstalled: false, gitignoreText: "node_modules/\n" });
    expect(posture.layers[2].state).toBe("off");
    expect(posture.layers[2].summary).toMatch(/pre-push scan not installed; \.gitignore misses \.env/);
  });

  it("treats disabled or unavailable push protection as off and unknown as unchecked", () => {
    expect(secretPosture({ pushProtection: { status: "disabled", detail: "off" } }).layers[3].state).toBe("off");
    expect(secretPosture({ pushProtection: { status: "unavailable", detail: "plan" } }).layers[3].state).toBe("off");
    expect(secretPosture({ pushProtection: { status: "unknown", detail: "no access" } }).layers[3].state).toBe("unchecked");
  });

  it("writes a hook shim with forward slashes", () => {
    const shim = prePushShim("C:\\repos\\pp\\core\\release\\hooks\\pre-push.mjs");
    expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shim).toContain('exec node "C:/repos/pp/core/release/hooks/pre-push.mjs" "$@"');
  });
});
