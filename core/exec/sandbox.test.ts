import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runTestCommand } from "../gate/index";
import { CONTAINED_HEADER, NOT_CONTAINED_HEADER, bwrapArgs, containedRunner, sandboxStatus, shQuote, toolchainDirs } from "./index";

const ok = { passed: true, exitCode: 0, timedOut: false, durationMs: 1, outputTail: "done\n" };

describe("fails closed", () => {
  it("runs nothing when the sandbox cannot start", async () => {
    const base = vi.fn(async () => ok);
    const run = containedRunner({ base, status: async () => ({ kind: "none", reason: "bubblewrap is not installed" }) });
    const result = await run("node -v", os.tmpdir(), {});
    expect(base).not.toHaveBeenCalled();
    expect(result).toMatchObject({ passed: false, exitCode: null, timedOut: false });
    expect(result.outputTail.split("\n")[0]).toBe(NOT_CONTAINED_HEADER);
    expect(result.outputTail).toContain("Not run: this computer cannot contain test commands (bubblewrap is not installed)");
  });

  it("says Windows is not available yet instead of running uncontained", async () => {
    const status = await sandboxStatus("win32");
    expect(status.kind).toBe("none");
    const run = containedRunner({ base: vi.fn(async () => ok), platform: "win32" });
    const result = await run("node -v", os.tmpdir(), {});
    expect(result.exitCode).toBeNull();
    expect(result.outputTail).toContain("not available on Windows yet");
  });

  it.skipIf(process.platform !== "linux")("refuses a precheck failure before anything starts", async () => {
    const base = vi.fn(async () => ok);
    const run = containedRunner({ base, status: async () => ({ kind: "bubblewrap" }), precheck: () => "refused: planted" });
    const result = await run("./node -v", os.tmpdir(), {});
    expect(base).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
    expect(result.outputTail).toContain("refused: planted");
  });
});

describe("pure helpers", () => {
  it("quotes any word for sh", () => {
    expect(shQuote("a'b c")).toBe(`'a'\\''b c'`);
  });

  it("builds a command with no network, a read-only root, only the worktree writable", () => {
    const args = bwrapArgs({ writable: ["/work/tree"], readable: [] }, "npm test", "/work/tree");
    expect(args).toEqual(expect.arrayContaining(["--unshare-all", "--die-with-parent", "--new-session", "--remount-ro"]));
    expect(args.join(" ")).toContain("--bind /work/tree /work/tree");
    expect(args.slice(-5)).toEqual(["--chdir", "/work/tree", "/bin/sh", "-c", "npm test"]);
  });

  it("keeps scratch away from a worktree that lives under /tmp", () => {
    const args = bwrapArgs({ writable: ["/tmp/x/tree"], readable: [] }, "true", "/tmp/x/tree");
    expect(args.join(" ")).toContain("--tmpfs /run/pp-scratch");
    expect(args.join(" ")).not.toContain("--tmpfs /tmp");
  });

  it("leaves out toolchain folders that hold the home folder or a protected root", () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-sb-")));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    const tools = path.join(dir, "tools", "bin");
    for (const d of [home, repo, tools, path.join(repo, "node_modules", ".bin")]) fs.mkdirSync(d, { recursive: true });
    const list = toolchainDirs({ PATH: [dir, home, path.join(repo, "node_modules", ".bin"), tools, "/usr/bin"].join(path.delimiter) }, { cwd: repo, protect: [repo], home });
    expect(list).toEqual([tools, path.join(dir, "tools")]);
  });
});

const status = process.platform === "linux" ? await sandboxStatus() : { kind: "none" as const, reason: "Linux only" };
describe.skipIf(status.kind !== "bubblewrap")("a real contained run", () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-sb-run-")));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = containedRunner({ base: runTestCommand, nodeDir: path.dirname(process.execPath) });

  it("reports a pass and a failure honestly, with the header first", async () => {
    const pass = await run("node -e \"process.exit(0)\"", dir, {});
    expect(pass).toMatchObject({ passed: true, exitCode: 0 });
    expect(pass.outputTail.split("\n")[0]).toBe(CONTAINED_HEADER);
    const fail = await run("node -e \"console.log('nope'); process.exit(1)\"", dir, {});
    expect(fail).toMatchObject({ passed: false, exitCode: 1 });
    expect(fail.outputTail).toContain("nope");
  });

  it("does not turn a bubblewrap error into a failing test", async () => {
    const result = await containedRunner({ base: async (_c, _d, _o) => ({ passed: false, exitCode: 1, timedOut: false, durationMs: 1, outputTail: "bwrap: Can't mkdir /x\n" }) })("true", dir, {});
    expect(result).toMatchObject({ passed: false, exitCode: null });
  });

  it("cannot see the host's loopback, any file outside the worktree, or a stray after the end", async () => {
    const secret = path.join(os.tmpdir(), `pp-sb-secret-${process.pid}`);
    fs.writeFileSync(secret, "SECRET");
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const script = `
        const fs = require("node:fs"), net = require("node:net"), cp = require("node:child_process");
        let read = "READ"; try { fs.readFileSync(${JSON.stringify(secret)}); } catch (e) { read = e.code; }
        let wrote = "WROTE"; try { fs.writeFileSync("/etc/pp-x", "x"); } catch (e) { wrote = e.code; }
        cp.spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync('late.txt','x'), 1200)"], { detached: true, stdio: "ignore" }).unref();
        const s = net.connect(${port}, "127.0.0.1");
        s.on("connect", () => { console.log("R:" + read + ":" + wrote + ":CONNECTED"); process.exit(0); });
        s.on("error", (e) => { console.log("R:" + read + ":" + wrote + ":" + e.code); process.exit(0); });`;
      fs.writeFileSync(path.join(dir, "probe.cjs"), script);
      const result = await run("node probe.cjs", dir, {});
      const line = /R:(\S+)/.exec(result.outputTail)?.[1] ?? result.outputTail;
      expect(line).toMatch(/^ENOENT:(EROFS|ENOENT):ECONNREFUSED|^ENOENT:(EROFS|ENOENT):ENETUNREACH/);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(fs.existsSync(path.join(dir, "late.txt"))).toBe(false);
    } finally {
      fs.rmSync(secret, { force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("keeps git readable inside a worktree", async () => {
    const { execFileSync } = await import("node:child_process");
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" });
    g(repo, "init", "-q");
    fs.writeFileSync(path.join(repo, "f.txt"), "1");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "x");
    const tree = path.join(dir, "wt");
    g(repo, "worktree", "add", "-q", "-b", "t1", tree);
    const result = await run("git log --oneline", tree, {});
    expect(result).toMatchObject({ passed: true, exitCode: 0 });
    expect(result.outputTail).toContain("x");
  });
});
