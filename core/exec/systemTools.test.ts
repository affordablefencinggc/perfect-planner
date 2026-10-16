import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keyStoreTool } from "./systemTools";

const isWindows = process.platform === "win32";
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "pp-keytool-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function plant(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

describe("keyStoreTool", () => {
  it("gives Windows PowerShell's full system path, never a bare name", () => {
    expect(keyStoreTool("powershell", { platform: "win32", env: { SystemRoot: "D:\\Win" } })).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(keyStoreTool("powershell", { platform: "win32", env: { SYSTEMROOT: "C:\\WINDOWS" } })).toBe("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    // A missing, relative or network SystemRoot is ignored: the default Windows folder is used.
    for (const root of [undefined, "Windows", ".\\", "\\\\server\\share", "\\\\?\\UNC\\server\\share"]) {
      expect(keyStoreTool("powershell", { platform: "win32", env: root === undefined ? {} : { SystemRoot: root } })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    }
    expect(keyStoreTool("powershell", { platform: "linux" })).toBeNull();
  });

  it("gives /usr/bin/security on macOS whatever PATH holds", () => {
    const planted = tempDir();
    plant(planted, "security");
    expect(keyStoreTool("security", { platform: "darwin", env: { PATH: planted }, cwd: planted })).toBe("/usr/bin/security");
    expect(keyStoreTool("security", { platform: "linux" })).toBeNull();
  });

  it("prefers secret-tool in /usr/bin over any copy on PATH", () => {
    const planted = tempDir();
    plant(planted, "secret-tool");
    const isFile = (file: string) => file === "/usr/bin/secret-tool";
    expect(keyStoreTool("secret-tool", { platform: "linux", env: { PATH: planted }, isFile })).toBe("/usr/bin/secret-tool");
  });

  it.skipIf(isWindows)("never takes secret-tool from the current folder, a relative PATH entry or a protected root", () => {
    const repo = tempDir();
    const project = path.join(repo, "apps", "web");
    mkdirSync(project, { recursive: true });
    plant(project, "secret-tool");
    plant(path.join(repo, "bin"), "secret-tool");
    const tools = tempDir();
    const real = plant(tools, "secret-tool");
    const noFixed = () => false;
    const find = (pathValue: string, protect: string[] = []) =>
      keyStoreTool("secret-tool", { platform: "linux", env: { PATH: pathValue }, cwd: project, protect, isFile: noFixed });
    expect(find(`.:${project}:${tools}`)).toBe(real);
    expect(find(`${path.join(repo, "bin")}:${tools}`, [repo])).toBe(real);
    expect(find(`.:${project}`)).toBeNull();
  });
});
