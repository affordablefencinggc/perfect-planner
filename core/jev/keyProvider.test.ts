import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KEYCHAIN_SERVICE, createOsKeyProvider, windowsScript, type RunResult, type Runner } from "./index";

const KEY = "ts_live_FAKE0123456789abcdef";

interface Call {
  command: string;
  args: string[];
  stdin?: string;
}

function fakeRunner(answer: (call: Call) => Partial<RunResult>): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (command, args, stdin) => {
    const call = { command, args, ...(stdin !== undefined ? { stdin } : {}) };
    calls.push(call);
    return { code: 0, stdout: "", stderr: "", ...answer(call) };
  };
  return { run, calls };
}

function decodeScript(args: string[]): string {
  return Buffer.from(args[args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
}

describe("Windows Credential Manager provider", () => {
  it("reads PR #2's credential through PowerShell, with the key only on stdout", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: Buffer.from(KEY, "utf8").toString("base64") }));
    const key = await createOsKeyProvider({ platform: "win32", run }).read();
    expect(key?.reveal()).toBe(KEY);
    // Started by its full system path, never as a bare "powershell.exe" Windows would look for in the current folder first.
    expect(calls[0]!.command).toMatch(/^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    const script = decodeScript(calls[0]!.args);
    expect(script).toContain("$t='PerfectPlanner/JevReviewerKey'");
    expect(script).toContain("CredReadW");
  });

  it("saves with the key on stdin, never on the command line", async () => {
    const { run, calls } = fakeRunner(() => ({}));
    const status = await createOsKeyProvider({ platform: "win32", run }).save(`  ${KEY}  `);
    expect(status).toEqual({ available: true, stored: true, store: "windows-credential-manager" });
    expect(calls[0]!.stdin).toBe(KEY);
    expect(calls.every((c) => !c.args.join(" ").includes(KEY) && !decodeScript(c.args).includes(KEY))).toBe(true);
    expect(decodeScript(calls[0]!.args)).toContain("UserName='jev'");
  });

  it("reports not stored, and quotes the target safely", async () => {
    const { run } = fakeRunner(() => ({ code: 2 }));
    const provider = createOsKeyProvider({ platform: "win32", run });
    expect(await provider.status()).toEqual({ available: true, stored: false, store: "windows-credential-manager" });
    expect(await provider.read()).toBeNull();
    expect(windowsScript("status", "a'b")).toContain("$t='a''b'");
  });

  it("is unavailable when PowerShell is missing", async () => {
    const { run } = fakeRunner(() => ({ code: null, missing: true }));
    expect(await createOsKeyProvider({ platform: "win32", run }).status()).toMatchObject({ available: false, store: "unavailable" });
  });
});

describe("macOS keychain provider", () => {
  it("reads the generic password for service and account", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: `${KEY}\n` }));
    expect((await createOsKeyProvider({ platform: "darwin", run }).read())?.reveal()).toBe(KEY);
    expect(calls[0]).toEqual({ command: "/usr/bin/security", args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "jev", "-w"] });
  });

  it("saves through interactive mode so the key stays off the command line", async () => {
    const { run, calls } = fakeRunner(() => ({}));
    await createOsKeyProvider({ platform: "darwin", run }).save('ab"c\\d-key-value');
    const save = calls[0]!;
    expect(save.args).toEqual(["-i"]);
    expect(save.stdin).toContain('-w "ab\\"c\\\\d-key-value"');
  });

  it("treats exit 44 as not stored", async () => {
    const { run } = fakeRunner(() => ({ code: 44 }));
    const provider = createOsKeyProvider({ platform: "darwin", run });
    expect(await provider.status()).toMatchObject({ available: true, stored: false });
    expect(await provider.read()).toBeNull();
  });
});

describe("Linux Secret Service provider", () => {
  it("looks up and stores with secret-tool, the key on stdin", async () => {
    const { run, calls } = fakeRunner((c) => (c.args[0] === "lookup" ? { stdout: KEY } : {}));
    const provider = createOsKeyProvider({ platform: "linux", locate: () => "/usr/bin/secret-tool", run });
    expect((await provider.read())?.reveal()).toBe(KEY);
    await provider.save(KEY);
    expect(calls[0]).toEqual({ command: "/usr/bin/secret-tool", args: ["lookup", "service", KEYCHAIN_SERVICE, "account", "jev"] });
    expect(calls[1]).toMatchObject({ command: "/usr/bin/secret-tool", args: ["store", "--label=Perfect Planner Jev key", "service", KEYCHAIN_SERVICE, "account", "jev"], stdin: KEY });
  });

  it("tells not-stored apart from no Secret Service", async () => {
    expect(await createOsKeyProvider({ platform: "linux", locate: () => "/usr/bin/secret-tool", run: fakeRunner(() => ({ code: 1 })).run }).status()).toMatchObject({ available: true, stored: false });
    expect(await createOsKeyProvider({ platform: "linux", locate: () => "/usr/bin/secret-tool", run: fakeRunner(() => ({ code: 1, stderr: "Cannot autolaunch D-Bus" })).run }).status()).toMatchObject({ available: false });
    expect(await createOsKeyProvider({ platform: "linux", locate: () => "/usr/bin/secret-tool", run: fakeRunner(() => ({ code: null, missing: true })).run }).status()).toMatchObject({ available: false, detail: expect.stringContaining("secret-tool") });
  });
});

describe("other platforms", () => {
  it("has no store and refuses to save", async () => {
    const provider = createOsKeyProvider({ platform: "aix" });
    expect(await provider.status()).toMatchObject({ available: false });
    await expect(provider.save(KEY)).rejects.toThrow(/aix/);
  });
});

// A real round trip against this machine's store, on CI only, using a
// throwaway entry so the user's real key is never touched. Linux runners have
// no Secret Service running, so Linux is covered by the fake runner above.
const live = Boolean(process.env.CI) && (process.platform === "win32" || process.platform === "darwin");

describe.runIf(live)(`live ${process.platform} key store`, () => {
  it("saves, reads back, and clears a throwaway key", async () => {
    const provider = createOsKeyProvider({ service: `PerfectPlanner/JevReviewerKey-ci-${randomBytes(4).toString("hex")}` });
    const secret = `ci-${randomBytes(12).toString("hex")}`;
    try {
      expect((await provider.status()).stored).toBe(false);
      expect((await provider.save(secret)).stored).toBe(true);
      expect((await provider.read())?.reveal()).toBe(secret);
    } finally {
      expect((await provider.clear()).stored).toBe(false);
    }
  }, 60_000);
});

describe("key-store helpers are started by full path", () => {
  it("uses /usr/bin/security on macOS", async () => {
    const { run, calls } = fakeRunner(() => ({ code: 44 }));
    await createOsKeyProvider({ platform: "darwin", run }).status();
    expect(calls[0]!.command).toBe("/usr/bin/security");
  });

  it("starts nothing when the helper cannot be found, rather than falling back to a bare name", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: KEY }));
    const provider = createOsKeyProvider({ platform: "linux", locate: () => null, run });
    expect(await provider.status()).toMatchObject({ available: false, detail: expect.stringContaining("secret-tool") });
    expect(await provider.read()).toBeNull();
    expect(calls).toEqual([]);
  });
});
