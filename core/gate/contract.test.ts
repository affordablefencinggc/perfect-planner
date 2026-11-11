import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { claimPatternProblem, claimPatternsOverlap } from "../../src/engine/claimPatterns.js";
import { gitExecutable } from "../exec/index";
import { LedgerError, isAuthoritative, type Actor, type LedgerEntry } from "../ledger/index";
import { git, runGit } from "../worktrees/git";
import { commitAll, makeRepo, memoryLedger, writeFiles } from "../worktrees/testing";
import {
  BINARY_LINES,
  TestGate,
  checkContract,
  contractRule,
  contractVerdictAt,
  evaluateContract,
  isUnderContract,
  latestContractVerdict,
  normalizePattern,
  pathCovered,
  pathCoveredFolded,
  patternProblem,
  recordContractVerdict,
  resolveLinkTarget,
  type ContractContext,
  type ContractLimits,
  type FileChange,
} from "./index";
import { isDependencyPath, isProtectedPath, isTestLike, oddPathProblem } from "./contractPaths";

const OWNER: Actor = { kind: "person", id: "owner" };
const WORKER: Actor = { kind: "agent", id: "worker-1", model: "test-model" };
const SLOW = 60_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const limits = (allowedFiles: string[], sizeCap = { maxFiles: 4, maxLines: 60 }): ContractLimits => ({ allowedFiles, sizeCap });
const change = (path: string, extra: Partial<FileChange> = {}): FileChange => ({ path, status: "M", oldMode: "100644", newMode: "100644", added: 1, deleted: 0, binary: false, ...extra });

