#!/usr/bin/env node
// Builds what the desktop installers ship next to the app so the core loop (Tasks,
// Connect agent, the agents' MCP bridge) works with no Node install of the person's own:
//   dist/desktop-host/node[.exe]        Node runtime, pinned and checksum-verified (desktop-node-runtime.json)
//   dist/desktop-host/NODE-LICENSE.txt  its license
//   dist/desktop-host/core-host/        desktop.mjs (the service), index.mjs, agent.mjs, connect.mjs, hooks/, skill/
//                                     fully bundled: no node_modules needed
//   dist/desktop-host/client/           the built app (dist/client), served by desktop.mjs
//   dist/desktop-host/desktop-host.json what was built, for the shell and the release checks
// The installers ship this folder as resources/desktop-host (tauri.conf.json bundle.resources);
// src-tauri/build.rs makes it empty when missing, so plain cargo builds and tests still work.
// Run by Tauri's beforeBuildCommand after build:client. The target comes from
// TAURI_ENV_TARGET_TRIPLE (set by `tauri build`, including --target), else this machine.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { buildCoreHost } from "./build-core-host.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DESKTOP_HOST_OUT = path.join(projectRoot, "dist", "desktop-host");
export const RUNTIME = JSON.parse(readFileSync(path.join(projectRoot, "scripts", "desktop-node-runtime.json"), "utf8"));
const CACHE = path.join(projectRoot, "node_modules", ".cache", "perfect-planner-node-runtime");

/** This machine's Rust target triple, for builds without TAURI_ENV_TARGET_TRIPLE. */
export function hostTriple(platform = process.platform, arch = process.arch) {
  const cpu = { x64: "x86_64", arm64: "aarch64" }[arch];
  const os = { win32: "pc-windows-msvc", darwin: "apple-darwin", linux: "unknown-linux-gnu" }[platform];
  if (!cpu || !os) throw new Error(`No bundled Node runtime for ${platform}-${arch}.`);
  return `${cpu}-${os}`;
}

/** The pinned download for a target, and where its node binary lands in the app. */
export function runtimeFor(triple, runtime = RUNTIME) {
  const entry = runtime.targets[triple];
  if (!entry) throw new Error(`No bundled Node runtime is pinned for ${triple}. Add it to scripts/desktop-node-runtime.json.`);
  const windows = triple.includes("windows");
  const archive = entry.file.endsWith(".tar.gz");
  return {
    url: new URL(entry.file, runtime.baseUrl).href,
    sha256: entry.sha256,
    cacheName: entry.file.replaceAll("/", "-"),
    binary: windows ? "node.exe" : "node",
    // Inside the official tarball the binary is <folder>/bin/node.
    member: archive ? `${path.posix.basename(entry.file, ".tar.gz")}/bin/node` : null,
  };
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Refuses anything but the exact pinned bytes. */
export function verified(bytes, expected, label) {
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${label} does not match its pinned checksum (expected ${expected}, got ${actual}). Refusing to bundle it.`);
  return bytes;
}

/** One regular file out of a .tar (ustar or GNU, as nodejs.org publishes). */
export function extractTarMember(tar, member) {
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const body = offset + 512;
    if ((type === "0" || type === "\0") && name === member) return Buffer.from(tar.subarray(body, body + size));
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${member} is not in the Node archive.`);
}

async function download(url, sha, cacheName) {
  const cached = path.join(CACHE, cacheName);
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    if (sha256(bytes) === sha) return bytes;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ${url} failed (${response.status}).`);
  const bytes = verified(Buffer.from(await response.arrayBuffer()), sha, url);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, bytes);
  return bytes;
}

export async function buildDesktopHost({ triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple(), out = DESKTOP_HOST_OUT, client = path.join(projectRoot, "dist", "client") } = {}) {
  if (!existsSync(path.join(client, "index.html"))) throw new Error(`${client} has no built app. Run npm run build:client first.`);
  const runtime = runtimeFor(triple);
  const downloaded = await download(runtime.url, runtime.sha256, runtime.cacheName);
  const node = runtime.member ? extractTarMember(gunzipSync(downloaded), runtime.member) : downloaded;
  const license = await download(RUNTIME.license.url, RUNTIME.license.sha256, `LICENSE-${RUNTIME.version}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, runtime.binary), node);
  if (!runtime.binary.endsWith(".exe")) chmodSync(path.join(out, runtime.binary), 0o755);
  writeFileSync(path.join(out, "NODE-LICENSE.txt"), license);
  await buildCoreHost({ outDir: path.join(out, "core-host"), standalone: true, entries: { desktop: path.join(projectRoot, "src/node/desktopHost.mjs") } });
  cpSync(client, path.join(out, "client"), { recursive: true });
  const manifest = { target: triple, node: { version: RUNTIME.version, binary: runtime.binary, sha256: sha256(node) }, entry: "core-host/desktop.mjs", client: "client" };
  writeFileSync(path.join(out, "desktop-host.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, ...manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDesktopHost().then(
    (result) => console.log(`[perfect-planner] Desktop host for ${result.target} (Node ${result.node.version}) built in ${result.out}`),
    (error) => { console.error(`[perfect-planner] ${error.message}`); process.exit(1); },
  );
}
