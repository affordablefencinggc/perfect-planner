// Seeds a roadmap from a plan template (see templates.ts), adapted to what the
// repo already has and what the idea says. Everything here is a SUGGESTION: the
// seeded tasks sit in the draft roadmap marked "suggested", and nothing is
// written to the board until the person approves the plan.
//
// What the repo may contribute is small and fixed on purpose: yes/no flags, a
// language, and a few well-known folder names. No file content, no package
// name, no description and no free text from the repo ever reaches a title, a
// done-when sentence or the template list, so text planted in a repo (a README,
// a package.json field) is data that cannot steer the plan.
import * as fs from "node:fs";
import * as path from "node:path";
import { readDescription, withoutNegations } from "./description";
import { profileIdea } from "./profile";
import { FINAL_TASK_KEY } from "./roadmap";
import { contractFlags, draftContract, normalizeContract } from "./contract";
import { readRepoStack, type RepoStack } from "./repo";
import {
  DEPTH_TIER,
  isTemplateDepth,
  type Cond,
  type FileRole,
  type Lang,
  type PlanTemplate,
  type SkeletonTask,
  type TemplateDepth,
  type TemplateTask,
} from "./templates";
import type { Roadmap, RoadmapTask } from "./types";

// ---------- What the repo looks like ----------

export type RepoKind = "empty" | "js" | "python" | "go" | "rust" | "other";

/** The repo as a plan template sees it: flags and a language, nothing read from file contents but package.json's test script. */
export interface RepoContext {
  kind: RepoKind;
  lang: Lang;
  /** TypeScript (js repos). */
  ts: boolean;
  /** The source folder, from a fixed list: "src", "lib", "app" or "". */
  srcDir: string;
  /** The test folder, from a fixed list: "tests", "test", "__tests__", "spec" or "". */
  testDir: string;
  /** A Python package folder (a plain identifier with an __init__.py), or "". */
  pyPackage: string;
  /** Go: a cmd/ folder exists. */
  goCmd: boolean;
  manifest: boolean;
  tests: boolean;
  ci: boolean;
  readme: boolean;
  store: boolean;
  signin: boolean;
  payments: boolean;
  ai: boolean;
}

export const EMPTY_CONTEXT: RepoContext = {
  kind: "empty",
  lang: "js",
  ts: false,
  srcDir: "",
  testDir: "",
  pyPackage: "",
  goCmd: false,
  manifest: false,
  tests: false,
  ci: false,
  readme: false,
  store: false,
  signin: false,
  payments: false,
  ai: false,
};

const KINDS: readonly RepoKind[] = ["empty", "js", "python", "go", "rust", "other"];
const LANGS: readonly Lang[] = ["js", "python", "go", "rust"];
const SRC_DIRS = ["src", "lib", "app"] as const;
const TEST_DIRS = ["tests", "test", "__tests__", "spec"] as const;
const PY_PACKAGE = /^[a-z_][a-z0-9_]{1,30}$/;
const NOT_A_PACKAGE = new Set(["tests", "test", "docs", "doc", "examples", "example", "scripts", "build", "dist", "venv", "env", "tools", "benchmarks", "migrations", "site", "typings", "stubs", "vendor", "node_modules"]);
const TEST_TOOLS = ["vitest", "jest", "mocha", "ava", "tap", "uvu", "jasmine", "@playwright/test"];
/** Most directory entries read from one folder, so a huge folder cannot stall planning. */
const MAX_ENTRIES = 5000;
const MAX_PACKAGE_JSON = 1_000_000;

/** Top-level names of a folder, at most MAX_ENTRIES, never throwing. */
function names(dir: string, limit = MAX_ENTRIES): string[] {
  const out: string[] = [];
  let handle: fs.Dir | undefined;
  try {
    handle = fs.opendirSync(dir);
    for (let entry = handle.readSync(); entry && out.length < limit; entry = handle.readSync()) out.push(entry.name);
  } catch {
    /* a missing or unreadable folder has no names */
  } finally {
    try {
      handle?.closeSync();
    } catch {
      /* already closed */
    }
  }
  return out;
}

/** A real folder inside root (a symlink, which could point anywhere, does not count). */
function isDir(root: string, rel: string): boolean {
  try {
    return fs.lstatSync(path.join(root, ...rel.split("/"))).isDirectory();
  } catch {
    return false;
  }
}

function isFile(root: string, rel: string): boolean {
  try {
    return fs.lstatSync(path.join(root, ...rel.split("/"))).isFile();
  } catch {
    return false;
  }
}

