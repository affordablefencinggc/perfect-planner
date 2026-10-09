import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGitWatcher } from "../src/core/watcher/gitWatcher.mjs";
import {
  parseCommitLog,
  parseImplementsRefs,
  parseStatusZ,
  parseWorktreePorcelain,
} from "../src/core/watcher/gitParsers.mjs";

const START = Date.parse("2026-10-01T10:00:00.000Z");

function fakeLedger(clock) {
  const entries = [];
  let counter = 0;
  return {
    entries: () => entries.slice(),
    async append(fields) {
      if (typeof fields.summary !== "string" || fields.summary.trim() === "") {
        throw Object.assign(new Error("summary is required"), { code: "LEDGER_RULE" });
      }
      if (/\.(blocked|reopened|rejected)$/.test(fields.type) && !fields.reason) {
        throw Object.assign(new Error("reason is required"), { code: "LEDGER_RULE" });
      }
      counter += 1;
      const entry = Object.freeze({
        n: `L-${String(counter).padStart(6, "0")}`,
        at: new Date(clock.t).toISOString(),
        actor: fields.actor,
        type: fields.type,
        subject: fields.subject,
        summary: fields.summary,
        ...(fields.reason ? { reason: fields.reason } : {}),
        ...(fields.blocking ? { blocking: true } : {}),
        ...(fields.data ? { data: fields.data } : {}),
        evidence: fields.evidence ?? [],
        refs: fields.refs ?? [],
        corrects: null,
      });
      entries.push(entry);
      return entry;
    },
    subscribe: () => () => {},
    close() {},
  };
}

function ofType(ledger, type) {
  return ledger.entries().filter((entry) => entry.type === type);
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function commitFile(worktree, file, content, message, body = "") {
  await fs.writeFile(path.join(worktree, file), content);
  git(worktree, ["add", "-A"]);
  const args = ["commit", "-m", message];
  if (body) args.push("-m", body);
  git(worktree, args);
}

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-watcher-"));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Watcher Test"]);
  git(repo, ["config", "user.email", "watcher@example.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "base"]);

  const worktrees = {};
  for (const task of ["T-1", "T-2"]) {
    const worktree = path.join(root, "wt", task);
    git(repo, ["worktree", "add", "-b", `pp/${task}`, worktree, "main"]);
    worktrees[task] = worktree;
  }
  return { root, repo, worktrees };
}

function listFor(repo, worktrees, extra = {}) {
  return async () => [
    { task: "T-1", path: worktrees["T-1"], branch: "pp/T-1", base: "main" },
    { task: "T-2", path: worktrees["T-2"], branch: "pp/T-2", base: "main" },
    ...(extra.more ?? []),
  ];
}

test("Implements refs are parsed from commit trailers only", () => {
  assert.deepEqual(parseImplementsRefs("Fix\n\nImplements: P-2 §3.1 (T-14)"), ["P-2 §3.1"]);
  assert.deepEqual(
    parseImplementsRefs("Work\n\nImplements: P-2 §3.1, P-2 §4.2.1 (T-14)\nimplements: P-3 §1"),
    ["P-2 §3.1", "P-2 §4.2.1", "P-3 §1"],
  );
  assert.deepEqual(parseImplementsRefs("We implements P-2 §3.1 in prose"), []);
  assert.deepEqual(parseImplementsRefs("no trailer here"), []);
  assert.deepEqual(parseImplementsRefs(""), []);
  assert.deepEqual(parseImplementsRefs("Implements: P-2 §3.1\r\nImplements: P-2 §3.1"), ["P-2 §3.1"]);
});

test("porcelain status parsing covers modified, untracked and renamed paths", () => {
  const text = " M src/a.js\0?? docs/new.md\0R  src/new-name.js\0src/old-name.js\0A  src/added.js\0";
  assert.deepEqual(parseStatusZ(text), ["src/a.js", "docs/new.md", "src/new-name.js", "src/added.js"]);
  assert.deepEqual(parseStatusZ(""), []);
});

test("commit log and worktree list parsing read git output", () => {
  const log = [
    "aaaaaaa1111111111111111111111111111111111\x1ffirst\x1fbody line\nImplements: P-1 §2 (T-1)\x1f2026-10-01T10:00:00+00:00\x1e",
    "\nbbbbbbb2222222222222222222222222222222222\x1fsecond\x1f\x1f2026-10-01T10:05:00+00:00\x1e",
  ].join("");
  const commits = parseCommitLog(log);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].subject, "first");
  assert.match(commits[0].body, /Implements: P-1 §2 \(T-1\)/);
  assert.equal(commits[1].body, "");
  assert.equal(commits[1].committedAt, "2026-10-01T10:05:00+00:00");

  const worktrees = parseWorktreePorcelain(
    "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/wt/T-1\nHEAD def\nbranch refs/heads/pp/T-1\n\nworktree /repo/x\nHEAD 123\ndetached\n",
  );
  assert.deepEqual(worktrees, [
    { path: "/repo", branch: "main" },
    { path: "/repo/wt/T-1", branch: "pp/T-1" },
    { path: "/repo/x", branch: null },
  ]);
});

