import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git";
import { resolveGit, scanDiff } from "./hooks/secret-scan.mjs";
import { makeRepo } from "./testing";
import { placeholderSecrets, PLACEHOLDER } from "./settings";

describe("secret scan", () => {
  it("flags added lines only, with file and line, and never echoes the secret", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,0 +4,2 @@",
      "+const ok = 1;",
      `+const token = "ghp_${"x".repeat(36)}";`,
      "@@ -10 +12 @@",
      `-const old = "AKIA${"B".repeat(16)}";`,
      "+const fine = 2;",
    ].join("\r\n");
    expect(scanDiff(diff)).toEqual([{ file: "src/a.ts", line: 5, rule: "github-token" }]);
  });

  it("catches .env style secrets and private keys but not placeholders", () => {
    const diff = ["+++ b/.env", "@@ -0,0 +1,3 @@", "+STRIPE_SECRET=abcdefghijklmnopqrstu", `+API_KEY=${PLACEHOLDER}`, `+-----BEGIN OPENSSH ${"PRIVATE"} KEY-----`].join("\n");
    expect(scanDiff(diff).map((finding) => finding.rule)).toEqual(["environment-secret", "private-key"]);
  });
});

describe("placeholderSecrets", () => {
  it("swaps secret values, keeps the rest, keeps line endings", () => {
    // Built at run time so the repo's own secret scan does not flag this fixture.
    const token = ["GITHUB", "TOKEN"].join("_");
    expect(placeholderSecrets(`# comment\nexport ${token}=abc\nPORT=1\nEMPTY_KEY=\r\nAuth.Header = xyz\n`)).toBe(
      `# comment\nexport ${token}=${PLACEHOLDER}\nPORT=1\nEMPTY_KEY=\r\nAuth.Header = ${PLACEHOLDER}\n`,
    );
  });
});

describe("placeholderSecrets on values whose names give nothing away", () => {
  it("replaces every value except plainly safe settings", () => {
    const pass = ["hunter2", "hunter2"].join("");
    const input = [
      "PORT=3000",
      "NODE_ENV=development",
      "DB_HOST=localhost",
      `DATABASE_URL=postgres://app:${pass}@localhost:5432/app`,
      `REDIS_URL="redis://:${pass}@cache:6379"`,
      `DB_PASS=${pass}`,
      "STRIPE=" + ["rk", "live", "a".repeat(24)].join("_"),
      "WEBHOOK=https://hooks.example.invalid/T000/B000/" + "x".repeat(24),
      "FEATURE_X_ENABLED=true",
      "API_HOST=" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4",
      "MYSTERY=anything",
    ].join("\n");
    expect(placeholderSecrets(input).split("\n")).toEqual([
      "PORT=3000",
      "NODE_ENV=development",
      "DB_HOST=localhost",
      `DATABASE_URL=${PLACEHOLDER}`,
      `REDIS_URL=${PLACEHOLDER}`,
      `DB_PASS=${PLACEHOLDER}`,
      `STRIPE=${PLACEHOLDER}`,
      `WEBHOOK=${PLACEHOLDER}`,
      "FEATURE_X_ENABLED=true",
      `API_HOST=${PLACEHOLDER}`,
      `MYSTERY=${PLACEHOLDER}`,
    ]);
  });
});

const isWindows = process.platform === "win32";
const HOOK = fileURLToPath(new URL("./hooks/secret-scan.mjs", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A program called git that leaves a marker if it ever runs, and reports nothing staged. */
function plantGit(dir: string): void {
  if (isWindows) {
    copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), path.join(dir, "git.exe"));
    return;
  }
  const file = path.join(dir, "git");
  writeFileSync(file, `#!/bin/sh\necho planted > "${path.join(dir, "planted-ran")}"\n`);
  chmodSync(file, 0o755);
}

