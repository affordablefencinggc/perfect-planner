// What a test command (and so a worker's test) can still reach (lane L6A). Perfect Planner has no
// sandbox: the approved test command runs through the shell as the person, in the task's worktree, with
// a scrubbed environment and a PATH that cannot hold planted programs. Those two things are enforced and
// tested below. Everything else a test can do as the person is NOT stopped, and each such attack is an
// `it.fails` test named "known gap": it asserts the safe outcome, fails today, and will start failing the
// suite (as an unexpected pass) the day the sandbox of step B closes it, which is the cue to move it to
// the enforced list in core/host/ISOLATION.md. The attacks run through the real approve-test route, so
// they use the same gate runner a worker's test gets.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTestCommand } from "../gate/index";
import { cleanAfterEach, cleanAll, dispatch, git, track, twoProjects } from "./isolation-testing";
import { hostCall } from "./testing";

cleanAfterEach();
/** A known gap that can only be probed where the OS has user ids and process ids to compare. */
const gapOnPosix = process.platform === "win32" ? it.skip : it.fails;

const HOST_SECRETS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "SSH_AUTH_SOCK", "PP_AGENT_TOKEN_FILE", "PP_BRIDGE_URL", "PP_CORE_DESKTOP_LAUNCH"];
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|SSH_|ANTHROPIC|OPENAI|GITHUB|AWS|^PP_/i;

describe("enforced: the environment a test command gets", () => {
  it("holds none of the host's secrets, and a variable given to project A's run is not in project B's run", async () => {
    for (const name of HOST_SECRETS) vi.stubEnv(name, `fake-value-for-${name.toLowerCase()}`);
    vi.stubEnv("PROJECT_A_SECRET_NOTE", "a-only");
    track(() => { vi.unstubAllEnvs(); });
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-iso-env-")));
    track(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "env.mjs"), `console.log("ENV:" + JSON.stringify(Object.keys(process.env).filter((name) => /KEY|TOKEN|SECRET|PASSWORD|SSH_|ANTHROPIC|OPENAI|GITHUB|AWS|^PP_|NOTE/i.test(name)).sort()));\n`);
    const names = async (extra: Record<string, string>) => {
      const run = await runTestCommand("node env.mjs", dir, { env: extra });
      expect(run.outputTail, "the probe must have run").toContain("ENV:");
      return JSON.parse(run.outputTail.split("ENV:")[1]!.split("\n")[0]!) as string[];
    };
    const forA = await names({ PROJECT_A_EXTRA_VALUE: "given to A" });
    // Nothing that looks like a secret reaches the command; only what the caller handed this one run.
    expect(forA.filter((name) => SECRET_NAME.test(name) || /NOTE/.test(name))).toEqual([]);
    for (const name of HOST_SECRETS) expect(forA).not.toContain(name);
    expect(forA).not.toContain("PROJECT_A_SECRET_NOTE");
    // What the caller hands one run is there for that run only.
    const probe = path.join(dir, "extra.mjs");
    fs.writeFileSync(probe, `console.log("EXTRA:" + (process.env.PROJECT_A_EXTRA_VALUE ?? "absent"));\n`);
    expect((await runTestCommand("node extra.mjs", dir, { env: { PROJECT_A_EXTRA_VALUE: "given to A" } })).outputTail).toContain("EXTRA:given to A");
    expect((await runTestCommand("node extra.mjs", dir, {})).outputTail).toContain("EXTRA:absent");
  }, 60_000);
});

interface Probe {
  envNames: string[];
  worktreeEnv: string;
  mainCheckoutEnv: string;
  otherProjectToken: string;
  otherProjectLedger: string;
  homeSecret: string;
  outsideWrite: string;
  mainCheckoutWrite: string;
  otherRepoWrite: string;
  network: string;
  uid: number | null;
  stray: number;
}

/**
 * One hostile test, run the way a worker's test is run: committed in the task's worktree, proposed as the
 * done-when test, and run by the gate when the person approves it (it must fail first, so it exits 1).
 * It reads, writes and connects to places that belong to other things, and reports what happened.
 */
