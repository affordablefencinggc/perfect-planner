import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore, Ledger, MemoryKeyProvider } from "./index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-ignore-")));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function write(projectRoot: string): void {
  const ledger = Ledger.openSync(new FileStore(projectRoot), { keys: new MemoryKeyProvider() });
  ledger.append({ actor: { kind: "agent", id: "claude-code", model: "x" }, type: "task.progress", subject: "T-1", summary: "Working" });
  ledger.close();
}

const exclude = (root: string) => fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8").split(/\r?\n/);
const status = (root: string) => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });

describe("the ledger folder stays out of the user's commits", () => {
  it("adds /.perfect-planner/ to .git/info/exclude when it creates the ledger, once", () => {
    const root = repo();
    write(root);
    write(root);
    expect(exclude(root).filter((line) => line === "/.perfect-planner/")).toHaveLength(1);
    expect(status(root)).not.toContain(".perfect-planner");
    execFileSync("git", ["add", "-A"], { cwd: root });
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" })).toBe("");
  });

  it("anchors the line at a project folder inside the repo", () => {
    const root = repo();
    const project = path.join(root, "apps", "web");
    fs.mkdirSync(project, { recursive: true });
    write(project);
    expect(exclude(root)).toContain("/apps/web/.perfect-planner/");
    expect(status(root)).not.toContain(".perfect-planner");
  });

  it("does not add the line twice when core/worktrees already wrote it", () => {
    const root = repo();
    fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "/.perfect-planner/\n");
    write(root);
    expect(exclude(root).filter((line) => line === "/.perfect-planner/")).toHaveLength(1);
  });

  it("does nothing outside a git repo", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-ignore-plain-"));
    roots.push(root);
    write(root);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".perfect-planner", "ledger"))).toBe(true);
  });
});
