import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import { ALLOWLIST_PATH, approveSecretFinding, approvedFingerprints, fingerprintOf, parseAllowlist } from "./allowlist";
import { checkPushProtection, enablePushProtection, type Fetcher } from "./pushProtection";
import {
  PLACEHOLDER, REQUIRED_IGNORES, SECRET_RULES, checkIgnoreList, isConfigLikeFile, isForbiddenFile, isPlaceholder, maskSecret, scanBranch, scanChange, scanText, withRequiredIgnores,
} from "./secrets";
import type { CommandRunner } from "./types";

// Builds `name = "value"` at run time so repo-wide secret scanners do not read the fixtures as assignments.
const kv = (name: string, sep: string, value: string): string => name + sep + '"' + value + '"';

// Fake secrets are built from pieces so this file holds no scannable literal.
const A = (n: number) => "a".repeat(n);
const SAMPLES: Record<string, string> = {
  "aws-access-key": "AKIA" + "ABCDEFGHIJKLMNOP",
  "github-token": "ghp_" + A(36),
  "anthropic-key": "sk-ant-" + "api03-" + A(30),
  "openai-key": "sk-" + "proj-" + A(30),
  "slack-token": "xoxb-" + "1234567890-abcdef",
  "stripe-key": "sk_" + "live_" + A(20),
  "google-api-key": "AIza" + A(35),
  "private-key": "-----BEGIN " + "RSA PRIVATE KEY-----",
  jwt: "eyJ" + A(10) + ".eyJ" + A(10) + "." + A(12),
  "aws-secret-key": 'aws_secret_access_key = "' + "wJalrXUtnFEMI/K7MDENG" + "+bPxRfiCYZq8W7abcd1" + '"',
  "generic-assignment": 'api_key = "' + "Zk3jd8Qm2LpA9xRw" + '"',
  "generic-assignment-unquoted": "password: " + "hunter2isnotsafe",
};
// Rules that only fire in config-like files are sampled under this name.
const SAMPLE_FILE: Record<string, string> = { "generic-assignment-unquoted": "config.yml" };