async function runHostileTest() {
  vi.stubEnv("ANTHROPIC_API_KEY", "fake-value-for-anthropic");
  vi.stubEnv("GITHUB_TOKEN", "fake-value-for-github");
  const { ctx, alpha, beta } = await twoProjects();
  const a = await dispatch(ctx, alpha);
  const b = await dispatch(ctx, beta);
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-iso-hostile-")));
  track(() => fs.rmSync(scratch, { recursive: true, force: true }));
  // A stand-in for "the home folder" and "somewhere else on the computer", with a fake key file in it.
  const fakeHome = path.join(scratch, "home");
  fs.mkdirSync(path.join(fakeHome, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".ssh", "id_fake"), "FAKE-PRIVATE-KEY-MARKER\n");
  fs.mkdirSync(path.join(scratch, "elsewhere"));
  // A listening socket: any host the test could reach, including another project's bridge.
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  track(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as net.AddressInfo).port;
  const betaLedger = path.join(ctx.host.project(beta.key).root, ".perfect-planner", "ledger");
  const betaMonth = path.join(betaLedger, fs.readdirSync(betaLedger).find((name) => name.endsWith(".jsonl"))!);
  const script = [
    'import fs from "node:fs";',
    'import net from "node:net";',
    'import path from "node:path";',
    'import { spawn } from "node:child_process";',
    "const r = {};",
    'const read = (name, file) => { try { r[name] = fs.readFileSync(file, "utf8").slice(0, 40); } catch (error) { r[name] = "BLOCKED:" + error.code; } };',
    'const write = (name, file) => { try { fs.writeFileSync(file, "written by the test"); r[name] = "WROTE"; } catch (error) { r[name] = "BLOCKED:" + error.code; } };',
    'r.envNames = Object.keys(process.env).filter((name) => /KEY|TOKEN|SECRET|PASSWORD|SSH_|ANTHROPIC|OPENAI|GITHUB|AWS|^PP_/i.test(name));',
    'read("worktreeEnv", ".env");',
    'read("mainCheckoutEnv", path.resolve("..", "..", "..", ".env"));',
    `read("otherProjectToken", ${JSON.stringify(b.tokenFile)});`,
    `read("otherProjectLedger", ${JSON.stringify(betaMonth)});`,
    `read("homeSecret", ${JSON.stringify(path.join(fakeHome, ".ssh", "id_fake"))});`,
    `write("outsideWrite", ${JSON.stringify(path.join(scratch, "elsewhere", "marker.txt"))});`,
    'write("mainCheckoutWrite", path.resolve("..", "..", "..", "WRITTEN-BY-THE-TEST.txt"));',
    `write("otherRepoWrite", ${JSON.stringify(path.join(beta.repo, "WRITTEN-BY-ALPHAS-TEST.txt"))});`,
    "r.uid = typeof process.getuid === 'function' ? process.getuid() : null;",
    'const stray = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: "ignore" });',
    "stray.unref();",
    "r.stray = stray.pid;",
    `await new Promise((resolve) => { const socket = net.connect(${port}, "127.0.0.1"); socket.on("connect", () => { r.network = "CONNECTED"; socket.destroy(); resolve(); }); socket.on("error", (error) => { r.network = "BLOCKED:" + error.code; resolve(); }); });`,
    'console.log("PROBE:" + JSON.stringify(r));',
    "process.exit(1);",
    "",
  ].join("\n");
  fs.mkdirSync(path.join(a.worktree, "tests"), { recursive: true });
  fs.writeFileSync(path.join(a.worktree, "tests", "hostile.mjs"), script);
  git(a.worktree, "add", "-A");
  git(a.worktree, "commit", "-q", "-m", "A test that goes looking");
  const defined = await hostCall(ctx.base, "POST", `/tasks/T-1/test?project=${alpha.key}`, { command: "node tests/hostile.mjs", files: ["tests/hostile.mjs"] });
  expect(defined.status, JSON.stringify(defined.body)).toBe(200);
  const approved = await hostCall(ctx.base, "POST", `/tasks/T-1/approve-test?project=${alpha.key}`, { test: defined.body.result.tasks[0].test.entry });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const output = String(approved.body.result.output ?? "");
  expect(output, "the hostile test must have run to its end").toContain("PROBE:");
  const probe = JSON.parse(output.split("PROBE:")[1]!.split("\n")[0]!) as Probe;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const strayAlive = alive(probe.stray);
  // Never leave the stray process behind.
  try {
    process.kill(probe.stray, "SIGKILL");
  } catch {
    // already gone
  }
  const ownUid = typeof process.getuid === "function" ? process.getuid() : null;
  const written = {
    mainCheckout: fs.existsSync(path.join(alpha.repo, "WRITTEN-BY-THE-TEST.txt")),
    otherRepo: fs.existsSync(path.join(beta.repo, "WRITTEN-BY-ALPHAS-TEST.txt")),
    outside: fs.existsSync(path.join(scratch, "elsewhere", "marker.txt")),
  };
  await cleanAll();
  vi.unstubAllEnvs();
  return { probe, strayAlive, ownUid, written };
}

