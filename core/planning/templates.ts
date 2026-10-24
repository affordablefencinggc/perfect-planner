// Plan templates: starter plans by kind of work. Pure data, server side.
//
// A template SUGGESTS. It never answers a question, never approves a plan and
// never writes a task on the board:
//   - it says which of the ten question areas to ask first and which are
//     usually skipped for this kind of work (the person still taps "skip");
//   - it carries suggested answers, shown as suggestions next to a question;
//   - it carries a skeleton of tiny tasks that is adapted to the repo scan and
//     the idea (see seed.ts) and shown as "suggested" until the person approves
//     the plan.
// Nothing in this file reads the repo, the idea or the ledger, so nothing a repo
// or an idea says can change what is listed here.
import { AREA_TITLES } from "./types";
import type { Area, PhaseId } from "./types";

export const TEMPLATE_IDS = ["web-app", "cli-tool", "backend-api", "library", "add-feature", "fix-bug", "cleanup", "release-ready"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/** How finely the starter breaks the work down: quick is the essentials, thorough is everything. */
export const TEMPLATE_DEPTHS = ["quick", "standard", "thorough"] as const;
export type TemplateDepth = (typeof TEMPLATE_DEPTHS)[number];

/** The tier a depth includes: quick takes tier 1 tasks, standard tiers 1 and 2, thorough all three. */
export const DEPTH_TIER: Readonly<Record<TemplateDepth, 1 | 2 | 3>> = { quick: 1, standard: 2, thorough: 3 };

/** A size hint, not an estimate: tiny is one or two files, small up to three, medium up to four. */
export const TASK_SIZES = ["tiny", "small", "medium"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];
/** The most file patterns a task of each size may name. */
export const SIZE_LIMIT: Readonly<Record<TaskSize, number>> = { tiny: 2, small: 3, medium: 4 };

/** A kind of file a task touches. seed.ts turns each role into a pattern for the repo's own language. */
export const FILE_ROLES = ["manifest", "entry", "source", "ui", "style", "routes", "schema", "test", "ci", "docs", "changelog", "license", "env"] as const;
export type FileRole = (typeof FILE_ROLES)[number];

export type Lang = "js" | "python" | "go" | "rust";

/**
 * When a skeleton task applies. All of a task's conditions must hold.
 *   repo:no-X   the repo does not have X yet (when it has, the task is listed as "already there")
 *   repo:has-X  the repo has X
 *   idea:accounts-allowed   the idea does not rule accounts out
 *   idea:accounts-mentioned the idea talks about sign-in, accounts or users
 *   idea:payments | ai | offline | files   the idea names it (and does not rule it out)
 */
export type Cond =
  | "repo:no-manifest"
  | "repo:no-tests"
  | "repo:no-ci"
  | "repo:no-readme"
  | "repo:no-store"
  | "repo:no-signin"
  | "repo:no-payments"
  | "repo:no-ai"
  | "repo:has-store"
  | "repo:has-signin"
  | "idea:accounts-allowed"
  | "idea:accounts-mentioned"
  | "idea:payments"
  | "idea:ai"
  | "idea:offline"
  | "idea:files";

export interface SkeletonTask {
  /** Unique within the template; the roadmap key is K-tpl-<template>-<step>. */
  step: string;
  phase: PhaseId;
  /** 1 essential, 2 usual, 3 thorough. */
  tier: 1 | 2 | 3;
  size: TaskSize;
  /** `{subject}` becomes ": <the idea in a few words>" or nothing. */
  title: string;
  /** One sentence a test can check. `{test}` becomes the repo's test command. */
  doneWhen: string;
  files: FileRole[];
  /** Steps this one comes after. A step the repo already covers is skipped over. */
  after?: string[];
  if?: Cond[];
  /** What to call it when the repo already has it ("A test setup"), shown instead of a task. */
  have?: string;
  change?: "feature" | "fix";
}

/** A suggested answer to one planning question. Shown as a suggestion; the person answers. */
export interface SuggestedAnswer {
  /** Planning question id, such as "data.store". */
  q: string;
  /** An option id of that question, or ... */
  option?: string;
  /** ... free text. Exactly one of the two. */
  text?: string;
  why: string;
  /** Only when the idea or repo raises this signal. */
  when?: string;
  /** Not when the idea or repo raises this signal (the question's own recommendation covers it). */
  unless?: string;
  /** Only for repos in this language. */
  lang?: Lang;
}

export interface PlanTemplate {
  id: TemplateId;
  title: string;
  /** One plain-language line. */
  description: string;
  /** Areas to ask first, in this order. */
  askFirst: Area[];
  /** Areas that are usually skipped for this kind of work (an idea that raises the matching signal keeps them). */
  usuallySkip: Area[];
  depth: TemplateDepth;
  /** "Not needed for <skipFor>." is what a skip records. */
  skipFor: string;
  suggestions: SuggestedAnswer[];
  skeleton: SkeletonTask[];
  /** Replaces the closing task's title and done-when when "Cut the first release" does not fit the work. */
  finish?: { title: string; doneWhen: string };
}

/** What a seeded roadmap task carries, as a separate block so the contract fields stay the contract's. */
export interface TemplateTask {
  id: TemplateId;
  step: string;
  size: TaskSize;
  tier: 1 | 2 | 3;
  /** Likely file patterns for this repo's language. A suggestion, not a permission. */
  files: string[];
}

/** What the picker lists. No skeleton, no repo: the same for every project. */
export interface TemplateCard {
  id: TemplateId;
  title: string;
  description: string;
  askFirst: { area: Area; title: string }[];
  usuallySkip: { area: Area; title: string }[];
  depth: TemplateDepth;
  /** Tasks at the default depth, before the repo and idea trim it. */
  tasks: number;
}

/** Areas that stay asked when the idea (or repo) raises the signal. */
export const AREA_SIGNALS: Readonly<Partial<Record<Area, readonly string[]>>> = {
  money: ["payments"],
  ai: ["ai"],
  offline: ["offline"],
};

const t = (
  step: string,
  phase: PhaseId,
  tier: 1 | 2 | 3,
  size: TaskSize,
  title: string,
  doneWhen: string,
  files: FileRole[],
  extra: Partial<Pick<SkeletonTask, "after" | "if" | "have" | "change">> = {},
): SkeletonTask => ({ step, phase, tier, size, title, doneWhen, files, ...extra });

const s = (q: string, pick: { option: string } | { text: string }, why: string, extra: Partial<Pick<SuggestedAnswer, "when" | "unless" | "lang">> = {}): SuggestedAnswer => ({ q, ...pick, why, ...extra });

// ---------- The eight templates ----------

const WEB_APP: PlanTemplate = {
  id: "web-app",
  title: "New web app",
  description: "A website or web app built from scratch: pick the stack, build the first screen, then publish it.",
  askFirst: ["stack", "data", "auth", "platforms"],
  usuallySkip: ["offline", "ai"],
  depth: "standard",
  skipFor: "a new web app",
  suggestions: [
    s("stack.language", { option: "python" }, "Your repo is Python, so the screens and the server can share it.", { lang: "python" }),
    s("stack.language", { option: "typescript" }, "One language for the screens and the server."),
    s("stack.framework", { option: "nextjs" }, "Routing, pages and server calls in one place: the usual start for a new web app."),
    s("stack.hosting", { option: "vercel" }, "A managed host publishes every change with little set-up."),
    s("data.store", { option: "postgres" }, "Most web apps keep data that outlives one visit and one person."),
    s("data.schema", { option: "drizzle" }, "One typed schema and plain SQL migrations."),
    s("data.migrations", { option: "forward-only" }, "Checked-in migrations that run on deploy are the safest default."),
    s("data.backups", { option: "managed-daily" }, "A managed database gives backups for little effort."),
    s("auth.signin", { option: "magic-link" }, "No passwords to store, and the lightest real sign-in."),
    s("auth.provider", { option: "authjs" }, "Free, and runs inside your own app."),
    s("auth.roles", { option: "single-role" }, "Start with one kind of user; add roles when a second one exists."),
    s("platforms.first", { option: "web" }, "This starter is for a web app."),
    s("platforms.desktop-shell", { option: "none" }, "No desktop app in this starter.", { unless: "desktop" }),
    s("platforms.mobile-stack", { option: "none" }, "No separate mobile app in this starter.", { unless: "mobile" }),
    s("platforms.shared", { option: "nothing" }, "One platform for now.", { unless: "mobile" }),
    s("money.payments", { option: "not-v1" }, "Leave payments out of the first version unless the idea needs them.", { unless: "payments" }),
    s("security.secrets", { option: "secret-manager" }, "Keep keys in the host's secret store, never in the repo."),
    s("security.personal-data", { option: "store-minimum" }, "Keep only what each feature needs."),
    s("scale.users", { option: "under-10k" }, "Plan for thousands of users, not millions."),
    s("testing.strategy", { option: "unit-integration" }, "Fast tests on every push catch most breakage cheaply."),
    s("testing.deploy", { option: "ci-preview-prod" }, "Every branch gets a preview and main goes live."),
    s("testing.rollback", { option: "redeploy-previous" }, "Managed hosts can put the previous version back in one step."),
  ],
  skeleton: [
    t("scaffold", "foundation", 1, "small", "Set up the project so it installs and starts", "a clean checkout installs and starts, and {test} runs even with zero tests.", ["manifest", "entry", "env"], { if: ["repo:no-manifest"], have: "A project that installs and starts" }),
    t("first-test", "foundation", 1, "tiny", "Add the test command and one passing test", "{test} passes with one test that loads the app's entry.", ["test", "manifest"], { after: ["scaffold"], if: ["repo:no-tests"], have: "A test setup" }),
    t("first-screen", "core", 1, "small", "Build the first screen{subject}", "a test renders the first screen and proves its main action works.", ["ui", "style", "test"], { after: ["first-test"] }),
    t("data-store", "core", 2, "small", "Store the first piece of data", "a test saves one record and reads it back unchanged.", ["schema", "source", "test"], { after: ["first-test"], if: ["repo:no-store"], have: "A place to store data" }),
    t("signin", "core", 2, "medium", "Add sign-in", "a test signs a test person in and refuses a wrong or expired sign-in.", ["routes", "ui", "source", "test"], { after: ["first-screen"], if: ["idea:accounts-mentioned", "repo:no-signin"], have: "Sign-in" }),
    t("payments", "integrations", 2, "small", "Take the first payment", "a test against a stub of the payment service proves a paid and a failed payment are both handled.", ["routes", "source", "test"], { after: ["first-screen"], if: ["idea:payments", "repo:no-payments"], have: "Payments" }),
    t("ai-call", "integrations", 2, "small", "Add the AI call with a plain message for when it is down", "a test with a stub model proves an answer is shown, and an outage shows a plain message instead of a crash.", ["source", "test"], { after: ["first-screen"], if: ["idea:ai", "repo:no-ai"], have: "An AI call" }),
    t("offline", "integrations", 2, "small", "Keep working when the connection drops", "a test cuts the connection and proves the screen still opens and edits are kept until it returns.", ["source", "test"], { after: ["first-screen"], if: ["idea:offline"] }),
    t("error-states", "hardening", 3, "small", "Show a plain message when loading or saving fails", "a test makes the data call fail and proves the screen says what went wrong and how to retry.", ["ui", "source", "test"], { after: ["first-screen"] }),
    t("ci", "release", 2, "tiny", "Run the tests on every push", "a push to a branch runs {test} and shows a result.", ["ci", "manifest"], { after: ["first-test"], if: ["repo:no-ci"], have: "Tests on every push" }),
    t("publish", "release", 2, "small", "Publish a preview and open it", "the preview address opens the first screen and a smoke test requests it.", ["env", "ci", "docs"], { after: ["first-screen"] }),
    t("readme", "release", 3, "tiny", "Write how to run, test and publish it", "a new person follows the README from a clean checkout to a running app.", ["docs"], { if: ["repo:no-readme"], have: "A README" }),
  ],
};

const CLI_TOOL: PlanTemplate = {
  id: "cli-tool",
  title: "New command-line tool",
  description: "A program you run in the terminal: one command that does one job, with clear errors.",
  askFirst: ["stack", "testing"],
  usuallySkip: ["auth", "money", "ai", "offline", "scale", "platforms"],
  depth: "quick",
  skipFor: "a command-line tool",
  suggestions: [
    s("stack.language", { option: "python" }, "Your repo is Python.", { lang: "python" }),
    s("stack.language", { option: "go" }, "Your repo is Go, which builds to one small program.", { lang: "go" }),
    s("stack.language", { option: "typescript" }, "Installs and runs with one command, and shares a language with most tools."),
    s("stack.framework", { text: "No UI framework: it is a command-line tool" }, "A terminal program has no screens."),
    s("stack.hosting", { option: "no-server" }, "It runs on the person's own computer."),
    s("data.store", { option: "none" }, "A command-line tool should keep no data of its own."),
    s("security.personal-data", { option: "store-none" }, "Keep nothing about people."),
    s("testing.strategy", { option: "unit-integration" }, "Run the command on sample input in a test, on every push."),
    s("testing.deploy", { option: "github-releases" }, "Tag a version, build it in CI and publish the download."),
    s("testing.rollback", { option: "redeploy-previous" }, "People can go back to the earlier release they had."),
  ],
  skeleton: [
    t("scaffold", "foundation", 1, "small", "Set up the project and a command that runs", "running the command with --help prints its usage and exits cleanly.", ["manifest", "entry", "env"], { if: ["repo:no-manifest"], have: "A project with a command" }),
    t("first-test", "foundation", 1, "tiny", "Add the test command and one passing test", "{test} passes with one test that runs the command with --help.", ["test", "manifest"], { after: ["scaffold"], if: ["repo:no-tests"], have: "A test setup" }),
    t("first-command", "core", 1, "small", "Build the first command{subject}", "a test runs the command on a sample input and checks its output and exit code.", ["source", "entry", "test"], { after: ["first-test"] }),
    t("bad-input", "core", 1, "small", "Handle wrong or missing input with a plain message", "a test gives the command bad input and proves it prints a clear message and exits with an error code, without a stack trace.", ["source", "test"], { after: ["first-command"] }),
    t("help-version", "core", 2, "small", "Add --help and --version", "tests prove --help lists every option and --version prints the version.", ["entry", "source", "test"], { after: ["first-command"] }),
    t("files-safe", "hardening", 2, "small", "Never overwrite or delete a file without being told to", "a test proves an existing file is left alone unless the person passes the option that allows it.", ["source", "test"], { after: ["first-command"], if: ["idea:files"] }),
    t("ci", "release", 2, "tiny", "Run the tests on every push", "a push to a branch runs {test} and shows a result.", ["ci", "manifest"], { after: ["first-test"], if: ["repo:no-ci"], have: "Tests on every push" }),
    t("readme", "release", 2, "tiny", "Write the install steps and two usage examples", "the README examples run as written and print the output shown.", ["docs"], { if: ["repo:no-readme"], have: "A README" }),
    t("install-check", "release", 3, "small", "Install it on a clean machine with one command", "a clean machine installs it with one command and --version prints the version.", ["manifest", "ci", "docs"], { after: ["help-version"] }),
  ],
};

const BACKEND_API: PlanTemplate = {
  id: "backend-api",
  title: "Backend service / API",
  description: "A server other programs talk to: a few endpoints, a data store, and a check on who is calling.",
  askFirst: ["stack", "data", "auth", "security"],
  usuallySkip: ["platforms", "offline", "ai", "money"],
  depth: "standard",
  skipFor: "a backend service",
  suggestions: [
    s("stack.language", { option: "python" }, "Your repo is Python.", { lang: "python" }),
    s("stack.language", { option: "go" }, "Your repo is Go: small, fast servers with few moving parts.", { lang: "go" }),
    s("stack.language", { option: "typescript" }, "One language for the service and any tools around it."),
    s("stack.framework", { text: "No UI framework: it is an API" }, "A service has no screens."),
    s("stack.hosting", { option: "fly-io" }, "Long-running servers without cold starts."),
    s("data.store", { option: "postgres" }, "One shared source of truth on a server."),
    s("data.schema", { option: "raw-sql" }, "Plain SQL migrations work in any language.", { lang: "python" }),
    s("data.schema", { option: "drizzle" }, "One typed schema and plain SQL migrations."),
    s("data.migrations", { option: "forward-only" }, "Ordered migrations that run on deploy."),
    s("data.backups", { option: "managed-daily" }, "A managed database restores to a point in time."),
    s("auth.signin", { text: "Callers send a token and the service checks it on every request" }, "An API is called by programs more than by people."),
    s("auth.roles", { option: "single-role" }, "Start with one kind of caller."),
    s("security.personal-data", { option: "store-minimum" }, "Keep only what each endpoint needs."),
    s("security.encryption", { option: "provider-default" }, "Disk encryption from the host covers ordinary data."),
    s("security.access", { option: "owner-only" }, "Each caller sees only their own records."),
    s("security.secrets", { option: "secret-manager" }, "Server keys belong in the host's secret store."),
    s("scale.users", { option: "under-10k" }, "Plan for thousands of callers, not millions."),
    s("scale.budget", { option: "under-50" }, "A small host and a database fit under $50."),
    s("scale.cost-watch", { option: "billing-alerts" }, "A spend alert on each provider is enough."),
    s("testing.strategy", { option: "unit-integration" }, "Call each endpoint in a test, on every push."),
    s("testing.deploy", { option: "ci-preview-prod" }, "CI deploys a preview and then production."),
    s("testing.rollback", { option: "redeploy-previous" }, "Put the previous build back in one step."),
  ],
  skeleton: [
    t("scaffold", "foundation", 1, "small", "Set up the service so it starts and answers a health check", "starting the service and requesting its health address returns ok.", ["manifest", "entry", "routes"], { if: ["repo:no-manifest"], have: "A service that starts" }),
    t("first-test", "foundation", 1, "tiny", "Add the test command and one passing test", "{test} passes with one test that calls the health address.", ["test", "manifest"], { after: ["scaffold"], if: ["repo:no-tests"], have: "A test setup" }),
    t("first-endpoint", "core", 1, "small", "Build the first endpoint{subject}", "a test calls the endpoint with good input and gets the expected answer and status.", ["routes", "source", "test"], { after: ["first-test"] }),
    t("bad-input", "core", 1, "small", "Refuse bad input with a clear error", "a test sends bad input and gets a client error with a plain message, never a crash.", ["routes", "source", "test"], { after: ["first-endpoint"] }),
    t("data-store", "core", 2, "small", "Store the first record", "a test writes a record through the service and reads it back unchanged.", ["schema", "source", "test"], { after: ["first-test"], if: ["repo:no-store"], have: "A place to store data" }),
    t("auth", "core", 2, "medium", "Check who is calling", "a test proves a call without a valid token is refused and a call with one is allowed.", ["routes", "source", "test", "env"], { after: ["first-endpoint"], if: ["idea:accounts-allowed", "repo:no-signin"], have: "A check on who is calling" }),
    t("payments", "integrations", 2, "small", "Take the first payment", "a test against a stub of the payment service proves a paid and a failed payment are both handled.", ["routes", "source", "test"], { after: ["first-endpoint"], if: ["idea:payments", "repo:no-payments"], have: "Payments" }),
    t("ai-call", "integrations", 2, "small", "Add the AI call with a plain error for when it is down", "a test with a stub model proves an answer is returned, and an outage returns a plain error.", ["source", "test"], { after: ["first-endpoint"], if: ["idea:ai", "repo:no-ai"], have: "An AI call" }),
    t("logging", "hardening", 2, "small", "Log each request without logging secrets", "a test proves a request is logged with its status, and a secret sent in the request is not.", ["source", "test"], { after: ["first-endpoint"] }),
    t("limits", "hardening", 3, "small", "Limit how fast one caller can call", "a test sends calls past the limit and proves the extra ones are refused with a plain message.", ["routes", "source", "test"], { after: ["bad-input"] }),
    t("ci", "release", 2, "tiny", "Run the tests on every push", "a push to a branch runs {test} and shows a result.", ["ci", "manifest"], { after: ["first-test"], if: ["repo:no-ci"], have: "Tests on every push" }),
    t("deploy", "release", 2, "small", "Deploy it and check it answers", "the deployed address answers the health check.", ["env", "ci", "docs"], { after: ["first-endpoint"] }),
    t("endpoint-docs", "release", 3, "tiny", "Document each endpoint with an example call", "every endpoint in the README has an example call that works as written.", ["docs"], { after: ["first-endpoint"] }),
  ],
};

const LIBRARY: PlanTemplate = {
  id: "library",
  title: "Library or package",
  description: "Code other projects install and use: a small public surface, tested on unusual input.",
  askFirst: ["stack", "testing"],
  usuallySkip: ["data", "auth", "money", "ai", "offline", "security", "scale", "platforms"],
  depth: "quick",
  skipFor: "a library",
  suggestions: [
    s("stack.language", { option: "python" }, "Your repo is Python.", { lang: "python" }),
    s("stack.language", { option: "go" }, "Your repo is Go.", { lang: "go" }),
    s("stack.language", { option: "typescript" }, "Types ship with the package, which helps everyone who uses it."),
    s("stack.framework", { text: "No UI framework: it is a library" }, "A library has no screens."),
    s("stack.hosting", { option: "no-server" }, "A library runs inside other people's programs."),
    s("data.store", { option: "none" }, "A library keeps no data of its own."),
    s("testing.strategy", { option: "unit-integration" }, "Fast tests on every push are a library's whole safety net."),
    s("testing.deploy", { option: "github-releases" }, "Tag a version, build it in CI and publish it."),
    s("testing.rollback", { option: "forward-fix" }, "Publish a patch version; a published version is never rewritten."),
  ],
  skeleton: [
    t("scaffold", "foundation", 1, "small", "Set up the package so it builds and can be imported", "a test imports the package and calls its public entry.", ["manifest", "entry", "source"], { if: ["repo:no-manifest"], have: "A package that builds" }),
    t("first-test", "foundation", 1, "tiny", "Add the test command and one passing test", "{test} passes with one test that imports the package.", ["test", "manifest"], { after: ["scaffold"], if: ["repo:no-tests"], have: "A test setup" }),
    t("main-function", "core", 1, "small", "Build the main function{subject}", "a test calls the main function with a normal input and checks the result.", ["source", "entry", "test"], { after: ["first-test"] }),
    t("edge-cases", "core", 1, "small", "Handle empty and unusual input", "tests prove empty, very large and wrongly typed input each give a clear result or error, never a crash.", ["source", "test"], { after: ["main-function"] }),
    t("public-api", "core", 2, "tiny", "Export only what people should use", "a test imports the package and finds exactly the documented names and nothing else.", ["entry", "docs"], { after: ["main-function"] }),
    t("example", "core", 2, "tiny", "Add a runnable example to the README", "the README example runs as written and prints the output shown.", ["docs", "test"], { after: ["main-function"] }),
    t("ci", "release", 2, "tiny", "Run the tests on every push", "a push to a branch runs {test} and shows a result.", ["ci", "manifest"], { after: ["first-test"], if: ["repo:no-ci"], have: "Tests on every push" }),
    t("package-check", "release", 2, "small", "Check what the published package contains", "a dry-run publish lists only the files meant to ship.", ["manifest", "docs", "ci"], { after: ["public-api"] }),
    t("changelog", "release", 3, "tiny", "Start a changelog", "the changelog has an entry for the first version and the README links to it.", ["changelog", "docs"]),
    t("license", "release", 3, "tiny", "Add a licence file", "the licence file is in the repo and the manifest names the same licence.", ["license", "manifest"]),
  ],
};

const ADD_FEATURE: PlanTemplate = {
  id: "add-feature",
  title: "Add a feature to an existing app",
  description: "One new feature in an app that already works: pin today's behaviour, then add the feature on top.",
  askFirst: ["data", "auth", "testing"],
  usuallySkip: ["stack", "platforms", "scale", "money", "ai", "offline"],
  depth: "standard",
  skipFor: "adding a feature to an app that already exists",
  suggestions: [
    s("auth.signin", { text: "Keep the app's current sign-in" }, "A new feature should not change who can sign in."),
    s("auth.roles", { text: "Use the app's current roles" }, "A new feature should follow the roles the app already has."),
    s("data.migrations", { option: "forward-only" }, "Any data change ships as an ordered migration."),
    s("security.personal-data", { option: "store-minimum" }, "Store only what the new feature needs."),
    s("testing.strategy", { option: "unit-integration" }, "Pin today's behaviour first, then test the new feature."),
    s("testing.rollback", { option: "feature-flags" }, "Switch the feature off without a new build if it misbehaves."),
  ],
  skeleton: [
    t("pin", "foundation", 1, "tiny", "Pin how the area works today with a test", "a test passes on today's code and describes how the area the feature touches behaves now.", ["test"]),
    t("feature-test", "foundation", 1, "tiny", "Write the test for the new feature", "a test that describes the new behaviour fails on today's code for the right reason.", ["test"], { after: ["pin"] }),
    t("build-feature", "core", 1, "small", "Build the feature{subject}", "the new feature test passes and the pinned test still passes.", ["source", "ui", "test"], { after: ["feature-test"] }),
    t("data-change", "core", 2, "small", "Change the stored data for it, with a migration", "a test migrates sample data forward and the old records still read back unchanged.", ["schema", "source", "test"], { after: ["feature-test"], if: ["repo:has-store"] }),
    t("access", "hardening", 2, "small", "Check who may use the feature", "a test proves a signed-out person and a person without access are refused.", ["routes", "source", "test"], { after: ["build-feature"], if: ["repo:has-signin"] }),
    t("edge-cases", "hardening", 2, "small", "Cover the empty, error and slow cases", "tests cover no data, a failed call and a slow call, and each shows a clear message.", ["ui", "source", "test"], { after: ["build-feature"] }),
    t("docs", "release", 2, "tiny", "Update the docs and the changelog", "the README and the changelog describe the feature and match how it behaves.", ["docs", "changelog"], { after: ["build-feature"] }),
    t("switch", "hardening", 3, "small", "Put the feature behind a switch you can turn off", "a test proves the feature is off by default and the app behaves as before while it is off.", ["env", "source", "test"], { after: ["build-feature"] }),
  ],
  finish: { title: "Ship the feature", doneWhen: "{test} passes on a clean checkout, the pinned test still passes, and the feature test is part of the normal test run." },
};

const FIX_BUG: PlanTemplate = {
  id: "fix-bug",
  title: "Fix a bug",
  description: "Find and fix one bug: reproduce it in a test first, then change as little as possible.",
  askFirst: ["testing"],
  usuallySkip: ["stack", "data", "auth", "money", "ai", "offline", "security", "scale", "platforms"],
  depth: "quick",
  skipFor: "fixing a bug",
  suggestions: [
    s("testing.strategy", { option: "unit-integration" }, "Reproduce the bug in a test first, so it cannot come back unnoticed."),
    s("testing.rollback", { option: "forward-fix" }, "A small fix ships as a patch; no rollback plan needed beyond the last release."),
  ],
  skeleton: [
    t("reproduce", "foundation", 1, "tiny", "Write a test that reproduces the bug{subject}", "the test fails on today's code with the same wrong result the bug shows.", ["test"], { change: "fix" }),
    t("narrow", "foundation", 1, "small", "Narrow the failure to one function", "a smaller test fails for the same reason and names the one function that is at fault.", ["test", "source"], { after: ["reproduce"], change: "fix" }),
    t("fix", "core", 1, "small", "Fix the cause and nothing else", "the reproducing test passes and no other test had to change.", ["source", "test"], { after: ["narrow"], change: "fix" }),
    t("neighbours", "hardening", 2, "small", "Check the cases next to it", "tests for the nearest similar inputs pass, or each one that fails is written down as its own task.", ["test"], { after: ["fix"], change: "fix" }),
    t("full-run", "release", 2, "tiny", "Run every test on a clean checkout", "{test} passes from a fresh clone with the reproducing test included.", ["test", "manifest"], { after: ["fix"], change: "fix" }),
    t("what-happened", "release", 3, "tiny", "Write down what went wrong", "the changelog says what failed, why, and which test now guards it.", ["changelog"], { after: ["fix"], change: "fix" }),
  ],
  finish: { title: "Ship the fix", doneWhen: "{test} passes on a clean checkout and the reproducing test is part of the normal test run." },
};

const CLEANUP: PlanTemplate = {
  id: "cleanup",
  title: "Clean-up / refactor",
  description: "Tidy code without changing what it does: lock in behaviour with tests, then make small safe moves.",
  askFirst: ["testing", "stack"],
  usuallySkip: ["auth", "money", "ai", "offline", "security", "scale", "platforms"],
  depth: "standard",
  skipFor: "a clean-up",
  suggestions: [
    s("testing.strategy", { option: "unit-integration" }, "Pin today's behaviour with tests before moving any code, so a clean-up cannot break it silently."),
    s("testing.rollback", { option: "redeploy-previous" }, "Each move is its own commit, so any one of them can be undone."),
  ],
  skeleton: [
    t("pin", "foundation", 1, "small", "Pin today's behaviour with tests first{subject}", "tests that cover the area pass on today's code.", ["test"]),
    t("one-move", "core", 1, "small", "Make one small move: a rename, an extraction or a deletion", "the pinned tests still pass after the move, and the move is one commit.", ["source", "test"], { after: ["pin"] }),
    t("split", "core", 2, "small", "Split the biggest file into smaller ones", "the pinned tests pass and no file in the area has more than 400 lines.", ["source", "test"], { after: ["one-move"] }),
    t("dead-code", "core", 1, "small", "Remove code nothing uses", "a search finds no caller for what was removed and {test} passes.", ["source", "test"], { after: ["pin"] }),
    t("names", "core", 2, "tiny", "Rename the unclear names", "a search for each old name finds nothing and {test} passes.", ["source", "test"], { after: ["one-move"] }),
    t("format", "hardening", 3, "tiny", "Turn on a formatter and fix what it finds", "the formatter reports no changes needed and {test} passes.", ["manifest", "env"], { after: ["names"] }),
    t("deps", "hardening", 3, "small", "Remove dependencies nothing uses", "the manifest lists no package the code never imports, and {test} passes.", ["manifest", "source", "test"], { after: ["dead-code"] }),
    t("ci", "release", 2, "tiny", "Run the tests on every push", "a push to a branch runs {test} and shows a result.", ["ci", "manifest"], { if: ["repo:no-ci"], have: "Tests on every push" }),
  ],
  finish: { title: "Merge the clean-up", doneWhen: "{test} passes on a clean checkout and the pinned tests pass unchanged, so behaviour is the same as before." },
};

const RELEASE_READY: PlanTemplate = {
  id: "release-ready",
  title: "Get an app ready to release",
  description: "Take a working app to a release: green tests, no secrets in the repo, a build that starts, and a way back.",
  askFirst: ["testing", "security", "platforms", "scale"],
  usuallySkip: ["stack", "money", "ai", "offline"],
  depth: "thorough",
  skipFor: "getting an app ready to release",
  suggestions: [
    s("platforms.first", { option: "desktop" }, "The app is a desktop app.", { when: "desktop" }),
    s("platforms.first", { option: "mobile" }, "The app is a mobile app.", { when: "mobile" }),
    s("platforms.first", { option: "web" }, "Most apps release to the web first."),
    s("security.personal-data", { option: "store-minimum" }, "Release with only the personal data each feature needs."),
    s("security.encryption", { option: "provider-default" }, "Disk encryption from the host covers ordinary data."),
    s("security.secrets", { option: "os-keychain" }, "A desktop app keeps keys in the computer's keychain.", { when: "desktop" }),
    s("security.secrets", { option: "secret-manager" }, "Server keys belong in the host's secret store."),
    s("scale.users", { option: "under-10k" }, "Plan for thousands of users, not millions."),
    s("scale.budget", { option: "under-50" }, "A small host and a database fit under $50."),
    s("scale.cost-watch", { option: "billing-alerts" }, "A spend alert on each provider is enough."),
    s("testing.strategy", { option: "unit-integration" }, "Fast tests on every push, plus one check of the main journey."),
    s("testing.deploy", { option: "github-releases" }, "Signed builds from CI.", { when: "desktop" }),
    s("testing.deploy", { option: "app-stores" }, "Mobile apps ship through the stores; plan for review time.", { when: "mobile" }),
    s("testing.deploy", { option: "ci-preview-prod" }, "Every branch gets a preview and main goes live."),
    s("testing.rollback", { option: "feature-flags" }, "An installed app cannot be pulled back quickly; flags switch features off.", { when: "desktop" }),
    s("testing.rollback", { option: "redeploy-previous" }, "Put the previous version back in one step."),
  ],
  skeleton: [
    t("green", "foundation", 1, "tiny", "Get the tests passing on a clean checkout", "{test} passes from a fresh clone.", ["test", "manifest"]),
    t("ci", "foundation", 1, "tiny", "Run the tests on every push", "a push to a branch runs {test} and shows a result.", ["ci", "manifest"], { after: ["green"], if: ["repo:no-ci"], have: "Tests on every push" }),
    t("secrets", "foundation", 1, "small", "Make sure no secret is in the repo", "a scan of the repo and its history finds no keys, and the .env files are ignored by git.", ["env", "docs", "ci"]),
    t("smoke", "core", 2, "small", "Add one check of the main journey", "a test walks the main journey from start to finish and passes.", ["test", "source"], { after: ["green"] }),
    t("errors", "hardening", 2, "small", "Show a plain message instead of a crash", "a test forces the main failures and each shows a plain message.", ["ui", "source", "test"], { after: ["smoke"] }),
    t("build", "release", 2, "small", "Build the release and start it from the build", "the built output starts on a clean machine and passes the main journey check.", ["manifest", "ci", "docs"], { after: ["smoke"] }),
    t("version", "release", 2, "tiny", "Set the version and write the release notes", "the version is set in one place and the changelog has notes for it.", ["manifest", "changelog"], { after: ["build"] }),
    t("way-back", "release", 2, "small", "Write down and try the way back to the last version", "the previous version is reinstalled by following the written steps and the main journey check passes.", ["docs", "ci"], { after: ["build"] }),
    t("readme", "release", 2, "tiny", "Write the install and first-run steps", "a new person follows the README from download to a running app.", ["docs"], { if: ["repo:no-readme"], have: "A README" }),
    t("license", "release", 3, "tiny", "Add a licence file", "the licence file is in the repo and the manifest names the same licence.", ["license", "manifest"]),
    t("watch", "hardening", 3, "small", "Make failures visible after release", "a test makes a call fail and proves the failure is recorded where the owner will see it.", ["source", "test"], { after: ["errors"] }),
    t("restore", "hardening", 3, "small", "Check the data can be restored from a backup", "a backup of sample data is restored into a clean copy and the records match.", ["schema", "docs"], { if: ["repo:has-store"] }),
  ],
  finish: { title: "Cut the release", doneWhen: "{test} passes on a clean checkout and a test proves the release entry (R-1) is in the ledger with its stamp." },
};

/** The eight templates, in the order the picker lists them. */
export const TEMPLATES: readonly PlanTemplate[] = [WEB_APP, CLI_TOOL, BACKEND_API, LIBRARY, ADD_FEATURE, FIX_BUG, CLEANUP, RELEASE_READY];

const BY_ID: ReadonlyMap<string, PlanTemplate> = new Map(TEMPLATES.map((x) => [x.id, x]));

/** True only for the eight ids above (not "__proto__", not "constructor", not a look-alike). */
export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === "string" && BY_ID.has(value);
}

