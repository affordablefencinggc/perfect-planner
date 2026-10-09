import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import { DEFAULT_PRE_PUSH_SCRIPT, PRE_PUSH_HOOK_FILES, prePushScanWanted, protectProject, setPrePushScan } from "./protect";
import { prePushInstalled } from "./layers";
import type { CommandRunner } from "./types";

const owner = { kind: "person" as const, id: "owner" };
const agent = { kind: "agent" as const, id: "claude-code", model: "m1" };
const system = { kind: "system" as const, id: "host" };
const NOW = new Date("2026-10-09T00:00:00Z");

const run: CommandRunner = async (command, args, options) => {
  try {
    return { code: 0, stdout: execFileSync(command, args as string[], { cwd: options?.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (error) {
    return { code: 1, stdout: "", stderr: String(error) };
  }
};

function open(): Ledger {
  const ledger = Ledger.openSync(new MemoryStore(), { now: () => NOW });
  installNumberingRules(ledger);
  return ledger;
}

function withRepo(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-protect-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("protectProject: shipping safety is on by default", () => {
  it("ships the pre-push scan script it points the hook at", () => {
    expect(existsSync(DEFAULT_PRE_PUSH_SCRIPT)).toBe(true);
  });

  it("lists every file the hook needs: itself plus everything it imports relatively, transitively", () => {
    const dir = join(DEFAULT_PRE_PUSH_SCRIPT, "..");
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(dir, file), "utf8");
      for (const m of text.matchAll(/(?:^|\n)\s*import[^"']*["']\.\/([^"']+)["']/g)) visit(m[1]!);
    };
    visit("pre-push.mjs");
    expect([...seen].sort()).toEqual([...PRE_PUSH_HOOK_FILES].sort());
  });

  it("installs the release rules and the pre-push scan when a project opens", withRepo(async (dir) => {
    const ledger = open();
    const report = await protectProject(ledger, { run, cwd: dir, now: () => NOW });
    expect(report.rules).toBe("on");
    expect(report.prePush.state).toBe("installed");
    expect(await prePushInstalled(run, { cwd: dir })).toBe(true);
    expect(readFileSync(join(dir, ".git", "hooks", "pre-push"), "utf8")).toContain(DEFAULT_PRE_PUSH_SCRIPT.replace(/\\/g, "/"));
    // The rules are live before any review has run: only a person may change settings.
    expect(() =>
      appendNumbered(ledger, { actor: system, type: "decision.made", summary: "cheap", reason: "x", evidence: [], refs: [], data: { topic: "review-preset", preset: "cheap" } }),
    ).toThrow(/Only a person/);
  }));

  it("opts out of the pre-push scan only on a person's decision, and removes only its own hook", withRepo(async (dir) => {
    const ledger = open();
    await protectProject(ledger, { run, cwd: dir });
    expect(() => setPrePushScan(ledger, agent, false, "slow")).toThrow(/Only a person/);
    expect(() =>
      appendNumbered(ledger, { actor: system, type: "decision.made", summary: "off", reason: "x", evidence: [], refs: [], data: { topic: "release-safety", prePush: false } }),
    ).toThrow(/Only a person/);
    expect(prePushScanWanted(ledger.entries())).toBe(true);

    setPrePushScan(ledger, owner, false, "we run our own scanner");
    expect(prePushScanWanted(ledger.entries())).toBe(false);
    const off = await protectProject(ledger, { run, cwd: dir });
    expect(off.prePush.state).toBe("opted-out");
    expect(off.rules).toBe("on"); // the rules are not part of the opt-out
    expect(await prePushInstalled(run, { cwd: dir })).toBe(false);

    setPrePushScan(ledger, owner, true, "back on");
    expect((await protectProject(ledger, { run, cwd: dir })).prePush.state).toBe("installed");
  }));

  it("ignores an opt-out a non-person wrote before the rule was installed", withRepo(async (dir) => {
    const ledger = open();
    appendNumbered(ledger, { actor: system, type: "decision.made", summary: "off", reason: "x", evidence: [], refs: [], data: { topic: "release-safety", prePush: false } });
    expect(prePushScanWanted(ledger.entries())).toBe(true);
    expect((await protectProject(ledger, { run, cwd: dir })).prePush.state).toBe("installed");
  }));

  it("rewrites its own hook on open when the Node or script path changed, so pushes never fail on a stale path", withRepo(async (dir) => {
    const hook = join(dir, ".git", "hooks", "pre-push");
    const ledger = open();
    await protectProject(ledger, { run, cwd: dir });
    const fresh = readFileSync(hook, "utf8");
    // The shim an older app version wrote: same mark, a Node that no longer exists.
    writeFileSync(hook, fresh.replace(/exec '[^']*'/, "exec '/old/app/node'"));
    const report = await protectProject(ledger, { run, cwd: dir });
    expect(report.prePush.state).toBe("installed");
    expect(readFileSync(hook, "utf8")).toBe(fresh);
  }));

  it("leaves someone else's hook alone and says so", withRepo(async (dir) => {
    const hook = join(dir, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\necho mine\n");
    const ledger = open();
    const report = await protectProject(ledger, { run, cwd: dir });
    expect(report.prePush.state).toBe("foreign-hook");
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho mine\n");
    setPrePushScan(ledger, owner, false, "x");
    await protectProject(ledger, { run, cwd: dir });
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho mine\n");
  }));

  it("still installs the rules when the folder is not a git repository, and says the hook could not go in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-protect-norepo-"));
    try {
      const ledger = open();
      const report = await protectProject(ledger, { run, cwd: dir });
      expect(report.rules).toBe("on");
      expect(report.prePush.state).toBe("not-a-repo");
      expect(report.prePush.reason).toMatch(/not a git repository/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