function readPackage(root: string): Record<string, unknown> | null {
  try {
    const file = path.join(root, "package.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_JSON) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function ideaLanguage(idea: string): { lang: Lang; ts: boolean } {
  const choice = readDescription(cap(idea)).facts.find((f) => f.id === "stack.language")?.choice;
  if (choice === "python") return { lang: "python", ts: false };
  if (choice === "go") return { lang: "go", ts: false };
  return { lang: "js", ts: choice === "typescript" };
}

/**
 * Reads the folder as a plan template needs it: language, whether it has a
 * manifest, tests, CI and a README, and which fixed folders exist. Text only:
 * nothing is imported or run, a symlink is never followed, and a folder with
 * thousands of entries is read only as far as MAX_ENTRIES.
 */
export function readRepoContext(root: string, stack: RepoStack = readRepoStack(root), idea = ""): RepoContext {
  const top = names(root);
  const visible = top.filter((n) => !n.startsWith("."));
  const has = (name: string): boolean => top.includes(name);
  const pkg = readPackage(root);
  const kind: RepoKind = pkg
    ? "js"
    : has("pyproject.toml") || has("setup.py") || has("setup.cfg") || has("requirements.txt")
      ? "python"
      : has("go.mod")
        ? "go"
        : has("Cargo.toml")
          ? "rust"
          : visible.length === 0
            ? "empty"
            : "other";
  const fromIdea = ideaLanguage(idea);
  const lang: Lang = kind === "js" || kind === "python" || kind === "go" || kind === "rust" ? kind : fromIdea.lang;
  const deps = { ...((pkg?.dependencies as Record<string, unknown> | undefined) ?? {}), ...((pkg?.devDependencies as Record<string, unknown> | undefined) ?? {}) };
  const ts = kind === "js" ? isFile(root, "tsconfig.json") || "typescript" in deps : kind === "empty" || kind === "other" ? lang === "js" && fromIdea.ts : false;

  const srcDir = SRC_DIRS.find((d) => isDir(root, d)) ?? "";
  const testDir = TEST_DIRS.find((d) => isDir(root, d)) ?? "";
  const pyPackage =
    kind === "python"
      ? (top
          .filter((n) => PY_PACKAGE.test(n) && !NOT_A_PACKAGE.has(n))
          .sort()
          .slice(0, 50)
          .find((n) => isDir(root, n) && isFile(root, `${n}/__init__.py`)) ?? "")
      : "";

  const scripts = pkg?.scripts as Record<string, unknown> | undefined;
  const testScript = typeof scripts?.test === "string" && !/no test specified/i.test(scripts.test);
  const tests =
    kind === "js"
      ? testScript || TEST_TOOLS.some((t) => t in deps) || testDir !== ""
      : kind === "python"
        ? testDir !== "" || has("pytest.ini") || has("tox.ini") || has("conftest.py")
        : kind === "go"
          ? top.some((n) => n.endsWith("_test.go"))
          : kind === "rust"
            ? isDir(root, "tests")
            : testDir !== "";
  const workflows = isDir(root, ".github/workflows") && names(path.join(root, ".github", "workflows"), 200).some((n) => /\.ya?ml$/i.test(n));
  const ci = workflows || has(".gitlab-ci.yml") || has(".travis.yml") || has("azure-pipelines.yml") || has("bitbucket-pipelines.yml") || has("Jenkinsfile") || isDir(root, ".circleci");
  const real = (id: string): boolean => stack.facts.some((f) => f.id === id && !f.notAnApp);

  return {
    kind,
    lang,
    ts,
    srcDir,
    testDir,
    pyPackage,
    goCmd: kind === "go" && isDir(root, "cmd"),
    manifest: kind === "js" || kind === "python" || kind === "go" || kind === "rust",
    tests,
    ci,
    readme: top.some((n) => /^readme(\.[a-z]{1,8})?$/i.test(n)),
    store: real("data.store"),
    signin: real("auth.provider") || real("auth.signin"),
    payments: real("money.payments"),
    ai: real("ai.model"),
  };
}

/**
 * A context read back from the ledger (or any other untrusted place): each
 * field is checked, anything unexpected falls back to the empty repo's value.
 */
export function coerceContext(raw: unknown): RepoContext {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const flag = (k: string): boolean => o[k] === true;
  const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback);
  const pick = (v: unknown, list: readonly string[]): string => (typeof v === "string" && list.includes(v) ? v : "");
  return {
    kind: oneOf(o.kind, KINDS, "empty"),
    lang: oneOf(o.lang, LANGS, "js"),
    ts: flag("ts"),
    srcDir: pick(o.srcDir, SRC_DIRS),
    testDir: pick(o.testDir, TEST_DIRS),
    pyPackage: typeof o.pyPackage === "string" && PY_PACKAGE.test(o.pyPackage) && !NOT_A_PACKAGE.has(o.pyPackage) ? o.pyPackage : "",
    goCmd: flag("goCmd"),
    manifest: flag("manifest"),
    tests: flag("tests"),
    ci: flag("ci"),
    readme: flag("readme"),
    store: flag("store"),
    signin: flag("signin"),
    payments: flag("payments"),
    ai: flag("ai"),
  };
}

export function sameContext(a: RepoContext, b: RepoContext): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- What the idea says ----------

/** What screens call the idea before there is one. It is a label, not something the person wrote. */
export const NO_IDEA_LABEL = "Your idea";

/** Longest idea the seeder reads. The routes already refuse longer ones; the core never trusts that. */
export const IDEA_CAP = 4000;
const cap = (idea: unknown): string => {
  const text = String(idea ?? "").slice(0, IDEA_CAP);
  return text.trim() === NO_IDEA_LABEL ? "" : text;
};

const ACCOUNT_WORDS = /\b(?:sign[- ]?in|log[- ]?in|accounts?|users?|passwords?|members?|customers?)\b/i;

export interface IdeaFacts {
  signals: string[];
  /** Ids of what the idea rules out (see description.ts). */
  ruledOut: string[];
  mentionsAccounts: boolean;
}

export function ideaFacts(idea: string): IdeaFacts {
  const text = cap(idea);
  const profile = profileIdea(text);
  return {
    signals: profile.signals,
    ruledOut: (profile.ruledOut ?? []).map((r) => r.id),
    mentionsAccounts: profile.signals.includes("team") || ACCOUNT_WORDS.test(withoutNegations(text)),
  };
}

/** The idea in a few words for one task title: its first sentence, one line, 48 characters at most. Empty when there is nothing to show. */
export function subjectOf(idea: unknown): string {
  const first = cap(idea)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s/)[0]!
    .replace(/[.!?]+$/, "")
    .trim();
  if (first.length < 3) return "";
  if (first.length <= 48) return first;
  // Cut at a word when there is one in reach, so a title never ends in half a word.
  const cut = first.slice(0, 47);
  const space = cut.lastIndexOf(" ");
  return `${(space >= 24 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, "")}…`;
}

