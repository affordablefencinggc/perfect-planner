// Attack 5: kill the host (SIGKILL, whole process group, no cleanup) during a ledger write, during a merge and
// during worktree add; start it again; the ledger chain must verify and the repo must hold no half-merge and no
// orphan lock. The host runs in its own process (core/attack/crashHost.ts, bundled here with esbuild).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCoreHost } from "../../scripts/build-core-host.mjs";
import { FileStore, Ledger, verifyChain } from "../ledger/index";
import { addTask, buildCheckApprove, cleanTemp, connectWindow, dispatchAndApproveTest, git, hostKeysOn, makeRepo, sleep, startWindow, tempDir } from "./helpers";

// NOT RUN on Windows: the host is started as its own process group and killed with SIGKILL (detached + process.kill(-pid)),
// which Windows does not have. A Windows version would kill the tree with taskkill /F /T; it is not written. The first
// Windows run (windows-latest run 39034910848) failed this file to load with "SyntaxError: Invalid or unexpected token".
const WINDOWS = process.platform === "win32";
let bundle = "";
beforeAll(async () => {
  if (WINDOWS) return;
  const out = tempDir("pp-attack-bundle-");
  await buildCoreHost({ outDir: out, standalone: true, entries: { crashHost: path.resolve("core/attack/crashHost.ts") } });
  bundle = path.join(out, "crashHost.mjs");
}, 60_000);
const running: Running[] = [];
afterAll(async () => {
  // Nothing may outlive the suite, whatever failed.
  await Promise.all(running.map((r) => r.kill()));
  cleanTemp();
});

interface Running {
  pid: number;
  win: Awaited<ReturnType<typeof connectWindow>>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): Promise<void>;
}

/** The host as its own process group. `crash` switches on a crash point (see crashHost.ts). */
async function spawnHost(o: { data: string; project: string; secrets: string; crash?: Record<string, string> }): Promise<Running> {
  const child = spawn(process.execPath, [bundle], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PP_ATTACK_DATA: o.data, PP_ATTACK_PROJECT: o.project, PP_ATTACK_SECRETS: o.secrets, ...o.crash } });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk));
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`host did not start: ${stderr}`)), 20_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        clearTimeout(timer);
        resolve(buffer.split("\n")[0]!);
      }
    });
    child.on("exit", () => reject(new Error(`host exited early: ${stderr}`)));
  });
  const { base, launch, pid } = JSON.parse(line) as { base: string; launch: string; pid: number };
  const win = await connectWindow(base, launch);
  const host: Running = {
    pid,
    win,
    exited,
    kill: async () => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
      await exited;
    },
  };
  running.push(host);
  return host;
}


// ---------- what must hold after any restart ----------

interface RepoFacts {
  /** *.lock files and worktree "locked" markers anywhere in .git. */
  locks: string[];
  /** MERGE_HEAD, a rebase or cherry-pick in progress, or unmerged files in the index. */
  halfMerge: string[];
  /** Plain git commands that fail on this repo (a repo that git itself cannot read is not "intact"). */
  gitErrors: string[];
  /** Uncommitted changes in the main checkout. */
  dirty: string;
  main: string;
  mainParents: string[];
}

function tryGit(repo: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(repo, ...args) };
  } catch (error) {
    return { ok: false, out: String((error as { stderr?: string }).stderr ?? error).trim() };
  }
}

function repoFacts(repo: string): RepoFacts {
  const gitDir = path.join(repo, ".git");
  const locks: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".lock") || entry.name === "locked") locks.push(path.relative(gitDir, full).replace(/\\/g, "/"));
    }
  };
  walk(gitDir);
  const halfMerge = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply"].filter((name) => fs.existsSync(path.join(gitDir, name)));
  const unmerged = tryGit(repo, "diff", "--name-only", "--diff-filter=U");
  if (unmerged.ok && unmerged.out) halfMerge.push("unmerged files in the index");
  const gitErrors: string[] = [];
  for (const args of [["status", "--porcelain"], ["branch", "--list"], ["worktree", "list"], ["fsck", "--no-dangling", "--strict"]]) {
    const run = tryGit(repo, ...args);
    if (!run.ok) gitErrors.push(`git ${args.join(" ")}: ${run.out.split("\n")[0]}`);
  }
  return {
    locks,
    halfMerge,
    gitErrors,
    dirty: tryGit(repo, "status", "--porcelain").out,
    main: tryGit(repo, "rev-parse", "main").out,
    mainParents: tryGit(repo, "log", "-1", "--format=%P", "main").out.split(" ").filter(Boolean),
  };
}

