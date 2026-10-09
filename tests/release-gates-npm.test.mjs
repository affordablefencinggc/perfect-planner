import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempRepo } from "./helpers/hermetic-env.mjs";
import { RELEASE_CHAINS, npmCliPath, runReleaseGates } from "../scripts/run-release-gates.mjs";

// A repository can carry its own npm, npm.cmd or npm.bat. Release gates must run npm's real entry
// script through this Node, so none of them ever runs, whatever the OS's program search does.
function plantedRepository(t) {
  const repo = createTempRepo("pp-release-npm-");
  const outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), "pp-release-npm-out-")));
  t.after(() => { repo.cleanup(); rmSync(outside, { recursive: true, force: true }); });
  const planted = path.join(outside, "planted-npm-ran");
  const gateLog = path.join(outside, "gates.log");
  const record = `node -e "require('fs').appendFileSync(process.env.PP_TEST_GATE_LOG, process.env.npm_lifecycle_event + '\\n')"`;
  const scripts = Object.fromEntries(RELEASE_CHAINS.web.map((step) => [step.split(" ")[0], record]));
  writeFileSync(path.join(repo.root, "package.json"), JSON.stringify({ name: "planted", private: true, scripts }, null, 2));
  writeFileSync(path.join(repo.root, ".gitignore"), ".cache/\n");
  writeFileSync(path.join(repo.root, "npm"), `#!/bin/sh\necho planted > "${planted}"\n`);
  chmodSync(path.join(repo.root, "npm"), 0o755);
  for (const name of ["npm.cmd", "npm.bat"]) writeFileSync(path.join(repo.root, name), `@echo planted> "${planted}"\r\n`);
  repo.git(["add", "-A"]);
  repo.git(["commit", "-q", "-m", "planted npm"]);
  return { root: repo.root, outside, planted, gateLog };
}

test("release gates run every step through npm's own entry script, never a planted npm in the repository", async (t) => {
  const { root, planted, gateLog } = plantedRepository(t);
  const previous = process.env.PP_TEST_GATE_LOG;
  process.env.PP_TEST_GATE_LOG = gateLog;
  t.after(() => { if (previous === undefined) delete process.env.PP_TEST_GATE_LOG; else process.env.PP_TEST_GATE_LOG = previous; });
  const result = await runReleaseGates(root, "web");
  assert.equal(result.state, "passed", JSON.stringify(result));
  assert.deepEqual(readFileSync(gateLog, "utf8").trim().split(/\r?\n/), RELEASE_CHAINS.web.map((step) => step.split(" ")[0]));
  assert.equal(existsSync(planted), false, "a planted npm in the repository ran");
});

test("an npm entry script inside the repository, directly or through a junction or symlink, is refused", (t) => {
  const { root, outside } = plantedRepository(t);
  const inRepo = path.join(root, "npm-cli.js");
  writeFileSync(inRepo, "process.exit(0)\n");
  const elsewhere = path.join(outside, "npm-dir");
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, "npm-cli.js"), "process.exit(0)\n");
  const alias = path.join(root, "npm-alias");
  symlinkSync(elsewhere, alias, process.platform === "win32" ? "junction" : "dir");
  for (const npm_execpath of [inRepo, path.join(alias, "npm-cli.js")]) {
    let chosen;
    try { chosen = npmCliPath(root, { npm_execpath }); } catch (error) { assert.match(error.message, /npm's entry script was not found/); continue; }
    assert.notEqual(chosen, realpathSync.native(npm_execpath));
    const relative = path.relative(realpathSync.native(root), chosen);
    assert.ok(relative.startsWith("..") || path.isAbsolute(relative), `chose ${chosen} inside the repository`);
  }
});