// ---------- Language-specific vocabulary ----------

const TEST_COMMAND: Readonly<Record<Lang, string>> = { js: "npm test", python: "pytest", go: "go test ./...", rust: "cargo test" };

export function testCommand(lang: Lang): string {
  return TEST_COMMAND[lang];
}

/** The pattern for one kind of file in this repo's language. Fixed vocabulary plus the validated folder names in the context. */
export function filePattern(role: FileRole, ctx: RepoContext): string {
  const src = ctx.srcDir || "src";
  const tests = ctx.testDir || "tests";
  const e = ctx.ts ? "ts" : "js";
  const u = ctx.ts ? "tsx" : "jsx";
  const py = ctx.pyPackage || "src";
  const common: Record<"ci" | "docs" | "changelog" | "license" | "env", string> = { ci: ".github/workflows/*.yml", docs: "README.md", changelog: "CHANGELOG.md", license: "LICENSE", env: ".env.example" };
  if (role === "ci" || role === "docs" || role === "changelog" || role === "license" || role === "env") return common[role];
  switch (ctx.lang) {
    case "js":
      return { manifest: "package.json", entry: `${src}/index.${e}`, source: `${src}/**/*.${e}`, ui: `${src}/**/*.${u}`, style: `${src}/**/*.css`, routes: `${src}/routes/**/*.${e}`, schema: "db/**/*.sql", test: `${tests}/**/*.test.${e}` }[role];
    case "python":
      return { manifest: "pyproject.toml", entry: `${py}/*.py`, source: `${py}/**/*.py`, ui: `${py}/templates/**`, style: `${py}/static/**/*.css`, routes: `${py}/routes/**/*.py`, schema: "migrations/**/*.sql", test: `${tests}/test_*.py` }[role];
    case "go":
      return { manifest: "go.mod", entry: ctx.goCmd ? "cmd/**/*.go" : "*.go", source: "**/*.go", ui: "web/**", style: "web/**/*.css", routes: "api/**/*.go", schema: "migrations/**/*.sql", test: "**/*_test.go" }[role];
    case "rust":
      return { manifest: "Cargo.toml", entry: "src/*.rs", source: "src/**/*.rs", ui: "ui/**", style: "static/**/*.css", routes: "src/routes/**/*.rs", schema: "migrations/**/*.sql", test: "tests/**/*.rs" }[role];
  }
}

