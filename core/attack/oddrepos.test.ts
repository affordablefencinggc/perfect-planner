// Attack 8: repositories that are not the tidy ones the other tests use. A repo with no commits, a symlink loop, a
// submodule, git LFS and a lot of files. For each: every screen still answers, and the work either goes all the way
// through (dispatch, test, build, check, diff, approve, merge) or is refused in plain words with nothing left behind.
// Nothing may hang, crash, or run a program the repo names (marker files that must never appear).
//
// SCALE: the map says 100k files. This suite uses 20k (200 folders of 100 files, all under src/features so the MVP
// scan walks every one of them): the point is "does it stay linear and finish", which 20k shows in about 5 seconds,
// and 100k files would dominate the suite's 90 second budget on a 4-core runner. The 20k folder-listing cap
// (launchFolderHost MAX_ENTRIES) is tested at its real size.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTask, buildCheckApprove, cleanTemp, dispatchAndApproveTest, git, gitWithHooks, makeRepo, startWindow, tempDir, write, type Window } from "./helpers";

// Removing the 20,000-file repo took longer than vitest's 10 s hook default on the Windows runner.
afterAll(cleanTemp, 180_000);
const q = "?project=p";

const SCREENS = ["/status", "/tasks", "/planning", "/mvp", "/summary", "/search?q=save", "/plan", "/people", "/agents", "/decisions", "/planning/mindmap", "/planning/roadmap"];

async function open(repo: string): Promise<Window> {
  const data = tempDir();
  return startWindow({ data, project: repo, secrets: path.join(data, "secrets.json") });
}

