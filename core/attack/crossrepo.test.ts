// Cross-repo merge failure (ledger 10-soak area 6): a task split over two repos is merged together. When the second
// repo refuses after the first merged, the first stays merged, the answer says which, the second can still be fixed and
// merged alone, and pressing the group again does not merge anything twice.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildCheckApprove, cleanTemp, dispatchAndApproveTest, git, makeRepo, startWindow, tempDir, write, type Window } from "./helpers";

afterAll(cleanTemp);
const q = "?project=p";

async function setup() {
  const a = makeRepo();
  const b = makeRepo({ "README.md": "# B\n", ".gitignore": ".perfect-planner/\n" });
  const dir = tempDir();
  const win = await startWindow({ data: dir, project: a, secrets: path.join(dir, "secrets.json") });
  const chosen = await win.call("POST", `/tasks/repo${q}`, { root: a });
  expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
  const added = await win.call("POST", `/repos${q}`, { name: "b", root: b });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const made = await win.call("POST", `/planning/tasks${q}`, { title: "Shared change", repos: ["main", "b"] });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const [ta, tb] = made.body.result.tasks as string[];
  const wa = await dispatchAndApproveTest(win, q, ta!);
  const wb = await dispatchAndApproveTest(win, q, tb!);
  const ca = await buildCheckApprove(win, q, wa);
  const cb = await buildCheckApprove(win, q, wb);
  const view = (await win.call("GET", `/tasks${q}`)).body.result.tasks as any[];
  const group = view.find((t) => t.id === ta).group as string;
  return { win, a, b, ta: ta!, tb: tb!, ca, cb, group, wb };
}

describe("a group of two repos, the second refuses", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    if (s) await s.win.stop();
    s = await setup();
  }, 120_000);
  afterAll(async () => s?.win.stop());

  it("B's main gets a conflicting file after approval: A stays merged, answer names B, B merges alone once the conflict is gone", async () => {
    write(s.b, "src/save.js", "export const save = 'someone else wrote this first';\n");
    git(s.b, "add", "-A");
    git(s.b, "commit", "-q", "-m", "conflicting change on main");
    const res = await s.win.call("POST", `/tasks/groups/${s.group}/merge${q}`, { commits: { [s.ta]: s.ca, [s.tb]: s.cb } });
    // Either everything is refused up front (nothing merged) or A merged and the answer says so. Never a crash, never a silent half.
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    const aOnMain = git(s.a, "ls-tree", "-r", "--name-only", "main").includes("src/save.js");
    console.log(`crossrepo conflict: status ${res.status} ${res.body.code}; A merged ${aOnMain}; ${String(res.body.message).slice(0, 400)}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GROUP_PARTLY_MERGED");
    expect(aOnMain).toBe(true);
    expect(String(res.body.message), "partial merge not explained").toContain(s.ta);
    expect(git(s.b, "show", "main:src/save.js"), "B's main was changed by a refused merge").toContain("someone else");
    expect(git(s.b, "status", "--porcelain"), "B's main checkout left dirty by the refused merge").toBe("");
    // second press: A is not merged twice, B is refused again the same way
    const again = await s.win.call("POST", `/tasks/groups/${s.group}/merge${q}`, { commits: { [s.ta]: s.ca, [s.tb]: s.cb } });
    expect(again.status).toBeLessThan(500);
    expect(git(s.a, "log", "--merges", "--format=%H", "main").split("\n").filter(Boolean).length, "A merged more than once").toBeLessThanOrEqual(1);
    // the person removes the conflicting commit; B merges alone
    git(s.b, "reset", "-q", "--hard", "HEAD~1");
    const merged = await s.win.call("POST", `/tasks/${s.tb}/merge${q}`, { commit: s.cb });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(git(s.b, "ls-tree", "-r", "--name-only", "main")).toContain("src/save.js");
  }, 120_000);

  it("B's folder is deleted after approval: A's part either merges and says so, or nothing merges; no 500", async () => {
    fs.rmSync(s.b, { recursive: true, force: true });
    const res = await s.win.call("POST", `/tasks/groups/${s.group}/merge${q}`, { commits: { [s.ta]: s.ca, [s.tb]: s.cb } });
    console.log(`crossrepo deleted: status ${res.status} ${res.body.code}; ${String(res.body.message).slice(0, 300)}`);
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(200);
    // the other repo's tasks and the app keep working
    const view = await s.win.call("GET", `/tasks${q}`);
    expect(view.status).toBe(200);
    const tb = (view.body.result.tasks as any[]).find((t) => t.id === s.tb);
    expect(JSON.stringify(tb)).toMatch(/missing|no longer|repo/i);
  }, 120_000);

  it("the person removes B between approval and merge: refused while B has a worktree", async () => {
    const res = await s.win.call("POST", `/repos/remove${q}`, { name: "b" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REPO_BUSY");
  }, 120_000);

  it("a wrong commit for one part refuses the whole group before anything merges", async () => {
    const res = await s.win.call("POST", `/tasks/groups/${s.group}/merge${q}`, { commits: { [s.ta]: s.ca, [s.tb]: "0".repeat(40) } });
    expect(res.status).toBe(409);
    expect(git(s.a, "ls-tree", "-r", "--name-only", "main")).not.toContain("src/save.js");
  }, 120_000);

  it("a worker token cannot press the group merge", async () => {
    const res = await fetch(`${s.win.base}/tasks/groups/${s.group}/merge${q}`, { method: "POST", headers: { authorization: `Bearer ${s.wb.token}`, origin: s.win.origin, "content-type": "application/json" }, body: JSON.stringify({ commits: { [s.ta]: s.ca, [s.tb]: s.cb } }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(git(s.a, "ls-tree", "-r", "--name-only", "main")).not.toContain("src/save.js");
  }, 120_000);
});

void ({} as Window);