// ---------- Seeding ----------

export interface SeedResult {
  tasks: RoadmapTask[];
  /** Skeleton tasks the repo already covers: named in the roadmap's "already in your repo" line. */
  existing: { node: string; label: string }[];
  /** Skeleton tasks the idea rules out, with the reason, so nothing disappears unexplained. */
  leftOut: { step: string; title: string; because: string }[];
}

export const templateTaskKey = (template: PlanTemplate, step: string): string => `K-tpl-${template.id}-${step}`;

type Verdict = { ok: true } | { ok: false; why: "repo" | "ruled-out" | "not-applicable"; because: string };

function judge(task: SkeletonTask, ctx: RepoContext, idea: IdeaFacts): Verdict {
  const ruled = (id: string): boolean => idea.ruledOut.includes(id);
  const checks: Record<Cond, () => Verdict> = {
    "repo:no-manifest": () => (ctx.manifest ? { ok: false, why: "repo", because: "your folder already has a project file" } : { ok: true }),
    "repo:no-tests": () => (ctx.tests ? { ok: false, why: "repo", because: "your folder already has tests" } : { ok: true }),
    "repo:no-ci": () => (ctx.ci ? { ok: false, why: "repo", because: "your folder already runs checks on every push" } : { ok: true }),
    "repo:no-readme": () => (ctx.readme ? { ok: false, why: "repo", because: "your folder already has a README" } : { ok: true }),
    "repo:no-store": () => (ctx.store ? { ok: false, why: "repo", because: "your app already stores data" } : { ok: true }),
    "repo:no-signin": () => (ctx.signin ? { ok: false, why: "repo", because: "your app already has sign-in" } : { ok: true }),
    "repo:no-payments": () => (ctx.payments ? { ok: false, why: "repo", because: "your app already takes payments" } : { ok: true }),
    "repo:no-ai": () => (ctx.ai ? { ok: false, why: "repo", because: "your app already calls an AI service" } : { ok: true }),
    "repo:has-store": () => (ctx.store ? { ok: true } : { ok: false, why: "not-applicable", because: "your app stores no data" }),
    "repo:has-signin": () => (ctx.signin ? { ok: true } : { ok: false, why: "not-applicable", because: "your app has no sign-in" }),
    "idea:accounts-allowed": () => (ruled("accounts") || ruled("single-user") || ruled("not-an-app") ? { ok: false, why: "ruled-out", because: "your idea rules out accounts" } : { ok: true }),
    "idea:accounts-mentioned": () =>
      ruled("accounts") || ruled("single-user") ? { ok: false, why: "ruled-out", because: "your idea rules out accounts" } : idea.mentionsAccounts ? { ok: true } : { ok: false, why: "not-applicable", because: "your idea does not mention accounts" },
    "idea:payments": () => (idea.signals.includes("payments") ? { ok: true } : { ok: false, why: "not-applicable", because: "your idea does not mention payments" }),
    "idea:ai": () => (idea.signals.includes("ai") ? { ok: true } : { ok: false, why: "not-applicable", because: "your idea does not mention AI" }),
    "idea:offline": () => (idea.signals.includes("offline") ? { ok: true } : { ok: false, why: "not-applicable", because: "your idea does not mention working offline" }),
    "idea:files": () => (idea.signals.includes("files") ? { ok: true } : { ok: false, why: "not-applicable", because: "your idea does not mention files" }),
  };
  // An idea rule-out is reported before a repo reason, and either before "not applicable".
  const order = { "ruled-out": 0, repo: 1, "not-applicable": 2 } as const;
  let worst: Verdict = { ok: true };
  for (const cond of task.if ?? []) {
    const v = checks[cond]();
    if (!v.ok && (worst.ok || order[v.why] < order[worst.why])) worst = v;
  }
  return worst;
}

/**
 * The template's tasks for this repo and idea at the given depth:
 *  - a task the repo already covers becomes a line in `existing`, not a task;
 *  - a task the idea rules out goes to `leftOut` with the reason;
 *  - a task that only fits when the idea names it (payments, AI, ...) is simply not offered;
 *  - "after" links skip over any step that is not there, so the graph stays whole and acyclic.
 */