describe("secret rules", () => {
  it("every rule has a sample and hits exactly its own id", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(SECRET_RULES.map((r) => r.id).sort());
    for (const [id, sample] of Object.entries(SAMPLES)) {
      const file = SAMPLE_FILE[id] ?? "a.ts";
      const hits = scanText(file, id === "generic-assignment-unquoted" ? sample : `const x = ${sample}`);
      expect(hits.map((h) => h.rule), id).toEqual([id]);
      expect(hits[0].line).toBe(1);
    }
  });

  it("also catches other github prefixes, fine-grained tokens and plain openai keys", () => {
    expect(scanText("a", "ghs_" + A(36))[0].rule).toBe("github-token");
    expect(scanText("a", "github_pat_" + A(30))[0].rule).toBe("github-token");
    expect(scanText("a", "sk-" + A(40))[0].rule).toBe("openai-key");
    expect(scanText("a", "ASIA" + "ABCDEFGHIJKLMNOP")[0].rule).toBe("aws-access-key");
  });

  it("does not call an anthropic key an openai key", () => {
    expect(scanText("a", SAMPLES["anthropic-key"]).map((h) => h.rule)).toEqual(["anthropic-key"]);
  });

  it("reports a token assigned to a secret name once", () => {
    const hits = scanText("a.ts", `token: "${SAMPLES["github-token"]}"`);
    expect(hits.map((h) => h.rule)).toEqual(["github-token"]);
  });

  it("does not flag whole-value placeholders or short values", () => {
    const lines = [
      kv("api_key", " = ", "PLACEHOLDER"),
      kv("password", ": ", "changeme"),
      kv("secret", " = ", "xxxxxxxxxxxx"),
      kv("token", " = ", "<your-token-here1>"),
      kv("apiKey", ": ", "${API_KEY_VALUE1}"),
      kv("apiKey", ": ", "{{ api_key_value }}"),
      kv("api_key", " = ", "process.env.API_KEY1"),
      kv("client_secret", " = ", "your_client_secret1"),
      kv("password", " = ", "example"),
      kv("api_key_value", " = ", "dummy"),
      kv("token_value", " = ", "REDACTED"),
      kv("secret_value", " = ", "********"),
      kv("password", " = ", "undefined"),
      kv("api_key", " = ", "short1"),
      kv("password", " = ", "abcdefg"),
      kv("token", " = ", "abcdefghijk"),
    ];
    expect(scanText("a.ts", lines.join("\n"))).toEqual([]);
  });

  it("only a WHOLE-value placeholder counts", () => {
    for (const v of ["placeholder", "ChangeMe", "xxx", "<anything>", "${X}", "{{x}}", "process.env.FOO_BAR", "your-key", "example", "dummy", "test", "redacted", "***", "none", "null", "undefined", "TODO",
      "secret://p/k", "keychain:svc", "keyring:svc", "vault:kv/a", "dpapi:v1:abc", "op://vault/item", "credentials:store"]) {
      expect(isPlaceholder(v), v).toBe(true);
    }
    for (const v of ["testAbCd1234efgh5678", "liveExampleKey9Zq8W7", "my-dummy-password", "xxxx1", "changeme12345", "correcthorsebatterystaple"]) {
      expect(isPlaceholder(v), v).toBe(false);
    }
    expect(PLACEHOLDER.flags).toContain("i");
  });

  it("catches values that merely contain placeholder words, and no-digit values", () => {
    for (const line of [
      kv("token", "=", "testAbCd1234efgh5678"),
      kv("api_key", "=", "liveExampleKey9Zq8W7"),
      kv("password", "=", "correcthorsebatterystaple"),
      kv("password", " = ", "example-password1"),
      kv("token", " = ", "test-token-12345"),
    ]) {
      expect(scanText("a.ts", line).map((h) => h.rule), line).toEqual(["generic-assignment"]);
    }
  });

  it("applies per-name minimum lengths (password/secret 8, key/token 12)", () => {
    expect(scanText("a.ts", kv("password", "=", "abcdefgh"))).toHaveLength(1);
    // in code (NAME = "value") short values pass; an env-style NAME="value" line counts at any length
    expect(scanText("a.ts", kv("passwd", " = ", "abcdefg"))).toHaveLength(0);
    expect(scanText("a.ts", kv("passwd", "=", "abcdefg"))).toHaveLength(1);
    expect(scanText("a.ts", kv("client_secret", "=", "abcdefgh"))).toHaveLength(1);
    expect(scanText("a.ts", kv("api_key", "=", "abcdefghijkl"))).toHaveLength(1);
    expect(scanText("a.ts", kv("auth_token", " = ", "abcdefghijk"))).toHaveLength(0);
  });

  it("has no inline bypass marker: pp-allow-secret allows nothing", () => {
    const marker = "pp-allow" + "-secret";
    const pw = scanText("a.ts", kv("password", "=", "hunter2secretvalue1") + " // " + marker);
    expect(pw.map((h) => h.rule)).toEqual(["generic-assignment"]);
    const gh = scanText("a.ts", `a = "${SAMPLES["github-token"]}" // ${marker}`);
    expect(gh.map((h) => h.rule)).toEqual(["github-token"]);
    const text = ["ok", `a = "${SAMPLES["github-token"]}" // ${marker}`, SAMPLES["aws-access-key"]].join("\r\n");
    const hits = scanText("a.ts", text);
    expect(hits.map((h) => [h.line, h.rule])).toEqual([[2, "github-token"], [3, "aws-access-key"]]);
  });

  it("catches an unquoted aws secret access key, and reports a quoted one once", () => {
    const awsValue = "wJalrXUtnFEMI/K7MDENG" + "/bPxRfiCYZq8W7abcd1";
    expect(awsValue).toHaveLength(40);
    for (const line of ["aws_secret_access_key = " + awsValue, "AWS_SECRET_ACCESS_KEY=" + awsValue, "aws_secret_access_key: " + awsValue, "aws_secret_access_key = '" + awsValue + "'"]) {
      expect(scanText("notes.txt", line).map((h) => h.rule), line).toEqual(["aws-secret-key"]);
    }
    expect(scanText("a.ts", "aws_secret_access_key = " + "${AWS_SECRET}" )).toEqual([]);
  });

  it("catches unquoted name: value / NAME=value only in config-like files", () => {
    const yml = "db:\n  " + "password: " + "hunter2isnotsafe" + "\n";
    expect(scanText("deploy/app.yml", yml).map((h) => [h.rule, h.line])).toEqual([["generic-assignment-unquoted", 2]]);
    expect(scanText(".env.production", "API_TOKEN=" + "abcdef123456789xyz").map((h) => h.rule)).toEqual(["generic-assignment-unquoted"]);
    expect(scanText("x.ini", "secret = " + "abcdefgh1234").map((h) => h.rule)).toEqual(["generic-assignment-unquoted"]);
    expect(scanText("x.yaml", "- password: " + "hunter2isnotsafe # note").map((h) => h.rule)).toEqual(["generic-assignment-unquoted"]);
    // the shared detector also catches a password with digits written as YAML in source or docs
    expect(scanText("src/a.ts", yml)).toHaveLength(1);
    expect(scanText("README.md", yml)).toHaveLength(1);
    // in a config file a password after other text is still a password
    expect(scanText("app.yml", "echo password: " + "hunter2isnotsafe")).toHaveLength(1);
    // placeholders stay quiet; in a config file even a short password is a password
    expect(scanText("app.yml", ["password: ${DB_PASSWORD}", "password: changeme", "token: " + "{{ vault_token }}", "password: secret://p/k"].join("\n"))).toEqual([]);
    expect(scanText("app.yml", "password: short")).toHaveLength(1);
  });

  it("recognises config-like file names", () => {
    for (const f of [".env", ".env.local", "a/b.yml", "a.YAML", "x.ini", "x.cfg", "x.conf", "x.properties", "x.toml", ".npmrc", "Dockerfile", "docker/Dockerfile.dev", "docker-compose.yml", "docker-compose.override.yaml"]) {
      expect(isConfigLikeFile(f), f).toBe(true);
    }
    for (const f of ["a.ts", "README.md", "package.json", "envfile.txt"]) expect(isConfigLikeFile(f), f).toBe(false);
  });

  it("catches PGP private key blocks", () => {
    const pgp = "-----BEGIN " + "PGP PRIVATE KEY BLOCK-----";
    expect(scanText("k.txt", pgp).map((h) => h.rule)).toEqual(["private-key"]);
    expect(scanText("k.txt", "-----BEGIN " + "PGP PUBLIC KEY BLOCK-----")).toEqual([]);
  });

  it("flags npmrc auth tokens only in .npmrc", () => {
    const text = "//registry.npmjs.org/:_authToken=npm_" + A(30);
    expect(scanText("sub/.npmrc", text).map((h) => h.rule)).toContain("npmrc-auth-token");
    expect(scanText("sub/.npmrc", "//r/:_authToken=${NPM_TOKEN}")).toEqual([]);
    expect(scanText("notes.txt", text).map((h) => h.rule)).not.toContain("npmrc-auth-token");
  });
});

