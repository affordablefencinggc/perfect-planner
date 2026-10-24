#!/usr/bin/env node
// Regenerates THIRD-PARTY-NOTICES.md at the repo root. Output has no timestamps,
// so the same inputs give the same file.
//
//   node scripts/generate-third-party-notices.mjs
//
// Inputs: package-lock.json (non-dev packages), src-tauri/Cargo.lock via
// `cargo metadata` (normal dependencies for the Windows and Linux targets),
// and scripts/desktop-node-runtime.json (the bundled Node runtime licence,
// downloaded and checked against the pinned sha256).
// Optional: --node-license-out <file> also writes the Node licence text (for the installer bundle).
// Optional: --licenses-out <file> writes the full licence text of every shipped npm package and Rust
// crate (read from node_modules and the local cargo registry cache; a crate whose files are not cached
// is listed with its SPDX id and its crates.io page). Run it at build time; the output is not committed.
// --skip-cargo leaves crates out, --no-notices skips rewriting THIRD-PARTY-NOTICES.md.
// Needs network for cargo (first run) and the Node licence text. Anything it
// cannot resolve is listed in the file under "Not resolved".
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const unresolved = [];
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);

// ---- npm
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const npm = [];
for (const [path, p] of Object.entries(lock.packages)) {
  if (!path || p.dev || p.link) continue;
  const name = p.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  let license = p.license;
  if (!license) { license = "unresolved"; unresolved.push(`npm ${name}@${p.version}: no license field in package-lock.json`); }
  npm.push({ dir: join(root, path), name, version: p.version, license: typeof license === "string" ? license : JSON.stringify(license) });
}
npm.sort(byName);

// ---- cargo
const cargo = new Map();
const tauri = join(root, "src-tauri");
let cargoOk = true;
for (const target of process.argv.includes("--skip-cargo") ? [] : ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]) {
  try {
    const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", target],
      { cwd: tauri, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }));
    const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const seen = new Set();
    const walk = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind === null)) walk(d.pkg);
    };
    walk(meta.resolve.root);
    for (const id of seen) {
      if (id === meta.resolve.root) continue;
      const p = pkgs.get(id);
      cargo.set(`${p.name}@${p.version}`, { dir: dirname(p.manifest_path), name: p.name, version: p.version, license: p.license ?? (p.license_file ? `see ${p.license_file}` : "unresolved") });
    }
  } catch {
    cargoOk = false;
    unresolved.push(`cargo metadata failed for ${target} (cargo missing or no network)`);
  }
}
if (!cargoOk && cargo.size === 0 && !process.argv.includes("--skip-cargo")) {
  const text = readFileSync(join(tauri, "Cargo.lock"), "utf8");
  for (const m of text.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\n(source = )?/g)) {
    if (m[3]) cargo.set(`${m[1]}@${m[2]}`, { name: m[1], version: m[2], license: "unresolved" });
  }
  unresolved.push("Rust crate licences: read names and versions from Cargo.lock only; licences not looked up");
}
for (const c of cargo.values()) if (c.license === "unresolved" || c.license.startsWith("see ")) unresolved.push(`crate ${c.name}@${c.version}: licence not in crate metadata`);
const crates = [...cargo.values()].sort(byName);

// ---- Node runtime
const rt = JSON.parse(readFileSync(join(root, "scripts/desktop-node-runtime.json"), "utf8"));
let nodeText = null;
try {
  if (!process.argv.includes("--node-license-out")) throw new Error("not requested");
  const res = await fetch(rt.license.url);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (createHash("sha256").update(buf).digest("hex") !== rt.license.sha256) throw new Error("sha256 mismatch");
  nodeText = buf.toString("utf8").trimEnd();
} catch (e) {
  if (process.argv.includes("--node-license-out")) unresolved.push(`Node ${rt.version} licence text not fetched (${e.message}); see ${rt.license.url}`);
}

