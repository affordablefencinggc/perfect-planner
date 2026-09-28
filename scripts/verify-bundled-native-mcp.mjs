import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const PROTOCOL = "2025-11-25";
const SERVICE = "perfect-planner-bundled-metadata";
const TOOL = "planner_registered_workspace_metadata";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const started = Date.now();
const fail = (code) => { throw Object.assign(new Error(code), { safeCode: code }); };
const requireThat = (condition, code) => { if (!condition) fail(code); };

async function noLinks(target, directory) {
  let cursor = target;
  for (;;) {
    const info = await lstat(cursor);
    requireThat(!info.isSymbolicLink(), "NATIVE_MCP_PATH_REFUSED");
    if (cursor === target) requireThat(directory ? info.isDirectory() : info.isFile(), "NATIVE_MCP_PATH_REFUSED");
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}

async function registrationAt(registry, workspaceId) {
  const target = path.join(registry, `${workspaceId}.json`);
  await noLinks(target, false);
  const before = await lstat(target);
  requireThat(before.size <= 16_384 && before.nlink === 1, "NATIVE_MCP_REGISTRATION_REFUSED");
  const source = await open(target, "r");
  try {
    const metadata = await source.stat();
    requireThat(metadata.isFile() && metadata.ino === before.ino && metadata.dev === before.dev, "NATIVE_MCP_REGISTRATION_REFUSED");
    const buffer = Buffer.alloc(16_385); let length = 0;
    while (length < buffer.length) { const result = await source.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await source.stat();
    requireThat(length <= 16_384 && length === metadata.size && metadata.size === after.size && metadata.mtimeMs === after.mtimeMs, "NATIVE_MCP_REGISTRATION_REFUSED");
    await noLinks(target, false);
    const final = await lstat(target);
    requireThat(final.ino === after.ino && final.dev === after.dev && final.size === after.size && final.mtimeMs === after.mtimeMs, "NATIVE_MCP_REGISTRATION_REFUSED");
    const value = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    requireThat(isDeepStrictEqual(Object.keys(value).sort(), ["access", "canonicalRoot", "registryRevision", "rootIdentity", "schemaVersion", "workspaceId"]), "NATIVE_MCP_REGISTRATION_REFUSED");
    requireThat(value.schemaVersion === 1 && value.workspaceId === workspaceId && value.access === "metadata-read-only"
      && Number.isInteger(value.registryRevision) && value.registryRevision > 0 && value.registryRevision < 0xffffffff
      && typeof value.canonicalRoot === "string" && path.isAbsolute(value.canonicalRoot)
      && /^[a-f0-9]{64}$/.test(value.rootIdentity)
      && createHash("sha256").update(value.canonicalRoot).digest("hex") === value.rootIdentity, "NATIVE_MCP_REGISTRATION_REFUSED");
    return value;
  } finally { await source.close(); }
}

let client; let transport; let closed = false; let closeSignal; let timer; let failure; let result;
const closePromise = new Promise((resolve) => { closeSignal = resolve; });
const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("NATIVE_MCP_TIMEOUT"), { safeCode: "NATIVE_MCP_TIMEOUT" })), 12_000); });
async function bounded(promise) { return Promise.race([promise, deadline]); }