describe("masking", () => {
  it("keeps 4 chars and the length", () => {
    expect(maskSecret("ghp_" + A(36))).toBe("ghp_…(40)");
  });

  it("never leaks a full secret into findings", () => {
    for (const [id, sample] of Object.entries(SAMPLES)) {
      const findings = scanText(SAMPLE_FILE[id] ?? "f.ts", SAMPLE_FILE[id] ? sample : `x = ${sample}\n`);
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        expect(JSON.stringify(f)).not.toContain(sample.slice(8));
        expect(f.preview).toMatch(/…\(\d+\)$/);
      }
    }
  });
});

describe("forbidden files", () => {
  it("blocks secret-bearing names", () => {
    const bad: Array<[string, string]> = [
      [".env", "env-file"], ["app/.env.local", "env-file"], [".env.production", "env-file"],
      ["certs/server.pem", "pem-file"], ["a/b.key", "key-file"], ["x.p12", "pkcs12-file"], ["x.pfx", "pkcs12-file"],
      ["home/id_rsa", "ssh-private-key"], ["id_ed25519", "ssh-private-key"], ["id_ecdsa", "ssh-private-key"],
      ["app.keystore", "keystore-file"], ["credentials.json", "credentials-file"], ["gcp/service-account-prod.json", "service-account-file"],
      ["win\\dir\\.ENV", "env-file"],
    ];
    for (const [p, id] of bad) expect(isForbiddenFile(p), p).toBe(id);
  });

  it("allows templates and ordinary files", () => {
    for (const p of [".env.example", ".env.sample", ".env.template", "id_rsa.pub", "src/env.ts", "package.json", ".gitignore"]) {
      expect(isForbiddenFile(p), p).toBeNull();
    }
  });
});

describe("Perfect Planner's own state", () => {
  it("refuses any path under .perfect-planner/, whatever it holds", () => {
    for (const p of [
      ".perfect-planner/ledger/ledger.jsonl", ".perfect-planner/worker-token", ".perfect-planner/briefs/T-3.md",
      ".perfect-planner/keys/system.json", "apps/web/.perfect-planner/HEAD", ".Perfect-Planner\\ledger\\HEAD",
    ]) expect(isForbiddenFile(p), p).toBe("planner-state");
    const findings = scanChange([{ path: ".perfect-planner/notes.txt", added: 1, removed: 0, addedText: "hello\n" }]);
    expect(findings.map((f) => f.rule)).toEqual(["planner-state"]);
  });

  it("still lets the reviewed allowlist file and look-alike names through", () => {
    for (const p of [ALLOWLIST_PATH, "perfect-planner/README.md", "docs/.perfect-planner.md", "src/.perfect-planner-ui/x.ts"]) {
      expect(isForbiddenFile(p), p).toBeNull();
    }
  });
});

describe("scanChange", () => {
  it("combines names and added text, skipping deleted and binary files", () => {
    const findings = scanChange([
      { path: ".env", added: 1, removed: 0 },
      { path: "src/a.ts", added: 1, removed: 0, addedText: SAMPLES["github-token"] },
      { path: "old.pem", added: 0, removed: 3, deleted: true },
      { path: "img.png", added: 0, removed: 0, binary: true, addedText: SAMPLES["github-token"] },
    ]);
    expect(findings.map((f) => `${f.file}:${f.rule}`).sort()).toEqual([".env:env-file", "src/a.ts:github-token"]);
  });
});

