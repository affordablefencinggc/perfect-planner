// The watcher polls every few seconds beside the worker's own git. Its status read must not take git's optional
// index lock: a worker whose `git add` or `git commit` meets that lock fails with "Unable to create index.lock",
// which the worker (or the person reading its log) sees as a broken repository. Measured before the fix: 10 of 150
// worker add+commit pairs failed while the watcher polled; with --no-optional-locks, none.
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { gitExecutable } from "../exec/index";
import { changedFiles } from "./changes";
import { makeTaskRepo, type Fixture } from "./fixtures";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const WORKER = `
const { spawnSync } = require("child_process");
const fs = require("fs");
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
const failures = [];
for (let i = 0; i < 60; i += 1) {
  fs.writeFileSync("src/f" + i + ".ts", i + "\\n");
  const add = spawnSync(process.env.PP_GIT, ["add", "-A"], { encoding: "utf8", env });
  const commit = spawnSync(process.env.PP_GIT, ["commit", "-q", "-m", "c" + i], { encoding: "utf8", env });
  if (add.status !== 0 || commit.status !== 0) failures.push((add.stderr + commit.stderr).slice(0, 200));
}
console.log(JSON.stringify(failures));
`;

describe("polling does not get in the worker's way", { timeout: 180_000 }, () => {
  it("a worker adding and committing while the watcher reads status as fast as it can never meets index.lock", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    const task = fixture.tasks["T-1"];
    let stop = false;
    let polls = 0;
    const poller = (async () => {
      while (!stop) {
        await changedFiles(task.path, task.baseSha);
        polls += 1;
      }
    })();
    const out: string[] = [];
    const worker = spawn(process.execPath, ["-e", WORKER], { cwd: task.path, env: { ...process.env, PP_GIT: gitExecutable(task.path) }, stdio: ["ignore", "pipe", "inherit"] });
    worker.stdout.on("data", (chunk) => out.push(String(chunk)));
    await new Promise((resolve) => worker.once("exit", resolve));
    stop = true;
    await poller;
    expect(polls).toBeGreaterThan(5);
    expect(JSON.parse(out.join(""))).toEqual([]);
  });
});