test("the constructor refuses a ledger without append and entries", () => {
  assert.throws(() => createGitWatcher({ ledger: {} }), TypeError);
});

test("a new commit is observed once with its clause refs, and never again", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    await commitFile(
      worktrees["T-1"],
      "feature.js",
      "export const x = 1;\n",
      "Add feature",
      "Implements: P-2 §3.1 (T-1)",
    );

    const first = await watcher.tick();
    assert.deepEqual(first.errors, []);
    const observed = ofType(ledger, "commit.observed");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].subject, "T-1");
    assert.equal(observed[0].actor.kind, "system");
    assert.equal(observed[0].evidence.length, 1);
    assert.match(observed[0].evidence[0], /^[0-9a-f]{40}$/);
    assert.deepEqual(observed[0].refs, ["P-2 §3.1"]);
    assert.match(observed[0].summary, /Add feature/);

    await watcher.tick();
    assert.equal(ofType(ledger, "commit.observed").length, 1);

    // A restarted watcher rebuilds its dedupe state from the ledger alone.
    const restarted = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    await restarted.tick();
    assert.equal(ofType(ledger, "commit.observed").length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("two worktrees touching the same file produce one collision per overlap", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    await commitFile(worktrees["T-1"], "shared.txt", "from T-1\n", "T-1 edits shared");
    // T-2 has only an uncommitted change to the same file.
    await fs.writeFile(path.join(worktrees["T-2"], "shared.txt"), "from T-2\n");
    await fs.writeFile(path.join(worktrees["T-2"], "only-two.txt"), "solo\n");

    const result = await watcher.tick();
    assert.deepEqual(result.errors, []);
    const collisions = ofType(ledger, "collision.detected");
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].subject, "T-1+T-2");
    assert.deepEqual(collisions[0].evidence, ["shared.txt"]);

    await watcher.tick();
    assert.equal(ofType(ledger, "collision.detected").length, 1);

    const restarted = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    await restarted.tick();
    assert.equal(ofType(ledger, "collision.detected").length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("disjoint worktrees produce no collision entries", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    await commitFile(worktrees["T-1"], "one.txt", "1\n", "T-1 work");
    await fs.writeFile(path.join(worktrees["T-2"], "two.txt"), "2\n");
    await watcher.tick();
    assert.equal(ofType(ledger, "collision.detected").length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a claimed task with no activity is flagged stalled once per stall", async () => {
  const clock = { t: START };
  const ledger = fakeLedger(clock);
  await ledger.append({ actor: { kind: "agent", id: "w1" }, type: "task.claimed", subject: "T-1", summary: "claimed T-1" });
  const watcher = createGitWatcher({
    repoRoot: ".",
    ledger,
    stallMs: 1000,
    now: () => new Date(clock.t),
    listWorktrees: async () => [],
  });

  await watcher.tick();
  assert.equal(ofType(ledger, "task.blocked").length, 0);

  clock.t = START + 1000;
  await watcher.tick();
  const stalls = ofType(ledger, "task.blocked");
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].reason, "stalled");
  assert.equal(stalls[0].subject, "T-1");
  assert.deepEqual(stalls[0].evidence, [`activity:${new Date(START).toISOString()}`]);

  clock.t = START + 5000;
  await watcher.tick();
  assert.equal(ofType(ledger, "task.blocked").length, 1);

  // Progress resets the clock; a later silence is a new stall.
  clock.t = START + 5500;
  await ledger.append({ actor: { kind: "agent", id: "w1" }, type: "task.progress", subject: "T-1", summary: "tests written" });
  clock.t = START + 6400;
  await watcher.tick();
  assert.equal(ofType(ledger, "task.blocked").length, 1);

  clock.t = START + 6500;
  await watcher.tick();
  assert.equal(ofType(ledger, "task.blocked").length, 2);
});

