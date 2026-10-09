import { describe, expect, it } from "vitest";
import { ALLOWLIST_PATH, fingerprintOf, parseAllowlist } from "./allowlist";

const HEX64 = /^[0-9a-f]{64}$/;
const entry = (fp: string, extra: Record<string, unknown> = {}) => ({ fingerprint: fp, reason: "fixture", approvedBy: "person-1", ...extra });

describe("fingerprintOf", () => {
  it("is file:rule:sha256 and leaks nothing", () => {
    const fp = fingerprintOf("src/a.ts", "github-token", "ghp_" + "a".repeat(36));
    const [file, rule, hash] = [fp.slice(0, 8), fp.split(":")[1], fp.split(":")[2]];
    expect(file).toBe("src/a.ts");
    expect(rule).toBe("github-token");
    expect(hash).toMatch(HEX64);
    expect(fp).not.toContain("aaaa");
  });

  it("normalises backslashes and depends on every part", () => {
    expect(fingerprintOf("a\\b.ts", "r", "v")).toBe(fingerprintOf("a/b.ts", "r", "v"));
    const base = fingerprintOf("a.ts", "r", "v");
    expect(fingerprintOf("b.ts", "r", "v")).not.toBe(base);
    expect(fingerprintOf("a.ts", "q", "v")).not.toBe(base);
    expect(fingerprintOf("a.ts", "r", "w")).not.toBe(base);
  });
});

describe("parseAllowlist", () => {
  it("reads approved entries", () => {
    const text = JSON.stringify({ version: 1, allow: [entry("a:r:" + "0".repeat(64)), entry("b:r:" + "1".repeat(64))] });
    expect(parseAllowlist(text)).toEqual(new Set(["a:r:" + "0".repeat(64), "b:r:" + "1".repeat(64)]));
  });

  it("ignores bad JSON, wrong shapes and non-strings without throwing", () => {
    for (const bad of ["", "{", "null", "[]", "42", '{"allow":5}', '{"version":1}', undefined as unknown as string, null as unknown as string]) {
      expect(parseAllowlist(bad), String(bad)).toEqual(new Set());
    }
  });

  it("ignores entries missing approvedBy, reason or fingerprint", () => {
    const text = JSON.stringify({
      version: 1,
      allow: [
        { fingerprint: "x:r:1", reason: "why" },
        { fingerprint: "x:r:2", approvedBy: "p" },
        { fingerprint: "x:r:3", reason: "", approvedBy: "p" },
        { fingerprint: "x:r:4", reason: "why", approvedBy: "  " },
        { reason: "why", approvedBy: "p" },
        null, 7, "x:r:5",
        entry("x:r:ok"),
      ],
    });
    expect(parseAllowlist(text)).toEqual(new Set(["x:r:ok"]));
  });

  it("rejects an unknown version", () => {
    expect(parseAllowlist(JSON.stringify({ version: 2, allow: [entry("x:r:ok")] }))).toEqual(new Set());
  });

  it("exposes the reviewed path", () => {
    expect(ALLOWLIST_PATH).toBe(".perfect-planner/secret-allowlist.json");
  });
});
