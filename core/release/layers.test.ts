import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installPrePushHook, prePushInstalled, prePushShim, secretPosture } from "./layers";
import type { CommandRunner } from "./types";
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

  it("writes a hook shim with forward slashes, single-quoted so sh expands nothing", () => {
    const shim = prePushShim("C:\\repos\\pp\\core\\release\\hooks\\pre-push.mjs", {}, "C:\\Program Files\\nodejs\\node.exe");
    expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shim).toContain(`exec 'C:/Program Files/nodejs/node.exe' 'C:/repos/pp/core/release/hooks/pre-push.mjs' "$@"`);
    expect(prePushShim("/opt/it's $(x)/pre-push.mjs", {}, "/usr/bin/node")).toContain(`exec '/usr/bin/node' '/opt/it'\\''s $(x)/pre-push.mjs' "$@"`);
  });

  it("runs the desktop app's own Node when it names one", () => {
    const shim = prePushShim("C:\\PP\\desktop-host\\core-host\\hooks\\pre-push.mjs", { PP_NODE_BINARY: "C:\\Program Files\\PP\\desktop-host\\node.exe" });
    expect(shim).toContain(`exec 'C:/Program Files/PP/desktop-host/node.exe' 'C:/PP/desktop-host/core-host/hooks/pre-push.mjs' "$@"`);
  });

  it("otherwise names the host's own Node by absolute path, never a bare node", () => {
    const shim = prePushShim("/opt/pp/pre-push.mjs", {});
    expect(shim).toContain(`exec '${process.execPath.replace(/\\/g, "/")}' '/opt/pp/pre-push.mjs'`);
    expect(shim).not.toMatch(/exec node /);
  });
});

describe("installing the pre-push scan", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const run: CommandRunner = async (command, args, options) => {
    try {
      return { code: 0, stdout: execFileSync(command, args as string[], { cwd: options?.cwd, encoding: "utf8" }), stderr: "" };
    } catch (error) {
      return { code: 1, stdout: "", stderr: String(error) };
    }
  };

  it("writes the shim into the repo's hooks folder, and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-prepush-"));
    try {
      git(dir, "init", "-q");
      const first = await installPrePushHook(run, { cwd: dir, hookScript: "/opt/pp/pre-push.mjs" });
      expect(first.installed).toBe(true);
      const hookFile = join(dir, ".git", "hooks", "pre-push");
      expect(readFileSync(hookFile, "utf8")).toBe(prePushShim("/opt/pp/pre-push.mjs"));
      if (process.platform !== "win32") expect(statSync(hookFile).mode & 0o111).not.toBe(0);
      const again = await installPrePushHook(run, { cwd: dir, hookScript: "/opt/pp/pre-push.mjs" });
      expect(again).toMatchObject({ installed: true });
      expect(await prePushInstalled(run, { cwd: dir })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites someone else's pre-push hook and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-prepush-"));
    try {
      git(dir, "init", "-q");
      const hookFile = join(dir, ".git", "hooks", "pre-push");
      writeFileSync(hookFile, "#!/bin/sh\necho mine\n");
      const result = await installPrePushHook(run, { cwd: dir, hookScript: "/opt/pp/pre-push.mjs" });
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/already has its own pre-push hook/);
      expect(readFileSync(hookFile, "utf8")).toBe("#!/bin/sh\necho mine\n");
      expect(await prePushInstalled(run, { cwd: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows core.hooksPath, where core/worktrees puts its hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-prepush-"));
    try {
      git(dir, "init", "-q");
      mkdirSync(join(dir, "hooks-here"));
      git(dir, "config", "core.hooksPath", "hooks-here");
      const result = await installPrePushHook(run, { cwd: dir, hookScript: "/opt/pp/pre-push.mjs" });
      expect(result.installed).toBe(true);
      expect(existsSync(join(dir, "hooks-here", "pre-push"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