test("commits keep a claimed task alive, and a finished task never stalls", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      stallMs: 1000,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    await ledger.append({ actor: { kind: "agent", id: "w1" }, type: "task.claimed", subject: "T-1", summary: "claimed T-1" });
    await ledger.append({ actor: { kind: "agent", id: "w2" }, type: "task.claimed", subject: "T-2", summary: "claimed T-2" });
    await ledger.append({ actor: { kind: "agent", id: "w2" }, type: "task.done", subject: "T-2", summary: "T-2 accepted" });

    clock.t = START + 500;
    await commitFile(worktrees["T-1"], "t1.txt", "1\n", "T-1 first commit");
    await watcher.tick();

    clock.t = START + 1200;
    await watcher.tick();
    assert.equal(ofType(ledger, "task.blocked").length, 0, "commit at +500ms keeps T-1 active at +1200ms");

    clock.t = START + 1600;
    await watcher.tick();
    const stalls = ofType(ledger, "task.blocked");
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].subject, "T-1");
    assert.equal(stalls.some((entry) => entry.subject === "T-2"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a stall is not re-recorded by a restarted watcher", async () => {
  const clock = { t: START };
  const ledger = fakeLedger(clock);
  await ledger.append({ actor: { kind: "agent", id: "w1" }, type: "task.claimed", subject: "T-3", summary: "claimed T-3" });
  clock.t = START + 2000;
  const options = { repoRoot: ".", ledger, stallMs: 1000, now: () => new Date(clock.t), listWorktrees: async () => [] };
  await createGitWatcher(options).tick();
  await createGitWatcher(options).tick();
  assert.equal(ofType(ledger, "task.blocked").length, 1);
});

test("a failing worktree is reported without stopping the other worktrees", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: async () => [
        { task: "T-1", path: worktrees["T-1"], branch: "pp/T-1", base: "no-such-base" },
        { task: "T-2", path: worktrees["T-2"], branch: "pp/T-2", base: "main" },
      ],
    });
    await commitFile(worktrees["T-2"], "ok.txt", "ok\n", "T-2 work");
    const result = await watcher.tick();
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].stage, "git");
    assert.equal(result.errors[0].task, "T-1");
    const observed = ofType(ledger, "commit.observed");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].subject, "T-2");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("discovery failures and refused writes are returned, not thrown", async () => {
  const clock = { t: START };
  const ledger = fakeLedger(clock);
  const failingDiscovery = createGitWatcher({
    repoRoot: ".",
    ledger,
    now: () => new Date(clock.t),
    listWorktrees: async () => {
      throw new Error("worktree list unavailable");
    },
  });
  const discovered = await failingDiscovery.tick();
  assert.equal(discovered.errors[0].stage, "listWorktrees");

  const locked = {
    entries: () => [],
    async append() {
      throw Object.assign(new Error("ledger locked"), { code: "LEDGER_LOCKED" });
    },
  };
  const { root, repo, worktrees } = await makeRepo();
  try {
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger: locked,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    await commitFile(worktrees["T-1"], "a.txt", "a\n", "T-1 work");
    await fs.writeFile(path.join(worktrees["T-2"], "a.txt"), "b\n");
    const result = await watcher.tick();
    assert.equal(result.written.length, 0);
    assert.equal(result.errors.length, 1, "after LEDGER_LOCKED no further writes are attempted");
    assert.equal(result.errors[0].code, "LEDGER_LOCKED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the default discovery finds pp/T-n worktrees against the integration branch", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      integrationBranch: "main",
      now: () => new Date(clock.t),
    });
    await commitFile(worktrees["T-1"], "default.txt", "d\n", "T-1 via default discovery");
    const result = await watcher.tick();
    assert.deepEqual(result.errors, []);
    const observed = ofType(ledger, "commit.observed");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].subject, "T-1");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("start ticks on an interval and stop halts further writes", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      intervalMs: 10,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    await commitFile(worktrees["T-1"], "loop.txt", "l\n", "T-1 loop");
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await watcher.stop();
    const countAtStop = ledger.entries().length;
    assert.equal(ofType(ledger, "commit.observed").length, 1);

    await commitFile(worktrees["T-2"], "later.txt", "x\n", "T-2 after stop");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(ledger.entries().length, countAtStop);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bare clause refs inherit the plan named earlier on the same Implements line", () => {
  assert.deepEqual(parseImplementsRefs("Work\n\nImplements: P-2 §3.1, §3.2 (T-14)"), ["P-2 §3.1", "P-2 §3.2"]);
  assert.deepEqual(parseImplementsRefs("Implements: P-2 §3.1; §4; P-5 §1, §2"), [
    "P-2 §3.1",
    "P-2 §4",
    "P-5 §1",
    "P-5 §2",
  ]);
  assert.deepEqual(parseImplementsRefs("Implements: §3.2 (T-14)"), [], "a bare clause with no plan is ignored");
  assert.deepEqual(parseImplementsRefs("Implements: P-2 §3.1\nImplements: §3.2"), ["P-2 §3.1"]);
});

