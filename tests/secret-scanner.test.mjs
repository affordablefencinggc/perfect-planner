import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scanner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/verify-secrets.mjs");
const installer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/install-git-hooks.mjs");
const bundledHooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.githooks");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pp-secret-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function run(root, args = [], input, environment = process.env) {
  return spawnSync(process.execPath, [scanner, ...args], { cwd: root, input, env: environment, encoding: "utf8", shell: false, timeout: 15_000 });
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function init(root) { git(root, ["init"]); git(root, ["config", "user.name", "Fixture"]); git(root, ["config", "user.email", "fixture@example.invalid"]); git(root, ["config", "core.autocrlf", "false"]); }
const syntheticToken = () => "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";

async function hookFixture(t) {
  const root = await fixture(t);
  init(root);
  await mkdir(path.join(root, ".githooks"));
  for (const name of ["pre-commit", "pre-push"]) await copyFile(path.join(bundledHooks, name), path.join(root, ".githooks", name));
  return root;
}
function install(root, environment = process.env) {
  return spawnSync(process.execPath, [installer], { cwd: root, env: environment, encoding: "utf8", shell: false, timeout: 15_000 });
}

const hostileGitOverrides = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
  "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

test("installer refuses Git routing and configuration environment overrides without changing hooks", async (t) => {
  const root = await hookFixture(t);
  const before = await readFile(path.join(root, ".git", "config"), "utf8");
  for (const key of hostileGitOverrides) {
    const value = key === "GIT_CONFIG_COUNT" ? "0" : key === "GIT_CONFIG_NOSYSTEM" ? "" : "fixture-private-override";
    const result = install(root, { ...process.env, [key]: value });
    assert.equal(result.status, 1, key);
    assert.match(result.stderr, /without Git repository or command configuration overrides/, key);
    assert.equal(result.stderr.includes("fixture-private-override"), false, key);
    assert.equal(await readFile(path.join(root, ".git", "config"), "utf8"), before, key);
  }
});

test("an inherited matching global hooks path still creates and verifies a persistent LOCAL binding", async (t) => {
  const root = await hookFixture(t);
  const profile = await fixture(t);
  const configPath = path.join(profile, ".gitconfig");
  await writeFile(configPath, "[core]\n\thooksPath = .githooks\n");
  const environment = { ...process.env, HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: path.join(profile, "xdg") };
  const result = install(root, environment);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(root, ["config", "--local", "--no-includes", "--get-all", "core.hooksPath"]), ".githooks");
  await rm(configPath);
  const second = install(root, environment);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(git(root, ["config", "--local", "--no-includes", "--get-all", "core.hooksPath"]), ".githooks");
});

test("installer preserves a foreign hooks path inherited from normal global configuration", async (t) => {
  const root = await hookFixture(t);
  const profile = await fixture(t);
  const globalConfig = "[core]\n\thooksPath = .husky\n";
  await writeFile(path.join(profile, ".gitconfig"), globalConfig);
  const before = await readFile(path.join(root, ".git", "config"), "utf8");
  const result = install(root, { ...process.env, HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: path.join(profile, "xdg") });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /existing core.hooksPath/);
  assert.equal(await readFile(path.join(root, ".git", "config"), "utf8"), before);
  assert.equal(await readFile(path.join(profile, ".gitconfig"), "utf8"), globalConfig);
});

test("staged scanner refuses hostile Git environments instead of scanning redirected clean content", async (t) => {
  const root = await fixture(t); init(root);
  await writeFile(path.join(root, "source.txt"), "clean"); git(root, ["add", "."]);
  const alternateIndex = path.join(root, ".git", "clean-index");
  await copyFile(path.join(root, ".git", "index"), alternateIndex);
  await writeFile(path.join(root, "source.txt"), syntheticToken()); git(root, ["add", "."]);
  for (const key of hostileGitOverrides) {
    const value = key === "GIT_INDEX_FILE" ? alternateIndex : key === "GIT_CONFIG_COUNT" ? "0" : key === "GIT_CONFIG_NOSYSTEM" ? "" : "fixture-private-override";
    const result = run(root, ["--staged"], undefined, { ...process.env, [key]: value });
    assert.equal(result.status, 3, key + ": " + result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.state, "incomplete", key);
    assert.ok(receipt.coverageIssues.some((issue) => /git-(?:environment|index)-override-refused/.test(issue.reason)), key);
    assert.equal(result.stdout.includes("fixture-private-override"), false, key);
  }
});