/** The ledger as a fresh reader sees it: every line parses, the hash chain holds, numbers run L-000001 up with no gap. */
function expectLedgerChain(project: string, secrets: string): number {
  const ledger = Ledger.openSync(new FileStore(project), { readOnly: true, keys: hostKeysOn(secrets) });
  try {
    expect(ledger.status, "ledger status").toMatchObject({ ok: true });
    const entries = ledger.entries();
    expect(verifyChain(entries)).toEqual({ ok: true });
    expect(entries.map((e) => e.n)).toEqual(entries.map((_, i) => `L-${String(i + 1).padStart(6, "0")}`));
    return entries.length;
  } finally {
    ledger.close();
  }
}

const q = "?project=p";
const boardSize = async (win: { call: (m: "GET" | "POST", r: string) => Promise<{ body: { result?: any } }> }) => ((await win.call("GET", `/tasks${q}`)).body.result.tasks as unknown[]).length;

function freshProject(files?: Record<string, string>) {
  const repo = makeRepo(files);
  const data = tempDir();
  return { repo, data, secrets: path.join(data, "secrets.json") };
}

// ---------- a kill during a ledger write ----------

describe.skipIf(WINDOWS)("attack 5a: the host is killed while a ledger entry is being written", () => {
  /** Writes the person's tasks until the host dies; returns how many the host said it had recorded. */
  async function writeUntilDead(h: Running): Promise<number> {
    let acknowledged = 0;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await h.win.call("POST", `/planning/tasks${q}`, { title: `Task ${i + 1}` });
        if (res.status === 200) acknowledged++;
      } catch {
        break;
      }
    }
    await h.exited;
    return acknowledged;
  }

  it("a line cut in half: the restart keeps the half line aside, the chain verifies, no recorded task is lost and writing resumes", async () => {
    const p = freshProject();
    const h = await spawnHost({ ...p, project: p.repo, crash: { PP_CRASH_TORN_AT: "5" } });
    const acknowledged = await writeUntilDead(h);
    expect(acknowledged).toBeGreaterThan(0);
    const ledgerDir = path.join(p.repo, ".perfect-planner", "ledger");
    const month = fs.readdirSync(ledgerDir).find((name) => name.endsWith(".jsonl"))!;
    expect(fs.readFileSync(path.join(ledgerDir, month), "utf8").endsWith("\n"), "the kill left a cut line on disk").toBe(false);

    const win = await startWindow({ ...p, project: p.repo });
    try {
      const status = (await win.call("GET", `/status${q}`)).body.result;
      expect(status.integrity).toEqual({ state: "ok", writesStopped: false });
      expect(status.ledger.repaired).toMatch(/incomplete final line/);
      // Preserve first: the cut bytes are kept, not thrown away.
      const kept = fs.readdirSync(ledgerDir).filter((name) => name.startsWith("torn-"));
      expect(kept).toHaveLength(1);
      expect(fs.readFileSync(path.join(ledgerDir, kept[0]!), "utf8").length).toBeGreaterThan(50);
      // Every task the host said it recorded is still there, and the one it was writing is not half-there.
      expect(await boardSize(win)).toBe(acknowledged);
      expect((await win.call("POST", `/planning/tasks${q}`, { title: "After the crash" })).status).toBe(200);
      expect(await boardSize(win)).toBe(acknowledged + 1);
    } finally {
      await win.stop();
    }
    expectLedgerChain(p.repo, p.secrets);
  }, 60_000);

  it.each([
    ["the line is written but HEAD is not yet updated", { PP_CRASH_BEFORE_HEAD_AT: "5" }],
    ["the entry is fully written, the caller is never told", { PP_CRASH_AFTER_HEAD_AT: "5" }],
  ])("%s: the restart finds an intact chain and no recorded task is lost", async (_name, crash) => {
    const p = freshProject();
    const h = await spawnHost({ ...p, project: p.repo, crash });
    const acknowledged = await writeUntilDead(h);
    const win = await startWindow({ ...p, project: p.repo });
    try {
      expect((await win.call("GET", `/status${q}`)).body.result.integrity).toEqual({ state: "ok", writesStopped: false });
      // The entry that was on disk when the host died may or may not have been acknowledged; none acknowledged may be missing.
      const present = await boardSize(win);
      expect(present).toBeGreaterThanOrEqual(acknowledged);
      expect(present).toBeLessThanOrEqual(acknowledged + 1);
      expect((await win.call("POST", `/planning/tasks${q}`, { title: "After the crash" })).status).toBe(200);
    } finally {
      await win.stop();
    }
    expectLedgerChain(p.repo, p.secrets);
  }, 60_000);

  it("five kills at random moments under a steady stream of writes leave one intact chain, and every recorded task is present", async () => {
    const p = freshProject();
    let acknowledged = 0;
    let hosts = 0;
    for (let round = 0; round < 5; round++) {
      const h = await spawnHost({ ...p, project: p.repo });
      hosts++;
      const status = (await h.win.call("GET", `/status${q}`)).body.result;
      expect(status.integrity, `round ${round}: the host found the ledger in this state`).toEqual({ state: "ok", writesStopped: false });
      let running = true;
      const stream = (async () => {
        for (let i = 0; running; i++) {
          try {
            if ((await h.win.call("POST", `/planning/tasks${q}`, { title: `Round ${round} task ${i}` })).status === 200) acknowledged++;
            else break;
          } catch {
            break;
          }
        }
      })();
      await sleep(120 + Math.floor(Math.random() * 280));
      running = false;
      await h.kill();
      await stream;
    }
    expect(hosts).toBe(5);
    const win = await startWindow({ ...p, project: p.repo });
    try {
      expect((await win.call("GET", `/status${q}`)).body.result.integrity).toEqual({ state: "ok", writesStopped: false });
      const present = await boardSize(win);
      expect(present).toBeGreaterThanOrEqual(acknowledged);
      expect(present).toBeLessThanOrEqual(acknowledged + 5);
    } finally {
      await win.stop();
    }
    expectLedgerChain(p.repo, p.secrets);
  }, 90_000);

  it("a second host started on the same project folder cannot write while the first is alive", async () => {
    const p = freshProject();
    const first = await spawnHost({ ...p, project: p.repo });
    expect((await first.win.call("POST", `/planning/tasks${q}`, { title: "From the first host" })).status).toBe(200);
    const second = await spawnHost({ ...p, project: p.repo });
    const refused = await second.win.call("POST", `/planning/tasks${q}`, { title: "From the second host" });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    await first.kill();
    await second.kill();
    const win = await startWindow({ ...p, project: p.repo });
    try {
      expect(await boardSize(win)).toBe(1);
    } finally {
      await win.stop();
    }
    expectLedgerChain(p.repo, p.secrets);
  }, 60_000);
});

