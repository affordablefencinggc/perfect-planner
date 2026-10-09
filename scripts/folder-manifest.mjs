#!/usr/bin/env node
// Builds a folder manifest for scripted intake (src/browser/scriptedIntake.js) from a real folder.
//
//   node scripts/folder-manifest.mjs <folder> [out.json]
//
// In a test: page.evaluate((m) => window.__ppTestIntake.queueFolder(m), await buildFolderManifest(dir)),
// then click "Choose app folder" and "Approve read-only analysis". The browser scan then applies
// .gitignore, the generated-folder exclusions and the size budgets itself; this helper only copies.
// To keep the manifest small it lists the contents of always-excluded folders (node_modules, dist, .git…)
// as empty folders, and files over maxFileBytes or named like credentials (.env, id_rsa, *.pem) as
// unreadable with their real size, which the scan skips exactly as it would skip them on disk.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSecretFileName } from "../src/shared/secretFiles.js";

export const MANIFEST_EMPTY_FOLDERS = Object.freeze([".git", ".next", ".turbo", ".cache", ".claude", ".ledger", ".local-preview-cache", ".perfect-planner", "_archive", "build", "coverage", "dist", "node_modules", "target", "target-codex"]);

export async function buildFolderManifest(root, { emptyFolders = MANIFEST_EMPTY_FOLDERS, maxFileBytes = 2_000_000, name = path.basename(path.resolve(root)) } = {}) {
  const skip = new Set(emptyFolders.map((entry) => entry.toLowerCase()));
  async function walk(dir, entryName, depth) {
    const children = [];
    if (depth > 0 && skip.has(entryName.toLowerCase())) return { kind: "directory", name: entryName, children };
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) children.push(await walk(full, entry.name, depth + 1));
      else if (entry.isFile()) {
        const info = await stat(full);
        const lastModified = Math.trunc(info.mtimeMs);
        // Credential files (.env, private keys) are listed by name and size only; their bytes never enter the manifest.
        if (info.size > maxFileBytes || isSecretFileName(entry.name)) children.push({ kind: "file", name: entry.name, size: info.size, lastModified, unreadable: true });
        else children.push({ kind: "file", name: entry.name, lastModified, contentBase64: (await readFile(full)).toString("base64") });
      }
      // Symlinks and special files are left out, as the browser picker does not follow them either.
    }
    return { kind: "directory", name: entryName, children };
  }
  return walk(path.resolve(root), name, 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, out] = process.argv.slice(2);
  if (!folder) {
    console.error("Usage: node scripts/folder-manifest.mjs <folder> [out.json]");
    process.exit(2);
  }
  const json = JSON.stringify(await buildFolderManifest(folder));
  if (out) await writeFile(out, json);
  else process.stdout.write(json);
}
