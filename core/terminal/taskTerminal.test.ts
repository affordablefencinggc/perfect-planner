// The task-scoped terminal runner: the allowlist, the transcript, the byte cap and the deadline.
// These tests use real Git and real Node in a throwaway repo; only the deadline test replaces spawn,
// because an honest "still running after the deadline" case must not leave a real process behind.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRepo, writeFiles } from "../worktrees/testing";
import {
  parseTaskCommand,
  redactEnvValues,
  runTaskCommand,
  TaskCommandError,
  transcriptDigest,
} from "./taskTerminal";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function repo(files: Record<string, string> = { "README.md": "hello\n" }) {
  const made = await makeRepo(files);
  cleanups.push(made.cleanup);
  return made.root;
}

function fakeChild(onKill: () => void): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (signal?: string) => boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    onKill();
    return true;
  });
  return child as unknown as ChildProcess;
}

describe("task command allowlist", () => {
  it("accepts the read-only forms the pane promises", () => {
    expect(parseTaskCommand("git status").program).toBe("git");
    expect(parseTaskCommand("git status").tokens).toEqual(["git", "status"]);
    expect(parseTaskCommand("git diff --stat").tokens).toEqual(["git", "diff", "--stat"]);
    expect(parseTaskCommand("git log --oneline -5").tokens).toEqual(["git", "log", "--oneline", "-5"]);
    expect(parseTaskCommand("git branch -a").tokens).toEqual(["git", "branch", "-a"]);
    expect(parseTaskCommand("git rev-parse HEAD").tokens).toEqual(["git", "rev-parse", "HEAD"]);
    expect(parseTaskCommand("git show HEAD:README.md").tokens).toEqual(["git", "show", "HEAD:README.md"]);
    expect(parseTaskCommand("git --no-pager status").tokens).toEqual(["git", "--no-pager", "status"]);
    expect(parseTaskCommand("npm test").program).toBe("npm");
    expect(parseTaskCommand("npm run test").program).toBe("npm");
    expect(parseTaskCommand("npm run test:core").program).toBe("npm");
    expect(parseTaskCommand("npm run typecheck:core").program).toBe("npm");
    expect(parseTaskCommand("node --test").program).toBe("node");
    expect(parseTaskCommand("node --test core/x.test.ts").program).toBe("node");
    expect(parseTaskCommand("npx vitest run").program).toBe("npx");
    expect(parseTaskCommand("npx vitest run core/x.test.ts").program).toBe("npx");
    expect(parseTaskCommand("ls").program).toBe("builtin");
    expect(parseTaskCommand("dir -a").program).toBe("builtin");
    expect(parseTaskCommand("pwd").program).toBe("builtin");
    expect(parseTaskCommand("cat README.md").program).toBe("builtin");
    expect(parseTaskCommand("type README.md").program).toBe("builtin");
    expect(parseTaskCommand("Get-ChildItem -Force").program).toBe("builtin");
    expect(parseTaskCommand("Get-Content -Raw README.md").program).toBe("builtin");
  });

  it("refuses deleting, pushing, resetting and every other change", () => {
    for (const command of ["rm -rf .", "del notes.txt", "rmdir src", "git push", "git reset --hard", "git clean -fdx", "git checkout main", "git switch main", "git merge work", "git rebase main", "git commit -m x", "git stash", "curl https://example.com", "wget https://example.com", "ssh host", "powershell -c ls", "cmd /c dir", "bash -c ls", "sh -c ls"]) {
      expect(() => parseTaskCommand(command), command).toThrow(TaskCommandError);
    }
    expect(() => parseTaskCommand("rm -rf .")).toThrow(/never run/);
    expect(() => parseTaskCommand("git push")).toThrow(/changes the repository/);
    expect(() => parseTaskCommand("git reset --hard")).toThrow(/changes the repository/);
  });

  it("refuses shell syntax instead of pretending to understand it", () => {
    for (const command of ["git status; rm -rf .", "git status && rm -rf .", "git status | cat", "git status > out.txt", "git status $(whoami)", "git status `whoami`", "git status\nrm -rf ."]) {
      expect(() => parseTaskCommand(command), command).toThrow(/shell character/);
    }
    expect(() => parseTaskCommand("")).toThrow(/Type a command/);
    expect(() => parseTaskCommand("   ")).toThrow(/Type a command/);
    expect(() => parseTaskCommand('git log --format="unclosed')).toThrow(/quote/);
  });

  it("refuses Git options that write a file or start another program", () => {
    expect(() => parseTaskCommand("git diff --output=patch.txt")).toThrow(/write a file/);
    expect(() => parseTaskCommand("git log --output patch.txt")).toThrow(/write a file/);
    expect(() => parseTaskCommand("git show --ext-diff HEAD")).toThrow(/start another program/);
    expect(() => parseTaskCommand("git diff --no-index a b")).toThrow(/write a file|start another program/);
    expect(() => parseTaskCommand("git branch -D main")).toThrow(/not a read-only listing/);
    expect(() => parseTaskCommand("git branch new-branch")).toThrow(/only lists branches/);
    expect(() => parseTaskCommand("git -c core.fsmonitor=true status")).toThrow(/read-only Git commands/);
    expect(() => parseTaskCommand("git -C .. status")).toThrow(/read-only Git commands/);
  });

  it("refuses npm scripts and Node options that are not on the list", () => {
    expect(() => parseTaskCommand("npm run build")).toThrow(/Only these npm scripts/);
    expect(() => parseTaskCommand("npm install")).toThrow(/Only npm test/);
    expect(() => parseTaskCommand("npm test --prefix ..")).toThrow(/after --/);
    expect(() => parseTaskCommand("node -e \"1+1\"")).toThrow(/Only node --test/);
    expect(() => parseTaskCommand("node --test --require ./hook.js")).toThrow(/name the test files/);
    expect(() => parseTaskCommand("npx vitest run --config other.config.mjs")).toThrow(/Options are not run here/);
    expect(() => parseTaskCommand("npx create-react-app app")).toThrow(/Only npx vitest run/);
  });
});