/** Every read screen answers 200 quickly, and the code scan of the repo finishes. Returns the scan's seconds. */
async function screensAnswer(win: Window, { scan = true, limitMs = 8000 } = {}): Promise<number> {
  for (const screen of SCREENS) {
    const started = Date.now();
    const res = await win.call("GET", screen.includes("?") ? `${screen}&project=p` : `${screen}${q}`);
    expect(res.status, `${screen}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    expect(Date.now() - started, `${screen} took too long`).toBeLessThan(limitMs);
  }
  if (!scan) return 0;
  const started = Date.now();
  const staged = await win.call("POST", `/mvp/stage${q}`, { mode: "existing", goal: "Ship the notes app" });
  expect(staged.status, JSON.stringify(staged.body).slice(0, 300)).toBe(200);
  const seconds = (Date.now() - started) / 1000;
  expect(seconds, "the code scan took too long").toBeLessThan(limitMs / 1000);
  return seconds;
}

/** dispatch -> approved test -> work -> check -> diff -> approve -> merge, all through the app. Returns the merge commit. */
async function wholeFlow(win: Window, repo: string, { title = "Save notes", prepare }: { title?: string; prepare?: (worktree: string) => void } = {}): Promise<{ merged: string; seconds: number }> {
  const task = await addTask(win, q, title);
  const w = await dispatchAndApproveTest(win, q, task);
  const started = Date.now();
  prepare?.(w.worktree);
  const head = await buildCheckApprove(win, q, w);
  const merged = await win.call("POST", `/tasks/${task}/merge${q}`, { commit: head });
  expect(merged.status, JSON.stringify(merged.body)).toBe(200);
  expect(git(repo, "show", "main:src/save.js")).toContain("save");
  expect(win.host.project("p").ledger.status.ok).toBe(true);
  return { merged: git(repo, "rev-parse", "main"), seconds: (Date.now() - started) / 1000 };
}

/** Nothing half-made after a refused or failed start. */
function expectNothingLeftBehind(repo: string, win: Window) {
  expect(fs.existsSync(path.join(repo, ".perfect-planner", "worktrees")) ? fs.readdirSync(path.join(repo, ".perfect-planner", "worktrees")) : []).toEqual([]);
  let branches = "";
  try {
    branches = git(repo, "branch", "--list");
  } catch {
    branches = "";
  }
  expect(branches.split("\n").map((b) => b.trim().replace("* ", "")).filter((b) => b && b !== "main")).toEqual([]);
  expect(win.host.project("p").ledger.status.ok).toBe(true);
}

const FEATURE = "export const notes = () => [];\n";

describe("attack 8: a repo with no commits", () => {
  it("every screen answers; starting a worker is refused in plain words and leaves nothing behind; after the first commit the same task starts", async () => {
    const repo = makeRepo({ "README.md": "# New\n", ".gitignore": ".perfect-planner/\n" }, { commit: false });
    const win = await open(repo);
    try {
      await screensAnswer(win, { scan: false });
      const task = await addTask(win, q);
      const refused = await win.call("POST", `/tasks/${task}/dispatch${q}`, { model: "builder-model" });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("NO_REPO");
      expect(refused.body.message).toMatch(/at least one commit/i);
      expectNothingLeftBehind(repo, win);
      // The person makes the first commit; nothing else needs repairing.
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "First");
      const w = await dispatchAndApproveTest(win, q, task);
      expect(fs.existsSync(w.worktree)).toBe(true);
    } finally {
      await win.stop();
    }
  }, 60_000);

  it("a folder that is not a repository at all is refused the same way", async () => {
    const folder = tempDir("pp-attack-plain-");
    write(folder, "README.md", "# not a repo\n");
    const win = await open(folder);
    try {
      await screensAnswer(win, { scan: false });
      const task = await addTask(win, q);
      const refused = await win.call("POST", `/tasks/${task}/dispatch${q}`, { model: "builder-model" });
      expect(refused.status).toBe(409);
      expect(["NO_REPO"]).toContain(refused.body.code);
      expect(fs.existsSync(path.join(folder, ".git"))).toBe(false);
      expect(fs.existsSync(path.join(folder, ".perfect-planner", "worktrees"))).toBe(false);
    } finally {
      await win.stop();
    }
  }, 60_000);

  it("a repo whose only commit is empty (no files at all) goes through the whole flow", async () => {
    const repo = makeRepo({}, { commit: false });
    git(repo, "commit", "-q", "--allow-empty", "-m", "Empty start");
    const win = await open(repo);
    try {
      await screensAnswer(win, { scan: false });
      await wholeFlow(win, repo);
    } finally {
      await win.stop();
    }
  }, 60_000);
});

describe("attack 8: a symlink loop", () => {
  let repo: string;
  let win: Window;
  let outside: string;
  beforeAll(async () => {
    // A secret outside the repo that a link inside the repo points at.
    outside = tempDir("pp-attack-outside-");
    write(outside, "secret.txt", "TOP-SECRET-OUTSIDE-THE-REPO\n");
    repo = makeRepo({ ".gitignore": ".perfect-planner/\n", "README.md": "# Loops\n", "src/features/notes/index.js": FEATURE });
    fs.symlinkSync("b", path.join(repo, "a"));
    fs.symlinkSync("a", path.join(repo, "b"));
    fs.symlinkSync(".", path.join(repo, "self"));
    fs.symlinkSync("../..", path.join(repo, "src/features/notes/up"));
    fs.symlinkSync("../notes", path.join(repo, "src/features/notes/loop"));
    fs.symlinkSync(outside, path.join(repo, "src/features/notes/outside"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Links, some of them loops");
    win = await open(repo);
  }, 60_000);
  afterAll(async () => win.stop());

  it("every screen answers and the code scan finishes (links are never followed)", async () => {
    await screensAnswer(win);
    const board = JSON.stringify((await win.call("GET", `/mvp${q}`)).body);
    expect(board).not.toContain("TOP-SECRET-OUTSIDE-THE-REPO");
  });

  it("the whole flow goes through; the worker's own loops and an outward link are carried as links, never followed or copied", async () => {
    const { merged } = await wholeFlow(win, repo, {
      prepare: (worktree) => {
        fs.symlinkSync("..", path.join(worktree, "src", "parent"));
        fs.symlinkSync(outside, path.join(worktree, "src", "peek"));
        fs.symlinkSync("loop2", path.join(worktree, "loop1"));
        fs.symlinkSync("loop1", path.join(worktree, "loop2"));
      },
    });
    // Links stay links in the merge (mode 120000) and the outside file was not pulled into the repo or the ledger.
    expect(git(repo, "ls-tree", merged, "src/peek", "loop1", "src/parent")).toMatch(/^120000 blob.*src\/peek/m);
    for (const file of git(repo, "ls-tree", "-r", "--name-only", merged).split("\n")) expect(file).not.toMatch(/secret\.txt/);
    // git grep exits 1 when nothing matches, which is the answer wanted here.
    expect(() => git(repo, "grep", "-l", "TOP-SECRET", merged, "--")).toThrow();
  });
});

describe("attack 8: a repo with a submodule", () => {
  const MARKER_NAME = "submodule-ran";
  let repo: string;
  let win: Window;
  let marker: string;
  beforeAll(async () => {
    marker = path.join(tempDir("pp-attack-marker-"), MARKER_NAME);
    const lib = makeRepo({ "lib.js": "export const x = 1;\n" });
    repo = makeRepo({ ".gitignore": ".perfect-planner/\n", "README.md": "# Vendored\n", "src/features/notes/index.js": FEATURE });
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    // The repo's own config names a program to run when the submodule is updated.
    git(repo, "config", "submodule.vendor/lib.update", `!touch ${marker}`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Vendor a library");
    win = await open(repo);
  }, 60_000);
  afterAll(async () => win.stop());

  it("every screen answers and the code scan finishes", async () => {
    await screensAnswer(win);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("the whole flow goes through; the submodule is kept as it was, and the program its settings name never runs", async () => {
    const before = git(repo, "ls-tree", "main", "vendor/lib");
    expect(before).toMatch(/^160000 commit/);
    await wholeFlow(win, repo);
    expect(git(repo, "ls-tree", "main", "vendor/lib")).toBe(before);
    expect(fs.existsSync(marker), "the submodule update program ran").toBe(false);
  });

  it("a worker that edits .gitmodules is shown to the person, who must confirm that file by name", async () => {
    const task = await addTask(win, q, "Point the submodule somewhere else");
    const w = await dispatchAndApproveTest(win, q, task, { file: "tests/modules.check.mjs", source: 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/modules.js") ? 0 : 1);\n', command: "node tests/modules.check.mjs" });
    await w.call({ tool: "claim_task", args: { task }, agent: w.agent });
    write(w.worktree, "src/modules.js", "export const modules = true;\n");
    const modules = fs.readFileSync(path.join(w.worktree, ".gitmodules"), "utf8");
    fs.writeFileSync(path.join(w.worktree, ".gitmodules"), modules.replace(/url = .*/, `url = ext::sh -c "touch ${marker.replace(/\\/g, "/")}"`));
    git(w.worktree, "add", "-A");
    git(w.worktree, "commit", "-q", "-m", "Move the submodule");
    const head = git(w.worktree, "rev-parse", "HEAD");
    await w.call({ tool: "attach_proof", args: { task, kind: "commit", link: head }, agent: w.agent });
    const checked = await win.call("POST", `/tasks/${task}/check${q}`);
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    const diff = (await win.call("GET", `/tasks/${task}/diff${q}`)).body.result as { sensitive: string[] };
    expect(diff.sensitive).toContain(".gitmodules");
    const blind = await win.call("POST", `/tasks/${task}/approve-diff${q}`, { commit: head });
    expect(blind.status).toBe(409);
    expect(blind.body.code).toBe("CONFIRM_SENSITIVE");
    expect(blind.body.message).toContain(".gitmodules");
    expect(fs.existsSync(marker), "the ext:: url was run").toBe(false);
  });
});

describe("attack 8: a submodule repo that also sets submodule.recurse and names an update command in .gitmodules", () => {
  let repo: string;
  let win: Window;
  let marker: string;
  let task: string;
  beforeAll(async () => {
    marker = path.join(tempDir("pp-attack-marker-"), "gitmodules-ran");
    const lib = makeRepo({ "lib.js": "export const x = 1;\n" });
    repo = makeRepo({ ".gitignore": ".perfect-planner/\n", "README.md": "# Vendored\n", "src/features/notes/index.js": FEATURE });
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    git(repo, "config", "-f", ".gitmodules", "submodule.vendor/lib.update", `!touch ${marker}`);
    git(repo, "config", "submodule.recurse", "true");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Vendor a library");
    win = await open(repo);
    task = await addTask(win, q);
  }, 60_000);
  afterAll(async () => win.stop());

  it("starting a worker is refused (git itself rejects this .gitmodules), no command is run, and the screens keep answering", async () => {
    await screensAnswer(win);
    const refused = await win.call("POST", `/tasks/${task}/dispatch${q}`, { model: "builder-model" });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(marker), "the update command ran").toBe(false);
    expect(win.host.project("p").ledger.status.ok).toBe(true);
    await screensAnswer(win, { scan: false });
  });

  // REAL DEFECT 2 (second repro, no crash needed): core/worktrees/manager.ts createNow() runs `git worktree add` outside
  // its try/catch, so when git fails the rollback (remove the worktree, delete the branch) never happens. The failed
  // dispatch leaves branch pp/T-1, a registered worktree and a half-made folder; every retry says "Branch pp/T-1
  // already exists" even after the person has fixed the setting.
  it.fails("a failed start leaves nothing behind, and once the repo is fixed the same task starts", async () => {
    expectNothingLeftBehind(repo, win);
    git(repo, "config", "--unset", "submodule.recurse");
    git(repo, "rm", "-q", "--cached", ".gitmodules");
    fs.rmSync(path.join(repo, ".gitmodules"));
    git(repo, "commit", "-q", "-m", "Drop the bad .gitmodules");
    const again = await win.call("POST", `/tasks/${task}/dispatch${q}`, { model: "builder-model" });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });
});

describe.skipIf(!(() => { try { execFileSync("git", ["lfs", "version"], { stdio: "ignore" }); return true; } catch { return false; } })())("attack 8: a repo using git LFS (needs git-lfs installed; no LFS server, no network)", () => {
  let repo: string;
  let win: Window;
  let marker: string;
  const oldPath = process.env.PATH;
  beforeAll(async () => {
    repo = makeRepo({ ".gitignore": ".perfect-planner/\n", "README.md": "# Assets\n", "src/features/notes/index.js": FEATURE });
    gitWithHooks(repo, "lfs", "install", "--local");
    git(repo, "lfs", "track", "*.bin");
    fs.writeFileSync(path.join(repo, "logo.bin"), Buffer.alloc(8192, 7));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "A big binary through LFS");
    expect(git(repo, "show", "HEAD:logo.bin")).toMatch(/^version https:\/\/git-lfs/);
    // From here a program called git-lfs that is not git-lfs sits first on the PATH. If the app ever lets git run the
    // repo's LFS filter, this is what runs, and it leaves the marker.
    marker = path.join(tempDir("pp-attack-marker-"), "lfs-ran");
    const bin = tempDir("pp-attack-fake-lfs-");
    fs.writeFileSync(path.join(bin, "git-lfs"), `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    win = await open(repo);
  }, 60_000);
  afterAll(async () => {
    process.env.PATH = oldPath;
    await win?.stop();
  });

  it("every screen answers", async () => {
    await screensAnswer(win, { scan: false });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("starting a worker is refused in plain words (the LFS filter is a program), the filter never runs, and nothing is left behind", async () => {
    const task = await addTask(win, q);
    const refused = await win.call("POST", `/tasks/${task}/dispatch${q}`, { model: "builder-model" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("GIT_PROGRAM_REFUSED");
    expect(refused.body.message).toMatch(/filter\.lfs/);
    expect(refused.body.message).toMatch(/person must review|git config --unset/i);
    expect(fs.existsSync(marker), "the LFS filter program ran").toBe(false);
    expectNothingLeftBehind(repo, win);
  });

  it("after the person removes the filter settings, the whole flow goes through and the pointer file is carried as it is", async () => {
    git(repo, "config", "--local", "--remove-section", "filter.lfs");
    // The working copy of logo.bin is still the 8 KB binary; without the filter git sees it as a change. Put the committed
    // pointer text back so main is clean (the app refuses to merge into a dirty main, and that is right).
    git(repo, "checkout", "--", "logo.bin");
    expect(git(repo, "status", "--porcelain")).toBe("");
    const { merged } = await wholeFlow(win, repo, { title: "After removing the LFS filter" });
    expect(git(repo, "show", `${merged}:logo.bin`)).toMatch(/^version https:\/\/git-lfs/);
    expect(fs.existsSync(marker), "the LFS filter program ran").toBe(false);
  });
});

describe("attack 8: a filter program named by a repo is refused at the first worker, with nothing run", () => {
  it("a smudge/clean filter set in the repo config and wired up by .gitattributes", async () => {
    const marker = path.join(tempDir("pp-attack-marker-"), "filter-ran");
    const repo = makeRepo({ ".gitignore": ".perfect-planner/\n", ".gitattributes": "*.dat filter=pp-evil\n", "data.dat": "payload\n", "src/features/notes/index.js": FEATURE });
    const win = await open(repo);
    try {
      for (const kind of ["smudge", "clean", "process"]) git(repo, "config", `filter.pp-evil.${kind}`, `sh -c 'touch ${marker}; cat'`);
      git(repo, "config", "filter.pp-evil.required", "true");
      await screensAnswer(win);
      const task = await addTask(win, q);
      const refused = await win.call("POST", `/tasks/${task}/dispatch${q}`, { model: "builder-model" });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("GIT_PROGRAM_REFUSED");
      expect(fs.existsSync(marker), "the filter ran").toBe(false);
      expectNothingLeftBehind(repo, win);
    } finally {
      await win.stop();
    }
  }, 60_000);
});

describe("attack 8: 20,000 files (scaled down from 100,000; 2,000 on Windows)", () => {
  let repo: string;
  let win: Window;
  // Creating and adding 20,000 files took over two minutes on the Windows runner (windows-latest run 39034910848): 2,000 there.
  const FOLDERS = process.platform === "win32" ? 20 : 200;
  const PER_FOLDER = 100;
  beforeAll(async () => {
    repo = makeRepo({ ".gitignore": ".perfect-planner/\n", "README.md": "# Big\n" });
    for (let d = 0; d < FOLDERS; d += 1) {
      const dir = path.join(repo, "src", "features", `f${String(d).padStart(3, "0")}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < PER_FOLDER; f += 1) fs.writeFileSync(path.join(dir, `c${f}.js`), `export const v${f} = ${d};\n`);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Twenty thousand files");
    expect(git(repo, "ls-files").split("\n").length).toBe(FOLDERS * PER_FOLDER + 2);
    win = await open(repo);
  }, 120_000);
  afterAll(async () => win.stop());

  it("every screen answers and the code scan walks all of it within seconds", async () => {
    const seconds = await screensAnswer(win, { limitMs: 15_000 });
    expect(seconds).toBeLessThan(15);
  }, 60_000);

  it("the whole flow goes through: worktree of 20,000 files, test, check, diff, merge into main", async () => {
    const { seconds } = await wholeFlow(win, repo);
    expect(seconds).toBeLessThan(30);
    expect(git(repo, "ls-files").split("\n").length).toBe(FOLDERS * PER_FOLDER + 4);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(execFileSync("git", ["fsck", "--strict"], { cwd: repo, stdio: "pipe" }).toString()).not.toMatch(/error/i);
  }, 90_000);
});

describe("attack 8: the launch-folder listing of a folder with more than 20,000 entries", () => {
  it("is cut at 20,000 entries, lists no link, follows none, and the server stays up", async () => {
    const folder = tempDir("pp-attack-launch-");
    const LIMIT = 20_000;
    fs.mkdirSync(path.join(folder, "flat"));
    for (let i = 0; i < LIMIT + 50; i += 1) fs.writeFileSync(path.join(folder, "flat", `f${i}.txt`), "x");
    fs.symlinkSync(".", path.join(folder, "self"));
    fs.symlinkSync("b", path.join(folder, "a"));
    fs.symlinkSync("a", path.join(folder, "b"));
    fs.symlinkSync(os_tmp(), path.join(folder, "out"));
    write(folder, "README.md", "# launch\n");
    const mod = (await import(/* @vite-ignore */ pathToFileURL(path.resolve("src/node/launchFolderHost.mjs")).href)) as { createLaunchFolderMiddleware: (o: { folder: string }) => (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => Promise<unknown> };
    const middleware = mod.createLaunchFolderMiddleware({ folder });
    const server = http.createServer((req, res) => void middleware(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/launch-folder`;
    const headers = { "x-pp-launch-folder": "1" };
    try {
      const started = Date.now();
      const flat = (await (await fetch(`${base}/list?path=flat`, { headers })).json()) as { entries: { name: string; kind: string }[] };
      expect(flat.entries.length).toBe(LIMIT);
      expect(Date.now() - started).toBeLessThan(10_000);
      const root = (await (await fetch(`${base}/list`, { headers })).json()) as { entries: { name: string; kind: string }[] };
      expect(root.entries.map((e) => e.name).sort()).toEqual(["README.md", "flat"]);
      // Walking through a link, or a loop of links, is refused as "not found" rather than followed.
      for (const through of ["self", "self/self/flat", "a", "a/b", "out", "out/anything", "flat/../self", "self/README.md"]) {
        const res = await fetch(`${base}/list?path=${encodeURIComponent(through)}`, { headers });
        expect(res.status, through).toBe(404);
      }
      for (const file of ["self/README.md", "out/anything.txt", "a"]) {
        expect((await fetch(`${base}/file?path=${encodeURIComponent(file)}`, { headers })).status, file).toBe(404);
      }
      expect((await fetch(`${base}`, { headers })).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});

function os_tmp(): string {
  return path.dirname(tempDir("pp-attack-x-"));
}
