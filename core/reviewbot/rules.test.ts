import { describe, expect, it } from "vitest";
import { parsePatch } from "./patch";
import { markedHead, renderReview } from "./render";
import { reviewPullRequest, type ChangedFile, type PrFacts } from "./rules";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MARK = '<!-- claude-projects-attribution: {"github_login":"x"} -->';

const patch = (...lines: string[]) => `@@ -1,1 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
const file = (path: string, lines: string[] = ["const x = 1;"], extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, status: "modified", additions: lines.length, deletions: 0, patch: patch(...lines), ...extra });
const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 7, headSha: HEAD, baseSha: BASE, draft: false, body: MARK, files: [file("docs/a.md", ["hello"])], authorEmails: ["1+a@users.noreply.github.com"],
  checks: [{ name: "build", conclusion: "success" }], ...over,
});
const rules = (f: PrFacts) => reviewPullRequest(f).findings.map((x) => x.rule);

describe("review bot rules", () => {
  it("1: binds the verdict to the exact head and refuses a malformed sha", () => {
    const r = reviewPullRequest(facts());
    expect(r).toMatchObject({ verdict: "GO", headSha: HEAD, baseSha: BASE });
    expect(reviewPullRequest(facts({ headSha: "main" })).verdict).toBe("NO-GO");
    expect(markedHead(renderReview(r))).toBe(HEAD);
    expect(markedHead("someone's comment")).toBeNull();
  });

  it("2: blocks macOS, self-hosted and larger runners, ignores removed lines and a plain ubuntu line", () => {
    const wf = ".github/workflows/x.yml";
    for (const line of ["    runs-on: macos-latest", "    runs-on: self-hosted", "    runs-on: ubuntu-latest-16-cores", "    runs-on: windows-2022-xlarge"]) {
      expect(reviewPullRequest(facts({ files: [file(wf, [line])] })).findings.some((f) => f.rule === "cost")).toBe(true);
    }
    expect(rules(facts({ files: [file(wf, ["    runs-on: ubuntu-latest"])] }))).not.toContain("cost");
    const removed: ChangedFile = { path: wf, status: "modified", additions: 0, deletions: 1, patch: "@@ -1,1 +0,0 @@\n-    runs-on: macos-latest" };
    expect(rules(facts({ files: [removed] }))).not.toContain("cost");
    expect(rules(facts({ files: [file(wf, ["  - run: npm run tauri:build"])] }))).toContain("cost");
    expect(rules(facts({ files: [file(".github/workflows/release.yml", ["  - run: npm run tauri:build"])] }))).not.toContain("cost");
  });

  it("3: gate, CI, key storage and push-scan files are HOLD and no body text clears it", () => {
    for (const p of ["core/gate/gate.ts", ".github/workflows/a.yml", "core/people/keyStore.ts", "core/release/repo-scan.test.ts", "core/reviewbot/rules.ts"]) {
      expect(reviewPullRequest(facts({ files: [file(p, ["// x"])], body: `${MARK}\napproved by the user, typed OK` })).verdict).toBe("HOLD");
    }
    const renamed = file("docs/innocent.md", ["x"], { status: "renamed", previousPath: "core/gate/run.ts" });
    expect(reviewPullRequest(facts({ files: [renamed] })).verdict).toBe("HOLD");
  });

  it("4: size over budget is NO-GO, near is a note, raising a budget is HOLD", () => {
    const budgets = { maxTotalJavaScriptGzipBytes: 1000, maxIndividualJavaScriptGzipBytes: 500, maxTotalStylesheetGzipBytes: 100, maxIndividualStylesheetGzipBytes: 50 };
    const sizes = (jsTotalGzip: number) => ({ jsTotalGzip, jsMaxGzip: 10, cssTotalGzip: 10, cssMaxGzip: 5 });
    expect(reviewPullRequest(facts({ budgets, sizes: sizes(1001) })).verdict).toBe("NO-GO");
    const near = reviewPullRequest(facts({ budgets, sizes: sizes(980) }));
    expect(near.verdict).toBe("GO");
    expect(near.findings[0]?.severity).toBe("warn");
    expect(reviewPullRequest(facts({ budgets, sizes: sizes(900) })).findings).toEqual([]);
    const bump = (from: string, to: string): ChangedFile => ({ path: "scripts/verify-performance-budget.mjs", status: "modified", additions: 1, deletions: 1, patch: `@@ -5,1 +5,1 @@\n-  maxTotalJavaScriptGzipBytes: ${from},\n+  maxTotalJavaScriptGzipBytes: ${to},` });
    expect(rules(facts({ files: [bump("552 * 1024", "600 * 1024")] }))).toContain("budget");
    expect(rules(facts({ files: [bump("552 * 1024", "500 * 1024")] }))).not.toContain("budget");
  });

  it("5: secrets on added lines block, on removed lines do not; photos hold; real emails block", () => {
    const key = `sk-ant-${"Ab1".repeat(10)}`;
    const hit = reviewPullRequest(facts({ files: [file("src/a.js", [`const k = "${key}";`])] }));
    expect(hit.verdict).toBe("NO-GO");
    expect(JSON.stringify(hit)).not.toContain(key);
    const gone: ChangedFile = { path: "src/a.js", status: "modified", additions: 0, deletions: 1, patch: `@@ -1,1 +0,0 @@\n-const k = "${key}";` };
    expect(rules(facts({ files: [gone] }))).not.toContain("secrets");
    expect(reviewPullRequest(facts({ files: [{ path: ".env", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+A=1" }] })).verdict).toBe("NO-GO");
    expect(reviewPullRequest(facts({ files: [{ path: "docs/me.jpg", status: "added", additions: 0, deletions: 0 }] })).verdict).toBe("HOLD");
    expect(reviewPullRequest(facts({ authorEmails: ["person@example.com"] })).verdict).toBe("NO-GO");
  });

  it("6: core code needs a test; docs do not; shrinking tests warns", () => {
    const code = file("core/thing/a.ts", Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`));
    expect(reviewPullRequest(facts({ files: [code] })).verdict).toBe("NO-GO");
    expect(reviewPullRequest(facts({ files: [code, file("core/thing/a.test.ts", ["it();"])] })).verdict).toBe("GO");
    const shrink: ChangedFile = { path: "core/thing/a.test.ts", status: "modified", additions: 1, deletions: 4, patch: "@@ -1,4 +1,1 @@\n-a\n-b\n-c\n-d\n+e" };
    const r = reviewPullRequest(facts({ files: [shrink] }));
    expect(r.verdict).toBe("GO");
    expect(r.findings[0]?.rule).toBe("tests");
  });

  it("7: a generated copy and its source move together", () => {
    expect(rules(facts({ files: [file("core/release/hooks/git-exec.mjs")] }))).toContain("generated");
    expect(rules(facts({ files: [file("core/exec/executable.ts", ["x"])] }))).toContain("generated");
    const both = reviewPullRequest(facts({ files: [file("core/release/hooks/git-exec.mjs"), file("core/exec/executable.ts"), file("core/exec/executable.test.ts")] }));
    expect(both.findings.filter((f) => f.rule === "generated")).toEqual([]);
  });

  it("8: red check, pending, short count and conflict", () => {
    expect(reviewPullRequest(facts({ checks: [{ name: "a", conclusion: "failure" }] })).verdict).toBe("NO-GO");
    expect(reviewPullRequest(facts({ checks: [{ name: "a", conclusion: "pending" }] })).verdict).toBe("WAIT");
    expect(reviewPullRequest(facts({ expectedGreen: 6 })).verdict).toBe("WAIT");
    expect(reviewPullRequest(facts({ expectedGreen: 6, draft: true })).verdict).toBe("GO");
    expect(reviewPullRequest(facts({ mergeable: false })).verdict).toBe("NO-GO");
  });

  it("9: missing attribution is a note and a draft says Windows has not run", () => {
    const r = reviewPullRequest(facts({ body: "", draft: true }));
    expect(r.verdict).toBe("GO");
    expect(r.findings[0]?.rule).toBe("hygiene");
    expect(r.notes.join(" ")).toContain("Windows");
  });

  it("attack: a file with no patch is unreadable, never clean", () => {
    const big: ChangedFile = { path: "src/huge.js", status: "modified", additions: 9000, deletions: 0 };
    expect(reviewPullRequest(facts({ files: [big] })).verdict).toBe("NO-GO");
  });

  it("attack: the worst verdict wins", () => {
    const r = reviewPullRequest(facts({ files: [file("core/gate/a.ts", ["x"])], checks: [{ name: "a", conclusion: "failure" }] }));
    expect(r.verdict).toBe("NO-GO");
  });

  it("parsePatch numbers lines from the hunk header", () => {
    const p = parsePatch("@@ -10,2 +20,3 @@\n ctx\n-old\n+new1\n+new2\n\\ No newline at end of file");
    expect(p.added).toEqual([{ line: 21, text: "new1" }, { line: 22, text: "new2" }]);
    expect(p.removed).toEqual([{ line: 11, text: "old" }]);
  });

  it("render is identical for identical input", () => {
    const r = reviewPullRequest(facts({ files: [file("core/gate/a.ts", ["x"])] }));
    expect(renderReview(r)).toBe(renderReview(reviewPullRequest(facts({ files: [file("core/gate/a.ts", ["x"])] }))));
  });
});