test("normal pre-commit GIT_INDEX_FILE binding is independently verified and scans the real staged index", async (t) => {
  const root = await fixture(t); init(root);
  await writeFile(path.join(root, "source.txt"), syntheticToken()); git(root, ["add", "."]);
  const environment = { ...process.env, GIT_INDEX_FILE: ".git/index", GIT_EXEC_PATH: git(root, ["--exec-path"]) };
  const result = run(root, ["--staged"], undefined, environment);
  assert.equal(result.status, 2, result.stdout);
  assert.equal(JSON.parse(result.stdout).findings[0].revision, "index");
  assert.equal(result.stdout.includes(syntheticToken()), false);
  await writeFile(path.join(root, "source.txt"), "safe"); git(root, ["add", "."]);
  assert.equal(run(root, ["--staged"], undefined, environment).status, 0);
});

test("real Git pre-commit invocation blocks the leaking index and permits a clean commit", async (t) => {
  const root = await fixture(t); init(root);
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  const shellQuote = (value) => "'" + value.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
  await writeFile(hook, "#!/bin/sh\n" + shellQuote(process.execPath) + " " + shellQuote(scanner) + " --staged\n");
  await chmod(hook, 0o755);
  await writeFile(path.join(root, "source.txt"), syntheticToken()); git(root, ["add", "."]);
  const leaking = spawnSync("git", ["commit", "-m", "fixture"], { cwd: root, encoding: "utf8", shell: false, timeout: 15_000 });
  assert.notEqual(leaking.status, 0);
  assert.match(leaking.stdout + leaking.stderr, /"state": "blocked"/);
  assert.equal((leaking.stdout + leaking.stderr).includes(syntheticToken()), false);
  await writeFile(path.join(root, "source.txt"), "safe"); git(root, ["add", "."]);
  const clean = spawnSync("git", ["commit", "-m", "fixture"], { cwd: root, encoding: "utf8", shell: false, timeout: 15_000 });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout + clean.stderr, /"state": "passed"/);
});

test("hook installer verifies bundled hooks and installs idempotently in a disposable checkout", async (t) => {
  const root = await hookFixture(t);
  if (process.platform !== "win32") await chmod(path.join(root, ".githooks", "pre-commit"), 0o644);
  assert.equal(install(root).status, 0);
  assert.equal(git(root, ["config", "--get", "core.hooksPath"]), ".githooks");
  const config = await readFile(path.join(root, ".git", "config"), "utf8");
  assert.equal(install(root).status, 0);
  assert.equal(await readFile(path.join(root, ".git", "config"), "utf8"), config);
  if (process.platform !== "win32") assert.equal((await lstat(path.join(root, ".githooks", "pre-commit"))).mode & 0o111, 0o111);
});

test("hook installer refuses to replace existing hooksPath and leaves config intact", async (t) => {
  const root = await hookFixture(t);
  git(root, ["config", "--local", "core.hooksPath", ".husky"]);
  const config = await readFile(path.join(root, ".git", "config"), "utf8");
  const result = install(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /existing core.hooksPath/);
  assert.equal(await readFile(path.join(root, ".git", "config"), "utf8"), config);
});

test("hook installer preserves active default Git hooks", async (t) => {
  const root = await hookFixture(t);
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 0\n");
  await chmod(hook, 0o755);
  const config = await readFile(path.join(root, ".git", "config"), "utf8");
  const result = install(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Existing hooks are active/);
  assert.equal(await readFile(path.join(root, ".git", "config"), "utf8"), config);
  assert.equal(await readFile(hook, "utf8"), "#!/bin/sh\nexit 0\n");
});

test("hook installer refuses nested directories, missing files, and modified bundled hooks", async (t) => {
  const root = await hookFixture(t);
  await mkdir(path.join(root, "nested"));
  assert.match(install(path.join(root, "nested")).stderr, /repository root/);
  await writeFile(path.join(root, ".githooks", "pre-push"), "#!/bin/sh\nexit 0\n");
  assert.match(install(root).stderr, /differs from the bundled/);
  await rm(path.join(root, ".githooks", "pre-push"));
  assert.match(install(root).stderr, /missing or is not a regular file/);
  assert.equal(spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: root }).status, 1);
});

test("hook installer refuses redirected hook directories", async (t) => {
  const root = await fixture(t); init(root);
  await symlink(bundledHooks, path.join(root, ".githooks"), process.platform === "win32" ? "junction" : "dir");
  const result = install(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or redirected/);
});

test("hook installer outside Git reports a bounded diagnostic without raw Git error output", async (t) => {
  const root = await fixture(t);
  const result = install(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not verify this checkout/);
  assert.doesNotMatch(result.stderr, /fatal:|not a git repository|node:internal/);
});

test("bounded secret scanner returns a redacted clean receipt", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "safe.js"), "const token = process.env.API_TOKEN;\n");
  const result = run(root);
  assert.equal(result.status, 0);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.findingCount, 0);
  assert.equal(receipt.secretsReturned, false);
});