describe("allowlist by fingerprint", () => {
  const ghp = SAMPLES["github-token"];
  const text = `a = "${ghp}"\n`;

  it("findings carry a hash fingerprint that leaks nothing", () => {
    const [f] = scanText("src/a.ts", text);
    expect(f.fingerprint).toBe(fingerprintOf("src/a.ts", "github-token", ghp));
    expect(JSON.stringify(f)).not.toContain(ghp.slice(8));
    const [g] = scanText("src\\b.ts", kv("password", "=", "hunter2secretvalue1"));
    expect(g.fingerprint).toBe(fingerprintOf("src/b.ts", "generic-assignment", "hunter2secretvalue1"));
  });

  it("skips only the exact fingerprint", () => {
    const allow = new Set([fingerprintOf("src/a.ts", "github-token", ghp)]);
    expect(scanText("src/a.ts", text, allow)).toEqual([]);
    expect(scanText("src/other.ts", text, allow)).toHaveLength(1); // other file
    expect(scanText("src/a.ts", text.replace("aaaa", "aaab"), allow)).toHaveLength(1); // other value
    expect(scanText("src/a.ts", text + SAMPLES["aws-access-key"], allow).map((f) => f.rule)).toEqual(["aws-access-key"]); // other rule
    expect(scanText("src/a.ts", text, new Set([fingerprintOf("src/a.ts", "jwt", ghp)]))).toHaveLength(1);
  });

  it("works for unquoted, npmrc and aws rules too", () => {
    const tok = "npm_" + A(30);
    const [n] = scanText(".npmrc", "//r/:_authToken=" + tok);
    expect(n.fingerprint).toBe(fingerprintOf(".npmrc", "npmrc-auth-token", tok));
    expect(scanText(".npmrc", "//r/:_authToken=" + tok, new Set([n.fingerprint!]))).toEqual([]);
  });

  it("scanChange honours the set and fingerprints forbidden files", () => {
    const files = [{ path: "src/a.ts", added: 1, removed: 0, addedText: ghp }, { path: ".env", added: 1, removed: 0 }];
    const all = scanChange(files);
    expect(all.every((f) => typeof f.fingerprint === "string")).toBe(true);
    const gh = all.find((f) => f.rule === "github-token")!;
    expect(scanChange(files, new Set([gh.fingerprint!])).map((f) => f.rule)).toEqual(["env-file"]);
  });

  it("the allowlist file itself is never a forbidden file", () => {
    expect(isForbiddenFile(ALLOWLIST_PATH)).toBeNull();
    expect(scanChange([{ path: ALLOWLIST_PATH, added: 1, removed: 0, addedText: JSON.stringify({ version: 1, allow: [] }) }])).toEqual([]);
  });

  it("parseAllowlist is re-usable with scanText", () => {
    const fp = fingerprintOf("src/a.ts", "github-token", ghp);
    const set = parseAllowlist(JSON.stringify({ version: 1, allow: [{ fingerprint: fp, reason: "fixture", approvedBy: "p1" }] }));
    expect(scanText("src/a.ts", text, set)).toEqual([]);
  });
});

describe("ignore list", () => {
  it("reports what is missing", () => {
    expect(checkIgnoreList("node_modules\n.env\n")).toEqual({ ok: false, missing: REQUIRED_IGNORES.filter((r) => r !== ".env") });
    expect(checkIgnoreList(REQUIRED_IGNORES.join("\r\n")).ok).toBe(true);
  });

  it("appends once and is idempotent", () => {
    const once = withRequiredIgnores("node_modules\n.env");
    expect(once.startsWith("node_modules\n.env\n\n# Perfect Planner: never commit secrets\n")).toBe(true);
    expect(once.split("\n").filter((l) => l === ".env")).toHaveLength(1);
    expect(checkIgnoreList(once).ok).toBe(true);
    expect(withRequiredIgnores(once)).toBe(once);
  });

  it("preserves CRLF and works on an empty file", () => {
    const crlf = withRequiredIgnores("dist\r\n");
    expect(crlf).not.toMatch(/[^\r]\n/);
    expect(crlf).toContain("\r\n*.pem\r\n");
    expect(withRequiredIgnores("")).toBe(["# Perfect Planner: never commit secrets", ...REQUIRED_IGNORES].join("\n") + "\n");
  });

  it("does not repeat the header when topping up", () => {
    const partial = "# Perfect Planner: never commit secrets\n.env\n";
    const out = withRequiredIgnores(partial);
    expect(out.match(/never commit secrets/g)).toHaveLength(1);
    expect(checkIgnoreList(out).ok).toBe(true);
  });
});

// A fake git that answers scanBranch's object reads (merge-base, ls-tree, cat-file) from in-memory trees.
function fakeGit(trees: Record<string, Record<string, string>>, mergeBase: string, calls: string[][] = []): CommandRunner {
  const id = (text: string) => createHash("sha1").update(text).digest("hex");
  const blobs = new Map(Object.values(trees).flatMap((tree) => Object.values(tree).map((text) => [id(text), text] as const)));
  return async (_cmd, args) => {
    calls.push([...args]);
    if (args[0] === "merge-base") return { code: 0, stdout: `${mergeBase}\n`, stderr: "" };
    if (args[0] === "ls-tree") {
      const tree = trees[args.at(-1)!] ?? {};
      return { code: 0, stdout: Object.entries(tree).map(([path, text]) => `100644 blob ${id(text)}\t${path}\0`).join(""), stderr: "" };
    }
    if (args[0] === "cat-file" && blobs.has(args[2]!)) return { code: 0, stdout: blobs.get(args[2]!)!, stderr: "" };
    return { code: 128, stdout: "", stderr: "fatal: unexpected git call\n" };
  };
}

