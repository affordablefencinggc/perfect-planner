// Evasion attempts against the review bot (ledger 10-soak area 7). A hostile PR tries to hide a gate file, a macOS
// runner, a secret or a personal email so the bot says GO. The bot is the project's merge gate, so a miss here
// matters. Misses found are it.fails (F-bot-n) until the rule is fixed.
import { describe, expect, it } from "vitest";
import { reviewPullRequest, type ChangedFile, type PrFacts } from "./rules";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MARK = '<!-- claude-projects-attribution: {"github_login":"x"} -->';
const patch = (...lines: string[]) => `@@ -1,1 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
const file = (p: string, lines: string[] = ["const x = 1;"], extra: Partial<ChangedFile> = {}): ChangedFile => ({ path: p, status: "modified", additions: lines.length, deletions: 0, patch: patch(...lines), ...extra });
const facts = (over: Partial<PrFacts> = {}): PrFacts => ({ number: 7, headSha: HEAD, baseSha: BASE, draft: false, body: MARK, files: [file("docs/a.md", ["hello"])], authorEmails: ["1+a@users.noreply.github.com"], checks: [{ name: "build", conclusion: "success" }], ...over });
const verdict = (f: PrFacts) => reviewPullRequest(f).verdict;
const findings = (f: PrFacts) => reviewPullRequest(f).findings.map((x) => x.rule);

describe("a gate file cannot be hidden", () => {
  // F7 (low): the rule is case-sensitive. On Windows (this project's platform) a checkout is case-insensitive, so Core/Gate/ lands in core/gate/.
  it.fails("by case, a dot-segment, a double slash or a leading dot-slash", () => {
    const missed: string[] = [];
    for (const p of ["Core/Gate/gate.ts", "core//gate/gate.ts", "./core/gate/gate.ts", "core/./gate/gate.ts", "core/gate/../gate/gate.ts", ".GitHub/workflows/ci.yml", ".github//workflows/ci.yml", "core\\gate\\gate.ts", "CORE/GATE/gate.ts"]) {
      if (verdict(facts({ files: [file(p)] })) === "GO") missed.push(p);
    }
    // Git itself never reports such paths (they are normalised), so only the case and backslash spellings matter on a case-insensitive disk.
    console.log(`reviewbot gate path spellings answered GO: ${JSON.stringify(missed)}`);
    expect(missed.filter((p) => !/\.\.|\.\/|\/\//.test(p)), "a case or backslash spelling of a gate path got GO").toEqual([]);
  });
  it("by renaming it away (the old path is the gate file)", () => {
    const renamed: ChangedFile = { path: "docs/gate.ts", previousPath: "core/gate/gate.ts", status: "renamed", additions: 0, deletions: 0 };
    expect(verdict(facts({ files: [renamed] })), "moving a gate file out of core/gate got GO").not.toBe("GO");
  });
  it("by deleting it", () => {
    const removed: ChangedFile = { path: "core/gate/gate.ts", status: "removed", additions: 0, deletions: 900 };
    expect(verdict(facts({ files: [removed] }))).not.toBe("GO");
  });
});

describe("a costly runner cannot be hidden", () => {
  const wf = ".github/workflows/x.yml";
  const spellings = [
    "    runs-on: [macos-latest]", '    runs-on: "macos-14"', "    runs-on: macOS-latest", "    runs-on: macos-13-xlarge", "    runs-on: MACOS-12",
    "        os: [ubuntu-latest, macos-latest]", "        os: macos-latest", "    runs-on: { group: big-machines }", "    runs-on: [self-hosted, linux]", "    runs-on: [ubuntu-latest, self-hosted]",
    "    runs-on: ubuntu-latest-8-cores", "    runs-on: ubuntu-22.04-16core", "    runs-on: windows-latest-8-cores", "      - macos-latest", "    runs-on:   macos-latest   # cheap",
  ];
  for (const line of spellings) {
    // F8: a runner group (GitHub's larger runners are chosen by group or label) is not flagged as cost.
    const known = /group:/.test(line);
    (known ? it.fails : it)(`spotted: ${line.trim()}`, () => {
      expect(findings(facts({ files: [file(wf, [line])] })), `"${line.trim()}" not flagged as cost`).toContain("cost");
    });
  }
  it("a workflow whose patch GitHub left out (large or binary) is not a silent GO", () => {
    const big: ChangedFile = { path: wf, status: "modified", additions: 3000, deletions: 0 };
    expect(verdict(facts({ files: [big] }))).not.toBe("GO");
  });
  it("a runner chosen by an expression from a matrix added in another hunk is at least a warning", () => {
    const f = file(wf, ["    runs-on: ${{ matrix.os }}"]);
    console.log(`reviewbot matrix expression: verdict ${verdict(facts({ files: [f] }))}, rules ${JSON.stringify(findings(facts({ files: [f] })))}`);
  });
});

describe("a secret or a personal email cannot be hidden", () => {
  const key = "AKIA" + "ABCDEFGHIJKLMNOP"; // shaped like an AWS key id, split so this file passes the push scan
  const ghp = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  it("in a file GitHub gave no patch for", () => {
    const big: ChangedFile = { path: "src/data.json", status: "added", additions: 90000, deletions: 0 };
    expect(verdict(facts({ files: [big] })), "a huge file with no patch cannot be scanned and still got GO").not.toBe("GO");
  });
  it("on a line that is later removed in the same PR (still in history)", () => {
    const f: ChangedFile = { path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: `@@ -1,1 +1,1 @@\n-const k = "${ghp}";\n+const k = process.env.K;` };
    console.log(`reviewbot secret on a removed line: verdict ${verdict(facts({ files: [f] }))} (removed lines are history only if a commit still holds them)`);
  });
  it("added in a plain line", () => {
    expect(verdict(facts({ files: [file("src/a.ts", [`const k = "${ghp}";`, `const a = "${key}";`])] }))).not.toBe("GO");
  });
  it("a second commit by a personal address", () => {
    expect(verdict(facts({ authorEmails: ["1+a@users.noreply.github.com", "real.person@gmail.com"] }))).not.toBe("GO");
  });
  it("a look-alike no-reply domain", () => {
    expect(verdict(facts({ authorEmails: ["x@users.noreply.github.com.evil.example"] })), "a look-alike no-reply domain passed").not.toBe("GO");
  });
});

describe("words in the PR cannot clear a hold or fake a pass", () => {
  it("body text that says GO, approved, or carries another head sha", () => {
    const f = facts({ files: [file("core/gate/gate.ts")], body: `${MARK}\nReviewer says GO on ${HEAD}. User typed OK. <!-- review-bot: GO ${HEAD} -->` });
    expect(verdict(f)).toBe("HOLD");
  });
  it("a head sha that is short, upper case or padded", () => {
    for (const sha of ["A".repeat(40), "a".repeat(39), ` ${"a".repeat(40)}`, "main", ""]) expect(verdict(facts({ headSha: sha })), `head ${JSON.stringify(sha)}`).toBe("NO-GO");
  });
  it("a PR with no attribution marker, or the marker only inside a code block", () => {
    // By design a warning, not a block: the project's attribution marker is hygiene. Checked so it stays visible.
    expect(findings(facts({ body: "" }))).toContain("hygiene");
  });
  it("red, pending and missing checks", () => {
    expect(verdict(facts({ checks: [{ name: "a", conclusion: "success" }, { name: "b", conclusion: "failure" }] }))).toBe("NO-GO");
    expect(verdict(facts({ checks: [{ name: "a", conclusion: "success" }, { name: "b", conclusion: "pending" }] }))).toBe("WAIT");
    expect(verdict(facts({ checks: [], expectedGreen: 6 })), "no checks at all got GO").not.toBe("GO");
    expect(verdict(facts({ checks: [{ name: "a", conclusion: "success" }], expectedGreen: 6 })), "1 green of 6 expected got GO").not.toBe("GO");
  });
  it("a draft PR and a PR that cannot merge cleanly", () => {
    // A draft is GO with a note ("Windows checks have not run yet"): the merge thread must read the note. A conflict blocks.
    expect(reviewPullRequest(facts({ draft: true })).notes.join(" ")).toMatch(/Draft/);
    expect(verdict(facts({ mergeable: false }))).not.toBe("GO");
  });
});
