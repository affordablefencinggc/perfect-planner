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
    const diff = ["+++ b/.env", "@@ -0,0 +1,3 @@", "+STRIPE_SECRET=abcdefghijklmnopqrstu", "+API_KEY=PLACEHOLDER", `+-----BEGIN OPENSSH ${"PRIVATE"} KEY-----`].join("\n");
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

describe("placeholderSecrets on values whose names give nothing away", () => {
  it("replaces every value except plainly safe settings", () => {
    const pass = ["hunter2", "hunter2"].join("");
    const input = [
      "PORT=3000",
      "NODE_ENV=development",
      "DB_HOST=localhost",
      `DATABASE_URL=postgres://app:${pass}@localhost:5432/app`,
      `REDIS_URL="redis://:${pass}@cache:6379"`,
      `DB_PASS=${pass}`,
      "STRIPE=" + ["rk", "live", "a".repeat(24)].join("_"),
      "WEBHOOK=https://hooks.example.invalid/T000/B000/" + "x".repeat(24),
      "FEATURE_X_ENABLED=true",
      "API_HOST=" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4",
      "MYSTERY=anything",
    ].join("\n");
    expect(placeholderSecrets(input).split("\n")).toEqual([
      "PORT=3000",
      "NODE_ENV=development",
      "DB_HOST=localhost",
      "DATABASE_URL=PLACEHOLDER",
      "REDIS_URL=PLACEHOLDER",
      "DB_PASS=PLACEHOLDER",
      "STRIPE=PLACEHOLDER",
      "WEBHOOK=PLACEHOLDER",
      "FEATURE_X_ENABLED=true",
      "API_HOST=PLACEHOLDER",
      "MYSTERY=PLACEHOLDER",
    ]);
  });
});
