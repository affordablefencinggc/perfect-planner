import { afterEach, describe, expect, it } from "vitest";
import { git } from "../worktrees/git";
import { commitAll, writeFiles } from "../worktrees/testing";
import { changedFiles, normalizeFileList } from "./changes";
import { makeTaskRepo, type Fixture } from "./fixtures";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("changedFiles", { timeout: 60_000 }, () => {
  it("is empty for a fresh worktree", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    const t1 = fixture.tasks["T-1"];
    expect(await changedFiles(t1.path, t1.baseSha)).toEqual([]);
  });

  it("unions committed, staged, unstaged and untracked changes, and ignores .perfect-planner/", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    const t1 = fixture.tasks["T-1"];
    writeFiles(t1.path, { "src/committed.ts": "1\n" });
    await commitAll(t1.path, "add committed");
    writeFiles(t1.path, { "src/staged.ts": "2\n", "src/shared.ts": "changed\n", "deep/dir/untracked.txt": "3\n", ".perfect-planner/state.json": "{}" });
    await git(t1.path, ["add", "src/staged.ts"]);
    expect(await changedFiles(t1.path, t1.baseSha)).toEqual(["deep/dir/untracked.txt", "src/committed.ts", "src/shared.ts", "src/staged.ts"]);
  });

  it("counts both sides of a committed rename and of a staged rename", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    const t1 = fixture.tasks["T-1"];
    await git(t1.path, ["mv", "src/shared.ts", "src/renamed.ts"]);
    await commitAll(t1.path, "rename committed");
    expect(await changedFiles(t1.path, t1.baseSha)).toEqual(["src/renamed.ts", "src/shared.ts"]);
    await git(t1.path, ["mv", "src/other.ts", "src/moved.ts"]);
    expect(await changedFiles(t1.path, t1.baseSha)).toEqual(["src/moved.ts", "src/other.ts", "src/renamed.ts", "src/shared.ts"]);
  });

  it("reports a deleted file and dedupes a file both committed and modified", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    const t1 = fixture.tasks["T-1"];
    writeFiles(t1.path, { "src/shared.ts": "v2\n" });
    await commitAll(t1.path, "edit");
    writeFiles(t1.path, { "src/shared.ts": "v3\n" });
    await git(t1.path, ["rm", "-q", "README.md"]);
    expect(await changedFiles(t1.path, t1.baseSha)).toEqual(["README.md", "src/shared.ts"]);
  });

  it("rejects an unknown base", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    await expect(changedFiles(fixture.tasks["T-1"].path, "0".repeat(40))).rejects.toThrow();
  });
});

describe("normalizeFileList", () => {
  it("uses forward slashes, sorts and dedupes", () => {
    expect(normalizeFileList(["b\\c.ts", "./a.ts", "a.ts", "", ".perfect-planner/x", ".perfect-planner"])).toEqual(["a.ts", "b/c.ts"]);
  });
});
