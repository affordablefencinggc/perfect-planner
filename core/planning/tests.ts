// What the repo already uses to test itself, read from package.json and the test runner configs, so a task's
// done-when names a real test file and the command that runs it instead of "npm test passes".
import fs from "node:fs";
import path from "node:path";
import { isTestLike } from "../gate/contractPaths";

export interface TestRunner {
  /** The package.json script that runs it, e.g. "test:core". */
  script: string;
  kind: "vitest" | "jest" | "node";
  /** The config file the script passes, repo-relative. */
  config?: string;
  /** Top-level folders the config says it tests (from its `include` globs); empty when unknown. */
  folders: string[];
}

export interface TestSetup {
  /** The script that runs everything, e.g. "npm test", when the repo has one. */
  suite?: string;
  runners: TestRunner[];
  pytest: boolean;
}

function readText(file: string): string {
  try {
    if (!fs.lstatSync(file).isFile()) return "";
    return fs.readFileSync(file, "utf8").slice(0, 200_000);
  } catch {
    return "";
  }
}

/** Top-level folders named in the `include` array of a runner config. */
function includeFolders(configText: string): string[] {
  const block = /include\s*:\s*\[([^\]]*)\]/s.exec(configText)?.[1] ?? "";
  const folders = [...block.matchAll(/["'`]([^"'`]+)["'`]/g)]
    .map((m) => m[1]!.replace(/^\.\//, "").split("/")[0]!)
    .filter((f) => f && !f.includes("*"));
  return [...new Set(folders)];
}

export function readTestSetup(root: string): TestSetup {
  let pkg: { scripts?: Record<string, unknown>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(readText(path.join(root, "package.json")) || "{}");
  } catch {
    pkg = {};
  }
  const scripts = pkg.scripts ?? {};
  const runners: TestRunner[] = [];
  for (const [script, raw] of Object.entries(scripts)) {
    if (typeof raw !== "string") continue;
    const kind = /\bvitest\b/.test(raw) ? "vitest" : /\bjest\b/.test(raw) ? "jest" : /\bnode\s+--test\b/.test(raw) ? "node" : null;
    if (!kind) continue;
    const config = /--config[ =]+(\S+)/.exec(raw)?.[1];
    runners.push({ script, kind, ...(config ? { config } : {}), folders: config ? includeFolders(readText(path.join(root, config))) : [] });
  }
  const suite = typeof scripts.test === "string" && !/no test specified/i.test(scripts.test) ? "npm test" : undefined;
  const pytest = fs.existsSync(path.join(root, "pytest.ini")) || /\[tool\.pytest/.test(readText(path.join(root, "pyproject.toml")));
  return { ...(suite ? { suite } : {}), runners, pytest };
}

/** The command that runs one test file, or null when the repo's setup does not say. */
export function testCommand(setup: TestSetup | undefined, testFile: string): string | null {
  if (!setup) return null;
  const top = testFile.split("/")[0]!;
  const vitests = setup.runners.filter((r) => r.kind === "vitest");
  const vitest = vitests.find((r) => r.folders.includes(top)) ?? vitests.find((r) => r.folders.length === 0);
  if (vitest && /\.(test|spec)\.[cm]?[jt]sx?$/.test(testFile)) return `npm run ${vitest.script} -- ${testFile}`;
  const jest = setup.runners.find((r) => r.kind === "jest");
  if (jest && /\.(test|spec)\.[cm]?[jt]sx?$/.test(testFile)) return `npm run ${jest.script} -- ${testFile}`;
  if (setup.runners.some((r) => r.kind === "node") && /\.[cm]?js$/.test(testFile)) return `node --test ${testFile}`;
  if (setup.pytest && testFile.endsWith(".py")) return `pytest ${testFile}`;
  if (testFile.endsWith("_test.go")) return `go test ./${path.posix.dirname(testFile)}/`;
  return null;
}

function stemOf(file: string): string {
  const base = file.split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "").replace(/\.(test|spec)$/i, "").replace(/^test_/, "").replace(/_test$/, "").toLowerCase();
}

/** Test files already in the repo whose name matches one of the code files (foo.ts -> foo.test.ts, test_foo.py). */
export function existingTestsFor(files: readonly string[], codeFiles: readonly string[]): string[] {
  const stems = new Set(codeFiles.map(stemOf));
  return files.filter((f) => isTestLike(f) && stems.has(stemOf(f))).sort();
}
