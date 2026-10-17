import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore, type Actor } from "../ledger/index";
import { installNumberingRules } from "../numbering/index";
import { installPlanningRules } from "./rules";
import { PlanningSession } from "./session";
import { profileRepo, readRepoStack } from "./repo";
import { planningAnswers } from "./state";

const agent: Actor = { kind: "agent", id: "claude-code", model: "test-model" };
// Only a person answers planning questions: the person confirms what the repo shows.
const owner: Actor = { kind: "person", id: "looplet-spare" };

function tmp(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-repo-"));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

// Shaped like Looplet, where planning recommended Tauri, Expo and SQLite for an
// Electron, Capacitor and Supabase app.
const looplet = () =>
  tmp({
    "package.json": JSON.stringify({
      dependencies: { react: "18", "@supabase/supabase-js": "2", "@stripe/stripe-js": "4", "@capacitor/core": "6", "better-sqlite3": "11", "@electric-sql/pglite": "0.3" },
      devDependencies: { vite: "5", typescript: "5", electron: "31" },
    }),
    "tsconfig.json": "{}",
    "vercel.json": "{}",
    "wrangler.production.jsonc": "{}",
    "supabase/migrations/0001_init.sql": "create table x (id int);",
    "android/build.gradle": "",
    "ios/App/Podfile": "",
  });

describe("readRepoStack", () => {
  it("reads the stack an existing repo already chose, with the files that show it", () => {
    const stack = readRepoStack(looplet());
    const by = Object.fromEntries(stack.facts.map((f) => [f.id, f]));
    expect(by["stack.language"]).toMatchObject({ choice: "typescript", evidence: ["tsconfig.json"] });
    expect(by["stack.framework"]).toMatchObject({ choice: "vite-react" });
    expect(by["stack.hosting"]).toMatchObject({ text: "Vercel and Cloudflare Workers", evidence: ["vercel.json", "wrangler.production.jsonc"] });
    expect(by["stack.hosting"].choice).toBeUndefined();
    // Supabase wins over a stray SQLite dependency.
    expect(by["data.store"]).toMatchObject({ choice: "postgres", text: "Supabase (Postgres)", evidence: ["package.json", "supabase"] });
    expect(by["data.schema"]).toMatchObject({ choice: "raw-sql" });
    expect(by["auth.provider"]).toMatchObject({ choice: "supabase-auth" });
    expect(by["money.payments"]).toMatchObject({ text: "Stripe" });
    expect(by["platforms.desktop-shell"]).toMatchObject({ choice: "electron" });
    expect(by["platforms.mobile-stack"]).toMatchObject({ text: "Capacitor (android, ios)", evidence: ["package.json", "android", "ios"] });
    expect(by["ai.model"]).toBeUndefined();
    // An embedded test database is not a sync engine.
    expect(by["offline.sync-engine"]).toBeUndefined();
    expect(stack.signals.sort()).toEqual(["desktop", "mobile", "payments", "web"]);
  });

  it("finds nothing in an empty folder and never throws on a broken package.json", () => {
    expect(readRepoStack(tmp({ "README.md": "x" }))).toEqual({ facts: [], signals: [] });
    expect(readRepoStack(tmp({ "package.json": "{ not json" }))).toEqual({ facts: [], signals: [] });
  });

  it("ignores a package.json symlinked from outside the repo", () => {
    const outside = tmp({ "package.json": JSON.stringify({ dependencies: { electron: "1" } }) });
    const root = tmp({ "README.md": "x" });
    try {
      fs.symlinkSync(path.join(outside, "package.json"), path.join(root, "package.json"));
    } catch {
      return; // symlinks need extra rights on some Windows runners
    }
    expect(readRepoStack(root)).toEqual({ facts: [], signals: [] });
  });
});

describe("planning an existing repo", () => {
  it("records the repo's stack as decisions and only asks what the repo leaves open", async () => {
    const root = looplet();
    const ledger = await Ledger.open(new MemoryStore());
    installNumberingRules(ledger);
    installPlanningRules(ledger);
    const session = new PlanningSession(ledger, { person: "looplet-spare" });
    const stack = readRepoStack(root);
    const profile = profileRepo("A fencing contractor app for quotes and invoices", stack);
    expect(profile.signals).toEqual(expect.arrayContaining(["desktop", "mobile", "payments", "web"]));

    const decided = session.recordRepoFacts(owner, profile, stack.facts);
    expect(decided).toHaveLength(stack.facts.length);
    session.start(agent, profile);

    const asked = session.questions().map((q) => q.id);
    // Each repo fact is asked once (and already answered), never asked again by start().
    for (const fact of stack.facts) expect(asked.filter((id) => id === fact.id)).toHaveLength(1);
    const open = session.open().map((q) => q.id);
    expect(open).not.toContain("platforms.desktop-shell");
    expect(open).not.toContain("data.store");

    const answers = Object.fromEntries(planningAnswers(ledger.entries()).map((a) => [a.questionId, a]));
    expect(answers["platforms.desktop-shell"]).toMatchObject({ choice: "electron", text: "Electron" });
    expect(answers["stack.language"]).toMatchObject({ choice: "typescript", text: "TypeScript everywhere" });
    expect(answers["data.store"]).toMatchObject({ choice: "postgres", text: "Hosted Postgres: Supabase (Postgres)" });
    expect(answers["platforms.mobile-stack"]).toMatchObject({ choice: "custom", text: "Capacitor (android, ios)" });

    const shell = ledger.entries().find((e) => e.type === "decision.made" && (e.data?.planning as { id?: string } | undefined)?.id === "platforms.desktop-shell")!;
    expect(shell.reason).toBe("Found in the repo: package.json");
    expect(shell.evidence).toEqual(["package.json"]);
    // The mind map builds on Electron, not a recommended Tauri.
    const labels = Object.values(session.mindMap("x").nodes).map((n) => n.label).join("\n");
    expect(labels).not.toMatch(/Tauri|Expo/);
  });

  it("leaves an already answered question alone", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    installNumberingRules(ledger);
    installPlanningRules(ledger);
    const session = new PlanningSession(ledger, { person: "looplet-spare" });
    const stack = readRepoStack(looplet());
    const profile = profileRepo("x", stack);
    session.recordRepoFacts(owner, profile, stack.facts);
    expect(session.recordRepoFacts(owner, profile, stack.facts)).toEqual([]);
  });

  it("an agent cannot settle the repo's stack on the person's behalf", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    installNumberingRules(ledger);
    installPlanningRules(ledger);
    const session = new PlanningSession(ledger, { person: "looplet-spare" });
    const stack = readRepoStack(looplet());
    expect(() => session.recordRepoFacts(agent, profileRepo("x", stack), stack.facts)).toThrow(/person/);
  });
});

