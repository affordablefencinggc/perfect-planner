import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../worktrees/git";
import { commitAll, writeFiles } from "../worktrees/testing";
import { commitFiles, commitsSince, parseImplements } from "./commits";
import { makeTaskRepo, type Fixture } from "./fixtures";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("parseImplements", () => {
  it("reads the standard trailer", () => {
    expect(parseImplements("Add login\n\nImplements: P-2 §3.1 (T-14)\n")).toEqual({ refs: ["P-2 §3.1"], taskIds: ["T-14"] });
  });

  it("reads several lines, several clauses, CRLF, shorthand and odd spacing", () => {
    const body = "Subject\r\n\r\nBody text mentioning Implements in prose.\r\nImplements: P-2 §3.1, §3.2 (T-14)\r\nimplements :  P-3  §1 (T-14) ; P-4 §2.2\r\nImplements: P-2 §3.1 (T-14)\r\n";
    expect(parseImplements(body)).toEqual({ refs: ["P-2 §3.1", "P-2 §3.2", "P-3 §1", "P-4 §2.2"], taskIds: ["T-14"] });
  });

  it("reads a task id after each clause", () => {
    expect(parseImplements("Implements: P-2 §3.1 (T-14), P-5 §1 (T-15)")).toEqual({ refs: ["P-2 §3.1", "P-5 §1"], taskIds: ["T-14", "T-15"] });
  });

  it("returns nothing without a trailer", () => {
    expect(parseImplements("just a message\nImplementation notes: none")).toEqual({ refs: [], taskIds: [] });
  });
});

describe("commitsSince", { timeout: 60_000 }, () => {
  it("lists task commits oldest first with trailers, including a CRLF message", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    const t1 = fixture.tasks["T-1"];
    writeFiles(t1.path, { "a.ts": "1\n" });
    const first = await commitAll(t1.path, "first\n\nImplements: P-2 §3.1 (T-1)");
    writeFiles(t1.path, { "b.ts": "2\n" });
    await git(t1.path, ["add", "-A"]);
    const msg = path.join(path.dirname(fixture.root), "msg.txt");
    writeFileSync(msg, "second\r\n\r\nImplements: P-2 §3.2, §4 (T-1)\r\nImplements: P-7 §1 (T-1)\r\n");
    await git(t1.path, ["commit", "-q", "--cleanup=verbatim", "-F", msg]);
    const second = await git(t1.path, ["rev-parse", "HEAD"]);

    const commits = await commitsSince(t1.path, t1.baseSha);
    expect(commits.map((c) => c.sha)).toEqual([first, second]);
    expect(commits[0]).toMatchObject({ subject: "first", refs: ["P-2 §3.1"], taskIds: ["T-1"], author: "Core Test <test@example.invalid>" });
    expect(commits[1]).toMatchObject({ subject: "second", refs: ["P-2 §3.2", "P-2 §4", "P-7 §1"] });
    expect(Number.isFinite(Date.parse(commits[0].at))).toBe(true);
    expect(await commitFiles(t1.path, second)).toEqual(["b.ts"]);
  });

  it("is empty before the first commit", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    expect(await commitsSince(fixture.tasks["T-1"].path, fixture.baseSha)).toEqual([]);
  });

  it("does not report base-branch commits merged into the task", async () => {
    fixture = await makeTaskRepo(["T-1"]);
    const t1 = fixture.tasks["T-1"];
    writeFiles(t1.path, { "task.ts": "1\n" });
    const own = await commitAll(t1.path, "task work");
    writeFiles(fixture.root, { "main.ts": "1\n" });
    const mainSha = await commitAll(fixture.root, "main work");
    await git(t1.path, ["merge", "-q", "--no-edit", "main"]);
    const shas = (await commitsSince(t1.path, t1.baseSha)).map((c) => c.sha);
    expect(shas[0]).toBe(own);
    expect(shas).not.toContain(mainSha);
  });
});