try {
  requireThat(process.argv.length === 2, "NATIVE_MCP_ARGUMENTS_REFUSED");
  const workspaceId = process.env.PERFECT_PLANNER_WORKSPACE_ID;
  requireThat(typeof workspaceId === "string" && /^[A-Za-z0-9_-]{3,64}$/.test(workspaceId), "NATIVE_MCP_EXPLICIT_WORKSPACE_REQUIRED");
  const registryInput = process.env.PERFECT_PLANNER_REGISTRY_ROOT
    ?? (process.env.APPDATA ? path.join(process.env.APPDATA, "com.perfectplanner.desktop", "workspace-registry-v1") : null);
  requireThat(typeof registryInput === "string" && path.isAbsolute(registryInput), "NATIVE_MCP_REGISTRY_REQUIRED");
  // Resolve Windows app-data virtualization without rewriting the registration's
  // Rust-produced slash/extended-path identity or choosing a different project.
  const registry = await bounded(realpath(registryInput));
  await bounded(noLinks(registry, true));
  const registration = await bounded(registrationAt(registry, workspaceId));
  const executable = path.join(projectRoot, "src-tauri", "target", "release", process.platform === "win32" ? "perfect-planner-desktop.exe" : "perfect-planner-desktop");
  await bounded(noLinks(executable, false));
  let protocol = null; let receivedBytes = 0; let receivedMessages = 0;
  transport = new StdioClientTransport({ command: executable, args: ["--planner-mcp-stdio", "--registry-root", registry], cwd: projectRoot, stderr: "pipe", maxBufferSize: 16_384 });
  transport.setProtocolVersion = (value) => { protocol = value; };
  transport.onclose = () => { closed = true; closeSignal(); };
  transport.onmessage = (message) => {
    receivedMessages += 1; receivedBytes += Buffer.byteLength(JSON.stringify(message));
    if (receivedMessages > 16 || receivedBytes > 131_072) { failure = "NATIVE_MCP_OUTPUT_LIMIT"; void transport.close(); }
  };
  let stderrBytes = 0;
  transport.stderr?.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 16_384) { failure = "NATIVE_MCP_OUTPUT_LIMIT"; void transport.close(); } });
  client = new Client({ name: "perfect-planner-native-verifier", version: "1" }, { capabilities: {} });
  client.onerror = () => {}; // Diagnostics are summarized below, never print raw protocol or filesystem errors.
  await bounded(client.connect(transport));
  requireThat(protocol === PROTOCOL && client.getServerVersion()?.name === SERVICE && isDeepStrictEqual(client.getServerCapabilities(), { tools: { listChanged: false } }), "NATIVE_MCP_PROTOCOL_MISMATCH");
  const listed = await bounded(client.listTools());
  requireThat(listed.tools?.length === 1 && listed.tools[0].name === TOOL && !listed.nextCursor, "NATIVE_MCP_TOOLS_MISMATCH");
  const tool = listed.tools[0];
  requireThat(isDeepStrictEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    && isDeepStrictEqual(tool.inputSchema, { type: "object", additionalProperties: false, required: ["workspaceId", "registryRevision", "rootIdentity"], properties: { workspaceId: { type: "string", minLength: 3, maxLength: 64 }, registryRevision: { type: "integer", minimum: 1 }, rootIdentity: { type: "string", pattern: "^[a-f0-9]{64}$" } } }), "NATIVE_MCP_TOOLS_MISMATCH");
  const args = { workspaceId, registryRevision: registration.registryRevision, rootIdentity: registration.rootIdentity };
  const response = await bounded(client.callTool({ name: TOOL, arguments: args }));
  const expected = { schemaVersion: 1, ...args, access: "metadata-read-only", contentReturned: false, executionAuthorized: false };
  requireThat(response.isError === false && isDeepStrictEqual(response.structuredContent, expected), "NATIVE_MCP_METADATA_MISMATCH");
  requireThat(response.content?.length === 1 && response.content[0].type === "text" && isDeepStrictEqual(JSON.parse(response.content[0].text), expected), "NATIVE_MCP_METADATA_MISMATCH");
  const stale = await bounded(client.callTool({ name: TOOL, arguments: { ...args, registryRevision: args.registryRevision + 1 } }));
  requireThat(stale.isError === true && !stale.structuredContent && isDeepStrictEqual(stale.content, [{ type: "text", text: "Workspace registration is unavailable or stale." }]), "NATIVE_MCP_STALE_BINDING_ACCEPTED");
  requireThat(!failure, failure ?? "NATIVE_MCP_FAILED");
  result = { state: "verified", scope: "packaged-helper-stdio-only", guiIpcVerified: false, protocolVersion: protocol, service: SERVICE, workspaceId, registryRevision: args.registryRevision,
    metadataOnly: true, contentReturned: false, executionAuthorized: false, computerUse: false, toolNames: [TOOL], staleRevisionRejected: true };
} catch (error) {
  failure ??= error?.safeCode ?? "NATIVE_MCP_FAILED";
} finally {
  clearTimeout(timer);
  if (client) {
    let cleanupTimer;
    try {
      await Promise.race([Promise.resolve().then(() => client.close()).then(() => closed ? undefined : closePromise), new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error("cleanup")), 5_000); })]);
    } catch { failure = "NATIVE_MCP_CLEANUP_UNCONFIRMED"; }
    finally { clearTimeout(cleanupTimer); }
  }
  const cleanupComplete = !transport || closed;
  if (!cleanupComplete) failure = "NATIVE_MCP_CLEANUP_UNCONFIRMED";
  process.stdout.write(`${JSON.stringify(failure ? { state: "failed", code: failure, scope: "packaged-helper-stdio-only", guiIpcVerified: false, cleanupComplete, durationMs: Date.now() - started }
    : { ...result, cleanupComplete, durationMs: Date.now() - started }, null, 2)}\n`);
  process.exitCode = failure ? 1 : 0;
}
