import { describe, expect, it } from "vitest";
import { scanDiff } from "./hooks/secret-scan.mjs";
import { placeholderSecrets } from "./settings";

describe("secret scan", () => {
  it("flags added lines only, with file and line, and never echoes the secret", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,0 +4,2 @@",
      "+const ok = 1;",
      `+const token = "ghp_${"x".repeat(36)}";`,
      "@@ -10 +12 @@",
      `-const old = "AKIA${"B".repeat(16)}";`,
      "+const fine = 2;",
    ].join("\r\n");
    expect(scanDiff(diff)).toEqual([{ file: "src/a.ts", line: 5, rule: "github-token" }]);
  });

  it("catches .env style secrets and private keys but not placeholders", () => {
    const diff = ["+++ b/.env", "@@ -0,0 +1,3 @@", "+STRIPE_SECRET=abcdefghijklmnopqrstu", "+API_KEY=PLACEHOLDER", "+-----BEGIN OPENSSH PRIVATE KEY-----"].join("\n");
    expect(scanDiff(diff).map((finding) => finding.rule)).toEqual(["environment-secret", "private-key"]);
  });
});

describe("placeholderSecrets", () => {
  it("swaps secret values, keeps the rest, keeps line endings", () => {
    expect(placeholderSecrets("# comment\nexport GITHUB_TOKEN=abc\nPORT=1\nEMPTY_KEY=\r\nAuth.Header = xyz\n")).toBe(
      "# comment\nexport GITHUB_TOKEN=PLACEHOLDER\nPORT=1\nEMPTY_KEY=\r\nAuth.Header = PLACEHOLDER\n",
    );
  });
});