describe("scanBranch", () => {
  const files: Record<string, string> = {
    "src/a.ts": "export const ok = 1;\r\n" + SAMPLES["aws-access-key"] + "\r\n",
    "src/b.ts": "fine",
    "logo.png": "\0PNG" + SAMPLES["github-token"],
    "secrets/.env": "A=1",
  };

  it("scans full content of each file head adds or changes since the merge-base, by object reads only", async () => {
    const calls: string[][] = [];
    const res = await scanBranch(fakeGit({ b0b0: { "src/b.ts": "fine", "old.ts": "gone" }, HEAD: files }, "b0b0", calls), { cwd: "/r", base: "origin/main" });
    expect(calls[0]).toEqual(["merge-base", "origin/main", "HEAD"]);
    expect(calls[1]).toEqual(["ls-tree", "-r", "-z", "--full-tree", "b0b0"]);
    expect(calls[2]).toEqual(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
    expect(calls.slice(3).every((c) => c[0] === "cat-file" && c[1] === "blob")).toBe(true);
    expect(res.ok).toBe(false);
    // src/b.ts is unchanged and old.ts was deleted: neither is read.
    expect(res.filesScanned).toBe(3);
    expect(res.findings.map((f) => `${f.file}:${f.rule}`).sort()).toEqual(["secrets/.env:env-file", "src/a.ts:aws-access-key"]);
    expect(res.findings.find((f) => f.file === "src/a.ts")?.line).toBe(2);
  });

  it("is ok when clean, and honours a custom head", async () => {
    const calls: string[][] = [];
    const res = await scanBranch(fakeGit({ b0b0: {}, feat: { "a.ts": "clean" } }, "b0b0", calls), { cwd: "/r", base: "main", head: "feat" });
    expect(res).toEqual({ ok: true, findings: [], filesScanned: 1 });
    expect(calls[0]).toEqual(["merge-base", "main", "feat"]);
    expect(calls[2].at(-1)).toBe("feat");
  });

  it("throws a clear error when git fails", async () => {
    const run: CommandRunner = async () => ({ code: 128, stdout: "", stderr: "fatal: bad revision 'x'\n" });
    await expect(scanBranch(run, { cwd: "/r", base: "x" })).rejects.toThrow(/git merge-base failed.*bad revision/);
  });
});

describe("scanBranch honours only ledger approvals, never a file on a branch", () => {
  const ghp = SAMPLES["github-token"];
  const allowDoc = (fp: string) => JSON.stringify({ version: 1, allow: [{ fingerprint: fp, reason: "fixture", approvedBy: "p1" }] });
  const fp = fingerprintOf("src/a.ts", "github-token", ghp);
  const runner = (head: Record<string, string>, base: Record<string, string>, calls: string[][] = []): CommandRunner =>
    fakeGit({ main: base, feat: head }, "main", calls);
  const src = `a = "${ghp}"\n`;
  const opts = { cwd: "/r", base: "main", head: "feat" };

  it("two-push bypass: an allowlist file already on base approves nothing", async () => {
    const calls: string[][] = [];
    const res = await scanBranch(runner({ "src/a.ts": src }, { [ALLOWLIST_PATH]: allowDoc(fp) }, calls), { ...opts, approved: new Set() });
    expect(res.ok).toBe(false);
    expect(res.findings.map((f) => f.rule)).toEqual(["github-token"]);
    expect(calls.some((c) => c.join(" ").includes(ALLOWLIST_PATH))).toBe(false);
    const none = await scanBranch(runner({ "src/a.ts": src }, { [ALLOWLIST_PATH]: allowDoc(fp) }), opts);
    expect(none.ok).toBe(false);
  });

  it("a head that adds its own allowlist file is flagged too", async () => {
    const res = await scanBranch(runner({ "src/a.ts": src, [ALLOWLIST_PATH]: allowDoc(fp) }, {}), opts);
    expect(res.ok).toBe(false);
  });

  it("approved fingerprints let exactly that finding through", async () => {
    const res = await scanBranch(runner({ "src/a.ts": src }, {}), { ...opts, approved: new Set([fp]) });
    expect(res).toMatchObject({ ok: true, findings: [], filesScanned: 1 });
    const other = await scanBranch(runner({ "src/a.ts": src }, {}), { ...opts, approved: new Set(["x:y:" + "0".repeat(64)]) });
    expect(other.ok).toBe(false);
  });

  describe("with a real ledger", () => {
    const person = { kind: "person", id: "owner" } as const;
    const open = () => {
      let t = 0;
      const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)) });
      installNumberingRules(ledger);
      return ledger;
    };
    const scan = (ledger: Ledger) => scanBranch(runner({ "src/a.ts": src }, {}), { ...opts, approved: approvedFingerprints(ledger.entries()) });

    it("a person's approval allows; a later revoke withdraws it", async () => {
      const ledger = open();
      expect((await scan(ledger)).ok).toBe(false);
      approveSecretFinding(ledger, person, { fingerprint: fp, reason: "fixture value" });
      expect((await scan(ledger)).ok).toBe(true);
      approveSecretFinding(ledger, person, { fingerprint: fp, reason: "no longer needed", revoke: true });
      expect((await scan(ledger)).ok).toBe(false);
    });

    it("a system actor's decision.made with the same data does not approve", async () => {
      const ledger = open();
      appendNumbered(ledger, {
        actor: { kind: "system", id: "gate" },
        type: "decision.made",
        summary: "auto approve",
        reason: "self approval attempt",
        evidence: [],
        refs: [],
        data: { topic: "secret-allowlist", fingerprint: fp },
      });
      expect(approvedFingerprints(ledger.entries()).size).toBe(0);
      expect((await scan(ledger)).ok).toBe(false);
    });
  });
});

