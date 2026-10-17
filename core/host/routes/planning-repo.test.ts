import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostCall, startTestHost } from "../testing";

// The trial case: a small library whose idea says "no accounts, no network"
// still got App shell, Data store, Backups, Secrets store and questions about
// Next.js and Stripe, because the start route never read the repo or ruled
// anything out from the idea.
const P = "?project=plan";
const stops: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function plan(files: Record<string, unknown>, idea: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pp-plan-repo-"));
  dirs.push(repo);
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, rel), typeof body === "string" ? body : JSON.stringify(body));
  const { base, stop } = await startTestHost({ projectRootOverride: repo });
  stops.push(stop);
  const start = (await hostCall(base, "POST", `/planning/start${P}`, { idea })).body.result;
  const open = (start.overview.areas as any[]).flatMap((a) => a.questions).filter((q) => q.status === "open").map((q) => q.id as string);
  const draft = (await hostCall(base, "GET", `/planning/roadmap${P}`)).body.result;
  const titles = (draft.phases as any[]).flatMap((p) => p.tasks.map((t: any) => t.title as string));
  return { start, open, titles, draft };
}

const NOT_AN_APP = ["Web screens", "AI provider", "App shell", "Data store", "Schema", "Backups", "Secrets store", "Sign-in", "Cost at scale", "Payments", "Sync engine"];

describe("deep planning reads the repo and the idea", () => {
  it("a small library with 'no accounts, no network' asks and plans nothing an app needs", async () => {
    const { open, titles, start } = await plan({ "package.json": { name: "slugify", main: "index.js" } }, "A tiny slugify library. No accounts, no network.");
    for (const id of ["data.store", "data.schema", "data.backups", "auth.signin", "auth.roles", "stack.hosting", "stack.framework", "security.secrets", "scale.users", "money.payments", "ai.use", "platforms.first", "platforms.desktop-shell"]) {
      expect(open, id).not.toContain(id);
    }
    for (const label of NOT_AN_APP) expect(titles.join("|"), label).not.toContain(label);
    expect(titles).toContain("Cut the first release");
    expect(start.overview.description.ruledOut.map((r: any) => r.id)).toEqual(expect.arrayContaining(["accounts", "not-an-app"]));
  });

  it("a command-line tool is read from the repo even when the idea does not say so", async () => {
    const { open, titles, start } = await plan({ "package.json": { name: "tool", bin: { tool: "cli.js" } } }, "Rename photos by date");
    expect(open).not.toContain("data.store");
    expect(open).not.toContain("stack.hosting");
    expect(open).not.toContain("auth.signin");
    expect(titles.join("|")).not.toContain("Data store");
    expect(start.fromRepo.length).toBeGreaterThan(5);
  });

  it("an existing app gets no build tasks for what the repo already has, and is not asked its stack", async () => {
    const { open, draft, start } = await plan(
      { "package.json": { dependencies: { react: "18", "@supabase/supabase-js": "2" }, devDependencies: { vite: "5", typescript: "5" } }, "tsconfig.json": "{}" },
      "A habit tracker with sign-in",
    );
    expect(open).not.toContain("stack.framework");
    expect(open).not.toContain("data.store");
    expect(open).not.toContain("auth.provider");
    expect(start.fromRepo.length).toBeGreaterThan(2);
    expect((draft.existing ?? []).length + draft.phases.flatMap((p: any) => p.tasks).filter((t: any) => /App shell/.test(t.title)).length).toBeGreaterThan(0);
    expect(draft.phases.flatMap((p: any) => p.tasks.map((t: any) => t.title))).not.toContain("Build App shell");
  });

  it("the idea beats the repo: a library repo whose idea names Postgres still asks nothing about the store", async () => {
    const { open, start } = await plan({ "package.json": { name: "x", main: "i.js" } }, "A library that wraps Postgres access");
    expect(open).not.toContain("data.store");
    const store = (start.overview.areas as any[]).flatMap((a) => a.questions).find((q) => q.id === "data.store");
    expect(store.choice).toBe("postgres");
  });

  it("an idea that names an app is not turned into a library by a library-shaped package or word", async () => {
    for (const idea of ["A photo library app where families share albums and sign in", "A library management system for schools with student accounts"]) {
      const { open, start } = await plan({ "package.json": { name: "x", main: "index.js" } }, idea);
      expect(open, idea).toContain("data.store");
      expect(open, idea).toContain("stack.framework");
      expect(start.overview.description.ruledOut.map((r: any) => r.id), idea).not.toContain("not-an-app");
    }
  });
});
