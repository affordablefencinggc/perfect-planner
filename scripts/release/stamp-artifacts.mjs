// Release-only: copies the installers Tauri produced into one flat folder under
// stamped names (PerfectPlanner-<release>-v<version>-<commit>-<platform>.<ext>)
// and writes a SHA256SUMS file next to them. Never edits or deletes the bundle.
//
//   node scripts/release/stamp-artifacts.mjs --release R-2 --platform windows-x64 --out release-out
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []));
const release = args.release || "dry-run";
const platform = args.platform;
const out = path.resolve(root, args.out || "release-out");
if (!/^[A-Za-z0-9._-]+$/.test(release)) throw Error(`RELEASE_NAME_INVALID: ${release}`);
if (!/^[a-z0-9-]+$/.test(platform || "")) throw Error("PLATFORM_REQUIRED (e.g. --platform windows-x64)");

const version = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
const commit = (process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()).slice(0, 7);

// Installer formats Tauri can emit, by the extension we ship.
const shipped = [".msi", ".exe", ".dmg", ".deb", ".rpm", ".AppImage"];
const kind = (file) => (file.endsWith("-setup.exe") ? "setup.exe" : shipped.find((ext) => file.endsWith(ext))?.slice(1));

const bundleRoots = [path.join(root, "src-tauri/target/release/bundle")];
const targetDir = path.join(root, "src-tauri/target");
if (existsSync(targetDir)) for (const triple of readdirSync(targetDir)) bundleRoots.push(path.join(targetDir, triple, "release/bundle"));

const found = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const info = statSync(full);
    // .app bundles are directories; the .dmg already carries them.
    if (info.isDirectory()) { if (!name.endsWith(".app")) walk(full); }
    else if (kind(name)) found.push(full);
  }
};
for (const dir of bundleRoots) if (existsSync(dir)) walk(dir);
if (!found.length) throw Error(`NO_INSTALLERS_FOUND under ${bundleRoots.join(", ")}`);

mkdirSync(out, { recursive: true });
const sums = [];
for (const source of found) {
  const name = `PerfectPlanner-${release}-v${version}-${commit}-${platform}.${kind(path.basename(source))}`;
  const destination = path.join(out, name);
  if (existsSync(destination)) throw Error(`DUPLICATE_INSTALLER_NAME: ${name}`);
  copyFileSync(source, destination);
  const digest = createHash("sha256").update(readFileSync(destination)).digest("hex");
  sums.push(`${digest}  ${name}`);
  console.log(`${name}  ${(statSync(destination).size / 1048576).toFixed(1)} MB  sha256:${digest}`);
}
writeFileSync(path.join(out, `SHA256SUMS-${platform}.txt`), sums.join("\n") + "\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = sums.map((line) => { const [digest, name] = line.split("  "); return `| ${name} | ${(statSync(path.join(out, name)).size / 1048576).toFixed(1)} MB | \`${digest.slice(0, 16)}…\` |`; });
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${platform}\n\n| File | Size | SHA-256 |\n|---|---|---|\n${rows.join("\n")}\n`, { flag: "a" });
}
