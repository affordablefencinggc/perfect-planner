import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitExecutable, NO_CWD_SEARCH_ENV } from "../exec/index";
import { approvedFingerprints } from "./allowlist";
import { scanChange } from "./secrets";

const root = fileURLToPath(new URL("../..", import.meta.url));

// Files whose fixtures still trip the scan, each with its owner. Pushing a
// change to one of them is refused until it is fixed; remove the entry then.
const PENDING: Record<string, string> = {
  "core/jev/jev.test.ts": "#7 (core/jev owner): fixture literal at line 380",
  "tests/document-registry.test.mjs": "fixture sweep held for the user's go-ahead",
  "tests/folder-contract-http.test.mjs": "fixture sweep held for the user's go-ahead",
  "tests/native-review-host-protocol.test.mjs": "fixture sweep held for the user's go-ahead",
  "tests/provider-review-gateway.test.mjs": "fixture sweep held for the user's go-ahead",
  "tests/windows-dpapi-secret-custody.test.mjs": "fixture sweep held for the user's go-ahead",
};

describe("this repository passes its own push scan", () => {
  it("finds nothing in any tracked file outside the listed pending files", () => {
    const files = execFileSync(gitExecutable(root), ["ls-files", "-z"], { cwd: root, encoding: "utf8", env: { ...process.env, ...NO_CWD_SEARCH_ENV } })
      .split("\0")
      .filter(Boolean);
    const changed = files.flatMap((path) => {
      let text: string;
      try {
        text = readFileSync(`${root}/${path}`, "utf8");
      } catch {
        return [];
      }
      return text.includes("\0") ? [] : [{ path, added: 0, removed: 0, addedText: text }];
    });
    // No ledger on a plain checkout, so no person-approved exceptions apply.
    const findings = scanChange(changed, approvedFingerprints([]));
    const unexpected = findings.filter((f) => !(f.file in PENDING)).map((f) => `${f.file}:${f.line ?? ""} ${f.rule}`);
    expect(unexpected).toEqual([]);
    // A pending entry that no longer flags must be removed from the list.
    const stillFlagged = new Set(findings.map((f) => f.file));
    expect(Object.keys(PENDING).filter((file) => !stillFlagged.has(file))).toEqual([]);
  });
});
