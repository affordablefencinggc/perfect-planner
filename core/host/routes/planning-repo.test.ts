import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostCall, startTestHost } from "../testing";

// "I uploaded a repo, so why does Deep planning show a blank idea screen?" Planning reads the project's
// folder (or the folder the person points it at) before any idea is typed, and says what it found.
const stops: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-plan-repo-"));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const APP = {
  "package.json": JSON.stringify({ name: "needle", scripts: { test: "vitest run" }, dependencies: { react: "18", "@supabase/supabase-js": "2" }, devDependencies: { vite: "5", typescript: "5", vitest: "1" } }),
  "src/main.tsx": "export {};\n",
  "src/reports.ts": "export {};\n",
  "src/reports.test.ts": "export {};\n",
};

async function open(projectRoot: string) {
  const { base, stop } = await startTestHost({ projectRootOverride: projectRoot });
  stops.push(stop);
  return (method: "GET" | "POST", route: string, body?: unknown) => hostCall(base, method, `${route}?project=t`, body);
}

describe("GET /planning/repo", () => {
  it("reads a project folder that holds code and suggests adding a feature", async () => {
    const call = await open(tmp(APP));
    const res = await call("GET", "/planning/repo");
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ known: true, suggestedTemplate: "add-feature", tests: "npm test" });
    expect(res.body.result.facts.map((f: any) => f.text)).toEqual(expect.arrayContaining(["Supabase (Postgres)"]));
  });

  it("says it knows nothing for an empty folder", async () => {
    const res = await (await open(tmp({})))("GET", "/planning/repo");
    expect(res.body.result).toMatchObject({ known: false, root: null, suggestedTemplate: null });
  });
});

describe("POST /planning/repo", () => {
  it("points planning at the person's folder, and the next read finds it", async () => {
    const repo = tmp(APP);
    const call = await open(tmp({}));
    expect((await call("GET", "/planning/repo")).body.result.known).toBe(false);
    expect((await call("POST", "/planning/repo", { path: repo })).status).toBe(200);
    const after = (await call("GET", "/planning/repo")).body.result;
    expect(after).toMatchObject({ known: true, root: fs.realpathSync(repo) });
    // and the idea is profiled from that repo: Supabase is not asked about again
    await call("POST", "/planning/start", { idea: "Add CSV export to the reports page" });
    const planning = (await call("GET", "/planning")).body.result;
    expect(JSON.stringify(planning)).toContain("Supabase");
  });

  it("refuses a relative path, a missing folder, the home folder and an empty folder", async () => {
    const call = await open(tmp({}));
    expect((await call("POST", "/planning/repo", { path: "needle-main" })).status).toBe(400);
    expect((await call("POST", "/planning/repo", { path: path.join(os.tmpdir(), "does-not-exist-pp") })).status).toBe(422);
    expect((await call("POST", "/planning/repo", { path: os.homedir() })).status).toBe(422);
    expect((await call("POST", "/planning/repo", { path: tmp({}) })).status).toBe(422);
  });
});
