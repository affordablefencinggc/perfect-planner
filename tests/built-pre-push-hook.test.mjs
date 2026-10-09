// The pre-push secret scan as the installed app runs it: the core host from dist/ opens a real
// repository, installs its hook from dist/core-host/hooks, and git runs that hook on push. A clean
// change goes through; a change with a planted secret is refused. Guards against a build that
// ships the hook without the files it imports (every push would then be refused).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { requiresBuild } from "./helpers/build-output.mjs";

const bundle = new URL("../dist/core-host/index.mjs", import.meta.url);

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Tester", "-c", "user.email=tester@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
const push = (cwd) => spawnSync("git", ["push", "origin", "HEAD:main"], { cwd, encoding: "utf8" });

test("the built pre-push hook allows a clean push and refuses a planted secret", { skip: requiresBuild }, async () => {
  assert.ok(existsSync(bundle), "dist/core-host/index.mjs is missing: run npm run build");
  const { hostKeys, openCoreProject } = await import(bundle.href);
  const dir = mkdtempSync(path.join(tmpdir(), "pp-built-hook-"));
  const remote = path.join(dir, "remote.git");
  const repo = path.join(dir, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(path.join(repo, "README.md"), "notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "remote", "add", "origin", remote);

  const project = openCoreProject(path.join(dir, "app-data"), "built", repo, hostKeys({ PP_CORE_KEYS: "memory" }));
  try {
    const report = await project.protection;
    assert.equal(report.prePush.state, "installed", JSON.stringify(report));

    writeFileSync(path.join(repo, "notes.md"), "Buy milk.\n");
    git(repo, "add", "notes.md");
    git(repo, "commit", "-qm", "Clean change");
    const clean = push(repo);
    assert.equal(clean.status, 0, `clean push refused:\n${clean.stderr}`);

    // Built at run time so this file never holds a secret-shaped literal.
    const planted = ["ghp", "_", "Z9y8X7w6".repeat(5).slice(0, 36)].join("");
    writeFileSync(path.join(repo, "config.js"), `export const token = "${planted}";\n`);
    git(repo, "add", "config.js");
    git(repo, "commit", "-qm", "Planted secret");
    const refused = push(repo);
    assert.notEqual(refused.status, 0, "a push with a planted secret went through");
    assert.doesNotMatch(refused.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/, refused.stderr);
    assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "Clean change");
  } finally {
    await Promise.allSettled([project.ready, project.protection]);
    project.ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
