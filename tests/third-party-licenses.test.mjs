import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("--licenses-out writes the full licence text of a shipped npm package, without touching THIRD-PARTY-NOTICES.md", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pp-licenses-"));
  try {
    const out = path.join(dir, "licenses", "THIRD-PARTY-LICENSES.txt");
    const before = readFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "utf8");
    execFileSync(process.execPath, [path.join(root, "scripts", "generate-third-party-notices.mjs"), "--licenses-out", out, "--skip-cargo", "--no-notices"], { cwd: root, stdio: "pipe" });
    const text = readFileSync(out, "utf8");
    assert.match(text, /npm react@19\.2\.0 +\(MIT\)/);
    assert.match(text, /Permission is hereby granted, free of charge, to any person obtaining a copy/);
    assert.equal(readFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "utf8"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
