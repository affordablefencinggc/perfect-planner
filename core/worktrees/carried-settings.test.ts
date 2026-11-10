import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { copyCarriedSettings } from "./git";

it("copies only safe settings, preserves system/global precedence and multiple directory values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-carried-settings-"));
  const system = path.join(root, "system"), global = path.join(root, "global"), target = path.join(root, "target");
  const previous = { system: process.env.GIT_CONFIG_SYSTEM, global: process.env.GIT_CONFIG_GLOBAL, noSystem: process.env.GIT_CONFIG_NOSYSTEM };
  try {
    fs.writeFileSync(system, '[user]\n name = System User\n[safe]\n directory = C:/system-one\n directory = C:/system-two\n[core]\n hooksPath = unsafe-system-hook\n');
    fs.writeFileSync(global, '[user]\n name = Global User\n email = owner@example.invalid\n[safe]\n directory = C:/global\n[core]\n autocrlf = true\n[filter "planted"]\n clean = unsafe-command\n[alias]\n injected = !unsafe-command\n');
    fs.writeFileSync(target, "");
    process.env.GIT_CONFIG_SYSTEM = system;process.env.GIT_CONFIG_GLOBAL = global;delete process.env.GIT_CONFIG_NOSYSTEM;
    copyCarriedSettings("git", root, target);
    const read = (...args: string[]) => execFileSync("git", ["config", "--file", target, ...args], { cwd: root, encoding: "utf8" }).trim();
    expect(read("--get-all", "user.name").split(/\r?\n/)).toEqual(["System User", "Global User"]);
    expect(read("--get", "user.name")).toBe("Global User");
    expect(read("--get-all", "safe.directory").split(/\r?\n/)).toEqual(["C:/system-one", "C:/system-two", "C:/global"]);
    expect(read("--get", "core.autocrlf")).toBe("true");
    expect(read("--get", "user.email")).toBe("owner@example.invalid");
    expect(read("--list")).not.toMatch(/hooksPath|hookspath|filter|alias|unsafe/);
  } finally {
    for (const [name, value] of [["GIT_CONFIG_SYSTEM", previous.system], ["GIT_CONFIG_GLOBAL", previous.global], ["GIT_CONFIG_NOSYSTEM", previous.noSystem]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
