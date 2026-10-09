import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkDiff, parseDiff } from "../jev/diffChecks";
import { detectSecrets, findSecrets, redactSecrets } from "./index";

// Every fixture is glued together at run time so the repository's own secret scan stays clean.
const j = (...parts: string[]) => parts.join("");
const RANDOM = "Zq8vK2mX7pL4nR9tW3yB6cD1fG5hJ0sA";

describe("redaction (review samples, #7 at b359f6f)", () => {
  it.each([
    ["letters-only env value", j("DB_", "PASSWORD=", "letmein"), "letmein"],
    ["letters-only YAML value", j("pass", "word: ", "hunter"), "hunter"],
    ["PGPASSWORD", j("PG", "PASSWORD=", "postgres"), "postgres"],
    ["cookie session id", j("Cookie: ", "session=", "s3ss10nAbc123; theme=dark"), "s3ss10nAbc123"],
    ["Set-Cookie session id", j("Set-Cookie: ", "sid=", "8f2kQ93mzz; Path=/; HttpOnly"), "8f2kQ93mzz"],
    ["Stripe test key", j("sk", "_test_", "D".repeat(24)), "D".repeat(24)],
    ["passphrase on an env line", j("DB_", "PASSWORD=", "correct-horse-battery-staple"), "correct-horse-battery-staple"],
    ["passphrase in YAML", j("pass", "word: ", "purple-monkey-dishwasher"), "purple-monkey-dishwasher"],
    ["dotted passphrase in YAML", j("pass", "phrase: ", "stormy.night.lantern"), "stormy.night.lantern"],
    ["dotted passphrase on an export line", j("export API_", "KEY=", "blue.whale.sings.loud"), "blue.whale.sings.loud"],
    ["a random token starting with fake", j("fake", RANDOM), RANDOM],
    ["curl -u password", j("curl -u admin:", "pass", " https://x.test"), "admin:pass "],
    ["curl --user password", j("curl --user ", "admin:", "Hunter22", " https://x.test"), "Hunter22"],
  ])("hides %s", (_name, text, leak) => {
    expect(redactSecrets(text)).not.toContain(leak);
  });
});