describe("the hostile test, run by the gate in project A's worktree", () => {
  let result: Awaited<ReturnType<typeof runHostileTest>>;
  beforeAll(async () => {
    result = await runHostileTest();
  }, 120_000);
  afterAll(async () => {
    await cleanAll();
    vi.unstubAllEnvs();
  });

  describe("enforced", () => {
    it("the test sees none of the host's secrets in its environment", () => {
      expect(result.probe.envNames).toEqual([]);
    });

    it("the worktree's own .env holds placeholders, not the project's real values", () => {
      expect(result.probe.worktreeEnv).toBe("API_KEY=PLACEHOLDER\nPORT=3000\n");
    });
  });

  // Not enforced. Each test states the safe outcome and fails today (it.fails). The probe's own report
  // shows what the test could do; the assertion is what a sandbox would have to make true.
  describe("not enforced (known gaps, step B)", () => {
    it.fails("known gap: the test cannot read the project's real .env in the main checkout (../../../.env)", () => {
      expect(result.probe.mainCheckoutEnv).toMatch(/^BLOCKED/);
    });

    it.fails("known gap: the test cannot read another project's worker token file", () => {
      expect(result.probe.otherProjectToken).toMatch(/^BLOCKED/);
    });

    it.fails("known gap: the test cannot read another project's ledger in the app's data folder", () => {
      expect(result.probe.otherProjectLedger).toMatch(/^BLOCKED/);
    });

    it.fails("known gap: the test cannot read files in the user's home folder (a stand-in ~/.ssh)", () => {
      expect(result.probe.homeSecret).toMatch(/^BLOCKED/);
    });

    it.fails("known gap: the test cannot write outside its worktree", () => {
      expect(result.probe.outsideWrite).toMatch(/^BLOCKED/);
      expect(result.written.outside).toBe(false);
    });

    it.fails("known gap: the test cannot write into its own project's main checkout, skipping the diff review", () => {
      expect(result.probe.mainCheckoutWrite).toMatch(/^BLOCKED/);
      expect(result.written.mainCheckout).toBe(false);
    });

    it.fails("known gap: the test cannot write into another project's git folder", () => {
      expect(result.probe.otherRepoWrite).toMatch(/^BLOCKED/);
      expect(result.written.otherRepo).toBe(false);
    });

    it.fails("known gap: the test cannot open a network connection (no network by default)", () => {
      expect(result.probe.network).toMatch(/^BLOCKED/);
    });

    gapOnPosix("known gap: the test runs as a different, limited OS user", () => {
      expect(result.probe.uid).not.toBeNull();
      expect(result.probe.uid).not.toBe(result.ownUid);
    });

    gapOnPosix("known gap: a process the test left running is stopped when the check ends", () => {
      expect(result.strayAlive).toBe(false);
    });
  });
});