describe("push protection", () => {
  const opts = { owner: "me", repo: "app", token: "tok_" + "SECRETVALUE123" };
  const reply = (status: number, body: unknown = {}) => ({ status, json: async () => body });
  const body = (s?: string) => ({ security_and_analysis: s ? { secret_scanning_push_protection: { status: s } } : undefined });

  it("reads enabled, disabled and unavailable", async () => {
    const urls: string[] = [];
    const f = (b: unknown): Fetcher => async (url, init) => { urls.push(url); expect(init?.headers?.Authorization).toBe(`Bearer ${opts.token}`); expect(init?.headers?.["X-GitHub-Api-Version"]).toBe("2022-11-28"); return reply(200, b); };
    expect((await checkPushProtection(f(body("enabled")), opts)).status).toBe("enabled");
    expect((await checkPushProtection(f(body("disabled")), opts)).status).toBe("disabled");
    const un = await checkPushProtection(f({}), opts);
    expect(un.status).toBe("unavailable");
    expect(un.detail).toContain("not offered for this repository's plan");
    expect(urls[0]).toBe("https://api.github.com/repos/me/app");
  });

  it("maps 404 and 403 to unknown without the token", async () => {
    for (const code of [404, 403, 401, 500]) {
      const r = await checkPushProtection(async () => reply(code), opts);
      expect(r.status).toBe("unknown");
      expect(r.detail).not.toContain(opts.token);
    }
  });

  it("redacts the token from network errors", async () => {
    const r = await checkPushProtection(async () => { throw new Error(`boom ${opts.token}`); }, opts);
    expect(r.status).toBe("unknown");
    expect(r.detail).not.toContain(opts.token);
  });

  it("enables via PATCH then re-checks", async () => {
    let enabled = false;
    const seen: Array<{ method?: string; body?: string }> = [];
    const f: Fetcher = async (_u, init) => {
      seen.push({ method: init?.method, body: init?.body });
      if (init?.method === "PATCH") { enabled = true; return reply(200, {}); }
      return reply(200, body(enabled ? "enabled" : "disabled"));
    };
    const r = await enablePushProtection(f, opts);
    expect(r.status).toBe("enabled");
    expect(seen.map((s) => s.method)).toEqual(["PATCH", "GET"]);
    expect(JSON.parse(seen[0].body!)).toEqual({
      security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } },
    });
    expect(JSON.stringify(seen)).not.toContain(opts.token);
  });

  it("reports a refused enable plainly", async () => {
    const r = await enablePushProtection(async () => reply(403), opts);
    expect(r.status).toBe("unknown");
    expect(r.detail).not.toContain(opts.token);
  });
});