// ---------- a kill during a merge ----------

interface MergeRun {
  repo: string;
  head: string;
  base: string;
  died: boolean;
  facts: RepoFacts;
  status: { integrity: { state: string } };
  stageAfter: string;
  retry: { status: number; message?: string };
  factsAfterRetry: RepoFacts;
  entries: number;
}

/** A task ready to merge (test approved, work checked, diff approved), then the host is killed at `crash` during the merge click. */
async function mergeKilled(crash: { env?: Record<string, string>; hang?: boolean }): Promise<MergeRun> {
  const p = freshProject();
  const flag = path.join(p.data, "hang.flag");
  const started = path.join(p.data, "hang.started");
  const test = crash.hang
    ? { file: "tests/hang.check.mjs", command: "node tests/hang.check.mjs", source: `import { existsSync, writeFileSync } from "node:fs";\nif (existsSync(${JSON.stringify(flag)})) { writeFileSync(${JSON.stringify(started)}, "1"); setTimeout(() => {}, 120000); } else process.exit(existsSync("src/save.js") ? 0 : 1);\n` }
    : undefined;
  const a = await startWindow({ ...p, project: p.repo });
  await addTask(a, q);
  const worker = await dispatchAndApproveTest(a, q, "T-1", test);
  const head = await buildCheckApprove(a, q, worker);
  const base = git(p.repo, "rev-parse", "main");
  await a.stop();

  const h = await spawnHost({ ...p, project: p.repo, crash: crash.env });
  if (crash.hang) fs.writeFileSync(flag, "1");
  const merging = h.win.call("POST", `/tasks/T-1/merge${q}`, { commit: head }).then(() => false, () => true);
  let died: boolean;
  if (crash.hang) {
    for (let i = 0; i < 200 && !fs.existsSync(started); i++) await sleep(50);
    expect(fs.existsSync(started), "the post-merge test started").toBe(true);
    await h.kill();
    died = await merging;
  } else {
    died = await merging;
    await h.exited;
  }
  fs.rmSync(flag, { force: true });
  const facts = repoFacts(p.repo);

  const win = await startWindow({ ...p, project: p.repo });
  try {
    const status = (await win.call("GET", `/status${q}`)).body.result;
    const stageAfter = ((await win.call("GET", `/tasks${q}`)).body.result.tasks[0] as { stage: string }).stage;
    const retried = await win.call("POST", `/tasks/T-1/merge${q}`, { commit: head });
    const factsAfterRetry = repoFacts(p.repo);
    await win.stop();
    return { repo: p.repo, head, base, died, facts, status, stageAfter, retry: { status: retried.status, message: retried.body.message }, factsAfterRetry, entries: expectLedgerChain(p.repo, p.secrets) };
  } catch (error) {
    await win.stop();
    throw error;
  }
}