describe("path rules", () => {
  it("covers what a pattern names, and everything inside a folder, case sensitively", () => {
    expect(pathCovered("src/app.ts", "src/app.ts")).toBe(true);
    expect(pathCovered("src/app.ts", "src/App.ts")).toBe(false);
    expect(pathCovered("src/billing", "src/billing/invoice/list.ts")).toBe(true);
    expect(pathCovered("src/billing/**", "src/billing/list.ts")).toBe(true);
    expect(pathCovered("src/billing/**", "src/billing")).toBe(true);
    expect(pathCovered("src/*.ts", "src/a.ts")).toBe(true);
    expect(pathCovered("src/*.ts", "src/sub/a.ts")).toBe(false);
    expect(pathCovered("src/**/index.ts", "src/index.ts")).toBe(true);
    expect(pathCovered("src/**/index.ts", "src/a/b/index.ts")).toBe(true);
    expect(pathCovered("src/**/index.ts", "src/a/b/other.ts")).toBe(false);
    expect(pathCovered("tests/core-?.test.mjs", "tests/core-a.test.mjs")).toBe(true);
    expect(pathCovered("tests/core-?.test.mjs", "tests/core-ab.test.mjs")).toBe(false);
    expect(pathCovered("src/billing", "src/billing-old/x.ts")).toBe(false);
    expect(pathCoveredFolded("src/B/**", "SRC/b/x.ts")).toBe(true);
  });

  it("agrees with the collision engine's claim patterns on what is a valid pattern and what overlaps", () => {
    const valid = ["src/app.js", "src/core/**", "tests/core-*.test.mjs", "a/**/b", "x?y.ts", "**"];
    const invalid = ["", "/etc/passwd", "../x", "a/../b", "C:/x", "src/[ab].ts", "src/{a,b}.ts", "a/**b", "a/./b"];
    for (const p of valid) {
      expect(claimPatternProblem(p), p).toBeNull();
      expect(patternProblem(p), p).toBeNull();
    }
    for (const p of invalid) {
      expect(patternProblem(p) !== null, p).toBe(true);
    }
    // Doubled slashes, backslashes and a trailing slash are cleaned up first (as the worktree manager does for claims).
    expect(normalizePattern("./src\\a//b/")).toBe("src/a/b");
    // Whatever the contract covers, the engine sees as overlapping (so another task's claim check fires for it). The engine
    // is deliberately wider: it also counts a file as a folder that might hold more.
    const patterns = ["src/billing", "src/billing/**", "src/*.ts", "src/**/index.ts", "tests/core-*.test.mjs", "**", "a/b?c"];
    const files = ["src/billing/list.ts", "src/app.ts", "src/x/y/index.ts", "tests/core-a.test.mjs", "tests/other.test.mjs", "docs/readme.md", "a/bxc", "a/bxxc"];
    for (const p of patterns) for (const f of files) if (pathCoveredFolded(p, f)) expect(claimPatternsOverlap(p.toLowerCase(), f.toLowerCase()), `${p} vs ${f}`).toBe(true);
  });

  it("refuses patterns that reach the planner's folder, git, or a Windows alias", () => {
    for (const p of [".perfect-planner/**", ".PERFECT-PLANNER", ".git/hooks", "a/.git/x", "src/name./x", "src/name /x", "src/a:b"]) expect(patternProblem(p), p).not.toBeNull();
  });

  it("knows dependency, protected, test and odd paths in any case", () => {
    for (const f of ["package.json", "PACKAGE.JSON", "app/package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".npmrc", "Cargo.toml", "go.sum", "requirements-dev.txt", "web/Gemfile.lock", ".gitmodules", "x/App.csproj"]) expect(isDependencyPath(f), f).toBe(true);
    for (const f of ["src/package.ts", "README.md", "src/requirements.ts"]) expect(isDependencyPath(f), f).toBe(false);
    for (const f of [".perfect-planner/ledger/x.jsonl", ".PERFECT-PLANNER/x", ".git/config", "sub/.GIT/x"]) expect(isProtectedPath(f), f).toBe(true);
    expect(isProtectedPath("src/.perfect-planner-notes.md")).toBe(false);
    for (const f of ["tests/a.mjs", "src/a.test.ts", "src/a.spec.js", "test_a.py", "pkg/a_test.go", "__tests__/x.js"]) expect(isTestLike(f), f).toBe(true);
    for (const f of ["src/latest.ts", "src/contest.ts"]) expect(isTestLike(f), f).toBe(false);
    for (const f of ["a:b", "a\\b", "dir /x", "a/b.", "a//b", "a/../b"]) expect(oddPathProblem(f), f).not.toBeNull();
    expect(oddPathProblem("src/ok-file_1.ts")).toBeNull();
  });

  it("resolves a symlink target against its own folder", () => {
    expect(resolveLinkTarget("src/a/link", "./real.ts")).toEqual({ path: "src/a/real.ts" });
    expect(resolveLinkTarget("src/a/link", "../b/x.ts")).toEqual({ path: "src/b/x.ts" });
    expect(resolveLinkTarget("src/a/link", "../../../etc/passwd")).toHaveProperty("problem");
    expect(resolveLinkTarget("src/a/link", "/etc/passwd")).toHaveProperty("problem");
    expect(resolveLinkTarget("src/a/link", "C:\\Windows\\win.ini")).toHaveProperty("problem");
    expect(resolveLinkTarget("link", "..")).toHaveProperty("problem");
    expect(resolveLinkTarget("src/link", "..")).toHaveProperty("problem");
  });
});

describe("evaluateContract (pure)", () => {
  it("passes work that stays on the list and under the cap", () => {
    const report = evaluateContract([change("src/billing/list.ts"), change("src/billing/list.test.ts", { status: "A" })], limits(["src/billing/**"]));
    expect(report).toMatchObject({ ok: true, files: 2, lines: 2, problems: [] });
  });

  it("refuses a file outside the list and names it", () => {
    const report = evaluateContract([change("src/billing/list.ts"), change("src/auth/session.ts")], limits(["src/billing/**"]), { taskLabel: "T-3" });
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([{ kind: "outside", files: ["src/auth/session.ts"] }]);
    expect(report.reason).toContain("T-3's contract does not allow this work");
    expect(report.reason).toContain("src/auth/session.ts");
    expect(report.reason).toContain("Nothing was approved");
  });

  it("an empty list allows nothing", () => {
    expect(evaluateContract([change("a.ts")], limits([])).ok).toBe(false);
    expect(evaluateContract([], limits([])).ok).toBe(true);
  });

  it("counts a dependency or lockfile change as outside unless that exact path is listed", () => {
    const deps = [change("package.json"), change("package-lock.json"), change("web/yarn.lock", { status: "A" })];
    for (const allowed of [["**"], ["*"], ["src/**"], ["web/*"], ["package*.json"]]) {
      const report = evaluateContract(deps, limits(allowed, { maxFiles: 9, maxLines: 99 }));
      expect(report.ok, allowed.join()).toBe(false);
      expect(report.problems[0]).toMatchObject({ kind: "dependency" });
    }
    const report = evaluateContract(deps, limits(["package.json"], { maxFiles: 9, maxLines: 99 }));
    expect(report.problems.flatMap((p) => p.files).sort()).toEqual(["package-lock.json", "web/yarn.lock"]);
    expect(report.reason).toContain("A new dependency or a lockfile change is outside the contract");
    expect(evaluateContract(deps, limits(["package.json", "package-lock.json", "web/yarn.lock"], { maxFiles: 9, maxLines: 99 })).ok).toBe(true);
  });

  it("treats a submodule (gitlink) as a dependency", () => {
    const sub = change("vendor/lib", { status: "A", oldMode: "000000", newMode: "160000" });
    expect(evaluateContract([sub], limits(["vendor/**"])).problems[0]).toMatchObject({ kind: "dependency", files: ["vendor/lib"] });
    expect(evaluateContract([sub], limits(["vendor/lib"])).ok).toBe(true);
  });

  it("refuses a file another running task has claimed, even when this list covers it", () => {
    const ctx: ContractContext = { taskLabel: "T-1", otherClaims: [{ taskId: "T-2", claims: ["src/shared/**", "Docs/Guide.md"] }] };
    const report = evaluateContract([change("src/shared/util.ts"), change("docs/guide.md")], limits(["src/**", "docs/**"]), ctx);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([{ kind: "other-task", files: ["src/shared/util.ts", "docs/guide.md"], detail: "T-2" }]);
    expect(report.reason).toContain("T-2 has claimed");
  });

  it("refuses the planner's own folder and git, whatever the list says", () => {
    const report = evaluateContract([change(".perfect-planner/ledger/2026-10.jsonl"), change(".PERFECT-PLANNER/contracts/T-1.json"), change("x/.git/config")], limits(["**"]));
    expect(report.problems).toEqual([{ kind: "protected", files: [".perfect-planner/ledger/2026-10.jsonl", ".PERFECT-PLANNER/contracts/T-1.json", "x/.git/config"] }]);
    expect(report.reason).toContain("the ledger and the contract live there");
  });

  it("refuses odd spellings of a path", () => {
    const report = evaluateContract([change("src/a.ts:hidden"), change("src/dir./x.ts")], limits(["src/**"]));
    expect(report.problems.map((p) => p.kind)).toEqual(["odd-name", "odd-name"]);
  });

  it("refuses a symlink that leaves the project, or leads to a file off the list, and allows one that stays on it", () => {
    const link = (path: string, target: string) => change(path, { status: "A", oldMode: "000000", newMode: "120000", linkTarget: target });
    const list = limits(["src/a/**"]);
    expect(evaluateContract([link("src/a/out", "../../../outside/secret")], list).problems[0]).toMatchObject({ kind: "symlink", files: ["src/a/out"] });
    expect(evaluateContract([link("src/a/abs", "/etc/passwd")], list).problems[0]).toMatchObject({ kind: "symlink" });
    expect(evaluateContract([link("src/a/other", "../b/secret.txt")], list).problems[0].detail).toContain("src/b/secret.txt");
    expect(evaluateContract([link("src/a/inside", "./real.ts")], list).ok).toBe(true);
    expect(evaluateContract([link("src/a/hook", "../../.perfect-planner/ledger")], list).problems[0]).toMatchObject({ kind: "symlink" });
    expect(evaluateContract([link("src/b/new", "../a/real.ts")], list).problems[0]).toMatchObject({ kind: "outside" });
    expect(evaluateContract([link("src/a/dep", "../../package.json")], list).problems[0]).toMatchObject({ kind: "symlink", detail: expect.stringContaining("package.json, which is not on the list") });
    // A link to a file the contract names (even a dependency file, by exact name) is fine.
    expect(evaluateContract([link("src/a/dep", "../../package.json")], limits(["src/a/**", "package.json"])).ok).toBe(true);
  });

  it("refuses work past the size cap, counting a binary file as a lot of lines", () => {
    const four = ["a", "b", "c", "d"].map((n) => change(`src/${n}.ts`));
    const many = evaluateContract(four, limits(["src/**"], { maxFiles: 3, maxLines: 100 }));
    expect(many.problems).toEqual([{ kind: "too-many-files", files: [], detail: "4 files changed, the limit is 3" }]);
    expect(many.reason).toContain("Split the task");
    const long = evaluateContract([change("src/a.ts", { added: 80, deleted: 30 })], limits(["src/**"], { maxFiles: 3, maxLines: 100 }));
    expect(long.problems[0]).toMatchObject({ kind: "too-many-lines", detail: "110 lines changed, the limit is 100" });
    expect(evaluateContract([change("src/a.ts", { added: 60, deleted: 40 })], limits(["src/**"], { maxFiles: 3, maxLines: 100 })).ok).toBe(true);
    const image = evaluateContract([change("src/logo.png", { binary: true })], limits(["src/**"], { maxFiles: 3, maxLines: BINARY_LINES - 1 }));
    expect(image.lines).toBe(BINARY_LINES);
    expect(image.problems[0]).toMatchObject({ kind: "too-many-lines" });
  });

  it("allows the person's approved test files besides the list, but only test-looking, non-dependency ones", () => {
    const ctx: ContractContext = { approvedTestFiles: ["tests/save.check.mjs", "src/other/secret.ts", "package.json", ".perfect-planner/x.test.ts"] };
    const report = evaluateContract([change("tests/save.check.mjs", { status: "A" }), change("src/other/secret.ts"), change("package.json"), change(".perfect-planner/x.test.ts")], limits(["src/save/**"], { maxFiles: 9, maxLines: 99 }), ctx);
    expect(report.problems.map((p) => [p.kind, p.files])).toEqual([
      ["outside", ["src/other/secret.ts"]],
      ["dependency", ["package.json"]],
      ["protected", [".perfect-planner/x.test.ts"]],
    ]);
  });

  it("refuses everything when the limits are missing or broken", () => {
    for (const bad of [{ allowedFiles: ["a"], sizeCap: { maxFiles: 0, maxLines: 5 } }, { allowedFiles: ["a"], sizeCap: { maxFiles: 1.5, maxLines: 5 } }, { allowedFiles: "a", sizeCap: { maxFiles: 1, maxLines: 5 } }, { allowedFiles: ["a"] }, undefined] as unknown[]) {
      const report = evaluateContract([], bad as ContractLimits);
      expect(report.ok).toBe(false);
      expect(report.problems[0]!.kind).toBe("no-limits");
    }
  });

  it("drops a pattern a contract may not hold instead of letting it allow things", () => {
    expect(evaluateContract([change("src/a.ts")], limits(["../src", "/src", "src/[a].ts"])).ok).toBe(false);
  });
});

// ---------- against a real repository ----------

async function setup(files: Record<string, string> = {}) {
  const repo = await makeRepo({
    "README.md": "# app\n",
    "package.json": '{ "name": "app", "version": "1.0.0" }\n',
    "package-lock.json": "{}\n",
    "src/billing/list.ts": "export const list = [];\n",
    "src/billing/list.test.ts": "// test\n",
    "src/auth/session.ts": "export const session = 1;\n",
    "src/b/shared.ts": "export const shared = 1;\n",
    ...files,
  });
  cleanups.push(repo.cleanup);
  const base = (await git(repo.root, ["rev-parse", "HEAD"])).trim();
  await git(repo.root, ["checkout", "-q", "-b", "pp/T-1"]);
  return { root: repo.root, base };
}

async function tipOf(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

/** Adds a symbolic link to the index without needing the OS to make one (works on every platform). */
async function addLink(root: string, path: string, target: string): Promise<void> {
  const hashed = spawnSync(gitExecutable(root), ["hash-object", "-w", "--stdin"], { cwd: root, input: target, encoding: "utf8" });
  expect(hashed.status).toBe(0);
  await git(root, ["update-index", "--add", "--cacheinfo", `120000,${hashed.stdout.trim()},${path}`]);
}

const check = async (root: string, base: string, allowed: string[], context: ContractContext = {}, cap?: ContractLimits["sizeCap"]) =>
  checkContract(root, { base, tip: await tipOf(root), limits: limits(allowed, cap), context: { taskLabel: "T-1", ...context } });

describe("checkContract against a real repository (attacks)", () => {
  it("passes work that stays inside its list", async () => {
    const { root, base } = await setup();
    writeFiles(root, { "src/billing/list.ts": "export const list = [1];\n", "src/billing/total.ts": "export const total = 0;\n" });
    await commitAll(root, "work");
    const result = await check(root, base, ["src/billing/**"]);
    expect(result).toMatchObject({ ok: true, files: 2, changed: ["src/billing/list.ts", "src/billing/total.ts"] });
    expect(result.lines).toBe(3);
  }, SLOW);

  it("attack: a worker edits a file outside its list", async () => {
    const { root, base } = await setup();
    writeFiles(root, { "src/billing/list.ts": "export const list = [1];\n", "src/auth/session.ts": "export const session = 'backdoor';\n" });
    await commitAll(root, "sneaky");
    const result = await check(root, base, ["src/billing/**"]);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: "outside", files: ["src/auth/session.ts"] }]);
    expect(result.reason).toContain("src/auth/session.ts");
  }, SLOW);

  it("attack: a worker adds a dependency or changes a lockfile", async () => {
    const { root, base } = await setup();
    writeFiles(root, { "package.json": '{ "name": "app", "version": "1.0.0", "dependencies": { "left-pad": "1.3.0" } }\n', "package-lock.json": '{ "lockfileVersion": 3 }\n', "src/billing/list.ts": "export const list = [2];\n" });
    await commitAll(root, "add left-pad");
    const refused = await check(root, base, ["**"]);
    expect(refused.ok).toBe(false);
    expect(refused.problems).toEqual([{ kind: "dependency", files: ["package-lock.json", "package.json"] }]);
    expect(refused.reason).toContain("package-lock.json, package.json");
    // Allowed only when both exact files are named in the contract.
    expect((await check(root, base, ["src/billing/**", "package.json", "package-lock.json"])).ok).toBe(true);
    // A case-changed spelling is still a dependency file.
    await git(root, ["mv", "package.json", "Package.JSON"]);
    await commitAll(root, "rename");
    expect((await check(root, base, ["src/billing/**", "package-lock.json"])).problems.map((p) => p.kind)).toContain("dependency");
  }, SLOW);

  it("attack: a worker adds a new lockfile, a requirements file or a submodule", async () => {
    const { root, base } = await setup();
    writeFiles(root, { "yarn.lock": "# lock\n", "requirements.txt": "requests\n" });
    await commitAll(root, "other package managers");
    await git(root, ["update-index", "--add", "--cacheinfo", `160000,${base},vendor/lib`]);
    await git(root, ["commit", "-q", "-m", "submodule"]);
    const result = await check(root, base, ["**"]);
    expect(result.problems).toEqual([{ kind: "dependency", files: ["requirements.txt", "yarn.lock"] }, { kind: "dependency", files: ["vendor/lib"], detail: "a submodule" }]);
  }, SLOW);

  it("attack: a worker edits a file a second running task has claimed", async () => {
    const { root, base } = await setup();
    writeFiles(root, { "src/billing/list.ts": "export const list = [3];\n", "src/b/shared.ts": "export const shared = 'mine now';\n" });
    await commitAll(root, "took T-2's file");
    const result = await check(root, base, ["src/**"], { otherClaims: [{ taskId: "T-2", claims: ["src/b/**"] }] });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: "other-task", files: ["src/b/shared.ts"], detail: "T-2" }]);
    expect(result.reason).toContain("T-2 has claimed");
  }, SLOW);

  it("attack: a worker grows past the size cap (files, then lines, then a binary file)", async () => {
    const { root, base } = await setup();
    writeFiles(root, { "src/billing/a.ts": "a\n", "src/billing/b.ts": "b\n", "src/billing/c.ts": "c\n" });
    await commitAll(root, "three new files");
    const files = await check(root, base, ["src/billing/**"], {}, { maxFiles: 2, maxLines: 500 });
    expect(files.problems).toEqual([{ kind: "too-many-files", files: [], detail: "3 files changed, the limit is 2" }]);
    expect((await check(root, base, ["src/billing/**"], {}, { maxFiles: 3, maxLines: 500 })).ok).toBe(true);
    const big = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    writeFiles(root, { "src/billing/a.ts": `${big}\n` });
    await commitAll(root, "long file");
    const lines = await check(root, base, ["src/billing/**"], {}, { maxFiles: 9, maxLines: 40 });
    expect(lines.problems).toEqual([{ kind: "too-many-lines", files: [], detail: expect.stringContaining("the limit is 40") }]);
    writeFiles(root, { "src/billing/logo.bin": "\u0000\u0001\u0002binary" });
    await commitAll(root, "binary");
    const binary = await check(root, base, ["src/billing/**"], {}, { maxFiles: 9, maxLines: 40 + BINARY_LINES - 1 });
    expect(binary.lines).toBeGreaterThanOrEqual(BINARY_LINES);
  }, SLOW);

  it("attack: a worker edits the contract file or the ledger (the planner's folder)", async () => {
    const { root, base } = await setup();
    writeFiles(root, { ".perfect-planner/ledger/2026-10.jsonl": "{}\n", ".perfect-planner/contracts/T-1.json": '{"allowedFiles":["**"]}\n', "src/billing/list.ts": "export const list = [4];\n" });
    await git(root, ["add", "-f", ".perfect-planner"]);
    await commitAll(root, "widen myself");
    const result = await check(root, base, ["**"]);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: "protected", files: [".perfect-planner/contracts/T-1.json", ".perfect-planner/ledger/2026-10.jsonl"] }]);
  }, SLOW);

  it("attack: a file renamed or moved so that it lands outside the list (and one moved in from outside)", async () => {
    const { root, base } = await setup();
    await git(root, ["mv", "src/billing/list.ts", "src/auth/list.ts"]);
    await git(root, ["commit", "-q", "-m", "move out"]);
    const out = await check(root, base, ["src/billing/**"]);
    expect(out.ok).toBe(false);
    expect(out.problems).toEqual([{ kind: "outside", files: ["src/auth/list.ts"] }]);
    // Moving a file from outside into the list deletes the outside path: also refused.
    await git(root, ["reset", "-q", "--hard", base]);
    await git(root, ["mv", "src/auth/session.ts", "src/billing/session.ts"]);
    await git(root, ["commit", "-q", "-m", "move in"]);
    const into = await check(root, base, ["src/billing/**"]);
    expect(into.problems).toEqual([{ kind: "outside", files: ["src/auth/session.ts"] }]);
    // A move that stays on the list is fine, and counts as two changed files.
    await git(root, ["reset", "-q", "--hard", base]);
    await git(root, ["mv", "src/billing/list.ts", "src/billing/items.ts"]);
    await git(root, ["commit", "-q", "-m", "rename inside"]);
    expect(await check(root, base, ["src/billing/**"])).toMatchObject({ ok: true, files: 2 });
  }, SLOW);

  it("attack: a symlink inside an allowed folder that points outside it", async () => {
    const { root, base } = await setup();
    await addLink(root, "src/billing/escape", "../../../outside/secret.txt");
    await addLink(root, "src/billing/absolute", "/etc/passwd");
    await addLink(root, "src/billing/sibling", "../auth/session.ts");
    await addLink(root, "src/billing/fine", "./list.ts");
    await git(root, ["commit", "-q", "-m", "links"]);
    const result = await check(root, base, ["src/billing/**"], {}, { maxFiles: 9, maxLines: 99 });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => [p.kind, p.files, p.detail])).toEqual([
      ["symlink", ["src/billing/absolute"], expect.stringContaining("/etc/passwd")],
      ["symlink", ["src/billing/escape"], expect.stringContaining("outside the project")],
      ["symlink", ["src/billing/sibling"], expect.stringContaining("src/auth/session.ts, which is not on the list")],
    ]);
    expect(result.problems.flatMap((p) => p.files)).not.toContain("src/billing/fine");
  }, SLOW);

  it("attack: a file turned into a symlink, and a folder turned into a link to another folder", async () => {
    const { root, base } = await setup();
    await git(root, ["rm", "-q", "src/billing/list.ts"]);
    await addLink(root, "src/billing/list.ts", "../auth/session.ts");
    await git(root, ["commit", "-q", "-m", "swap for a link"]);
    const swapped = await check(root, base, ["src/billing/**"]);
    expect(swapped.problems[0]).toMatchObject({ kind: "symlink", files: ["src/billing/list.ts"] });
    await git(root, ["reset", "-q", "--hard", base]);
    await addLink(root, "src/billing/auth", "../auth");
    await git(root, ["commit", "-q", "-m", "folder link"]);
    expect((await check(root, base, ["src/billing/**"])).problems[0]).toMatchObject({ kind: "symlink", files: ["src/billing/auth"] });
  }, SLOW);

  it("attack: history rewritten so the branch no longer contains its start", async () => {
    const { root, base } = await setup();
    await git(root, ["checkout", "-q", "--orphan", "rewritten"]);
    writeFiles(root, { "src/billing/list.ts": "export const list = [];\n" });
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "fresh root"]);
    const result = await check(root, base, ["**"]);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatchObject({ kind: "history" });
    expect(result.reason).toContain("history was rewritten");
  }, SLOW);

  it("refuses when it cannot read the changes (fail closed)", async () => {
    const { root, base } = await setup();
    const tip = await tipOf(root);
    expect((await checkContract(root, { base: "main", tip, limits: limits(["**"]) })).problems[0]).toMatchObject({ kind: "unreadable" });
    expect((await checkContract(root, { base, tip: "--output=/tmp/x", limits: limits(["**"]) })).ok).toBe(false);
    const missing = "0".repeat(40);
    const unknown = await checkContract(root, { base, tip: missing, limits: limits(["**"]) });
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toContain("Nothing was approved");
    expect((await checkContract("/definitely/not/a/folder", { base, tip, limits: limits(["**"]) })).ok).toBe(false);
  }, SLOW);

  it("refuses while the repo's git settings name a program, instead of running it", async () => {
    const { root, base } = await setup();
    writeFiles(root, { "src/billing/list.ts": "export const list = [5];\n" });
    await commitAll(root, "work");
    await runGit(root, ["config", "filter.planted.clean", "cat"]);
    const result = await check(root, base, ["src/billing/**"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("filter.planted.clean");
  }, SLOW);

  it("lets the person's approved test file through besides the list", async () => {
    const { root, base } = await setup();
    writeFiles(root, { "tests/total.check.mjs": "process.exit(1)\n", "src/billing/total.ts": "export const total = 0;\n" });
    await commitAll(root, "test and work");
    expect((await check(root, base, ["src/billing/**"])).problems).toEqual([{ kind: "outside", files: ["tests/total.check.mjs"] }]);
    expect((await check(root, base, ["src/billing/**"], { approvedTestFiles: ["tests/total.check.mjs"] })).ok).toBe(true);
  }, SLOW);
});

