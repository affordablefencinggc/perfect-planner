import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const styles = read("src/styles.css");

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function luminance(hex) {
  const [red, green, blue] = hexToRgb(hex).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function variable(name) {
  const match = styles.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `expected --${name} to be declared as a six-digit hex color`);
  return match[1];
}

test("secondary text tokens pass WCAG AA on every shared light surface", () => {
  const foregrounds = [variable("muted"), variable("muted-2")];
  const backgrounds = [variable("canvas"), variable("paper"), variable("paper-strong"), variable("header-surface")];

  for (const foreground of foregrounds) {
    for (const background of backgrounds) {
      assert.ok(
        contrast(foreground, background) >= 4.5,
        `${foreground} must have at least 4.5:1 contrast on ${background}`,
      );
    }
  }
});

test("late desktop grids cannot override the narrow single-column contract", () => {
  for (const selector of [
    ".blueprint-layout",
    ".component-plans-layout",
    ".collision-grid",
    ".integrity-grid",
    ".ledger-grid",
  ]) {
    const forcedDesktop = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*\\{[^}]*grid-template-columns:[^;}]+!important`,
      "s",
    );
    assert.equal(forcedDesktop.test(styles), false, `${selector} must not force its desktop columns with !important`);
  }

  assert.match(styles, /@media \(max-width: 1280px\)[\s\S]*?\.blueprint-layout,[\s\S]*?\.ledger-grid[\s\S]*?grid-template-columns: minmax\(0, 1fr\) !important;/);
  assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*?\.integrity-grid[\s\S]*?grid-template-columns: minmax\(0, 1fr\) !important;/);
});

test("shared chrome and each dedicated CSS surface declare a readable text floor", () => {
  assert.match(styles, /Release accessibility contract/);
  assert.match(styles, /font-size: 12px !important;/);
  assert.match(styles, /scrollbar-gutter: stable;/);

  for (const relativePath of [
    "src/components/BlueprintWorkspace.css",
    "src/components/ComponentPlansWorkspace.css",
    "src/components/StructureWorkspace.css",
  ]) {
    const css = read(relativePath);
    assert.match(css, /font-size: 12px !important;/, `${relativePath} needs a 12px information floor`);
    assert.match(css, /grid-template-columns: minmax\(0, 1fr\) !important;/, `${relativePath} needs an explicit narrow layout`);
  }
});

test("collapsed header keeps the More actions fallback and project targets usable", () => {
  assert.match(styles, /\.topbar-project-truth\s*\{[\s\S]*?display: none;/);
  assert.match(styles, /@media \(max-width: 2600px\)[\s\S]*?\.plan-identity\s*\{[\s\S]*?display: none;/);
  assert.match(styles, /@media \(max-width: 1800px\)[\s\S]*?\.top-metrics\s*\{[\s\S]*?display: flex;/);
  assert.match(styles, /@media \(max-width: 1800px\)[\s\S]*?\.plan-identity\s*\{[\s\S]*?display: none;/);
  assert.match(styles, /\.top-metrics > :not\(\.more-actions-anchor\)[\s\S]*?display: none;/);
  assert.match(styles, /\.responsive-topbar-action\s*\{[\s\S]*?display: grid !important;/);
  assert.doesNotMatch(styles, /\.responsive-topbar-action\s*\{\s*display: none !important;/);
  assert.match(styles, /\.project-tabs button\s*\{[\s\S]*?min-height: 32px;/);
});
