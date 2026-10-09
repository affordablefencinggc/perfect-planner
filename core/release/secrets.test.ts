import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPushProtection, enablePushProtection, type Fetcher } from "./pushProtection";
import {
  REQUIRED_IGNORES, SECRET_RULES, checkIgnoreList, isForbiddenFile, maskSecret, scanBranch, scanChange, scanText, withRequiredIgnores,
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
  "generic-assignment": 'api_key = "' + "Zk3jd8Qm2LpA9xRw" + '"',
};

describe("secret rules", () => {
  it("every rule has a sample and hits exactly its own id", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(SECRET_RULES.map((r) => r.id).sort());
    for (const [id, sample] of Object.entries(SAMPLES)) {
      const hits = scanText("a.ts", `const x = ${sample}`);
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

  it("does not flag placeholders", () => {
    const lines = [
      kv("api_key", " = ", "PLACEHOLDER_VALUE_123"),
      kv("password", ": ", "changeme12345"),
      kv("secret", " = ", "xxxxxxxxxxxx1"),
      kv("token", " = ", "<your-token-here1>"),
      kv("apiKey", ": ", "${API_KEY_VALUE1}"),
      kv("api_key", " = ", "process.env.API_KEY1"),
      kv("client_secret", " = ", "your_client_secret1"),
      kv("password", " = ", "example-password1"),
      kv("api_key", " = ", "dummy-value-12345"),
      kv("token", " = ", "test-token-12345"),
      kv("password", " = ", "onlylettersnodigits"),
      kv("api_key", " = ", "short1"),
    ];
    expect(scanText("a.ts", lines.join("\n"))).toEqual([]);
  });

  it("honours pp-allow-secret and numbers lines from 1, handling CRLF", () => {
    const text = ["ok", `a = "${SAMPLES["github-token"]}" // pp-allow-secret`, SAMPLES["aws-access-key"]].join("\r\n");
    const hits = scanText("a.ts", text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 3, rule: "aws-access-key" });
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
    for (const sample of Object.values(SAMPLES)) {
      const findings = scanText("f.ts", `x = ${sample}\n`);
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

describe("scanBranch", () => {
  const files: Record<string, string> = {
    "src/a.ts": "export const ok = 1;\r\n" + SAMPLES["aws-access-key"] + "\r\n",
    "src/b.ts": "fine",
    "logo.png": "\0PNG" + SAMPLES["github-token"],
    "secrets/.env": "A=1",
  };
  const make = (calls: string[][]): CommandRunner => async (_cmd, args) => {
    calls.push([...args]);
    if (args[0] === "diff") return { code: 0, stdout: Object.keys(files).join("\n") + "\n", stderr: "" };
    const path = args[1].split(":").slice(1).join(":");
    return { code: 0, stdout: files[path], stderr: "" };
  };

  it("scans full content of each changed file at head", async () => {
    const calls: string[][] = [];
    const res = await scanBranch(make(calls), { cwd: "/r", base: "origin/main" });
    expect(calls[0]).toEqual(["diff", "--name-only", "--diff-filter=ACMR", "origin/main...HEAD"]);
    expect(calls[1]).toEqual(["show", "HEAD:src/a.ts"]);
    expect(res.ok).toBe(false);
    expect(res.filesScanned).toBe(4);
    expect(res.findings.map((f) => `${f.file}:${f.rule}`).sort()).toEqual(["secrets/.env:env-file", "src/a.ts:aws-access-key"]);
    expect(res.findings.find((f) => f.file === "src/a.ts")?.line).toBe(2);
  });

  it("is ok when clean, and honours a custom head", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_c, args) => {
      calls.push([...args]);
      return args[0] === "diff" ? { code: 0, stdout: "a.ts\n", stderr: "" } : { code: 0, stdout: "clean", stderr: "" };
    };
    const res = await scanBranch(run, { cwd: "/r", base: "main", head: "feat" });
    expect(res).toEqual({ ok: true, findings: [], filesScanned: 1 });
    expect(calls[0][3]).toBe("main...feat");
    expect(calls[1][1]).toBe("feat:a.ts");
  });

  it("throws a clear error when git fails", async () => {
    const run: CommandRunner = async () => ({ code: 128, stdout: "", stderr: "fatal: bad revision 'x'\n" });
    await expect(scanBranch(run, { cwd: "/r", base: "x" })).rejects.toThrow(/git diff failed.*bad revision/);
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
    expect(rules).toEqual(SECRET_RULES.map((r) => ({ id: r.id, source: r.pattern.source, flags: r.pattern.flags })));
  });

  it("finds the same rule ids as scanText on a sample file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-hook-"));
    try {
      const file = join(dir, "sample.txt");
      const lines = [...Object.values(SAMPLES), kv("password", " = ", "changeme12345"), `a = "${SAMPLES["github-token"]}" // pp-allow-secret`];
      const text = lines.join("\r\n");
      writeFileSync(file, text);
      const fromHook = JSON.parse(node("--scan-text", file)) as Array<{ rule: string; line: number; preview: string }>;
      const expected = scanText(file, text);
      expect(fromHook.map((f) => [f.rule, f.line, f.preview])).toEqual(expected.map((f) => [f.rule, f.line, f.preview]));
      expect(new Set(fromHook.map((f) => f.rule))).toEqual(new Set(Object.keys(SAMPLES)));
      expect(JSON.stringify(fromHook)).not.toContain(SAMPLES["github-token"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the same forbidden-name decisions", () => {
    for (const p of [".env", ".env.example", "a/x.pem", "id_rsa", "id_rsa.pub", "src/a.ts", "service-account-1.json"]) {
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
