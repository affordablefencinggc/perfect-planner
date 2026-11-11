import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { draftContract, repoAwareDoneWhen, verifyDoneWhen } from "./contract";
import { buildMindMap } from "./mindmap";
import { buildRoadmap } from "./roadmap";
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

describe("verify-only tasks and more repo facts", () => {
  it("reads Firebase, MongoDB and Netlify so those questions are not asked", () => {
    const stack = readRepoStack(repo({ "package.json": JSON.stringify({ dependencies: { firebase: "1", mongoose: "1" } }), "netlify.toml": "" }));
    const text = (id: string) => stack.facts.find((f) => f.id === id)?.text;
    expect(text("auth.provider")).toBe("Firebase Auth");
    expect(text("data.store")).toBe("MongoDB");
    expect(text("stack.hosting")).toBe("Netlify");
  });

  const root = repo({
    "package.json": pkg,
    "vitest.core.config.mjs": 'export default { test: { include: ["core/**/*.test.ts"] } }',
    "core/billing/invoice.ts": "",
    "core/billing/invoice.test.ts": "",
    "core/search/index.ts": "",
  });
  const index = listRepoFiles(root);

  it("gives a verify done-when only for a part that has a test", () => {
    expect(verifyDoneWhen("Invoice", index)).toContain("npm run test:core -- core/billing/invoice.test.ts");
    expect(verifyDoneWhen("Search", index)).toBeNull();
    expect(verifyDoneWhen("Invoice", { files: [], truncated: false })).toBeNull();
  });

  it("draws a verify contract that changes nothing and is not flagged", () => {
    const { contract, flags } = draftContract({ kind: "verify", label: "Invoice", parts: [], doneWhen: "x" }, index);
    expect(contract.allowedFiles).toEqual([]);
    expect(flags).toEqual([]);
    expect(contract.clauses.join(" ")).toMatch(/Change no files/);
  });

  it("adds a Verify task to the roadmap for an existing, tested part and makes the release depend on it", () => {
    const suiteRepo = listRepoFiles(
      repo({
        "package.json": pkg,
        "vitest.core.config.mjs": 'export default { test: { include: ["core/**/*.test.ts"] } }',
        "core/harness/test-suite.ts": "",
        "core/harness/test-suite.test.ts": "",
      }),
    );
    const map = buildMindMap("An app", [{ questionId: "testing.strategy", area: "testing", q: "q", choice: "unit-integration", text: "Automated tests", fromRepo: true }]);
    const tasks = buildRoadmap(map, { repo: suiteRepo }).phases.flatMap((p) => p.tasks);
    const verify = tasks.find((t) => t.title === "Verify Test suite still works");
    expect(verify?.doneWhen).toContain("core/harness/test-suite.test.ts");
    expect(tasks.some((t) => t.title === "Build Test suite")).toBe(false);
    expect(tasks.find((t) => t.key === "K-first-release")?.dependsOn).toContain(verify!.key);
  });
});