describe.skipIf(WINDOWS).each([
  ["test.passed", "after the branch moved, before anything is recorded"],
  ["merge.done", "after the test pass is recorded, before the merge is"],
  ["task.done", "after the merge is recorded, before the task is marked done"],
])("attack 5b: the host is killed at the ledger write of %s (%s)", (type, when) => {
  let run: MergeRun;
  beforeAll(async () => {
    run = await mergeKilled({ env: { PP_CRASH_BEFORE_TYPE: type } });
  }, 90_000);

  it(`${when}: the host really died, the chain verifies, there is no half-merge and no orphan lock, main is a whole merge`, () => {
    expect(run.died).toBe(true);
    expect(run.status.integrity.state).toBe("ok");
    expect(run.facts.halfMerge).toEqual([]);
    expect(run.facts.locks).toEqual([]);
    expect(run.facts.gitErrors).toEqual([]);
    expect(run.facts.dirty).toBe("");
    // main is the old tip or the whole approved merge (both parents), never anything in between.
    if (run.facts.main !== run.base) expect(run.facts.mainParents).toEqual([run.base, run.head]);
  });

  // REAL DEFECT (found by this attack): the gate moves main with update-ref and only then writes test.passed,
  // merge.done and task.done. A kill in between leaves the work merged in git and the task unfinished in the ledger,
  // and the Merge button then refuses with "main was left untouched" although main holds the merge.
  it.fails("after the restart the person can still finish the task (the app notices main already holds the approved merge)", () => {
    expect(run.retry.status, run.retry.message).toBe(200);
  });
});

describe.skipIf(WINDOWS)("attack 5b: the host is killed while the post-merge test is running", () => {
  let run: MergeRun;
  beforeAll(async () => {
    run = await mergeKilled({ hang: true });
  }, 90_000);

  it("main is untouched, nothing is half-merged, the chain verifies and the merge can be done again", () => {
    expect(run.died).toBe(true);
    expect(run.facts.halfMerge).toEqual([]);
    expect(run.facts.locks).toEqual([]);
    expect(run.facts.gitErrors).toEqual([]);
    expect(run.facts.main).toBe(run.base);
    expect(run.status.integrity.state).toBe("ok");
    expect(run.stageAfter).toBe("ready-to-merge");
    expect(run.retry.status, run.retry.message).toBe(200);
    expect(run.factsAfterRetry.mainParents).toEqual([run.base, run.head]);
    expect(run.factsAfterRetry.halfMerge).toEqual([]);
  });
});

