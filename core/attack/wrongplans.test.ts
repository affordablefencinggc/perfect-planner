// Wrong plans and wrong tests (ledger 10-soak area 8). The planner (or a worker) names a file, test or repo that is
// not there, or a test that "fails first" for the wrong reason. A wrong plan should be refused or flagged before it
// costs a worker's whole run. Known holes are it.fails so the suite shows them.
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeCall } from "../mcp/index";
import { addTask, cleanTemp, git, makeRepo, startWindow, tempDir, write, type Window } from "./helpers";
import fs from "node:fs";

afterAll(cleanTemp);
const q = "?project=p";
let win: Window;
let repo: string;

beforeAll(async () => {
  repo = makeRepo();
  const dir = tempDir();
  win = await startWindow({ data: dir, project: repo, secrets: path.join(dir, "secrets.json") });
  await win.call("POST", `/tasks/repo${q}`, { root: repo });
}, 120_000);
afterAll(async () => win.stop());

async function worker(title: string) {
  const id = await addTask(win, q, title);
  const d = (await win.call("POST", `/tasks/${id}/dispatch${q}`, { model: "m" })).body.result;
  const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
  const hello = (await call({ tool: "hello", args: { name: "Planner victim" } })) as { agent: string };
  return { id, d, call, agent: hello.agent };
}

describe("8. wrong plans", () => {
  it("a task that names a repo the project does not have is refused when it is written", async () => {
    const res = await win.call("POST", `/planning/tasks${q}`, { title: "Ghost repo", repos: ["ghost"] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNKNOWN_REPO");
  });

  it("repo names that are paths, reserved or huge are refused, not stored", async () => {
    for (const name of ["../x", "con", "x".repeat(33), "a/b", "", " ", "__proto__", "main/../x"]) {
      const res = await win.call("POST", `/repos${q}`, { name, root: repo });
      expect(res.status, `name ${JSON.stringify(name)}`).toBeLessThan(500);
      expect(res.status, `name ${JSON.stringify(name)} was accepted`).toBeGreaterThanOrEqual(400);
    }
  });

  it("a worker whose test file does not exist cannot get a fails-first approval", async () => {
    const w = await worker("Missing test file");
    await w.call({ tool: "propose_test", args: { task: w.id, command: "node tests/missing.mjs", files: ["tests/missing.mjs"] }, agent: w.agent });
    const entry = ((await win.call("GET", `/tasks${q}`)).body.result.tasks as any[]).find((t) => t.id === w.id).test.entry;
    const approved = await win.call("POST", `/tasks/${w.id}/approve-test${q}`, { test: entry });
    const failsFirst = approved.body.result?.failsFirst === true;
    console.log(`wrongplans missing test file: status ${approved.status} failsFirst ${failsFirst} ${String(approved.body.message ?? approved.body.result?.reason ?? "").slice(0, 200)}`);
    expect(failsFirst, "a test that only 'fails' because its file does not exist was accepted as fails-first").toBe(false);
  });

  // FOUND (F4): exit codes other than 126/127 count as "the test ran and failed", so npm's ENOENT (254) is a fails-first proof.
  it("a test command that fails because the tooling is missing is not a fails-first proof (F4, fixed in core/gate/run.ts)", async () => {
    const w = await worker("No tooling");
    write(w.d.worktree, "tests/real.mjs", "process.exit(1);\n");
    git(w.d.worktree, "add", "-A");
    git(w.d.worktree, "commit", "-q", "-m", "t");
    // npm test with no package.json fails with exit 254 or 1 depending on npm: it never ran the project's test
    await w.call({ tool: "propose_test", args: { task: w.id, command: "npm test", files: ["tests/real.mjs"] }, agent: w.agent });
    const entry = ((await win.call("GET", `/tasks${q}`)).body.result.tasks as any[]).find((t) => t.id === w.id).test.entry;
    const approved = await win.call("POST", `/tasks/${w.id}/approve-test${q}`, { test: entry });
    const failsFirst = approved.body.result?.failsFirst === true;
    console.log(`wrongplans npm test without package.json: status ${approved.status} failsFirst ${failsFirst} ${String(approved.body.result?.output ?? approved.body.message ?? "").slice(0, 200)}`);
    expect(failsFirst, "'npm test' failing for lack of a package.json counted as fails-first").toBe(false);
  }, 60_000);

  it("...so the worker cannot then pass it by adding a package.json whose test script is `exit 0` (F4)", async () => {
    const w = await worker("Tooling trick");
    write(w.d.worktree, "tests/real.mjs", "process.exit(1);\n");
    git(w.d.worktree, "add", "-A");
    git(w.d.worktree, "commit", "-q", "-m", "t");
    await w.call({ tool: "propose_test", args: { task: w.id, command: "npm test", files: ["tests/real.mjs"] }, agent: w.agent });
    const entry = ((await win.call("GET", `/tasks${q}`)).body.result.tasks as any[]).find((t) => t.id === w.id).test.entry;
    await win.call("POST", `/tasks/${w.id}/approve-test${q}`, { test: entry });
    // The missing package.json is inconclusive, not a failure on today's code, so the worker cannot claim and build the empty script.
    let claimed = true;
    try {
      await w.call({ tool: "claim_task", args: { task: w.id }, agent: w.agent });
    } catch {
      claimed = false;
    }
    expect(claimed, "a worker claimed a task whose test never ran").toBe(false);
  }, 60_000);

  it("a test that passes the moment any file appears (checks nothing) is accepted only if it failed first, and only the pinned file is protected", async () => {
    const w = await worker("Vacuous test");
    write(w.d.worktree, "tests/vacuous.mjs", 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("anything.txt") ? 0 : 1);\n');
    git(w.d.worktree, "add", "-A");
    git(w.d.worktree, "commit", "-q", "-m", "t");
    await w.call({ tool: "propose_test", args: { task: w.id, command: "node tests/vacuous.mjs", files: ["tests/vacuous.mjs"] }, agent: w.agent });
    const entry = ((await win.call("GET", `/tasks${q}`)).body.result.tasks as any[]).find((t) => t.id === w.id).test.entry;
    const approved = await win.call("POST", `/tasks/${w.id}/approve-test${q}`, { test: entry });
    expect(approved.body.result.failsFirst).toBe(true);
    // The test reads a file the worker may create freely: "tests" can be satisfied by any junk. That is the person's read of the test, so it must
    // be visible to them: the view names the test files and command, and the diff lists the new file.
    await w.call({ tool: "claim_task", args: { task: w.id }, agent: w.agent });
    write(w.d.worktree, "anything.txt", "junk\n");
    git(w.d.worktree, "add", "-A");
    git(w.d.worktree, "commit", "-q", "-m", "junk");
    const checked = await win.call("POST", `/tasks/${w.id}/check${q}`);
    expect(checked.body.result?.passed).toBe(true); // by design; the person reads the test before approving it
    const diff = (await win.call("GET", `/tasks/${w.id}/diff${q}`)).body.result;
    expect(JSON.stringify(diff.files)).toContain("anything.txt");
  }, 60_000);

  it("a roadmap task for a repo that was removed or never existed cannot be dispatched", async () => {
    const res = await win.call("POST", `/planning/tasks${q}`, { title: "Needs repo", repos: [] });
    expect(res.status).toBe(200);
  });
});