describe("roadmap for an existing repo", () => {
  async function planned() {
    const ledger = await Ledger.open(new MemoryStore());
    installNumberingRules(ledger);
    installPlanningRules(ledger);
    const session = new PlanningSession(ledger, { person: "looplet-spare" });
    const stack = readRepoStack(looplet());
    const profile = profileRepo("A fencing contractor app for quotes and invoices, offline on site", stack);
    session.recordRepoFacts(owner, profile, stack.facts);
    session.start(agent, profile);
    return { session, ledger };
  }

  it("lists no build task for a part the repo already has, and names those parts instead", async () => {
    const { session } = await planned();
    // A person decides something the code cannot show; that part is still planned.
    const offline = session.open().find((q) => q.id === "offline.required")!;
    session.answer({ kind: "person", id: "looplet-spare" }, offline.q, { choice: "full-offline" });
    const roadmap = session.roadmap("x", "looplet-spare");
    const titles = roadmap.phases.flatMap((p) => p.tasks.map((t) => t.title));
    expect(titles).toContain("Build Sync engine");
    for (const built of ["Set up Data store", "Build App shell", "Integrate Payments", "Build Mobile screens", "Build Sign-in"]) {
      expect(titles).not.toContain(built);
    }
    expect(titles.some((t) => t.startsWith("Integrate Framework"))).toBe(false);
    expect(roadmap.existing?.map((e) => e.label)).toEqual(expect.arrayContaining(["Data store", "App shell", "Payments", "Mobile screens", "Sign-in"]));
    // Every dependency still points at a task that is in the roadmap.
    const keys = new Set(roadmap.phases.flatMap((p) => p.tasks.map((t) => t.key)));
    for (const task of roadmap.phases.flatMap((p) => p.tasks)) for (const d of task.dependsOn) expect(keys.has(d)).toBe(true);
  });

  it("keeps what the code cannot show open for a person to answer", async () => {
    const { session } = await planned();
    const open = session.open().map((q) => q.id);
    expect(open).toEqual(expect.arrayContaining(["money.pricing", "offline.required", "auth.signin"]));
    expect(session.blockers().length).toBeGreaterThan(0);
    // Nothing is written as a plan while those blockers are open.
    expect(() => session.writeRoadmap({ kind: "person", id: "looplet-spare" }, session.roadmap("x"))).toThrow(/blocking questions/);
  });

  it("reads a package with a bin, or a plain library, as not an app; an app or a server is not", () => {
    const ids = (pkg: object) => readRepoStack(tmp({ "package.json": JSON.stringify(pkg) })).facts.map((f) => f.id);
    expect(ids({ bin: { t: "cli.js" } })).toEqual(expect.arrayContaining(["data.store", "stack.hosting", "auth.signin", "offline.sync-engine"]));
    expect(ids({ main: "index.js" })).toContain("data.store");
    expect(ids({ name: "no entry point" })).not.toContain("data.store");
    expect(ids({ main: "server.js", dependencies: { express: "4" } })).not.toContain("data.store");
    expect(ids({ main: "index.js", dependencies: { react: "18" } })).not.toContain("data.store");
    expect(ids({ main: "db.js", dependencies: { pg: "8" } }).filter((i) => i === "data.store")).toHaveLength(1);
    const fact = readRepoStack(tmp({ "package.json": JSON.stringify({ bin: "cli.js" }) })).facts.find((f) => f.id === "data.store")!;
    expect(fact).toMatchObject({ choice: "none", evidence: ["package.json"] });
  });
});
