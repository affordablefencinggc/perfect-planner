// Attack 4: edit the approved test after the person approved it and before Check. A worker that cannot make the
// real test pass tries to make the test pass instead. The edited test drops a marker file when it runs; the marker
// must never appear, Check must not record a pass, and nothing can reach the diff, merge or done stages.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTask, buildCheckApprove, cleanTemp, dispatchAndApproveTest, git, makeRepo, startWindow, tempDir, write, TEST_FILE, TEST_SOURCE, type Dispatched, type Window } from "./helpers";

afterAll(cleanTemp);
const q = "?project=p";

interface Ctx {
  win: Window;
  repo: string;
  dir: string;
}

async function open(files?: Record<string, string>): Promise<Ctx> {
  const repo = makeRepo(files);
  const dir = tempDir();
  const win = await startWindow({ data: dir, project: repo, secrets: path.join(dir, "secrets.json") });
  return { win, repo, dir };
}

const stageOf = async (win: Window, task: string) => ((await win.call("GET", `/tasks${q}`)).body.result.tasks as { id: string; stage: string }[]).find((t) => t.id === task)!.stage;
const entriesOf = (win: Window, task: string) => win.host.project("p").entries().filter((e) => e.subject === task);

/** What a cheating test looks like: it writes the marker and passes. */
const cheat = (marker: string) => `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "the edited test ran");\nprocess.exit(0);\n`;

/** After the edit: Check must not pass, nothing past Check is reachable and the cheating test never ran. */
async function expectRefused(ctx: Ctx, w: Dispatched, marker: string, expected: RegExp) {
  const checked = await ctx.win.call("POST", `/tasks/${w.task}/check${q}`);
  const text = JSON.stringify(checked.body);
  const passed = checked.status === 200 && checked.body.result?.passed === true;
  expect(passed, `Check accepted an edited test: ${text}`).toBe(false);
  expect(text).toMatch(expected);
  expect(fs.existsSync(marker), "the edited test must never run").toBe(false);
  expect(entriesOf(ctx.win, w.task).filter((e) => e.type === "test.passed")).toEqual([]);
  expect(await stageOf(ctx.win, w.task)).not.toMatch(/review-diff|ready-to-merge|done/);
  const head = git(w.worktree, "rev-parse", "HEAD");
  expect((await ctx.win.call("POST", `/tasks/${w.task}/approve-diff${q}`, { commit: head })).status).toBe(409);
  expect((await ctx.win.call("POST", `/tasks/${w.task}/merge${q}`, { commit: head })).status).toBe(409);
}

describe("attack 4: a worker edits the approved test before Check", () => {
  let ctx: Ctx;
  const workers: Record<string, Dispatched> = {};
  const markers: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await open();
    for (const name of ["dirty", "commit", "amend", "symlink"]) {
      const task = await addTask(ctx.win, q, `Variant ${name}`);
      workers[name] = await dispatchAndApproveTest(ctx.win, q, task);
      markers[name] = path.join(ctx.dir, `marker-${name}`);
      await workers[name]!.call({ tool: "claim_task", args: { task }, agent: workers[name]!.agent });
    }
  }, 120_000);
  afterAll(async () => ctx.win.stop());

  it("an uncommitted edit of the test file is refused and never run", async () => {
    const w = workers.dirty!;
    write(w.worktree, TEST_FILE, cheat(markers.dirty!));
    await expectRefused(ctx, w, markers.dirty!, /commit or remove|tamper|changed|differ/i);
  });

  it("a committed edit of the test file is refused and never run", async () => {
    const w = workers.commit!;
    write(w.worktree, TEST_FILE, cheat(markers.commit!));
    git(w.worktree, "add", "-A");
    git(w.worktree, "commit", "-q", "-m", "Make the test pass");
    await expectRefused(ctx, w, markers.commit!, /tamper|changed|differ/i);
  });

  it("an edit folded into the original test commit (history rewritten with --amend) is refused and never run", async () => {
    const w = workers.amend!;
    // Put the cheating test into the very commit that introduced the test, so no later commit shows the change.
    write(w.worktree, TEST_FILE, cheat(markers.amend!));
    git(w.worktree, "add", "-A");
    git(w.worktree, "commit", "-q", "--amend", "--no-edit");
    await expectRefused(ctx, w, markers.amend!, /tamper|changed|differ/i);
  });

  it("the test file swapped for a link to another script is refused and never run", async () => {
    const w = workers.symlink!;
    write(w.worktree, "tests/decoy.mjs", cheat(markers.symlink!));
    fs.rmSync(path.join(w.worktree, TEST_FILE));
    fs.symlinkSync("decoy.mjs", path.join(w.worktree, TEST_FILE));
    git(w.worktree, "add", "-A");
    git(w.worktree, "commit", "-q", "-m", "Link the test to a script that passes");
    await expectRefused(ctx, w, markers.symlink!, /tamper|changed|differ|link/i);
  });
});