describe("secret scan hook starts the real git", () => {
  it("never runs a git planted in the repo, so a staged secret is still caught", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    cleanups.push(repo.cleanup);
    plantGit(repo.root);
    mkdirSync(path.join(repo.root, "libexec"));
    plantGit(path.join(repo.root, "libexec"));
    writeFileSync(path.join(repo.root, "config.js"), `const api_${"key"} = "${"abcdefghijklm"}nopqrstuvwxyz";\n`);
    await git(repo.root, ["add", "config.js"]);
    for (const env of [
      { PATH: `.${path.delimiter}${process.env.PATH}` },
      { PATH: `${path.delimiter}${repo.root}${path.delimiter}${process.env.PATH}`, GIT_EXEC_PATH: path.join(repo.root, "libexec") },
    ]) {
      const run = spawnSync(process.execPath, [HOOK], { cwd: repo.root, env: { ...process.env, ...env }, encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("config.js:1 (generic-assignment)");
    }
    expect(existsSync(path.join(repo.root, "planted-ran"))).toBe(false);
    expect(existsSync(path.join(repo.root, "libexec", "planted-ran"))).toBe(false);
  });

  it("resolveGit on Windows refuses a local-looking PATH folder whose real path is a network share", () => {
    const links: Record<string, string> = {
      "C:\\repo": "C:\\repo",
      "C:\\share-link": "\\\\server\\share\\git\\cmd",
      "C:\\share-link\\git.exe": "\\\\server\\share\\git\\cmd\\git.exe",
      "C:\\Program Files\\Git\\cmd": "C:\\Program Files\\Git\\cmd",
      "C:\\Program Files\\Git\\cmd\\git.exe": "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\dev-link": "C:\\Program Files\\Git\\cmd",
      "C:\\dev-link\\git.exe": "\\??\\UNC\\server\\share\\git.exe",
    };
    const io = {
      realpath: (file: string) => {
        if (!(file in links)) throw new Error("ENOENT");
        return links[file]!;
      },
      isProgram: () => true,
    };
    expect(resolveGit({ PATH: "C:\\share-link;C:\\dev-link" }, "C:\\repo", "win32", io)).toBeNull();
    expect(resolveGit({ PATH: "C:\\share-link;C:\\dev-link;C:\\Program Files\\Git\\cmd" }, "C:\\repo", "win32", io)).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });

  it("resolveGit refuses when the only git is inside the repo", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    cleanups.push(repo.cleanup);
    plantGit(repo.root);
    expect(resolveGit({ PATH: [".", "", repo.root].join(path.delimiter), GIT_EXEC_PATH: repo.root }, repo.root)).toBeNull();
    // A PATH folder that reaches the repo through a symlink (a junction on Windows) is the repo too.
    const link = path.join(path.dirname(repo.root), `${path.basename(repo.root)}-link`);
    symlinkSync(repo.root, link, isWindows ? "junction" : "dir");
    cleanups.push(() => rmSync(link, { recursive: true, force: true }));
    expect(resolveGit({ PATH: link, GIT_EXEC_PATH: link }, repo.root)).toBeNull();
    expect(resolveGit({ PATH: repo.root }, link)).toBeNull();
  });
});

describe("secret scan hook bundled into another program", () => {
  it("never runs its scan when the host that bundles it starts", async () => {
    const { build } = await import("esbuild");
    const out = mkdtempSync(path.join(os.tmpdir(), "pp-bundle-"));
    cleanups.push(() => rmSync(out, { recursive: true, force: true }));
    const entry = path.join(out, "entry.mjs");
    const worktrees = fileURLToPath(new URL("./index.ts", import.meta.url));
    writeFileSync(
      entry,
      `import * as worktrees from ${JSON.stringify(worktrees)};\n` +
        `import { scanDiff } from ${JSON.stringify(HOOK)};\n` +
        `console.log("host started", typeof scanDiff, typeof worktrees.runGit);\n`,
    );
    // Like dist/core-host/index.mjs: one file, so import.meta.url is the bundle's own address.
    const bundle = path.join(out, "core-host", "index.mjs");
    await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });

    const empty = mkdtempSync(path.join(os.tmpdir(), "pp-not-a-repo-"));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    const repo = await makeRepo({ "a.txt": "a\n" });
    cleanups.push(repo.cleanup);
    plantGit(repo.root);
    writeFileSync(path.join(repo.root, "config.js"), `const api_${"key"} = "${"abcdefghijklm"}nopqrstuvwxyz";\n`);
    await git(repo.root, ["add", "config.js"]);

    for (const cwd of [empty, repo.root]) {
      const run = spawnSync(process.execPath, [bundle], {
        cwd,
        env: { ...process.env, PATH: `.${path.delimiter}${process.env.PATH}` },
        encoding: "utf8",
      });
      expect(run.stdout).toContain("host started function function");
      expect(run.stderr).not.toContain("secret scan");
      expect(run.status).toBe(0);
    }
    expect(existsSync(path.join(repo.root, "planted-ran"))).toBe(false);
  });
});
