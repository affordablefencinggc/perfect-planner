import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { readGitWorkspaceInventory } from "../src/node/gitWorkspaceInventory.mjs";
import { inspectMergeRecoveryCatalog, inspectMergeRecoveryPage } from '../src/node/mergeTransactionStore.mjs';

import { buildWorkspaceDiscovery, buildWorkspaceStructureTree } from "../src/engine/workspaceDiscoveryEngine.js";
import {
  MCP_OPERATION_LIMITS,
  readOpenRegularFile,
  runBoundedMcpOperation,
  scanWorkspaceSnapshot,
} from "./boundedWorkspaceScan.mjs";

const WORKSPACE_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SEARCH_RESULTS = 200;
const MAX_REGISTRY_ENTRIES = 2_000;
const MAX_REGISTRY_RECORD_BYTES = 64 * 1024;
const REGISTRATION_FIELDS = Object.freeze([
  "access", "canonicalRoot", "registryRevision", "rootIdentity", "schemaVersion", "workspaceId",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function mcpError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function usableWindowsPath(value) {
  const text = String(value ?? "");
  if (/^\\\\\?\\UNC\\/i.test(text)) return `\\\\${text.slice(8)}`;
  if (/^\/\/\?\/UNC\//i.test(text)) return `//${text.slice(8)}`;
  if (text.startsWith("\\\\?\\") || text.startsWith("//?/")) return text.slice(4);
  return text;
}

function comparablePath(value) {
  let normalized = path.resolve(usableWindowsPath(value)).replaceAll("\\", "/").normalize("NFC");
  normalized = normalized.replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertWorkspaceId(value) {
  if (!WORKSPACE_ID.test(String(value ?? ""))) throw mcpError("MCP_WORKSPACE_ID_INVALID", "A registered workspace id is required.");
  return String(value);
}

function statsStamp(stats) {
  return Object.freeze({
    dev: String(stats.dev), ino: String(stats.ino), size: stats.size,
    mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs,
    kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "other",
  });
}

function sameStats(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.kind === right.kind;
}

function entryKind(entry) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function entrySignature(entries) {
  return entries.map((entry) => `${entry.name}\u0000${entryKind(entry)}`).sort((left, right) => left.localeCompare(right));
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function assertCanonicalDirectory(directory, label, operation) {
  operation.check();
  let stats;
  let real;
  try {
    stats = await lstat(directory, { bigint: false });
    real = await realpath(directory);
  } catch (error) {
    throw mcpError("MCP_DIRECTORY_UNAVAILABLE", `${label} is unavailable.`, error);
  }
  operation.check();
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw mcpError("MCP_DIRECTORY_REFUSED", `${label} is not a regular directory.`);
  if (comparablePath(directory) !== comparablePath(real)) {
    throw mcpError("MCP_DIRECTORY_REDIRECTION_REFUSED", `${label} resolves through a redirected path.`);
  }
  return Object.freeze({ path: path.resolve(directory), realPath: real, stamp: statsStamp(stats) });
}

function exactRegistration(record, workspaceId) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw mcpError("MCP_REGISTRY_ENTRY_INVALID", `Workspace registry entry ${workspaceId}.json is invalid.`);
  }
  const fields = Object.keys(record).sort((left, right) => left.localeCompare(right));
  if (!sameList(fields, [...REGISTRATION_FIELDS].sort((left, right) => left.localeCompare(right)))) {
    throw mcpError("MCP_REGISTRY_ENTRY_INVALID", `Workspace registry entry ${workspaceId}.json has an invalid schema.`);
  }
  if (record.schemaVersion !== 1 || record.workspaceId !== workspaceId || record.access !== "metadata-read-only"
    || !Number.isSafeInteger(record.registryRevision) || record.registryRevision < 1
    || typeof record.canonicalRoot !== "string" || record.canonicalRoot.length < 3
    || record.canonicalRoot.length > MCP_OPERATION_LIMITS.maxPathCharacters
    || /[\u0000-\u001f\u007f]/.test(record.canonicalRoot) || !SHA256.test(record.rootIdentity)) {
    throw mcpError("MCP_REGISTRY_ENTRY_INVALID", `Workspace registry entry ${workspaceId}.json is invalid.`);
  }
  if (sha256(record.canonicalRoot) !== record.rootIdentity) {
    throw mcpError("MCP_ROOT_IDENTITY_INVALID", `Workspace identity ${workspaceId} no longer verifies.`);
  }
  const portableRoot = usableWindowsPath(record.canonicalRoot).replaceAll("\\", "/");
  const rootParts = portableRoot.split("/").filter(Boolean);
  if (!path.isAbsolute(usableWindowsPath(record.canonicalRoot)) || rootParts.some((part) => part === "." || part === "..")) {
    throw mcpError("MCP_ROOT_REDIRECTION_REFUSED", `Registered workspace ${workspaceId} does not contain a canonical absolute root.`);
  }
  return record;
}

async function inspectRegistryRoot(registryRoot, operation) {
  if (typeof registryRoot !== "string" || !registryRoot.trim()) {
    throw mcpError("MCP_REGISTRY_ROOT_REQUIRED", "Perfect Planner registry root is required.");
  }
  const root = path.resolve(registryRoot);
  const canonical = await assertCanonicalDirectory(root, "Perfect Planner registry root", operation);
  const entries = await readdir(root, { withFileTypes: true });
  operation.check();
  if (entries.length > MAX_REGISTRY_ENTRIES) throw mcpError("MCP_REGISTRY_ENTRY_LIMIT", `Workspace registry exceeded ${MAX_REGISTRY_ENTRIES} entries.`);
  return Object.freeze({ root, canonical, entries, signature: entrySignature(entries) });
}

async function verifyRegistryRoot(snapshot, operation) {
  operation.check();
  const current = await assertCanonicalDirectory(snapshot.root, "Perfect Planner registry root", operation);
  const entries = await readdir(snapshot.root, { withFileTypes: true });
  operation.check();
  if (comparablePath(current.realPath) !== comparablePath(snapshot.canonical.realPath)
    || !sameStats(current.stamp, snapshot.canonical.stamp)
    || !sameList(entrySignature(entries), snapshot.signature)) {
    throw mcpError("MCP_REGISTRY_CHANGED", "Perfect Planner registry changed during the operation.");
  }
}

async function readWorkspaceRecord(registryRoot, workspaceId, operation) {
  const id = assertWorkspaceId(workspaceId);
  const recordPath = path.join(registryRoot, `${id}.json`);
  let stats;
  try {
    stats = await lstat(recordPath, { bigint: false });
  } catch (error) {
    throw mcpError("MCP_WORKSPACE_NOT_REGISTERED", `Workspace ${id} is not registered in Perfect Planner.`, error);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw mcpError("MCP_REGISTRY_ENTRY_REFUSED", `Workspace registry entry ${id}.json was refused.`);
  if (stats.size > MAX_REGISTRY_RECORD_BYTES) {
    throw mcpError("MCP_REGISTRY_RECORD_LIMIT", `Workspace registry entry ${id}.json exceeded ${MAX_REGISTRY_RECORD_BYTES} bytes.`);
  }
  const bytes = await readOpenRegularFile(recordPath, stats, operation, `workspace registry entry ${id}.json`);
  let record;
  try {
    record = exactRegistration(JSON.parse(bytes.toString("utf8")), id);
  } catch (error) {
    if (error?.code) throw error;
    throw mcpError("MCP_REGISTRY_ENTRY_INVALID", `Workspace registry entry ${id}.json is invalid.`, error);
  }
  const canonicalRoot = path.resolve(usableWindowsPath(record.canonicalRoot));
  const root = await assertCanonicalDirectory(canonicalRoot, `Registered workspace ${id}`, operation);
  if (comparablePath(canonicalRoot) !== comparablePath(root.realPath)) {
    throw mcpError("MCP_ROOT_REDIRECTION_REFUSED", `Registered workspace ${id} no longer resolves to its canonical root.`);
  }
  const workspace = Object.freeze({
    workspaceId: id, registryRevision: record.registryRevision, canonicalRoot,
    rootIdentity: record.rootIdentity, access: record.access,
  });
  return Object.freeze({ workspace, recordDigest: sha256(bytes), recordStamp: statsStamp(stats) });
}

function sameWorkspace(left, right) {
  return left.workspaceId === right.workspaceId && left.registryRevision === right.registryRevision
    && left.rootIdentity === right.rootIdentity && left.access === right.access
    && comparablePath(left.canonicalRoot) === comparablePath(right.canonicalRoot);
}

function operationBoundary(error) {
  return ["MCP_OPERATION_TIMEOUT", "MCP_OPERATION_CANCELLED", "MCP_OPERATION_BYTE_LIMIT",
    "MCP_OPERATION_INVALID_SIZE", "MCP_REGISTRY_CHANGED"].includes(error?.code);
}

async function registeredWorkspaceInventory(registryRoot, operation) {
  const rootSnapshot = await inspectRegistryRoot(registryRoot, operation);
  const workspaces = [];
  const accepted = [];
  const issues = [];
  const entries = [...rootSnapshot.entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const workspaceId = entry.name.slice(0, -5);
    try {
      if (!entry.isFile()) throw mcpError("MCP_REGISTRY_ENTRY_REFUSED", `Workspace registry entry ${entry.name} was refused.`);
      assertWorkspaceId(workspaceId);
      const result = await readWorkspaceRecord(rootSnapshot.root, workspaceId, operation);
      workspaces.push(result.workspace);
      accepted.push(result);
    } catch (error) {
      if (operationBoundary(error)) throw error;
      issues.push(Object.freeze({
        entry: entry.name.slice(0, 128), code: String(error?.code ?? "MCP_REGISTRY_ENTRY_INVALID"),
        reason: "Registry entry was isolated because it did not verify.",
      }));
    }
  }
  await verifyRegistryRoot(rootSnapshot, operation);
  for (const prior of accepted) {
    const current = await readWorkspaceRecord(rootSnapshot.root, prior.workspace.workspaceId, operation);
    if (current.recordDigest !== prior.recordDigest || !sameStats(current.recordStamp, prior.recordStamp)
      || !sameWorkspace(current.workspace, prior.workspace)) {
      throw mcpError("MCP_REGISTRY_CHANGED", "Perfect Planner registry changed during the operation.");
    }
  }
  await verifyRegistryRoot(rootSnapshot, operation);
  workspaces.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  return Object.freeze({ schemaVersion: 1, workspaces: Object.freeze(workspaces), issues: Object.freeze(issues) });
}

export async function inspectRegisteredWorkspaceInventory(registryRoot, options = {}) {
  return runBoundedMcpOperation(options, (operation) => registeredWorkspaceInventory(registryRoot, operation));
}

export async function readRegisteredWorkspaces(registryRoot, options = {}) {
  return (await inspectRegisteredWorkspaceInventory(registryRoot, options)).workspaces;
}

async function resolveInsideOperation(registryRoot, workspaceId, operation) {
  const rootSnapshot = await inspectRegistryRoot(registryRoot, operation);
  const result = await readWorkspaceRecord(rootSnapshot.root, workspaceId, operation);
  await verifyRegistryRoot(rootSnapshot, operation);
  return Object.freeze({ rootSnapshot, ...result });
}

export async function resolveRegisteredWorkspace(registryRoot, workspaceId, options = {}) {
  return runBoundedMcpOperation(options, async (operation) => (await resolveInsideOperation(registryRoot, workspaceId, operation)).workspace);
}

let gitInventoryActive = false;
let gitProcessUncertain = false;
export async function inspectRegisteredGitWorkspace(registryRoot, workspaceId, binding, options = {}) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || Object.keys(binding).sort().join(",") !== "registryRevision,rootIdentity"
    || !Number.isSafeInteger(binding.registryRevision) || binding.registryRevision < 1 || typeof binding.rootIdentity !== "string" || !SHA256.test(binding.rootIdentity)) {
    throw mcpError("MCP_GIT_BINDING_INVALID", "An exact workspace registration revision and root identity are required.");
  }
  const expected = Object.freeze({ ...binding });
  if (gitProcessUncertain) throw mcpError("MCP_GIT_PROCESS_UNCERTAIN", "A prior Git helper did not confirm cleanup; runtime reconciliation is required.");
  if (gitInventoryActive) throw mcpError("MCP_GIT_BUSY", "A repository inventory is already running; retry after it completes.");
  gitInventoryActive = true;
  try {
    return await runBoundedMcpOperation(options, async (operation) => {
      const resolved = await resolveInsideOperation(registryRoot, workspaceId, operation);
      if (resolved.workspace.registryRevision !== expected.registryRevision || resolved.workspace.rootIdentity !== expected.rootIdentity) {
        throw mcpError("MCP_GIT_BINDING_STALE", "Workspace registration changed; obtain the current registered identity before retrying.");
      }
      const observation = await readGitWorkspaceInventory(resolved.workspace.canonicalRoot, { ...options, check: operation.check });
      await revalidateResolvedWorkspace(resolved, operation);
      operation.check();
      return Object.freeze({ schemaVersion: 1, workspace: resolved.workspace, observation });
    });
  } catch (error) {
    if (error?.code === "MCP_GIT_PROCESS_UNCERTAIN") gitProcessUncertain = true;
    throw error;
  } finally { gitInventoryActive = false; }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

// Internal read-only bridge. registryRoot/catalogRoot come from host authority,
// never from a tool request. This does not register/adopt any external store.
export async function inspectRegisteredMergeRecovery(registryRoot, catalogRoot, workspaceId, request, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join(',') !== 'catalogHead,cursor,registryRevision,rootIdentity,storeId') {
    throw mcpError('MCP_RECOVERY_REQUEST_INVALID', 'An exact recovery inspection request is required.');
  }
  let expected;
  try { expected = structuredClone(request); }
  catch { throw mcpError('MCP_RECOVERY_REQUEST_INVALID', 'An exact recovery inspection request is required.'); }
  if (!Number.isSafeInteger(expected.registryRevision) || expected.registryRevision < 1
    || typeof expected.rootIdentity !== 'string' || !SHA256.test(expected.rootIdentity)
    || (expected.storeId === null ? expected.catalogHead !== null || expected.cursor !== null
      : typeof expected.storeId !== 'string' || !SHA256.test(expected.storeId) || typeof expected.catalogHead !== 'string' || !SHA256.test(expected.catalogHead))
    || (expected.cursor !== null && (!expected.cursor || typeof expected.cursor !== 'object' || Array.isArray(expected.cursor)
      || Object.keys(expected.cursor).sort().join(',') !== 'listingDigest,offset'
      || typeof expected.cursor.listingDigest !== 'string' || !SHA256.test(expected.cursor.listingDigest)
      || !Number.isSafeInteger(expected.cursor.offset) || expected.cursor.offset < 0))) {
    throw mcpError('MCP_RECOVERY_REQUEST_INVALID', 'Recovery binding or cursor is invalid.');
  }
  try { return await runBoundedMcpOperation(options, async operation => {
    const resolved = await resolveInsideOperation(registryRoot, workspaceId, operation);
    if (resolved.workspace.registryRevision !== expected.registryRevision || resolved.workspace.rootIdentity !== expected.rootIdentity) {
      throw mcpError('MCP_RECOVERY_BINDING_STALE', 'The workspace registration must be refreshed.');
    }
    const catalog = await inspectMergeRecoveryCatalog({ catalogRoot, repositoryRoot: resolved.workspace.canonicalRoot });
    operation.check();
    let page = null;
    if (expected.storeId !== null) {
      if (catalog.status !== 'registered' || catalog.head !== expected.catalogHead) throw mcpError('MCP_RECOVERY_CATALOG_STALE', 'Refresh the recovery catalog before continuing.');
      const store = catalog.stores.find(entry => entry.storeId === expected.storeId);
      if (!store) throw mcpError('MCP_RECOVERY_STORE_UNKNOWN', 'The selected store is not registered for this repository.');
      page = await inspectMergeRecoveryPage({ storeRoot: store.storeRoot, repositoryRoot: resolved.workspace.canonicalRoot, cursor: expected.cursor, signal: options.signal });
    }
    const after = await inspectMergeRecoveryCatalog({ catalogRoot, repositoryRoot: resolved.workspace.canonicalRoot });
    if (after.status !== catalog.status || after.head !== catalog.head) throw mcpError('MCP_RECOVERY_CATALOG_CHANGED', 'The recovery catalog changed during inspection.');
    await revalidateResolvedWorkspace(resolved, operation); operation.check();
    return Object.freeze({ schemaVersion: 1,
      workspace: Object.freeze({ workspaceId: resolved.workspace.workspaceId, registryRevision: resolved.workspace.registryRevision, rootIdentity: resolved.workspace.rootIdentity }),
      observation: Object.freeze({ kind: 'merge-recovery', status: catalog.status === 'unconfigured' ? 'unconfigured' : page ? 'page-observed' : 'catalog-observed',
        coverage: catalog.coverage, catalogHead: catalog.head, stores: Object.freeze(catalog.stores.map(store => Object.freeze({ storeId: store.storeId }))),
        selectedStoreId: expected.storeId, page, metadataOnly: true, executionAuthorized: false, canAutomaticallyDelete: false, promotionAuthority: false }) });
  }); } catch (error) {
    const safeCodes = new Set(['MCP_RECOVERY_BINDING_STALE', 'MCP_RECOVERY_CATALOG_STALE', 'MCP_RECOVERY_STORE_UNKNOWN', 'MCP_RECOVERY_CATALOG_CHANGED', 'MCP_OPERATION_TIMEOUT', 'MCP_OPERATION_CANCELLED']);
    const code = safeCodes.has(error?.code) ? error.code : 'MCP_RECOVERY_UNAVAILABLE';
    // Do not retain a cause: native/filesystem/parser messages can contain paths
    // or malformed journal bytes even when the successful payload is redacted.
    throw mcpError(code, 'Recovery inspection could not be verified. No recovery actions were taken.');
  }
}

function compactTree(root, maxDepth, maxNodes) {
  let emitted = 0;
  let truncated = false;
  const visit = (node) => {
    if (emitted >= maxNodes) { truncated = true; return null; }
    emitted += 1;
    const result = {
      id: node.id, kind: node.kind, name: node.name, path: node.path,
      fileCount: node.files.length,
      files: node.files.slice(0, 20).map((file) => ({ path: file.path, category: file.category })), children: [],
    };
    if (node.depth < maxDepth) {
      result.children = node.children.map(visit).filter(Boolean);
      if (node.children.length > result.children.length) truncated = true;
    } else if (node.children.length) truncated = true;
    return result;
  };
  return { root: visit(root), emittedNodes: emitted, truncated };
}

async function revalidateResolvedWorkspace(resolved, operation) {
  const current = await readWorkspaceRecord(resolved.rootSnapshot.root, resolved.workspace.workspaceId, operation);
  if (current.recordDigest !== resolved.recordDigest || !sameStats(current.recordStamp, resolved.recordStamp)
    || !sameWorkspace(current.workspace, resolved.workspace)) {
    throw mcpError("MCP_REGISTRY_CHANGED", "Workspace registration changed during the operation.");
  }
  await verifyRegistryRoot(resolved.rootSnapshot, operation);
}

export async function mapRegisteredWorkspace(registryRoot, workspaceId, options = {}) {
  return runBoundedMcpOperation(options, async (operation) => {
    const resolved = await resolveInsideOperation(registryRoot, workspaceId, operation);
    const { workspace } = resolved;
    const { census } = await scanWorkspaceSnapshot(workspace.canonicalRoot, {
      maxFiles: boundedInteger(options.maxFiles, MCP_OPERATION_LIMITS.maxFiles, 1, MCP_OPERATION_LIMITS.maxFiles),
      maxFileBytes: MCP_OPERATION_LIMITS.maxFileBytes, maxDirectories: options.maxDirectories,
      maxEntries: options.maxEntries, maxScanDepth: options.maxScanDepth, onProgress: options.onProgress,
    }, operation);
    const appName = path.basename(workspace.canonicalRoot);
    const discovery = buildWorkspaceDiscovery(census, { appName });
    const tree = buildWorkspaceStructureTree(census, { appName });
    operation.check();
    const compact = compactTree(tree.root, boundedInteger(options.maxDepth, 5, 1, 12), boundedInteger(options.maxNodes, 400, 10, 2_000));
    await revalidateResolvedWorkspace(resolved, operation);
    return Object.freeze({
      schemaVersion: 1, workspace,
      census: Object.freeze({
        generatedAt: census.generatedAt, fileCount: census.fileCount, totalBytesHashed: census.totalBytesHashed,
        summary: census.summary, skipped: census.skipped, digest: census.digest, scope: census.scope,
      }),
      discovery,
      structure: Object.freeze({ directoryCount: tree.directoryCount, fileCount: tree.fileCount, nodeCount: tree.nodeCount, ...compact }),
      limits: Object.freeze({ aggregateBytes: operation.maxAggregateBytes, maxFileBytes: MCP_OPERATION_LIMITS.maxFileBytes, maxFiles: MCP_OPERATION_LIMITS.maxFiles }),
    });
  });
}

function linePreview(value, query, caseSensitive) {
  const source = caseSensitive ? value : value.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const index = source.indexOf(needle);
  if (index < 0) return null;
  const start = Math.max(0, index - 100);
  const end = Math.min(value.length, index + query.length + 140);
  return value.slice(start, end).trim();
}

export async function searchRegisteredWorkspace(registryRoot, workspaceId, query, options = {}) {
  return runBoundedMcpOperation(options, async (operation) => {
    const needle = String(query ?? "").trim();
    if (needle.length < 2 || needle.length > 200) throw mcpError("MCP_SEARCH_QUERY_INVALID", "Search text must contain 2-200 characters.");
    const resolved = await resolveInsideOperation(registryRoot, workspaceId, operation);
    const { workspace } = resolved;
    const scan = await scanWorkspaceSnapshot(workspace.canonicalRoot, {
      maxFiles: boundedInteger(options.maxFiles, MCP_OPERATION_LIMITS.maxFiles, 1, MCP_OPERATION_LIMITS.maxFiles),
      maxFileBytes: MCP_OPERATION_LIMITS.maxFileBytes, maxDirectories: options.maxDirectories,
      maxEntries: options.maxEntries, maxScanDepth: options.maxScanDepth, retainContent: true, onProgress: options.onProgress,
    }, operation);
    const maxResults = boundedInteger(options.maxResults, 50, 1, MAX_SEARCH_RESULTS);
    const caseSensitive = options.caseSensitive === true;
    const matches = [];
    for (const file of scan.census.files) {
      operation.check();
      if (matches.length >= maxResults) break;
      const lines = scan.contentByPath.get(file.path).toString("utf8").split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length && matches.length < maxResults; lineIndex += 1) {
        const preview = linePreview(lines[lineIndex], needle, caseSensitive);
        if (preview !== null) matches.push(Object.freeze({ path: file.path, line: lineIndex + 1, preview }));
      }
    }
    await revalidateResolvedWorkspace(resolved, operation);
    return Object.freeze({
      schemaVersion: 1, workspaceId: workspace.workspaceId, rootIdentity: workspace.rootIdentity,
      query: needle, caseSensitive, matchCount: matches.length, capped: matches.length >= maxResults,
      matches: Object.freeze(matches), limits: Object.freeze({ aggregateBytes: operation.maxAggregateBytes, maxResults }),
    });
  });
}

export async function buildComputerUseBrief(registryRoot, workspaceId, input = {}) {
  return runBoundedMcpOperation(input, async (operation) => {
    const resolved = await resolveInsideOperation(registryRoot, workspaceId, operation);
    const { workspace } = resolved;
    const intent = String(input.intent ?? "").trim();
    if (intent.length < 3 || intent.length > 500) throw mcpError("MCP_COMPUTER_USE_INTENT_INVALID", "Computer-use intent must contain 3-500 characters.");
    await revalidateResolvedWorkspace(resolved, operation);
    return Object.freeze({
      schemaVersion: 1, workspace, intent,
      target: String(input.target ?? "Perfect Planner desktop app").slice(0, 160),
      computerUseAvailable: process.env.PERFECT_PLANNER_COMPUTER_USE_AVAILABLE === "1",
      authority: "external-explicit-user-request",
      sequence: Object.freeze([
        "Inspect the registered workspace context before acting.",
        "Use the installed Codex computer-use tool for the visible UI only.",
        "Keep the selected window and exact target in view; do not infer hidden state.",
        "Re-inspect the result and report evidence after each material action.",
      ]),
      plannerBoundary: "This MCP server supplies context only. It does not move the pointer, type, approve, or expand operating-system permissions.",
    });
  });
}
