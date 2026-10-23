import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoAwareDoneWhen } from "./contract";
import { listRepoFiles, readRepoStack } from "./repo";
import { existingTestsFor, readTestSetup, testCommand } from "./tests";

const dirs: string[] = [];
function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-tests-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const pkg = JSON.stringify({
  scripts: { test: "node --test tests/*.test.mjs", "test:core": "vitest run --config vitest.core.config.mjs" },
  devDependencies: { vitest: "1" },
});

describe("readTestSetup", () => {
  it("finds the suite, the vitest script and the folders its config tests", () => {
    const root = repo({ "package.json": pkg, "vitest.core.config.mjs": 'export default { test: { include: ["core/**/*.test.ts"] } }' });
    const setup = readTestSetup(root);
    expect(setup.suite).toBe("npm test");
    expect(setup.runners.find((r) => r.kind === "vitest")).toMatchObject({ script: "test:core", config: "vitest.core.config.mjs", folders: ["core"] });
  });
  it("ignores the npm placeholder test script", () => {
    expect(readTestSetup(repo({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })).suite).toBeUndefined();
  });
  it("gives the command for the config that covers the file", () => {
    const setup = readTestSetup(repo({ "package.json": pkg, "vitest.core.config.mjs": 'export default { test: { include: ["core/**/*.test.ts"] } }' }));
    expect(testCommand(setup, "core/planning/roadmap.test.ts")).toBe("npm run test:core -- core/planning/roadmap.test.ts");
    expect(testCommand(setup, "tests/engine.test.mjs")).toBe("node --test tests/engine.test.mjs");
    expect(testCommand(undefined, "a.test.ts")).toBeNull();
  });
});

describe("existingTestsFor", () => {
  it("matches foo.ts with foo.test.ts and tests/foo.test.mjs but not other files", () => {
    const files = ["src/foo.ts", "src/foo.test.ts", "tests/foo.test.mjs", "tests/bar.test.mjs"];
    expect(existingTestsFor(files, ["src/foo.ts"])).toEqual(["src/foo.test.ts", "tests/foo.test.mjs"]);
  });
});

describe("repoAwareDoneWhen", () => {
  const root = repo({
    "package.json": pkg,
    "vitest.core.config.mjs": 'export default { test: { include: ["core/**/*.test.ts"] } }',
    "core/billing/invoice.ts": "",
    "core/billing/invoice.test.ts": "",
    "core/search/index.ts": "",
  });
  const index = listRepoFiles(root);
  const generic = "a test proves Billing starts and does its one job, and `npm test` passes for Billing.";
  it("names the existing test and its command", () => {
    const out = repoAwareDoneWhen(["core/billing/invoice.ts"], index, generic);
    expect(out).toContain("`core/billing/invoice.test.ts`");
    expect(out).toContain("npm run test:core -- core/billing/invoice.test.ts");
    expect(out).not.toContain("npm test` passes");
  });
  it("says where a new test goes when none exists", () => {
    const out = repoAwareDoneWhen(["core/search/index.ts"], index, generic);
    expect(out).toContain("no test covers these files yet");
    expect(out).toContain("core/search/index.test.ts");
  });
  it("leaves the sentence alone for a repo without test info or files", () => {
    expect(repoAwareDoneWhen(["x/**"], { files: [], truncated: false }, generic)).toBe(generic);
    expect(repoAwareDoneWhen(["nothing/**"], index, generic)).toBe(generic);
  });
});

describe("readRepoStack testing", () => {
  it("records the repo's tests so the testing question is not asked", () => {
    const stack = readRepoStack(repo({ "package.json": pkg, ".github/workflows/release.yml": "name: r" }));
    expect(stack.facts.find((f) => f.id === "testing.strategy")?.text).toContain("npm test");
    expect(stack.facts.find((f) => f.id === "testing.deploy")?.evidence).toEqual([".github/workflows/release.yml"]);
  });
});