// ---------- the ledger rule ----------

describe("contractRule", () => {
  const COMMIT = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const contract = { clauses: ["Build it."], allowedFiles: ["src/**"], doneWhen: "a test passes", sizeCap: { maxFiles: 3, maxLines: 50 } };

  async function ledgerWith(options: { contract?: boolean } = { contract: true }) {
    const ledger = await memoryLedger();
    ledger.addRule(contractRule());
    ledger.append({ actor: OWNER, type: "task.created", subject: "T-1", summary: "Billing", data: options.contract ? { contract } : {} });
    return ledger;
  }

  const diffApproval = (ledger: Awaited<ReturnType<typeof memoryLedger>>, commit = COMMIT, actor: Actor = OWNER) =>
    new TestGate({ ledger }).approveDiff("T-1", actor, commit);

  it("refuses to approve a diff for a task under contract with no contract check at that commit", async () => {
    const ledger = await ledgerWith();
    expect(isUnderContract(ledger.entries(), "T-1")).toBe(true);
    expect(() => diffApproval(ledger)).toThrow(LedgerError);
    expect(() => diffApproval(ledger)).toThrow(/has not passed the contract check/);
  });

  it("refuses the merge approval the same way, and Jev's diff approval too", async () => {
    const ledger = await ledgerWith();
    expect(() => new TestGate({ ledger }).approveMerge("T-1", OWNER, COMMIT)).toThrow(/contract check/);
    expect(() => diffApproval(ledger, COMMIT, { kind: "jev", id: "jev", model: "m" })).toThrow(/contract check/);
  });

  it("allows approval after a passing check at that exact commit, and not for another commit", async () => {
    const ledger = await ledgerWith();
    recordContractVerdict(ledger, "T-1", { ok: true, base: "c".repeat(40), tip: COMMIT, files: 1, lines: 2, problems: [], changed: ["src/a.ts"] });
    expect(contractVerdictAt(ledger.entries(), "T-1", COMMIT)).toMatchObject({ ok: true });
    expect(diffApproval(ledger).ok).toBe(true);
    expect(() => diffApproval(ledger, OTHER)).toThrow(/contract check/);
  });

  it("a failing check at the commit keeps refusing, with the reason, until a later passing check", async () => {
    const ledger = await ledgerWith();
    const base = "c".repeat(40);
    recordContractVerdict(ledger, "T-1", { ok: false, base, tip: COMMIT, files: 1, lines: 2, changed: ["x.ts"], problems: [{ kind: "outside", files: ["x.ts"] }], reason: "T-1's contract does not allow this work. It changes a file that is not on its list: x.ts." });
    expect(() => diffApproval(ledger)).toThrow(/breaks its contract.*x\.ts/);
    recordContractVerdict(ledger, "T-1", { ok: true, base, tip: COMMIT, files: 1, lines: 2, problems: [], changed: ["src/a.ts"] });
    expect(diffApproval(ledger).ok).toBe(true);
  });

  it("does not touch tasks without a contract, and never blocks a rejection", async () => {
    const plain = await ledgerWith({ contract: false });
    expect(isUnderContract(plain.entries(), "T-1")).toBe(false);
    expect(diffApproval(plain).ok).toBe(true);
    const ledger = await ledgerWith();
    ledger.append({ actor: OWNER, type: "review.verdict", subject: "T-1", summary: "No", evidence: ["scope:diff", "verdict:reject", `commit:${COMMIT}`], data: { scope: "diff", verdict: "reject" } });
  });

  it("a task entry that fails its signature check still counts as under contract (an edit cannot remove the check)", async () => {
    const ledger = await ledgerWith();
    const real = ledger.entries();
    const forged = { ...real[0]!, data: { contract } } as LedgerEntry;
    expect(isAuthoritative(forged)).toBe(false);
    expect(isUnderContract([forged], "T-1")).toBe(true);
    expect(isUnderContract([forged], "T-1.a3")).toBe(true);
    expect(isUnderContract([{ ...forged, data: {} } as LedgerEntry], "T-1")).toBe(false);
  });

  it("latestContractVerdict reports the gate's last check, for the screen", async () => {
    const ledger = await ledgerWith();
    expect(latestContractVerdict(ledger.entries(), "T-1")).toBeUndefined();
    const base = "c".repeat(40);
    recordContractVerdict(ledger, "T-1", { ok: false, base, tip: COMMIT, files: 2, lines: 7, changed: ["x.ts"], problems: [{ kind: "outside", files: ["x.ts"] }], reason: "T-1's contract does not allow this work. x.ts" });
    expect(latestContractVerdict(ledger.entries(), "T-1")).toMatchObject({ ok: false, commit: COMMIT, files: 2, lines: 7, reason: expect.stringContaining("x.ts") });
    recordContractVerdict(ledger, "T-1", { ok: true, base, tip: OTHER, files: 1, lines: 2, problems: [], changed: ["src/a.ts"] });
    expect(latestContractVerdict(ledger.entries(), "T-1")).toMatchObject({ ok: true, commit: OTHER });
    // A person's entry is not the gate's measurement.
    ledger.append({ actor: OWNER, type: "review.verdict", subject: "T-1", summary: "fine", evidence: ["scope:contract", "verdict:refuse", `commit:${COMMIT}`] });
    expect(latestContractVerdict(ledger.entries(), "T-1")).toMatchObject({ ok: true, commit: OTHER });
  });

  it("an unsigned or agent-written contract verdict does not count", async () => {
    const ledger = await ledgerWith();
    // An agent may not write a review.verdict at all.
    expect(() => ledger.append({ actor: WORKER, type: "review.verdict", subject: "T-1", summary: "fine", evidence: ["scope:contract", "verdict:approve", `commit:${COMMIT}`] })).toThrow(LedgerError);
    // A person's own entry is signed, but only the gate's contract check counts as the check: a person's "approve" is not a measurement.
    ledger.append({ actor: { kind: "person", id: "owner" }, type: "review.verdict", subject: "T-1", summary: "Looks fine to me", evidence: ["scope:contract", "verdict:approve", `commit:${COMMIT}`] });
    expect(contractVerdictAt(ledger.entries(), "T-1", COMMIT)).toBeUndefined();
    expect(() => diffApproval(ledger)).toThrow(/contract check/);
  });
});