export function seedTemplate(template: PlanTemplate, context: RepoContext, idea: string, opts: { depth?: TemplateDepth; owner?: string } = {}): SeedResult {
  const depth = isTemplateDepth(opts.depth) ? opts.depth : template.depth;
  const owner = opts.owner ?? "unassigned";
  const facts = ideaFacts(idea);
  const subject = subjectOf(idea);
  const test = testCommand(context.lang);
  const byStep = new Map(template.skeleton.map((x) => [x.step, x]));

  const kept = new Set<string>();
  const existing: SeedResult["existing"] = [];
  const leftOut: SeedResult["leftOut"] = [];
  for (const task of template.skeleton) {
    if (task.tier > DEPTH_TIER[depth]) continue;
    const verdict = judge(task, context, facts);
    if (verdict.ok) kept.add(task.step);
    else if (verdict.why === "repo" && task.have) existing.push({ node: `tpl:${task.step}`, label: task.have });
    else if (verdict.why === "ruled-out") leftOut.push({ step: task.step, title: fillTitle(task.title, ""), because: verdict.because });
  }

  /** The nearest kept steps at or behind `step`, walking through steps that are not kept. */
  const reach = (step: string, seen = new Set<string>()): string[] => {
    if (seen.has(step)) return [];
    seen.add(step);
    if (kept.has(step)) return [step];
    return (byStep.get(step)?.after ?? []).flatMap((a) => reach(a, seen));
  };

  const tasks: RoadmapTask[] = template.skeleton
    .filter((x) => kept.has(x.step))
    .map((x) => {
      const info: TemplateTask = { id: template.id, step: x.step, size: x.size, tier: x.tier, files: [...new Set(x.files.map((r) => filePattern(r, context)))] };
      const doneWhen = x.doneWhen.replaceAll("{test}", test);
      const title = fillTitle(x.title, subject);
      // Every task carries a contract. A starter's step names the files it usually touches: those are the allowed files.
      const drafted = draftContract({ kind: "component", label: title, parts: [], doneWhen });
      const own = info.files.length ? normalizeContract({ ...drafted.contract, allowedFiles: info.files }) : null;
      const contract = own && own.ok ? own.contract : drafted.contract;
      return {
        key: templateTaskKey(template, x.step),
        title,
        phase: x.phase,
        owner,
        doneWhen,
        contract,
        contractFlags: own && own.ok ? contractFlags(contract) : drafted.flags,
        node: "root",
        change: x.change ?? "feature",
        dependsOn: [...new Set((x.after ?? []).flatMap((a) => reach(a)).filter((s) => s !== x.step))].map((s) => templateTaskKey(template, s)),
        template: info,
      };
    });
  return { tasks, existing, leftOut };
}

function fillTitle(title: string, subject: string): string {
  return title.replace("{subject}", subject ? `: ${subject}` : "");
}

/** The closing task for this template, when "Cut the first release" does not fit the work. */
function finishOf(template: PlanTemplate, ctx: RepoContext): { title: string; doneWhen: string } | undefined {
  return template.finish ? { title: template.finish.title, doneWhen: template.finish.doneWhen.replaceAll("{test}", testCommand(ctx.lang)) } : undefined;
}

/**
 * Puts the seeded tasks into a roadmap built from the mind map: in each phase
 * they come first, the closing task waits for them too, and the parts the repo
 * already has are added to the "already in your repo" line. Dependencies of the
 * mind map's own tasks are untouched.
 */
export function applyTemplate(roadmap: Roadmap, template: PlanTemplate, seed: SeedResult, ctx: RepoContext): Roadmap {
  const keys = seed.tasks.map((x) => x.key);
  const finish = finishOf(template, ctx);
  const phases = roadmap.phases.map((phase) => ({
    ...phase,
    tasks: [
      ...seed.tasks.filter((x) => x.phase === phase.id),
      ...phase.tasks.map((x) =>
        x.key === FINAL_TASK_KEY ? { ...x, ...(finish ?? {}), ...(finish ? { contract: { ...x.contract, doneWhen: finish.doneWhen } } : {}), dependsOn: [...new Set([...keys, ...x.dependsOn])] } : x,
      ),
    ],
  }));
  const existing = [...(roadmap.existing ?? []), ...seed.existing];
  return existing.length > 0 ? { phases, existing } : { phases };
}
