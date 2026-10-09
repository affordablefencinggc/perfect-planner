import { chmodSync, copyFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "./manager";
import { npmCliPath, runNpm } from "./npm";
import { commitAll, makeRepo, memoryLedger, writeFiles } from "./testing";

const isWindows = process.platform === "win32";
const SLOW = 120_000;
const person = { kind: "person", id: "owner" } as const;
const originalPath = process.env.PATH;
const cleanups: (() => void)[] = [];
afterEach(() => {
  process.env.PATH = originalPath;
  while (cleanups.length) cleanups.pop()!();
});

const LOCK = { name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "app", version: "1.0.0" } } };

/** Every spelling of npm (and a node beside an npm-cli.js) a shell or a PATH walk could pick up, each leaving a marker. */
function plantNpm(dir: string, marker: string): void {
  const js = `require("fs").writeFileSync(${JSON.stringify(marker)}, "planted");\n`;
  writeFiles(dir, { "node_modules/npm/bin/npm-cli.js": js, "npm-cli.js": js, "npm.cmd": `@echo planted> "${marker}"\r\n` });
  writeFileSync(path.join(dir, "npm"), `#!/bin/sh\necho planted > "${marker}"\n`);
  chmodSync(path.join(dir, "npm"), 0o755);
  if (isWindows) {
    for (const exe of ["npm.exe", "node.exe"]) copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), path.join(dir, exe));
  }
}

describe("npm for worktree installs", () => {
  it("never runs an npm planted in the project, even through a symlinked or relative PATH entry", async () => {
    const repo = await makeRepo({ "package.json": JSON.stringify({ name: "app", version: "1.0.0" }), "package-lock.json": JSON.stringify(LOCK) });
    cleanups.push(repo.cleanup);
    const marker = path.join(path.dirname(repo.root), "planted-ran");
    plantNpm(repo.root, marker);
    await commitAll(repo.root, "planted npm");
    const link = `${repo.root}-link`;
    symlinkSync(repo.root, link, isWindows ? "junction" : "dir");
    cleanups.push(() => rmSync(link, { recursive: true, force: true }));
    process.env.PATH = [link, ".", "", repo.root, originalPath].join(path.delimiter);

    expect(path.resolve(npmCliPath(repo.root, [], process.env)).startsWith(repo.root)).toBe(false);
    const ledger = await memoryLedger();
    const manager = new WorktreeManager({ repoRoot: repo.root, ledger, ports: [43200, 43299] });
    const info = await manager.create({ taskId: "T-1", actor: person });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(info.path, "node_modules"))).toBe(true);
  }, SLOW);

  it("skips packages' install scripts unless a person allowed them", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'postinstall-ran\', \'\')"' } }),
      "package-lock.json": JSON.stringify(LOCK),
    });
    cleanups.push(repo.cleanup);
    expect((await runNpm(["ci", "--no-audit", "--no-fund"], { cwd: repo.root })).code).toBe(0);
    expect(existsSync(path.join(repo.root, "postinstall-ran"))).toBe(false);
    expect((await runNpm(["ci", "--no-audit", "--no-fund"], { cwd: repo.root, allowInstallScripts: true })).code).toBe(0);
    expect(existsSync(path.join(repo.root, "postinstall-ran"))).toBe(true);
  }, SLOW);

  it("ignores a hostile project .npmrc that points git or the script shell at the repo", async () => {
    const repo = await makeRepo({
      "package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'postinstall-ran\', \'\')"' } }),
      "package-lock.json": JSON.stringify(LOCK),
    });
    cleanups.push(repo.cleanup);
    const marker = path.join(path.dirname(repo.root), "hostile-ran");
    const evil = isWindows ? "evil.cmd" : "evil.sh";
    writeFiles(repo.root, { [evil]: isWindows ? `@echo planted> "${marker}"\r\n` : `#!/bin/sh\necho planted > "${marker}"\n` });
    if (!isWindows) chmodSync(path.join(repo.root, evil), 0o755);
    const target = path.join(repo.root, evil);
    writeFiles(repo.root, { ".npmrc": `git=${target}\nscript-shell=${target}\nnode-options=--require ${target}\n` });
    const config = async (key: string) => (await runNpm(["config", "get", key], { cwd: repo.root })).output.trim();
    expect(await config("git")).not.toContain(repo.root);
    expect(await config("script-shell")).not.toContain(repo.root);
    expect((await runNpm(["ci", "--no-audit", "--no-fund"], { cwd: repo.root, allowInstallScripts: true })).code).toBe(0);
    expect(existsSync(path.join(repo.root, "postinstall-ran"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  }, SLOW);

  it("names the person-only switch and the ignored npm settings when an install fails", async () => {
    const repo = await makeRepo({ "package.json": "{ not json", "package-lock.json": JSON.stringify(LOCK) });
    cleanups.push(repo.cleanup);
    const ledger = await memoryLedger();
    const manager = new WorktreeManager({ repoRoot: repo.root, ledger, ports: [43300, 43399] });
    await expect(manager.create({ taskId: "T-2", actor: person })).rejects.toThrow(/allowInstallScripts/);
    await expect(manager.create({ taskId: "T-3", actor: person })).rejects.toThrow(/registry login and proxy/);
  }, SLOW);
});
