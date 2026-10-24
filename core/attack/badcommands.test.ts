// Bad test commands (ledger 10-soak area 2): what the gate does with a test command that hangs, floods, forks,
// escapes its process group, fills the disk or kills its parent. Run plain and, where bubblewrap works, contained
// (PP_CONTAIN_TESTS). A break is a hang past the limit, a leftover process, an unbounded buffer or a write outside
// the worktree that the contained run did not stop. Known gaps are it.fails so the suite shows them.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxStatus } from "../exec/index";
import { runTestCommand } from "../gate/index";
import { testRunnerFor } from "../host/project";

const posix = process.platform !== "win32";
const d = posix ? describe : describe.skip;
let dir: string;
let outside: string;
const contained = posix && (await sandboxStatus()).kind === "bubblewrap";
const plain = (c: string, o = {}) => runTestCommand(c, dir, { timeoutMs: 3000, killWaitMs: 3000, ...o });
const runner = testRunnerFor({ PP_CONTAIN_TESTS: "1" } as any);
const boxed = (c: string, o = {}) => runner!(c, dir, { timeoutMs: 6000, killWaitMs: 3000, ...o });
const alive = (marker: string) => spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);

beforeAll(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-bad-")));
  outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-outside-")));
  fs.writeFileSync(path.join(dir, "loop.mjs"), "for (;;) {}\n");
  fs.writeFileSync(path.join(dir, "flood.mjs"), "const b = 'x'.repeat(1 << 16); for (;;) process.stdout.write(b);\n");
  fs.writeFileSync(path.join(dir, "grandchild.mjs"), `import { spawn } from "node:child_process";\nspawn("sleep", ["303"], { detached: true, stdio: "ignore" }).unref();\nprocess.exit(1);\n`);
  fs.writeFileSync(path.join(dir, "forks.mjs"), `import { spawn } from "node:child_process";\nfor (let i = 0; i < 150; i++) spawn("sleep", ["304"], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`);
  fs.writeFileSync(path.join(dir, "fill.mjs"), `import fs from "node:fs";\nconst fd = fs.openSync("big.bin", "w");\nconst b = Buffer.alloc(1 << 20);\nfor (let i = 0; i < 400; i++) fs.writeSync(fd, b);\nconsole.log("wrote 400 MB");\nprocess.exit(1);\n`);
});
afterAll(() => {
  spawnSync("pkill", ["-f", "sleep 30[34]"]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

d.each([["plain", plain], ...(contained ? [["contained", boxed]] : [])] as [string, typeof plain][])("%s runner", (_name, run) => {
  it("a command that never ends is stopped at the limit and reported as no pass", async () => {
    const r = await run("node loop.mjs");
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(15_000);
  }, 30_000);

  it("100 MB/s of output keeps memory flat and ends at the limit", async () => {
    const before = process.memoryUsage().rss;
    const r = await run("node flood.mjs");
    expect(r.timedOut).toBe(true);
    expect(r.outputTail.length).toBeLessThan(8000);
    expect(process.memoryUsage().rss - before, "rss grew more than 200 MB").toBeLessThan(200 * 1024 * 1024);
  }, 30_000);

  it("150 child processes are gone after the timeout", async () => {
    const r = await run("node forks.mjs");
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 500));
    expect(alive("sleep 304"), "children of a timed-out test are still running").toEqual([]);
  }, 30_000);

  it("a missing program and a shell trick are plain refusals, not crashes", async () => {
    for (const c of ["no-such-program-xyz", "node -e 'process.exit(0)'; rm -rf /nonexistent-xyz", "true && exit 0", "", " ", "\n\n", "x".repeat(200_000)]) {
      const r = await run(c);
      expect(typeof r.passed, c.slice(0, 40)).toBe("boolean");
      if (c === "no-such-program-xyz") expect(r.passed).toBe(false);
    }
  }, 60_000);
});

d("escapes the plain runner does not stop (said plainly)", () => {
  it.fails("a grandchild that starts its own session outlives the test (KNOWN: process-group kill only)", async () => {
    await plain("node grandchild.mjs");
    await new Promise((res) => setTimeout(res, 300));
    expect(alive("sleep 303"), "a detached process survived the run").toEqual([]);
  });
  it.fails("a test can write 400 MB into its worktree with no limit (KNOWN: no disk quota)", async () => {
    const r = await runTestCommand("node fill.mjs", dir, { timeoutMs: 20_000 });
    void r;
    const size = fs.existsSync(path.join(dir, "big.bin")) ? fs.statSync(path.join(dir, "big.bin")).size : 0;
    fs.rmSync(path.join(dir, "big.bin"), { force: true });
    expect(size).toBeLessThan(50 * 1024 * 1024);
  }, 30_000);
  it.fails("a test can write outside its worktree (KNOWN: logic isolation only, ISOLATION.md)", async () => {
    await plain(`node -e "require('fs').writeFileSync('${outside}/pwned','x')"`);
    expect(fs.existsSync(path.join(outside, "pwned"))).toBe(false);
  });
});

(contained ? d : d.skip)("what the sandbox adds", () => {
  it("blocks the outside write and the disk fill is bounded by nothing but the worktree", async () => {
    const r = await boxed(`node -e "require('fs').writeFileSync('${outside}/pwned2','x')"`);
    expect(fs.existsSync(path.join(outside, "pwned2")), r.outputTail).toBe(false);
  }, 30_000);
  it("a detached grandchild dies with the sandbox", async () => {
    spawnSync("pkill", ["-f", "sleep 303"]); // the plain-runner escape above left one behind
    await boxed("node grandchild.mjs");
    await new Promise((res) => setTimeout(res, 300));
    expect(alive("sleep 303")).toEqual([]);
  }, 30_000);
  it.fails("a 400 MB write inside the worktree is stopped (KNOWN: no quota)", async () => {
    await boxed("node fill.mjs", { timeoutMs: 20_000 });
    const size = fs.existsSync(path.join(dir, "big.bin")) ? fs.statSync(path.join(dir, "big.bin")).size : 0;
    fs.rmSync(path.join(dir, "big.bin"), { force: true });
    expect(size).toBeLessThan(50 * 1024 * 1024);
  }, 40_000);
  it("no network", async () => {
    const r = await boxed(`node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))"`);
    expect(r.passed).toBe(false);
  }, 30_000);
});

void execFileSync;