export function isTemplateDepth(value: unknown): value is TemplateDepth {
  return typeof value === "string" && (TEMPLATE_DEPTHS as readonly string[]).includes(value);
}

export function templateById(id: unknown): PlanTemplate | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

/** How many skeleton tasks a depth includes, before the repo and idea trim any. */
export function taskCount(template: PlanTemplate, depth: TemplateDepth = template.depth): number {
  return template.skeleton.filter((task) => task.tier <= DEPTH_TIER[depth]).length;
}

/** What the picker shows. The same for every project and every repo. */
export function templateCards(): TemplateCard[] {
  return TEMPLATES.map((x) => ({
    id: x.id,
    title: x.title,
    description: x.description,
    askFirst: x.askFirst.map((area) => ({ area, title: AREA_TITLES[area] })),
    usuallySkip: x.usuallySkip.map((area) => ({ area, title: AREA_TITLES[area] })),
    depth: x.depth,
    tasks: taskCount(x),
  }));
}

/** The areas the template usually skips, minus any the idea or repo raises a signal for ("pay" keeps Money). */
export function effectiveSkip(template: PlanTemplate, signals: readonly string[]): Area[] {
  return template.usuallySkip.filter((area) => !(AREA_SIGNALS[area] ?? []).some((signal) => signals.includes(signal)));
}