test("unsafe base refs never reach git, and the integration branch is required", async () => {
  const clock = { t: START };
  assert.throws(() => createGitWatcher({ repoRoot: ".", ledger: fakeLedger(clock) }), TypeError);
  assert.throws(
    () => createGitWatcher({ repoRoot: ".", ledger: fakeLedger(clock), integrationBranch: "--output=x" }),
    TypeError,
  );

  const { root, repo, worktrees } = await makeRepo();
  try {
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: async () => [
        { task: "T-1", path: worktrees["T-1"], branch: "pp/T-1", base: "--output=pwned.txt" },
        { task: "T-2", path: worktrees["T-2"], branch: "pp/T-2", base: "main" },
      ],
    });
    await commitFile(worktrees["T-2"], "ok.txt", "ok\n", "T-2 work");
    const result = await watcher.tick();
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].stage, "git");
    assert.equal(result.errors[0].task, "T-1");
    await assert.rejects(fs.access(path.join(worktrees["T-1"], "pwned.txt...HEAD")));
    await assert.rejects(fs.access(path.join(repo, "pwned.txt...HEAD")));
    assert.equal(ofType(ledger, "commit.observed").length, 1, "the safe worktree is still read");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a blocking question pauses the stall clock until it is answered", async () => {
  const clock = { t: START };
  const ledger = fakeLedger(clock);
  await ledger.append({ actor: { kind: "agent", id: "w1" }, type: "task.claimed", subject: "T-1", summary: "claimed T-1" });
  clock.t = START + 100;
  const question = await ledger.append({
    actor: { kind: "agent", id: "w1" },
    type: "question.asked",
    subject: "T-1",
    summary: "which schema version?",
    blocking: true,
  });
  const watcher = createGitWatcher({
    repoRoot: ".",
    ledger,
    stallMs: 1000,
    now: () => new Date(clock.t),
    listWorktrees: async () => [],
  });

  clock.t = START + 5000;
  await watcher.tick();
  assert.equal(ofType(ledger, "task.blocked").length, 0, "a worker waiting on a blocking question is not stalled");

  await ledger.append({
    actor: { kind: "human", id: "owner" },
    type: "question.answered",
    subject: "T-1",
    summary: "use schema v2",
    evidence: [question.n],
  });
  clock.t = START + 5500;
  await watcher.tick();
  assert.equal(ofType(ledger, "task.blocked").length, 0, "the answer counts as activity");

  clock.t = START + 6100;
  await watcher.tick();
  const stalls = ofType(ledger, "task.blocked");
  assert.equal(stalls.length, 1);
  assert.deepEqual(stalls[0].evidence, [`activity:${new Date(START + 5000).toISOString()}`]);
});