describe("task command runner", () => {
  it("runs git status in a task folder and returns a reproducible transcript hash", async () => {
    const root = await repo();
    const result = await runTaskCommand({ cwd: root, command: "git status" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("On branch main");
    expect(result.cwd).toBe(fs.realpathSync.native(root));
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.transcriptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.transcriptHash).toBe(transcriptDigest(result.command, result.exitCode, result.stdout, result.stderr));
  });

  it("never starts a refused command", async () => {
    const root = await repo();
    const spawnImpl = vi.fn();
    await expect(runTaskCommand({ cwd: root, command: "rm -rf .", spawn: spawnImpl as unknown as typeof spawn })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(runTaskCommand({ cwd: root, command: "git push", spawn: spawnImpl as unknown as typeof spawn })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(runTaskCommand({ cwd: root, command: "git status; rm -rf .", spawn: spawnImpl as unknown as typeof spawn })).rejects.toMatchObject({ code: "SHELL_METACHARACTER" });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "README.md"))).toBe(true);
  });

  it("bounds output and says how many bytes it dropped", async () => {
    const root = await repo({ "README.md": "hello\n", "big.txt": "x".repeat(200_000) });
    const result = await runTaskCommand({ cwd: root, command: "git show HEAD:big.txt", maxOutputBytes: 1024 });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.truncated).toBe(true);
    expect(result.droppedBytes).toBeGreaterThan(190_000);
    // The end of the transcript is kept, because that is what a person reads last.
    expect(result.stdout.endsWith("x")).toBe(true);
  });

  it("reports a deadline honestly and stops the program", async () => {
    const root = await repo();
    const child = fakeChild(() => setImmediate(() => child.emit("close", null, "SIGKILL")));
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
    const result = await runTaskCommand({ cwd: root, command: "git status", timeoutMs: 20, spawn: spawnImpl });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/\[Stopped after 20 ms: it was still running\.\]/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const used = (child as unknown as { kill: ReturnType<typeof vi.fn> }).kill;
    expect(used).toHaveBeenCalledWith("SIGKILL");
  });

  it("redacts secret-looking environment values from the transcript", async () => {
    const root = await repo({ "README.md": "hello\n", "secret.txt": "value: sup3rsecret\n" });
    const secretName = "APP_" + "SECRET";
    const secretValue = "sup3r" + "secret";
    const env = { ...process.env, [secretName]: secretValue };
    const result = await runTaskCommand({ cwd: root, command: "cat secret.txt", env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(secretValue);
    expect(result.stdout).toContain("[redacted]");
    expect(redactEnvValues("a sup3rsecret b", { [secretName]: secretValue })).toBe("a [redacted] b");
  });

  it("reads and lists only inside the task folder", async () => {
    const root = await repo({ "README.md": "hello\n" });
    const listed = await runTaskCommand({ cwd: root, command: "ls" });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.split(/\r?\n/)).toContain("README.md");
    const here = await runTaskCommand({ cwd: root, command: "pwd" });
    expect(here.stdout.trim()).toBe(fs.realpathSync.native(root));
    await expect(runTaskCommand({ cwd: root, command: "cat ../outside.txt" })).rejects.toMatchObject({ code: "OUTSIDE_CWD" });
    await expect(runTaskCommand({ cwd: root, command: "cat " + path.join(root, "..", "outside.txt") })).rejects.toMatchObject({ code: "OUTSIDE_CWD" });
  });

  it("follows a link out of the task folder only to refuse it", async () => {
    const root = await repo({ "README.md": "hello\n" });
    const outside = fs.mkdtempSync(path.join(root, "..", "pp-terminal-outside-"));
    cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
    writeFiles(outside, { "secret.txt": "not yours\n" });
    const link = path.join(root, "link");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    await expect(runTaskCommand({ cwd: root, command: "cat link/secret.txt" })).rejects.toMatchObject({ code: "OUTSIDE_CWD" });
  });

  it("runs node --test through the Node that runs Perfect Planner", async () => {
    const root = await repo({
      "README.md": "hello\n",
      "tiny.test.mjs": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("adds", () => assert.equal(1 + 1, 2));\n',
    });
    const result = await runTaskCommand({ cwd: root, command: "node --test tiny.test.mjs" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/(?:#|ℹ) pass 1/);
  });

  it("starts npm through its own script, never through a shell", async () => {
    const root = await repo();
    const result = await runTaskCommand({ cwd: root, command: "npm test" });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/package\.json|ENOENT/i);
  });

  it("refuses a folder that is not a real full path", async () => {
    await expect(runTaskCommand({ cwd: "relative/folder", command: "git status" })).rejects.toMatchObject({ code: "INVALID_CWD" });
    await expect(runTaskCommand({ cwd: path.join(path.sep, "definitely-not-here-pp"), command: "git status" })).rejects.toMatchObject({ code: "INVALID_CWD" });
  });
});