/** Areas in the order to show them: ask-first areas, then the rest in the usual order, then the usually skipped ones. */
export function areaOrder(template: PlanTemplate, signals: readonly string[], all: readonly Area[]): Area[] {
  const skip = effectiveSkip(template, signals);
  const first = template.askFirst.filter((a) => all.includes(a) && !skip.includes(a));
  const last = all.filter((a) => skip.includes(a) && !first.includes(a));
  const middle = all.filter((a) => !first.includes(a) && !last.includes(a));
  return [...first, ...middle, ...last];
}

export type AreaHint = "ask-first" | "usually-skip";

export function areaHint(template: PlanTemplate, signals: readonly string[], area: Area): AreaHint | undefined {
  if (effectiveSkip(template, signals).includes(area)) return "usually-skip";
  return template.askFirst.includes(area) ? "ask-first" : undefined;
}

export interface Suggestion {
  option?: string;
  text?: string;
  why: string;
}

/**
 * The template's suggestion for one question, or undefined. A question in a usually
 * skipped area is suggested "Not needed for <what>" unless the template says otherwise.
 * The first matching entry wins, so more specific entries are listed first.
 */
export function suggestionFor(template: PlanTemplate, questionId: string, area: Area, signals: readonly string[], lang?: Lang): Suggestion | undefined {
  const hit = template.suggestions.find(
    (x) => x.q === questionId && (!x.lang || x.lang === lang) && (!x.when || signals.includes(x.when)) && (!x.unless || !signals.includes(x.unless)),
  );
  if (hit) return { ...(hit.option ? { option: hit.option } : {}), ...(hit.text ? { text: hit.text } : {}), why: hit.why };
  if (effectiveSkip(template, signals).includes(area)) return { text: skipText(template), why: `Usually skipped for ${template.skipFor}.` };
  return undefined;
}

/** What a skip records as the person's answer. */
export function skipText(template: PlanTemplate): string {
  return `Not needed for ${template.skipFor}.`;
}
