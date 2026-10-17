// Shared set-up for the isolation tests (isolation.test.ts, isolation-exec.test.ts): two projects in one
// host, each with its own git folder, the same task id T-1, and a dispatched worker on demand.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect } from "vitest";
import { appendNumbered } from "../numbering/index";
import { asPersonRequest } from "./keys";
import { hostCall, startTestHost } from "./testing";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const cleanups: (() => Promise<void> | void)[] = [];
/** Undoes everything registered with track(), newest first. */
export async function cleanAll(): Promise<void> {
  for (const clean of cleanups.splice(0).reverse()) await clean();
}
/** Call once per test file: everything registered with track() is undone after each test. */
export function cleanAfterEach(): void {
  afterEach(cleanAll);
}
export function track(clean: () => Promise<void> | void): void {
  cleanups.push(clean);
}

export function newRepo(label: string): string {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `pp-iso-${label}-`)));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "README.md"), `# ${label}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial");
  // Untracked local settings with a value that must never reach a worktree: the worktree gets a placeholder.
  fs.writeFileSync(path.join(repo, ".env"), `API_KEY=${label}-real-value\nPORT=3000\n`);
  track(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  return repo;
}

export type Ctx = Awaited<ReturnType<typeof startTestHost>>;
export interface Side {
  key: string;
  repo: string;
  /** Filled by dispatch(). */
  dispatched?: { worktree: string; tokenFile: string; token: string; bridgeUrl: string };
}
export const person = { kind: "person", id: "owner" } as const;

/** Two projects in one host, each with one task T-1 (same id on purpose) and its own git folder. */
export async function twoProjects(): Promise<{ ctx: Ctx; alpha: Side; beta: Side }> {
  const ctx = await startTestHost();
  track(() => ctx.stop());
  const sides = [] as Side[];
  for (const key of ["alpha", "beta"]) {
    const repo = newRepo(key);
    await ctx.host.openProject(key);
    asPersonRequest(() => appendNumbered(ctx.host.project(key).ledger, { actor: person, type: "task.created", summary: `Save notes (${key})`, data: { title: `Save notes (${key})` } }));
    const chose = await hostCall(ctx.base, "POST", `/tasks/repo?project=${key}`, { root: repo });
    expect(chose.status, JSON.stringify(chose.body)).toBe(200);
    sides.push({ key, repo });
  }
  return { ctx, alpha: sides[0]!, beta: sides[1]! };
}

export async function dispatch(ctx: Ctx, side: Side, task = "T-1"): Promise<NonNullable<Side["dispatched"]>> {
  const res = await hostCall(ctx.base, "POST", `/tasks/${task}/dispatch?project=${side.key}`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const d = res.body.result;
  side.dispatched = { worktree: d.worktree, tokenFile: d.tokenFile, bridgeUrl: d.bridgeUrl, token: fs.readFileSync(d.tokenFile, "utf8") };
  return side.dispatched;
}