test("bounded secret scanner blocks a credential without returning its value", async (t) => {
  const root = await fixture(t);
  const value = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  await writeFile(path.join(root, "leak.js"), `export const value = "${value}";\n`);
  const result = run(root);
  assert.equal(result.status, 2);
  assert.equal(result.stdout.includes(value), false);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.findingCount, 1);
  assert.equal(receipt.findings[0].rule, "github-token");
  assert.match(receipt.findings[0].fingerprint, /^[a-f0-9]{64}$/);
});

test("staged scan catches a secret staged in Git after its working copy is cleaned", async (t) => {
  const root = await fixture(t); init(root);
  await writeFile(path.join(root, "source.txt"), syntheticToken());
  git(root, ["add", "."]);
  await writeFile(path.join(root, "source.txt"), "clean working copy");
  const result = run(root, ["--staged"]);
  assert.equal(result.status, 2, result.stdout);
  assert.equal(JSON.parse(result.stdout).findings[0].revision, "index");
  assert.equal(result.stdout.includes(syntheticToken()), false);
});

test("staged scan uses clean staged bytes even if working copy contains a new secret", async (t) => {
  const root = await fixture(t); init(root);
  await writeFile(path.join(root, "source.txt"), "clean staged copy"); git(root, ["add", "."]);
  await writeFile(path.join(root, "source.txt"), syntheticToken());
  const result = run(root, ["--staged"]);
  assert.equal(result.status, 0, result.stdout);
});

test("push scan catches secrets removed by a later outgoing commit", async (t) => {
  const root = await fixture(t); init(root);
  await writeFile(path.join(root, "source.txt"), "base"); git(root, ["add", "."]); git(root, ["commit", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, "source.txt"), syntheticToken()); git(root, ["add", "."]); git(root, ["commit", "-m", "fixture leak"]);
  const leak = git(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, "source.txt"), "cleaned"); git(root, ["add", "."]); git(root, ["commit", "-m", "cleaned"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const result = run(root, ["--push"], `refs/heads/main ${head} refs/heads/main ${base}\n`);
  assert.equal(result.status, 2, result.stdout);
  assert.equal(JSON.parse(result.stdout).findings[0].revision, leak);
});

test("source allow markers and binary-looking filenames cannot suppress findings", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "photo.png"), "perfect-planner-secret-scan: allow-test-fixture\n" + syntheticToken());
  assert.equal(run(root).status, 2);
});

test("oversized files and invalid push metadata are incomplete, never clean", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "oversized.txt"), Buffer.alloc(5_000_001, 65));
  const result = run(root);
  assert.equal(result.status, 3, result.stdout);
  assert.equal(JSON.parse(result.stdout).state, "incomplete");
  init(root);
  const invalid = run(root, ["--push"], "invalid\n");
  assert.equal(invalid.status, 3, invalid.stdout);
  assert.match(invalid.stdout, /invalid-push-refs/);
});

test("UTF16 credential content is scanned", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "source.txt"), Buffer.concat([Buffer.from([255, 254]), Buffer.from(syntheticToken(), "utf16le")]));
  assert.equal(run(root).status, 2);
});

test("environment secrets, quoted JSON credentials, and OpenAI tokens are blocked and redacted", async (t) => {
  const root = await fixture(t);
  const openAi = "sk-" + "proj-" + "A".repeat(100);
  const password = ["Example", "Password", "123456789"].join("");
  await writeFile(path.join(root, ".env"), "OPENAI_API_KEY=" + openAi + "\n");
  await writeFile(path.join(root, "config.json"), JSON.stringify({ password }));
  const result = run(root);
  assert.equal(result.status, 2, result.stdout);
  const rules = new Set(JSON.parse(result.stdout).findings.map((finding) => finding.rule));
  for (const rule of ["openai-key", "environment-secret", "generic-assignment"]) assert.ok(rules.has(rule), rule);
  assert.equal(result.stdout.includes(openAi), false);
  assert.equal(result.stdout.includes(password), false);
});

test("credential-bearing filenames are redacted from findings and coverage issues", async (t) => {
  const root = await fixture(t);
  const name = syntheticToken();
  await writeFile(path.join(root, name + ".txt"), syntheticToken());
  await writeFile(path.join(root, name + ".large"), Buffer.alloc(5_000_001, 65));
  const result = run(root);
  assert.equal(result.status, 2, result.stdout);
  assert.equal(result.stdout.includes(name), false);
  const receipt = JSON.parse(result.stdout);
  assert.match(receipt.findings[0].path, /^\[redacted-path:[a-f0-9]{16}\]$/);
  assert.match(receipt.coverageIssues[0].path, /^\[redacted-path:[a-f0-9]{16}\]$/);
  assert.equal(receipt.secretsReturned, false);
});

