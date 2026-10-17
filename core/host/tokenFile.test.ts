import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { icaclsPath, isNetworkPath, writeOwnerOnlyFile } from "./tokenFile";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-token-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("network paths", () => {
  it("treats UNC, device and double-slash paths as network paths, and local drive paths as local", () => {
    expect(isNetworkPath("\\\\host\\share\\x.token", "win32")).toBe(true);
    expect(isNetworkPath("//host/share/x.token", "win32")).toBe(true);
    expect(isNetworkPath("\\\\?\\UNC\\host\\share\\x.token", "win32")).toBe(true);
    expect(isNetworkPath("\\\\.\\pipe\\x.token", "win32")).toBe(true);
    expect(isNetworkPath("//host/share/x.token", "linux")).toBe(true);
    expect(isNetworkPath("\\/host/s/x.token", "win32")).toBe(true);
    expect(isNetworkPath("/\\host\\s\\x.token", "win32")).toBe(true);
    expect(isNetworkPath("\\??\\UNC\\host\\s\\x.token", "win32")).toBe(true);
    expect(isNetworkPath("\\Users\\me\\x.token", "win32")).toBe(true);
    expect(isNetworkPath("C:x.token", "win32")).toBe(true);
    expect(isNetworkPath("C:\\Users\\me\\x.token", "win32")).toBe(false);
    expect(isNetworkPath("d:\\pp\\x.token", "win32")).toBe(false);
    expect(isNetworkPath("/home/me/x.token", "linux")).toBe(false);
  });
});

describe("owner-only token file", () => {
  it("writes the token so only this user can read it, replacing an older file", () => {
    const file = path.join(dir, "tokens", "C-1.token");
    writeOwnerOnlyFile(file, "first");
    writeOwnerOnlyFile(file, "second");
    expect(fs.readFileSync(file, "utf8")).toBe("second");
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o077).toBe(0);
      expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
    }
  });

  it("refuses to write through a link planted where the token goes", () => {
    const file = path.join(dir, "tokens", "C-1.token");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const target = path.join(dir, "elsewhere.txt");
    fs.writeFileSync(target, "untouched");
    try {
      fs.symlinkSync(target, file);
    } catch {
      return; // creating symlinks needs Developer Mode on Windows; nothing to test then
    }
    writeOwnerOnlyFile(file, "secret");
    expect(fs.readFileSync(target, "utf8")).toBe("untouched");
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
  });

  it.runIf(process.platform === "win32")("on Windows, grants the token file to this user alone, with no inherited access", () => {
    const file = path.join(dir, "tokens", "C-1.token");
    writeOwnerOnlyFile(file, "secret");
    for (const target of [file, path.dirname(file)]) {
      const acl = execFileSync(icaclsPath(), [target], { encoding: "utf8" });
      expect(acl).toContain(os.userInfo().username);
      expect(acl).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/i);
    }
    expect(fs.readFileSync(file, "utf8")).toBe("secret");
  });
});