describe("the diff check finds what redaction finds (review samples)", () => {
  const MUST_FIND: [string, string, string][] = [
    ["export GITHUB_TOKEN in a shell script", "deploy/release.sh", j("export GITHUB_", "TOKEN=", RANDOM)],
    ["connection-string password", "src/db.ts", j('const url = "postgres://app:', "Pa55word", '@db.internal:5432/app";')],
    ["npm token outside .npmrc", "src/publish.ts", j('const t = "npm', "_", "A".repeat(36), '";')],
    ["STRIPE_KEY", "scripts/env.sh", j("STRIPE", "_KEY=", "plainkeyvalue1")],
    ["PGPASS", "scripts/env.sh", j("PG", "PASS=", "pgpw1234")],
    ["AUTH", "scripts/env.sh", j("AU", "TH=", "authval99")],
    ["Bearer header", "src/api.ts", j('fetch(u, { headers: { Authorization: "', "Bearer ", "abc123def456ghi789", '" } });')],
    ["Basic header", "docs/curl.md", j("-H 'Authorization: ", "Basic ", "dXNlcjpwYXNzd29yZA==", "'")],
    ["mysql -p", "scripts/backup.sh", j("mysqldump -u root ", "-p", "rootpw77 app > dump.sql")],
    ["Stripe test key", "src/pay.ts", j('const k = "sk', "_test_", "E".repeat(24), '";')],
    ["letters-only password in a config file", "config/app.yml", j("  pass", "word: ", "hunter")],
    ["letters-only env value", ".env.production", j("DB_", "PASSWORD=", "letmein")],
    ["curl -u password", "scripts/check.sh", j("curl -u admin:", "pass", " https://x.test")],
    ["passphrase on an env line", "deploy/env.sh", j("DB_", "PASSWORD=", "correct-horse-battery-staple")],
    ["passphrase in YAML", "config/app.yml", j("pass", "word: ", "purple-monkey-dishwasher")],
    ["passphrase in source", "src/a.ts", j('const pass', 'word = "', "purple-monkey-dishwasher", '";')],
    ["dotted passphrase in YAML", "config/app.yml", j("pass", "phrase: ", "stormy.night.lantern")],
    ["dotted passphrase on an export line", "deploy/env.sh", j("export API_", "KEY=", "blue.whale.sings.loud")],
    ["a random token starting with fake", "src/a.ts", j('const k = "', "fake", RANDOM, '";')],
    ["URL-encoded cookie session", "docs/debug.md", j("Cookie: ", "session=", "eyJ1c2VyIjoxfQ%3D%3D.Zk9a2", "; theme=dark")],
  ];
  it.each(MUST_FIND)("finds %s", (_name, file, line) => {
    expect(detectSecrets(file, line)).not.toEqual([]);
  });

  const MUST_PASS: [string, string, string][] = [
    ["a label string", "src/i18n/en.json", '  "passwordLabel": "Password",'],
    ["a storage key name", "src/session.ts", 'const TOKEN_KEY = "auth.session.token";'],
    ["a token type", "src/oauth.ts", '  tokenType: "access_token",'],
    ["a call", "src/a.ts", "const token = await fetchToken(user);"],
    ["a type", "src/a.ts", "  token: string;"],
    ["a variable", "src/a.ts", "const token = value;"],
    ["an environment read", "src/a.ts", "const password = process.env.DB_PASSWORD;"],
    ["a template header", "src/a.ts", "headers: { Authorization: `Bearer ${token}` },"],
    ["a password field label", "src/Login.jsx", '<input type="password" name="password" />'],
    ["a curl call without a password", "scripts/check.sh", "curl -u \"$USER:$PASS\" https://x.test"],
    ["a cookie with no session", "docs/debug.md", "Cookie: theme=dark; lang=en"],
  ];
  it.each(MUST_PASS)("leaves %s alone", (_name, file, line) => {
    expect(detectSecrets(file, line)).toEqual([]);
  });

  it("rejects a diff that adds one, through the same detector", () => {
    const diff = `diff --git a/deploy/release.sh b/deploy/release.sh
--- a/deploy/release.sh
+++ b/deploy/release.sh
@@ -0,0 +1,2 @@
+${j("export GITHUB_", "TOKEN=", RANDOM)}
+const token = value;
`;
    expect(checkDiff(parseDiff(diff), [])).toEqual([expect.objectContaining({ rule: "secret", line: 1 })]);
  });
});

describe("lines the release scanner flagged in the repo that are not secrets", () => {
  it("passes a canary value a test checks never leaves (scripts/generate-truth-report.mjs)", () => {
    const line = j('  artifact: { summary: "fixture", api', 'Key: "must-not-leave" }, maxOutputTokens: 300,');
    expect(findSecrets("scripts/generate-truth-report.mjs", line)).toEqual([]);
    expect(detectSecrets("scripts/generate-truth-report.mjs", line)).toEqual([]);
  });

  it("passes fixed status text in a failed-proof receipt (src-tauri/src/native_draft_commands.rs)", () => {
    const line = 'reply:Some(json!({"secret":"do-not-retain-payload"})),stopped:Some(json!({"secret":"do-not-retain-stderr"})),';
    expect(findSecrets("src-tauri/src/native_draft_commands.rs", line)).toEqual([]);
    expect(detectSecrets("src-tauri/src/native_draft_commands.rs", line)).toEqual([]);
  });

  it("passes a dotted storage key name for the release scanner too", () => {
    expect(findSecrets("src/session.ts", 'const TOKEN_KEY = "auth.session.token";')).toEqual([]);
  });

  it("still flags a secret that merely starts like a sentinel word", () => {
    expect(detectSecrets("src/a.ts", j('const apiKey = "', "fake", 'Q9x2LmP4vR7tY1wZ";'))).not.toEqual([]);
  });

  it("finds nothing in its own documentation and comments", () => {
    for (const file of ["core/secrets/index.ts", "core/secrets/README.md"]) {
      const lines = readFileSync(new URL(file.replace("core/secrets/", "./"), import.meta.url), "utf8").split("\n");
      const hits = lines.flatMap((line, i) => [...findSecrets(file, line), ...detectSecrets(file, line)].map((h) => `${file}:${i + 1} ${h.rule}`));
      expect(hits).toEqual([]);
    }
  });
});