test("push scan blocks credentials in outgoing commit messages", async (t) => {
  const root = await fixture(t); init(root);
  await writeFile(path.join(root, "safe.txt"), "safe"); git(root, ["add", "."]);
  git(root, ["commit", "-m", syntheticToken()]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const result = run(root, ["--push"], `refs/heads/main ${head} refs/heads/main ${"0".repeat(40)}\n`);
  assert.equal(result.status, 2, result.stdout);
  assert.equal(result.stdout.includes(syntheticToken()), false);
  assert.ok(JSON.parse(result.stdout).findings.some((finding) => finding.path === "<commit-message>" && finding.revision === head));
});

test("push scan blocks credentials in outgoing annotated tags even when the tree is clean", async (t) => {
  const root = await fixture(t); init(root);
  await writeFile(path.join(root, "safe.txt"), "safe"); git(root, ["add", "."]); git(root, ["commit", "-m", "safe"]);
  git(root, ["tag", "-a", "review-tag", "-m", syntheticToken()]);
  const tag = git(root, ["rev-parse", "review-tag"]);
  const result = run(root, ["--push"], `refs/tags/review-tag ${tag} refs/tags/review-tag ${"0".repeat(40)}\n`);
  assert.equal(result.status, 2, result.stdout);
  assert.equal(result.stdout.includes(syntheticToken()), false);
  assert.ok(JSON.parse(result.stdout).findings.some((finding) => finding.path === "<annotated-tag>" && finding.revision === tag));
});

test("reviewed OpenAI diagnostic dummy exemption requires the exact file content and path", async (t) => {
  const root = await fixture(t);
  const relative = "tests-ui/pp-diagnostics-120-runtime-event-ledger.test.jsx";
  const reviewed = await readFile(path.resolve(path.dirname(scanner), "..", relative), "utf8");
  await mkdir(path.join(root, "tests-ui"));
  await writeFile(path.join(root, relative), reviewed);
  const exact = run(root);
  assert.equal(exact.status, 0, exact.stdout);
  assert.ok(JSON.parse(exact.stdout).reviewedFixtureMatches >= 2);
  await writeFile(path.join(root, relative), reviewed + "\n// changed fixture\n");
  const changed = run(root);
  assert.equal(changed.status, 2, changed.stdout);
  assert.ok(JSON.parse(changed.stdout).findings.some((finding) => finding.rule === "openai-key"));
  await rm(path.join(root, relative));
  await writeFile(path.join(root, "other.jsx"), reviewed);
  const moved = run(root);
  assert.equal(moved.status, 2, moved.stdout);
  assert.ok(JSON.parse(moved.stdout).findings.some((finding) => finding.rule === "openai-key"));
});

test("push metadata byte bound fails closed", async (t) => {
  const root = await fixture(t); init(root);
  const result = run(root, ["--push"], "A".repeat(64_001));
  assert.equal(result.status, 3, result.stdout);
  assert.ok(JSON.parse(result.stdout).coverageIssues.some((issue) => issue.reason === "push-input-limit"));
});

test("reviewed CI transport dummy is pinned to exact bytes and cannot exempt added credentials", async (t) => {
  const root = await fixture(t);
  const relative = "tests/ci-derivation.test.mjs";
  const reviewed = await readFile(path.resolve(path.dirname(scanner), "..", relative), "utf8");
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, relative), reviewed);
  const exact = run(root);
  assert.equal(exact.status, 0, exact.stdout);
  assert.equal(JSON.parse(exact.stdout).reviewedFixtureMatches, 1);
  await writeFile(path.join(root, relative), reviewed + "\n// " + syntheticToken());
  const changed = run(root);
  assert.equal(changed.status, 2, changed.stdout);
  assert.equal(JSON.parse(changed.stdout).reviewedFixtureMatches, 0);
  assert.ok(JSON.parse(changed.stdout).findings.some(f => f.rule === "github-token"));
});

test("release workflow scans real workspace files before building", async () => {
  const manifest = JSON.parse(await readFile(path.resolve(path.dirname(scanner), "..", "package.json"), "utf8"));
  assert.equal(manifest.scripts["verify:release"].split(" && ")[0], "npm run verify:secrets");
  assert.equal(manifest.scripts["verify:secrets"], "node scripts/verify-secrets.mjs");
});

test("an open push-input pipe terminates at the production deadline with incomplete coverage", { timeout: 15_000 }, async (t) => {
  const root = await fixture(t); init(root);
  const started = Date.now();
  const child = spawn(process.execPath, [scanner, "--push"], { cwd: root, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.stdin.destroy(); if (child.exitCode === null) child.kill(); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.on("error", () => {});
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Scanner did not enforce its input deadline")); }, 12_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(status, 3, stdout);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.state, "incomplete");
  assert.equal(receipt.limits.pushInputMs, 5_000);
  assert.ok(Date.now() - started >= receipt.limits.pushInputMs);
  assert.ok(receipt.coverageIssues.some((issue) => issue.reason === "push-input-time-limit"));
});
