import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectArgsProblem, connectLineProblem } from "./agentConnect";
import { icaclsPath, isNetworkPath, writeOwnerOnlyFile, type RunSystemTool } from "./tokenFile";

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

const SPELLINGS = ["\\\\host\\share\\x.token", "//host/share/x.token", "\\/host/s/x.token", "/\\host\\s\\x.token", "\\\\?\\UNC\\host\\s\\x.token", "\\\\.\\pipe\\x.token", "\\??\\UNC\\host\\s\\x.token", "\\Users\\me\\x.token", "C:x.token"];

describe("a token file on a network share is refused by every caller, whatever the slashes", () => {
  it("the connect arguments and the pasted connect line both say 'network share', and nothing is created", () => {
    for (const bad of SPELLINGS) {
      expect(connectArgsProblem(["http://127.0.0.1:4000", bad], "win32"), bad).toMatch(/network share/);
      const line = `node 'C:\\app\\connect.mjs' http://127.0.0.1:4000 '${bad}'`;
      const problem = connectLineProblem(line, "C:\\app", "win32");
      expect(problem, line).not.toBeNull();
    }
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("the owner-only ACL on Windows (icacls stood in for)", () => {
  const SID = "S-1-5-21-111-222-333-1001";
  const fake = (calls: string[][], failIcaclsAt?: number): RunSystemTool => (file, args) => {
    calls.push([path.win32.basename(file).toLowerCase(), ...args]);
    if (/whoami/i.test(file)) return `"HOST\\me","${SID}"\r\n`;
    if (failIcaclsAt !== undefined && calls.filter((c) => c[0] === "icacls.exe").length >= failIcaclsAt) throw new Error("icacls: Access is denied");
    return "";
  };

  it("grants the user by SID, not by a domain and name that may be missing or renamed", () => {
    const calls: string[][] = [];
    writeOwnerOnlyFile(path.join(dir, "t", "C-1.token"), "secret", "win32", fake(calls));
    const grants = calls.filter((c) => c[0] === "icacls.exe");
    expect(grants).toHaveLength(2);
    for (const g of grants) expect(g.slice(2)).toEqual(["/inheritance:r", "/grant:r", `*${SID}:F`]);
  });

  it("deletes the token file and throws when icacls fails, so a secret never stays behind with the wrong access", () => {
    const file = path.join(dir, "t", "C-1.token");
    expect(() => writeOwnerOnlyFile(file, "secret", "win32", fake([], 2))).toThrow(/Access is denied/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("writes nothing when the user cannot be identified", () => {
    const file = path.join(dir, "t", "C-1.token");
    expect(() => writeOwnerOnlyFile(file, "secret", "win32", () => "garbage")).toThrow(/which Windows user/);
    expect(fs.existsSync(file)).toBe(false);
  });
});