// ---------- a kill during worktree add ----------

interface AddRun {
  base: string;
  completedBeforeKill: boolean;
  facts: RepoFacts;
  statusState: string;
  retry: { status: number; message?: string };
  after: RepoFacts;
  entries: number;
}

/** Starts a worker (worktree add) on a repo big enough that the add takes a while, kills the host once `ready` says git is in the middle of it. */
async function worktreeAddKilled(ready: (wt: string) => boolean): Promise<AddRun> {
  // Enough files that adding the worktree takes long enough to land a kill inside it.
  const files: Record<string, string> = { ".gitignore": ".perfect-planner/\n" };
  for (let i = 0; i < 4000; i++) files[`src/d${i % 60}/f${i}.js`] = `export const v${i} = ${i};\n`;
  const p = freshProject(files);
  const base = git(p.repo, "rev-parse", "main");
  const h = await spawnHost({ ...p, project: p.repo });
  await addTask(h.win, q);
  const wt = path.join(p.repo, ".perfect-planner", "worktrees", "T-1");
  let completedBeforeKill = false;
  const dispatching = h.win.call("POST", `/tasks/T-1/dispatch${q}`, {}).then(
    (res) => { completedBeforeKill = res.status === 200; },
    () => undefined,
  );
  for (let i = 0; i < 4000 && !ready(wt) && !completedBeforeKill; i++) await sleep(1);
  await h.kill();
  await dispatching;
  const facts = repoFacts(p.repo);
  const win = await startWindow({ ...p, project: p.repo });
  try {
    const statusState = (await win.call("GET", `/status${q}`)).body.result.integrity.state;
    const again = await win.call("POST", `/tasks/T-1/dispatch${q}`, {});
    const after = repoFacts(p.repo);
    await win.stop();
    return { base, completedBeforeKill, facts, statusState, retry: { status: again.status, message: again.body.message }, after, entries: expectLedgerChain(p.repo, p.secrets) };
  } catch (error) {
    await win.stop();
    throw error;
  }
}

describe.skipIf(WINDOWS).each([
  ["as git makes the worktree", (wt: string) => fs.existsSync(wt)],
  ["while its files are being checked out", (wt: string) => fs.existsSync(path.join(wt, "src")) && fs.readdirSync(path.join(wt, "src")).length >= 5],
])("attack 5c: the host is killed %s", (_name, ready) => {
  let run: AddRun;
  beforeAll(async () => {
    run = await worktreeAddKilled(ready);
    // A kill that came after the add had finished proves nothing; try again rather than pass by luck.
    for (let attempt = 0; attempt < 2 && run.completedBeforeKill; attempt++) run = await worktreeAddKilled(ready);
    expect(run.completedBeforeKill, "the kill landed while the worktree was still being added").toBe(false);
  }, 120_000);

  it("the chain verifies, main is untouched, there is no half-merge and no uncommitted change in the main checkout", () => {
    expect(run.statusState).toBe("ok");
    expect(run.entries).toBeGreaterThan(0);
    expect(run.facts.halfMerge).toEqual([]);
    expect(run.facts.main).toBe(run.base);
    expect(run.facts.dirty).toBe("");
  });

  // REAL DEFECT (found by this attack): git marks a worktree it is making as locked ("initializing") and keeps an
  // index.lock while it checks files out; a half-written .git/worktrees/T-1 even makes `git branch --list` fail.
  // The kill leaves all of that, the branch pp/T-1 stays, nothing in the app's registry or ledger knows the
  // worktree, and Start worker is refused for good: "Branch pp/T-1 already exists. Use the next attempt id
  // instead of reusing it." (core/worktrees/manager.ts createNow; reconcile on start is lane L10's).
  it.fails("after the restart git still works, no lock is left behind and the task can be started again", () => {
    expect(run.after.gitErrors).toEqual([]);
    expect(run.after.locks).toEqual([]);
    expect(run.retry.status, run.retry.message).toBe(200);
  });
});