describe("attack 4: the approved test is deleted, or only its line endings change", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await open();
  }, 60_000);
  afterAll(async () => ctx.win.stop());

  it("a deleted test file does not pass Check", async () => {
    const task = await addTask(ctx.win, q, "Deleted test");
    const w = await dispatchAndApproveTest(ctx.win, q, task);
    await w.call({ tool: "claim_task", args: { task }, agent: w.agent });
    fs.rmSync(path.join(w.worktree, TEST_FILE));
    git(w.worktree, "add", "-A");
    git(w.worktree, "commit", "-q", "-m", "Remove the test");
    const checked = await ctx.win.call("POST", `/tasks/${task}/check${q}`);
    expect(checked.status === 200 && checked.body.result?.passed === true, JSON.stringify(checked.body)).toBe(false);
    expect(entriesOf(ctx.win, task).filter((e) => e.type === "test.passed")).toEqual([]);
  });

  it("control: a line-ending-only change is not tampering (the pin ignores CRLF), the honest work still passes Check", async () => {
    const task = await addTask(ctx.win, q, "CRLF test");
    const w = await dispatchAndApproveTest(ctx.win, q, task);
    write(w.worktree, TEST_FILE, TEST_SOURCE.replace(/\n/g, "\r\n"));
    git(w.worktree, "add", "-A");
    git(w.worktree, "commit", "-q", "-m", "Windows line endings");
    const head = await buildCheckApprove(ctx.win, q, w);
    expect(git(w.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(await stageOf(ctx.win, task)).toBe("ready-to-merge");
  });
});

describe("attack 4: the worker edits something the approved test imports (not pinned)", () => {
  // The pin covers the test file itself. A helper it imports is not pinned, so the second line of defence is the
  // diff screen: every file the test reaches through imports is "sensitive" and the person must confirm it by name.
  const HELPER = 'import { saved } from "./deep/inner.mjs";\nexport const ok = () => saved();\n';
  const INNER_REAL = 'import { existsSync } from "node:fs";\nexport const saved = () => existsSync("src/save.js");\n';
  const TEST = 'import { ok } from "../lib/check-helper.mjs";\nprocess.exit(ok() ? 0 : 1);\n';
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await open({ ".gitignore": ".perfect-planner/\n", "README.md": "# app\n", "lib/check-helper.mjs": HELPER, "lib/deep/inner.mjs": INNER_REAL });
  }, 60_000);
  afterAll(async () => ctx.win.stop());

  it("a helper two imports away that is rewritten to make the test pass is shown to the person, who must confirm it by name", async () => {
    const task = await addTask(ctx.win, q, "Helper chain");
    const w = await dispatchAndApproveTest(ctx.win, q, task, { file: "tests/chain.check.mjs", source: TEST, command: "node tests/chain.check.mjs" });
    await w.call({ tool: "claim_task", args: { task }, agent: w.agent });
    // No src/save.js at all: the worker just makes the deep helper say "saved".
    write(w.worktree, "lib/deep/inner.mjs", "export const saved = () => true;\n");
    git(w.worktree, "add", "-A");
    git(w.worktree, "commit", "-q", "-m", "Make the helper say yes");
    const head = git(w.worktree, "rev-parse", "HEAD");
    const checked = await ctx.win.call("POST", `/tasks/${task}/check${q}`);
    const diff = (await ctx.win.call("GET", `/tasks/${task}/diff${q}`)).body.result as { sensitive: string[] };
    if (checked.status === 200 && checked.body.result?.passed === true) {
      // Check cannot know the helper changed; the person must be told, and cannot approve without naming it.
      expect(diff.sensitive).toContain("lib/deep/inner.mjs");
      const blind = await ctx.win.call("POST", `/tasks/${task}/approve-diff${q}`, { commit: head });
      expect(blind.status, JSON.stringify(blind.body)).toBe(409);
      expect(blind.body.code).toBe("CONFIRM_SENSITIVE");
      expect(blind.body.message).toContain("lib/deep/inner.mjs");
      const partial = await ctx.win.call("POST", `/tasks/${task}/approve-diff${q}`, { commit: head, confirmSensitive: diff.sensitive.filter((f) => f !== "lib/deep/inner.mjs") });
      expect(partial.body.code).toBe("CONFIRM_SENSITIVE");
    } else {
      expect(JSON.stringify(checked.body)).toMatch(/tamper|changed|differ/i);
    }
    expect(entriesOf(ctx.win, task).some((e) => e.type === "task.done")).toBe(false);
  });
});