test("attaching proof counts as activity, so a proved task can still stall later", async () => {
  const clock = { t: START };
  const ledger = fakeLedger(clock);
  await ledger.append({ actor: { kind: "agent", id: "w1" }, type: "task.claimed", subject: "T-1", summary: "claimed T-1" });
  clock.t = START + 500;
  await ledger.append({ actor: { kind: "agent", id: "w1" }, type: "task.proof", subject: "T-1", summary: "screenshot attached" });
  const watcher = createGitWatcher({
    repoRoot: ".",
    ledger,
    stallMs: 1000,
    now: () => new Date(clock.t),
    listWorktrees: async () => [],
  });

  clock.t = START + 1200;
  await watcher.tick();
  assert.equal(ofType(ledger, "task.blocked").length, 0);

  clock.t = START + 1600;
  await watcher.tick();
  const stalls = ofType(ledger, "task.blocked");
  assert.equal(stalls.length, 1, "proof did not end stall tracking");
  assert.deepEqual(stalls[0].evidence, [`activity:${new Date(START + 500).toISOString()}`]);
});

test("a resolved collision is detected again if the same pair overlaps later", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    await commitFile(worktrees["T-1"], "shared.txt", "from T-1\n", "T-1 edits shared");
    await fs.writeFile(path.join(worktrees["T-2"], "shared.txt"), "from T-2\n");
    await watcher.tick();
    assert.equal(ofType(ledger, "collision.detected").length, 1);

    await ledger.append({
      actor: { kind: "human", id: "owner" },
      type: "collision.resolved",
      subject: "T-1+T-2",
      summary: "shared.txt reconciled",
      evidence: ["shared.txt"],
    });
    await watcher.tick();
    const collisions = ofType(ledger, "collision.detected");
    assert.equal(collisions.length, 2, "the overlap is recorded again after resolution");
    assert.deepEqual(collisions[1].evidence, ["shared.txt"]);
    assert.equal(collisions[1].subject, "T-1+T-2");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("copied local settings are not collisions, but other shared untracked files are", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    for (const task of ["T-1", "T-2"]) {
      await fs.mkdir(path.join(worktrees[task], ".claude"), { recursive: true });
      await fs.writeFile(path.join(worktrees[task], ".claude", "settings.local.json"), "{}\n");
      await fs.mkdir(path.join(worktrees[task], ".perfect-planner"), { recursive: true });
      await fs.writeFile(path.join(worktrees[task], ".perfect-planner", "state.json"), "{}\n");
    }
    await watcher.tick();
    assert.equal(ofType(ledger, "collision.detected").length, 0, "copied settings are ignored");

    for (const task of ["T-1", "T-2"]) {
      await fs.writeFile(path.join(worktrees[task], "notes.txt"), "same\n");
    }
    await watcher.tick();
    const collisions = ofType(ledger, "collision.detected");
    assert.equal(collisions.length, 1);
    assert.deepEqual(collisions[0].evidence, ["notes.txt"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a replaced ledger window is replayed from scratch, so no entry is skipped", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const base = fakeLedger(clock);
    let view = null;
    const ledger = { append: (fields) => base.append(fields), entries: () => view ?? base.entries() };
    const actor = { kind: "system", id: "git-watcher" };

    await commitFile(worktrees["T-1"], "a.txt", "a\n", "T-1 first");
    const commitA = git(worktrees["T-1"], ["rev-parse", "HEAD"]);
    await base.append({ actor, type: "commit.observed", subject: "T-1", summary: "a", evidence: [commitA] });
    await base.append({ actor: { kind: "agent", id: "w1" }, type: "task.claimed", subject: "T-1", summary: "claimed T-1" });
    await base.append({ actor: { kind: "agent", id: "w1" }, type: "task.progress", subject: "T-1", summary: "progress" });

    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    const first = await watcher.tick();
    assert.deepEqual(first.errors, []);
    assert.equal(first.written.length, 0, "commit A was already observed");

    // A new commit on T-2 is recorded in a window that replaces the old one at the same length.
    await commitFile(worktrees["T-2"], "b.txt", "b\n", "T-2 work");
    const commitB = git(worktrees["T-2"], ["rev-parse", "HEAD"]);
    const [observedA, claimed] = base.entries();
    view = [
      observedA,
      claimed,
      Object.freeze({
        n: "L-000099",
        at: new Date(START).toISOString(),
        actor,
        type: "commit.observed",
        subject: "T-2",
        summary: "b",
        evidence: [commitB],
        refs: [],
        corrects: null,
      }),
    ];
    const second = await watcher.tick();
    assert.deepEqual(second.errors, []);
    assert.equal(
      second.written.filter((entry) => entry.type === "commit.observed").length,
      0,
      "commit B is already in the replaced window and must not be observed again",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a commit reachable from two task worktrees is observed once", async () => {
  const { root, repo, worktrees } = await makeRepo();
  try {
    const clock = { t: START };
    const ledger = fakeLedger(clock);
    const watcher = createGitWatcher({
      repoRoot: repo,
      ledger,
      now: () => new Date(clock.t),
      listWorktrees: listFor(repo, worktrees),
    });
    await commitFile(worktrees["T-1"], "same.txt", "x\n", "T-1 work");
    const hash = git(worktrees["T-1"], ["rev-parse", "HEAD"]);
    git(worktrees["T-2"], ["reset", "--hard", hash]);

    const result = await watcher.tick();
    assert.deepEqual(result.errors, []);
    const observed = ofType(ledger, "commit.observed");
    assert.equal(observed.length, 1, "one commit hash is observed once, whichever task reaches it first");
    assert.deepEqual(observed[0].evidence, [hash]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the strict ledger's question shape (Q-n subject, data.task and data.blocking) pauses the stall clock", async () => {
  const clock = { t: START };
  const ledger = fakeLedger(clock);
  await ledger.append({ actor: { kind: "agent", id: "w1" }, type: "task.claimed", subject: "T-1.a2", summary: "claimed T-1.a2" });
  clock.t = START + 100;
  await ledger.append({
    actor: { kind: "agent", id: "w1" },
    type: "question.asked",
    subject: "Q-1",
    summary: "which schema version?",
    data: { task: "T-1.a2", options: [], blocking: true },
  });
  const watcher = createGitWatcher({ repoRoot: ".", ledger, stallMs: 1000, now: () => new Date(clock.t), listWorktrees: async () => [] });
  clock.t = START + 5000;
  await watcher.tick();
  assert.equal(ofType(ledger, "task.blocked").length, 0, "waiting on a blocking question is not a stall");
  await ledger.append({ actor: { kind: "system", id: "relay" }, type: "question.answered", subject: "Q-1", summary: "use schema v2", data: { decision: "D-1" } });
  clock.t = START + 6100;
  await watcher.tick();
  const stalls = ofType(ledger, "task.blocked");
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].subject, "T-1", "attempts share the base task's watch state");
});

test("commit and collision entries carry the data the strict ledger's board reads", async () => {
  const clock = { t: START };
  const ledger = fakeLedger(clock);
  const { root, repo, worktrees } = await makeRepo();
  try {
    await commitFile(worktrees["T-1"], "shared.txt", "one\n", "T-1 work", "Implements: P-1 §1 (T-1)");
    await commitFile(worktrees["T-2"], "shared.txt", "two\n", "T-2 work");
    const watcher = createGitWatcher({ repoRoot: repo, ledger, listWorktrees: listFor(repo, worktrees), now: () => new Date(clock.t) });
    const result = await watcher.tick();
    assert.deepEqual(result.errors, []);
    const commits = ofType(ledger, "commit.observed");
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0].data, { sha: commits[0].evidence[0], files: ["shared.txt"], message: "T-1 work" });
    const [collision] = ofType(ledger, "collision.detected");
    assert.deepEqual(collision.data, { files: ["shared.txt"], tasks: ["T-1", "T-2"] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