describe("hooks/pre-push.mjs stays in sync", () => {
  const hook = join(__dirname, "hooks", "pre-push.mjs");
  const node = (...args: string[]) => execFileSync(process.execPath, [hook, ...args], { encoding: "utf8" });

  it("uses the same rule patterns as secrets.ts", () => {
    const rules = JSON.parse(node("--rules")) as Array<{ id: string; source: string; flags: string }>;
    expect(rules).toEqual(
      SECRET_RULES.map((r) => ({ id: r.id, source: r.pattern.source, flags: r.pattern.flags, valueGroup: r.valueGroup ?? null, nameGroup: r.nameGroup ?? null, configOnly: r.configOnly === true })),
    );
  });

  it("uses the same placeholder regex", () => {
    const p = JSON.parse(node("--placeholder")) as { source: string; flags: string };
    expect(p).toEqual({ source: PLACEHOLDER.source, flags: PLACEHOLDER.flags });
  });

  it("makes the same config-like decisions", () => {
    for (const f of [".env", ".env.local", "a/b.yml", "a.YAML", "x.ini", "x.toml", ".npmrc", "Dockerfile", "docker-compose.yml", "a.ts", "README.md", "envfile.txt"]) {
      expect(JSON.parse(node("--check-config", f)), f).toBe(isConfigLikeFile(f));
    }
  });

  it("finds the same rule ids as scanText on a sample file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-hook-"));
    try {
      const file = join(dir, "sample.txt");
      const lines = [...Object.values(SAMPLES).filter((x) => !x.startsWith("password: ")), kv("password", " = ", "changeme"), kv("password", " = ", "correcthorsebatterystaple"), kv("token", "=", "testAbCd1234efgh5678"), "-----BEGIN " + "PGP PRIVATE KEY BLOCK-----", `a = "${SAMPLES["github-token"]}" // ` + "pp-allow" + "-secret", kv("password", " = ", "abcdefg")];
      const text = lines.join("\r\n");
      writeFileSync(file, text);
      const fromHook = JSON.parse(node("--scan-text", file)) as Array<{ rule: string; line: number; preview: string; fingerprint: string }>;
      const expected = scanText(file, text);
      expect(fromHook.map((f) => [f.rule, f.line, f.preview, f.fingerprint])).toEqual(expected.map((f) => [f.rule, f.line, f.preview, f.fingerprint]));
      expect(new Set(fromHook.map((f) => f.rule))).toEqual(new Set(Object.keys(SAMPLES).filter((k) => k !== "generic-assignment-unquoted")));
      // allowlist (second arg) removes only the listed fingerprint, same as scanText
      const allowFile = join(dir, "allow.json");
      writeFileSync(allowFile, JSON.stringify({ version: 1, allow: [{ fingerprint: expected[0].fingerprint, reason: "fixture", approvedBy: "p1" }] }));
      const filtered = JSON.parse(node("--scan-text", file, allowFile)) as Array<{ fingerprint: string }>;
      expect(filtered.map((f) => f.fingerprint)).toEqual(scanText(file, text, new Set([expected[0].fingerprint!])).map((f) => f.fingerprint));
      expect(filtered).toHaveLength(expected.length - 1);
      expect(JSON.stringify(fromHook)).not.toContain(SAMPLES["github-token"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets a value that only names a field through, in the gate and the hook alike", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-hook-"));
    try {
      const file = join(dir, "en.json");
      // the reviewer's sample: a UI label, not a credential
      const text = ['  "passwordLabel": "Password",', '  "tokenHeading": "Token",', '  "secretTitle": "Secret",', kv("password", " = ", "hunter2isnotsafe")].join("\n");
      writeFileSync(file, text);
      expect(scanText("src/i18n/en.json", '  "passwordLabel": "Password",')).toEqual([]);
      const expected = scanText(file, text);
      expect(expected.map((f) => f.line)).toEqual([4]);
      const fromHook = JSON.parse(node("--scan-text", file)) as Array<{ line: number; fingerprint: string }>;
      expect(fromHook.map((f) => [f.line, f.fingerprint])).toEqual(expected.map((f) => [f.line, f.fingerprint]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is as strict as Jev's diff check: the reviewer's samples, in the gate and the hook alike", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-hook-"));
    try {
      const caught: Array<[string, string]> = [
        ["deploy.sh", "export GITHUB_" + "TOKEN=" + "q7Wm2Lp9Xz4Rt8Kd3Vn6"],
        ["src/db.ts", "DB_PASS" + "WORD=" + "letmeinplease"],
        ["src/db.ts", 'const url = "postgres://app:' + "s3cretPw" + '@db.internal:5432/app";'],
        ["scripts/backup.ts", 'run("mysql -uroot -p' + "Hunter2xyz" + ' app");'],
        ["src/pay.ts", 'const stripe = "sk_' + "test_" + "4eC39HqLyjWDarjtT1zdp7dc" + '";'],
        ["scripts/call.ts", 'exec("curl -u admin:' + "Adm1nPass" + ' https://api.example.com");'],
      ];
      for (const [file, line] of caught) {
        const local = join(dir, file.replace(/\//g, "_"));
        writeFileSync(local, line + "\n");
        expect(scanText(file, line + "\n").length, line).toBeGreaterThan(0);
        expect(JSON.parse(node("--scan-text", local)).length, line).toBeGreaterThan(0);
      }
      const harmless = 'const TOKEN_KEY = "auth.session.token";';
      const local = join(dir, "keys.ts");
      writeFileSync(local, harmless + "\n");
      expect(scanText("src/keys.ts", harmless)).toEqual([]);
      expect(JSON.parse(node("--scan-text", local))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports a generated copy of core/secrets that is up to date", () => {
    execFileSync(process.execPath, [fileURLToPath(new URL("./hooks/build-detector.mjs", import.meta.url)), "--check"]);
  });

  it("scans config-only unquoted rules identically", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-hook-"));
    try {
      const file = join(dir, "app.yml");
      const text = "db:\n  " + "password: " + "hunter2isnotsafe" + "\n  token: ${T}\n";
      writeFileSync(file, text);
      const fromHook = JSON.parse(node("--scan-text", file)) as Array<{ rule: string; line: number; fingerprint: string }>;
      expect(fromHook.map((f) => [f.rule, f.line])).toEqual([["generic-assignment-unquoted", 2]]);
      expect(fromHook.map((f) => f.fingerprint)).toEqual(scanText(file, text).map((f) => f.fingerprint));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats the allowlist file as never forbidden", () => {
    expect(JSON.parse(node("--check-name", ALLOWLIST_PATH))).toBeNull();
  });

  it("uses the same forbidden-name decisions", () => {
    for (const p of [".env", ".env.example", "a/x.pem", "id_rsa", "id_rsa.pub", "src/a.ts", "service-account-1.json", ".perfect-planner/worker-token", "x/.perfect-planner/ledger/HEAD", ".perfect-planner/secret-allowlist.json", "perfect-planner/a.md"]) {
      expect(JSON.parse(node("--check-name", p)), p).toBe(isForbiddenFile(p));
    }
  });
});

describe("secret-store references", () => {
  it("does not flag handles that point at a secret store", () => {
    const text = 'const a = { secretHandle: "secret://provider/review-a/key-1" };\nconst b = { tokenHandle: "dpapi:v1:00000000-0000-0000-0000-000000000000" };\n';
    expect(scanText("src/a.ts", text)).toEqual([]);
  });
});

describe("pre-push hook honours the allowlist only from the remote default branch", () => {
  const hook = join(__dirname, "hooks", "pre-push.mjs");
  const secretText = 'a = "' + SAMPLES["github-token"] + '"\n';
  const fp = fingerprintOf("src/a.ts", "github-token", SAMPLES["github-token"]);
  const doc = JSON.stringify({ version: 1, allow: [{ fingerprint: fp, reason: "fixture", approvedBy: "p1" }] });
  const ZERO = "0".repeat(40);

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" }).trim();
  const write = (cwd: string, rel: string, text: string) => {
    const full = join(cwd, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const commit = (cwd: string, files: Record<string, string>, msg: string) => {
    for (const [k, v] of Object.entries(files)) write(cwd, k, v);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", msg);
    return git(cwd, "rev-parse", "HEAD");
  };
  const run = (cwd: string, ref: string, local: string, remote: string) =>
    spawnSync(process.execPath, [hook], { cwd, input: `refs/heads/${ref} ${local} refs/heads/${ref} ${remote}\n`, encoding: "utf8" });

  /** Bare remote with `main` holding `mainFiles`; a clone with origin/HEAD set (unless noHead). */
  const world = (mainFiles: Record<string, string>, opts: { noHead?: boolean; branch?: string } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "pp-hook-git-"));
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    execFileSync("git", ["init", "-q", "--bare", "-b", opts.branch ?? "main", remote]);
    mkdirSync(work);
    git(work, "init", "-q", "-b", opts.branch ?? "main");
    git(work, "remote", "add", "origin", remote);
    commit(work, { "README.md": "hi\n", ...mainFiles }, "main");
    git(work, "push", "-q", "origin", opts.branch ?? "main");
    git(work, "fetch", "-q", "origin");
    if (opts.noHead) {
      try { git(work, "remote", "set-head", "origin", "-d"); } catch { /* none set */ }
    } else {
      git(work, "remote", "set-head", "origin", opts.branch ?? "main");
    }
    return { root, work };
  };
  const done = (w: { root: string }) => rmSync(w.root, { recursive: true, force: true });

  it("two-push bypass on a feature branch is blocked", () => {
    const w = world({});
    try {
      git(w.work, "checkout", "-q", "-b", "feat");
      // push 1: only the allowlist entry
      const c1 = commit(w.work, { [ALLOWLIST_PATH]: doc }, "allowlist");
      expect(run(w.work, "feat", c1, ZERO).status).toBe(0);
      git(w.work, "push", "-q", "origin", "feat");
      git(w.work, "fetch", "-q", "origin");
      // push 2: the secret, measured against the remote tip of feat
      const c2 = commit(w.work, { "src/a.ts": secretText }, "secret");
      const res = run(w.work, "feat", c2, c1);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("github-token");
      expect(res.stderr).not.toContain(SAMPLES["github-token"]);
      // a brand-new branch (zero remote sha) holding both is blocked too
      expect(run(w.work, "other", c2, ZERO).status).toBe(1);
    } finally {
      done(w);
    }
  });

  it("a push that allowlists its own secret is blocked", () => {
    const w = world({});
    try {
      git(w.work, "checkout", "-q", "-b", "feat");
      const c = commit(w.work, { "src/a.ts": secretText, [ALLOWLIST_PATH]: doc }, "both");
      expect(run(w.work, "feat", c, ZERO).status).toBe(1);
    } finally {
      done(w);
    }
  });

  it("lets a feature push through when the remote default branch already holds the fingerprint", () => {
    const w = world({ [ALLOWLIST_PATH]: doc });
    try {
      git(w.work, "checkout", "-q", "-b", "feat");
      const c = commit(w.work, { "src/a.ts": secretText }, "secret");
      expect(run(w.work, "feat", c, ZERO).status).toBe(0);
    } finally {
      done(w);
    }
  });

  it("falls back to origin/master when origin/HEAD is unset", () => {
    const w = world({ [ALLOWLIST_PATH]: doc }, { noHead: true, branch: "master" });
    try {
      git(w.work, "checkout", "-q", "-b", "feat");
      const c = commit(w.work, { "src/a.ts": secretText }, "secret");
      expect(run(w.work, "feat", c, ZERO).status).toBe(0);
    } finally {
      done(w);
    }
  });

  it("uses no allowlist when no default branch ref resolves", () => {
    const w = world({ [ALLOWLIST_PATH]: doc }, { noHead: true, branch: "trunk" });
    try {
      git(w.work, "checkout", "-q", "-b", "feat");
      const c = commit(w.work, { "src/a.ts": secretText }, "secret");
      expect(run(w.work, "feat", c, ZERO).status).toBe(1);
    } finally {
      done(w);
    }
  });

  it("still blocks other secrets and the old inline marker", () => {
    const w = world({ [ALLOWLIST_PATH]: doc });
    try {
      git(w.work, "checkout", "-q", "-b", "feat");
      const c = commit(w.work, { "src/b.ts": secretText + "x = " + SAMPLES["aws-access-key"] + " // " + "pp-allow" + "-secret\n" }, "more");
      const res = run(w.work, "feat", c, ZERO);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("aws-access-key");
    } finally {
      done(w);
    }
  });

  it("keeps agent token files out of git", () => {
    expect(REQUIRED_IGNORES).toContain(".perfect-planner/tokens/");
  });
});
