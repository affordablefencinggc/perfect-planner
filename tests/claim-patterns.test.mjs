import test from "node:test";
import assert from "node:assert/strict";
import { claimPatternProblem, claimPatternsOverlap, namePatternsOverlap, isClaimPattern } from "../src/engine/claimPatterns.js";

test("accepts the safe glob subset and plain relative paths", () => {
  for (const path of ["src/app.js", "src/core/**", "tests/core-*.test.mjs", "mcp/**", "**", "*", "src/**/index.js", "src/?.js", "src/*/a.js", "docs/read me.md", "src/components"]) {
    assert.equal(claimPatternProblem(path), null, path);
  }
});

test("refuses absolute, traversal, backslash, empty parts, braces, brackets and partial **", () => {
  for (const path of ["/root", "../x", "src/../x", "./src", "src/./a", "src\\app", "C:/root", "src//app", "src/", "src/{a,b}.js", "src/[ab].js", "src/a**", "src/**b/x", "src/***", "a<b", "a|b", "", "src/\u0001"]) {
    assert.ok(claimPatternProblem(path), path);
  }
});

test("isClaimPattern detects wildcard claims only", () => {
  assert.equal(isClaimPattern("src/app.js"), false);
  assert.equal(isClaimPattern("src/*.js"), true);
  assert.equal(isClaimPattern("src/?.js"), true);
  assert.equal(isClaimPattern("src/**"), true);
});

test("name patterns intersect when some single name matches both", () => {
  for (const [a, b, expected] of [
    ["core-*.test.mjs", "ui-*.test.mjs", false],
    ["core-*.test.mjs", "core-a.test.mjs", true],
    ["*.js", "*.ts", false],
    ["*.js", "a*", true],
    ["a*b", "*c", false],
    ["a*b", "a*", true],
    ["?", "ab", false],
    ["??", "ab", true],
    ["*", "anything", true],
    ["a?c", "*b*", true],
    ["App.JS", "app.js", true],
    ["x*y*z", "*q*", true],
    ["abc", "abd", false],
  ]) {
    assert.equal(namePatternsOverlap(a, b), expected, `${a} vs ${b}`);
    assert.equal(namePatternsOverlap(b, a), expected, `${b} vs ${a}`);
  }
});

test("claims overlap when some concrete path could match both", () => {
  for (const [a, b, expected] of [
    ["src/core/**", "src/core/a.js", true],
    ["src/core/**", "src/core", true],
    ["tests/core-*.test.mjs", "tests/ui-*.test.mjs", false],
    ["tests/core-*.test.mjs", "tests/core-ledger.test.mjs", true],
    ["src/**", "src/core/**", true],
    ["src/components", "src/components/**", true],
    ["src/components", "src/components/Button.jsx", true],
    ["src/components", "src/components-old/x.js", false],
    ["src/a/**", "src/b/**", false],
    ["src/a/*", "src/ab/*", false],
    ["mcp/**", "src/**", false],
    ["**", "anything/at/all.js", true],
    ["**/index.js", "src/core/index.js", true],
    ["**/index.js", "src/core/main.js", true], // main.js could be a folder holding index.js
    ["src/**/index.js", "lib/index.js", false],
    ["src/*/index.js", "src/a/b/index.js", false],
    ["src/*/index.js", "src/*/*.js", true],
    ["src/*.js", "src/*.ts", false],
    ["src/*.js", "src/app.js", true],
    ["SRC/Core/A.js", "src/core/a.js", true],
    ["src/?.js", "src/ab.js", false],
    ["src/?.js", "src/a.js", true],
    ["src/app.js", "src/app.jsx", false],
    ["*", "src/x.js", true],
    ["*.md", "src/x.js", false],
  ]) {
    assert.equal(claimPatternsOverlap(a, b), expected, `${a} vs ${b}`);
    assert.equal(claimPatternsOverlap(b, a), expected, `${b} vs ${a}`);
  }
});

test("overlap stays fast on long adversarial patterns", () => {
  const a = Array.from({ length: 40 }, () => "**/*a*").join("/");
  const b = Array.from({ length: 40 }, () => "*b*/**").join("/");
  const started = Date.now();
  assert.equal(claimPatternsOverlap(a, b), true);
  assert.equal(claimPatternsOverlap(`${"*".repeat(100)}x`, `${"*".repeat(100)}y`), false);
  assert.ok(Date.now() - started < 1000);
});