const row = (p) => `| ${p.name.replace(/\|/g, "\\|")} | ${p.version} | ${p.license.replace(/\|/g, "\\|")} |`;
const out = [];
out.push(
  "# Third-party notices",
  "",
  "Perfect Planner includes the software below. Each part keeps its own licence.",
  "",
  "This file is generated. Do not edit it by hand. To regenerate it, run this from the repo root:",
  "",
  "```sh",
  "node scripts/generate-third-party-notices.mjs",
  "```",
  "",
  "The tables list each part's name, version and SPDX licence. The full licence texts ship with the installer in `THIRD-PARTY-LICENSES.txt` (inside the app's `desktop-host` folder, next to `NODE-LICENSE.txt`), written at build time by `node scripts/generate-third-party-notices.mjs --licenses-out <file> --no-notices`. That file is large, so it is not kept in git.",
  "",
  "It reads `package-lock.json`, `src-tauri/Cargo.lock` (through `cargo metadata`) and `scripts/desktop-node-runtime.json`. It needs `cargo` and network access. It is not part of any npm script or CI step.",
  "",
  "## Not resolved",
  "",
  ...(unresolved.length ? [...new Set(unresolved)].sort().map((u) => `- ${u}`) : ["Nothing. Every licence below came from the lockfile or crate metadata."]),
  "",
  `## Node.js runtime ${rt.version}`,
  "",
  `The installer bundles the Node.js runtime ${rt.version} (from ${rt.baseUrl}). Its full licence text is in the bundled \`NODE-LICENSE.txt\` and is also published at ${rt.license.url} (sha256 ${rt.license.sha256}). The full text is not kept in this file because it is large: the release build writes it next to the installer with \`node scripts/generate-third-party-notices.mjs --node-license-out <file>\`.`,
  "",
  `## npm packages (${npm.length})`,
  "",
  "Non-development packages in `package-lock.json`. Licence is the SPDX value the package declares.",
  "",
  "| Package | Version | Licence |",
  "|---|---|---|",
  ...npm.map(row),
  "",
  `## Rust crates (${crates.length})`,
  "",
  "Normal (non-build, non-dev) dependencies of the desktop app for Windows (x86_64-pc-windows-msvc) and Linux (x86_64-unknown-linux-gnu), from `src-tauri/Cargo.lock`.",
  "",
  "| Crate | Version | Licence |",
  "|---|---|---|",
  ...crates.map(row),
  "",
);
// ---- full licence texts (build-time output, not committed)
const licFlag = process.argv.indexOf("--licenses-out");
if (licFlag > 0 && process.argv[licFlag + 1]) {
  const licenseFiles = (dir) => {
    try { return readdirSync(dir).filter((f) => /^(licen[sc]e|copying|unlicense|notice)([-_.].*)?$/i.test(f)).sort().map((f) => readFileSync(join(dir, f), "utf8").trim()).filter(Boolean); } catch { return []; }
  };
  const sections = [];
  const missing = [];
  for (const [kind, list] of [["npm", npm], ["crate", crates]]) {
    for (const p of list) {
      const texts = p.dir ? [...new Set(licenseFiles(p.dir))] : [];
      if (!texts.length) {
        const where = kind === "npm" ? `https://www.npmjs.com/package/${p.name}/v/${p.version}` : `https://crates.io/crates/${p.name}/${p.version}`;
        missing.push(`${kind} ${p.name}@${p.version} (${p.license}): licence file not found locally; see ${where}`);
      } else sections.push(`${"=".repeat(78)}\n${kind} ${p.name}@${p.version}  (${p.license})\n${"=".repeat(78)}\n\n${texts.join("\n\n---\n\n")}\n`);
    }
  }
  const head = `Perfect Planner third-party licences\n\nThis file holds the full licence text of the software that ships with Perfect Planner. It is generated at build time from the installed packages. The Node.js runtime licence is in NODE-LICENSE.txt beside this file.\n\n${missing.length ? `Licence files not found locally (SPDX id and where to read the text):\n${missing.map((m) => `- ${m}`).join("\n")}\n\n` : ""}`;
  const dest = resolve(process.argv[licFlag + 1]);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, head + sections.join("\n"));
  console.log(`licence texts: ${sections.length} written, ${missing.length} not found locally -> ${dest}`);
}
if (process.argv.includes("--no-notices")) process.exit(0);
const flag = process.argv.indexOf("--node-license-out");
if (flag > 0 && process.argv[flag + 1]) {
  if (!nodeText) { console.error("Node licence text could not be fetched"); process.exit(1); }
  writeFileSync(process.argv[flag + 1], nodeText + "\n");
}
writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), out.join("\n"));
console.log(`THIRD-PARTY-NOTICES.md: ${npm.length} npm, ${crates.length} crates, ${unresolved.length} unresolved`);
