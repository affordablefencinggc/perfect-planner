import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserWorkspaceAdapter } from "../src/browser/workspaceCensus.js";

function namedError(name, message = name) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function fileHandle(name, content, { getError = null, readError = null, lastModified = 1 } = {}) {
  return {
    kind: "file",
    name,
    async getFile() {
      if (getError) throw getError;
      const bytes = new TextEncoder().encode(content);
      return {
        size: bytes.byteLength,
        lastModified,
        async arrayBuffer() {
          if (readError) throw readError;
          return bytes.buffer;
        },
      };
    },
  };
}

function directoryHandle(name, entries, { queryPermission = "granted", entriesError = null } = {}) {
  return {
    kind: "directory",
    name,
    async requestPermission() { return "granted"; },
    async queryPermission() { return queryPermission; },
    async *entries() {
      for (const entry of entries) yield entry;
      if (entriesError) throw entriesError;
    },
  };
}

async function register(root, workspaceId) {
  const runtime = { crypto: globalThis.crypto, async showDirectoryPicker() { return root; } };
  const selection = await browserWorkspaceAdapter.selectWorkspaceFolder({ runtime });
  assert.equal(selection.selectionState, "selected");
  const registration = await browserWorkspaceAdapter.registerWorkspaceReadOnly({
    workspaceId,
    rootPath: selection.selectedPath,
    explicitUserApproval: true,
  });
  assert.equal(registration.authoritative, true);
  return registration;
}

function assertUnavailableWithoutPartialData(result, reason) {
  assert.deepEqual(result, {
    available: false,
    authoritative: false,
    reason,
    schemaVersion: 1,
  });
  assert.equal("files" in result, false);
  assert.equal("digest" in result, false);
}

test("browser census traverses deterministically, yields cooperatively, and emits frozen metadata-only progress", async () => {
  const firstRoot = directoryHandle("deterministic-app", [
    ["z.txt", fileHandle("z.txt", "z")],
    ["src", directoryHandle("src", [
      ["z.js", fileHandle("z.js", "z-js")],
      ["a.js", fileHandle("a.js", "a-js")],
    ])],
    ["package.json", fileHandle("package.json", "{}")],
  ]);
  const secondRoot = directoryHandle("deterministic-app", [
    ["package.json", fileHandle("package.json", "{}")],
    ["src", directoryHandle("src", [
      ["a.js", fileHandle("a.js", "a-js")],
      ["z.js", fileHandle("z.js", "z-js")],
    ])],
    ["z.txt", fileHandle("z.txt", "z")],
  ]);
  const firstRegistration = await register(firstRoot, "deterministic_a");
  const secondRegistration = await register(secondRoot, "deterministic_b");
  const progress = [];
  let yields = 0;
  const first = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "deterministic_a",
    registryRevision: firstRegistration.registryRevision,
    batchSize: 1,
    onProgress(receipt) { progress.push(receipt); },
    async yieldControl() { yields += 1; },
  });
  const second = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "deterministic_b",
    registryRevision: secondRegistration.registryRevision,
    batchSize: 1,
    async yieldControl() {},
  });

  assert.equal(first.authoritative, true);
  assert.equal(second.authoritative, true);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.files.map((file) => file.path), ["package.json", "src/a.js", "src/z.js", "z.txt"]);
  assert.ok(yields >= first.fileCount);
  assert.equal(progress[0].phase, "started");
  assert.equal(progress.at(-1).phase, "complete");
  assert.equal(progress.at(-1).authoritative, true);
  assert.equal(progress.at(-1).filesHashed, 4);
  assert.equal(progress.at(-1).bytesHashed, first.totalBytesHashed);
  assert.ok(progress.slice(0, -1).every((receipt) => receipt.authoritative === false));
  assert.ok(progress.every((receipt) => Object.isFrozen(receipt) && !("files" in receipt) && !("content" in receipt)));
  assert.ok(first.files.every((file) => !("content" in file)));
});

test("AbortSignal cancellation stops between batches and never exposes a partial authoritative census", async () => {
  const root = directoryHandle("abort-app", [
    ["a.js", fileHandle("a.js", "a")],
    ["b.js", fileHandle("b.js", "b")],
  ]);
  const registration = await register(root, "abort_app");
  const controller = new AbortController();
  const progress = [];
  const result = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "abort_app",
    registryRevision: registration.registryRevision,
    batchSize: 1,
    signal: controller.signal,
    onProgress(receipt) { progress.push(receipt); },
    async yieldControl() { controller.abort(); },
  });

  assertUnavailableWithoutPartialData(result, "workspace-census-aborted");
  assert.equal(progress.at(-1).phase, "cancelled");
  assert.equal(progress.at(-1).reason, "workspace-census-aborted");
  assert.equal(progress.at(-1).authoritative, false);
});

test("the file-count ceiling fails closed while oversized files are recorded and skipped", async () => {
  const cases = [
    {
      workspaceId: "limit_files",
      entries: [["a.js", fileHandle("a.js", "aa")], ["b.js", fileHandle("b.js", "bb")]],
      limits: { maxFiles: 1 },
      reason: "maximum-file-count-reached",
    },
  ];

  for (const item of cases) {
    const registration = await register(directoryHandle(`${item.workspaceId}-root`, item.entries), item.workspaceId);
    const progress = [];
    const result = await browserWorkspaceAdapter.censusRegisteredWorkspace({
      workspaceId: item.workspaceId,
      registryRevision: registration.registryRevision,
      onProgress(receipt) { progress.push(receipt); },
      ...item.limits,
    });
    assertUnavailableWithoutPartialData(result, item.reason);
    assert.equal(progress.at(-1).phase, "failed");
    assert.equal(progress.at(-1).reason, item.reason);
    assert.equal(progress.at(-1).authoritative, false);
  }

  const oversizedRegistration = await register(directoryHandle("limit-file-size-root", [
    ["large.bin", fileHandle("large.bin", "1234")],
    ["small.js", fileHandle("small.js", "ok")],
  ]), "limit_file_size");
  const oversizedProgress = [];
  const oversized = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "limit_file_size",
    registryRevision: oversizedRegistration.registryRevision,
    maxFileBytes: 3,
    onProgress(receipt) { oversizedProgress.push(receipt); },
  });
  assert.equal(oversized.authoritative, true);
  assert.deepEqual(oversized.files.map((file) => file.path), ["small.js"]);
  assert.deepEqual(oversized.skipped, [{ path: "large.bin", reason: "file-too-large", size: 4 }]);
  assert.equal(oversizedProgress.at(-1).phase, "complete");
  assert.equal(oversizedProgress.at(-1).skippedCount, 1);
});

test("revoked folder permission and unreadable files return stable non-authoritative reasons", async () => {
  const revokedRoot = directoryHandle("revoked-root", [["a.js", fileHandle("a.js", "a")]], { queryPermission: "denied" });
  const revokedRegistration = await register(revokedRoot, "revoked_app");
  const revoked = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "revoked_app",
    registryRevision: revokedRegistration.registryRevision,
  });
  assertUnavailableWithoutPartialData(revoked, "workspace-read-permission-lost");

  const unreadableRoot = directoryHandle("unreadable-root", [
    ["good.js", fileHandle("good.js", "good")],
    ["locked.js", fileHandle("locked.js", "", { getError: namedError("NotReadableError") })],
  ]);
  const unreadableRegistration = await register(unreadableRoot, "unreadable_app");
  const unreadable = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "unreadable_app",
    registryRevision: unreadableRegistration.registryRevision,
  });
  // One locked file is skipped and listed; it never aborts the whole scan.
  assert.equal(unreadable.authoritative, true);
  assert.deepEqual(unreadable.files.map((file) => file.path), ["good.js"]);
  assert.deepEqual(unreadable.skipped.map(({ path, reason }) => [path, reason]), [["locked.js", "file-unreadable"]]);

  const lostMidTraversalRoot = directoryHandle("lost-mid-root", [], { entriesError: namedError("NotAllowedError") });
  const lostRegistration = await register(lostMidTraversalRoot, "lost_mid_app");
  const lost = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "lost_mid_app",
    registryRevision: lostRegistration.registryRevision,
  });
  assertUnavailableWithoutPartialData(lost, "workspace-read-permission-lost");
});

test("invalid ceiling inputs are rejected as non-authoritative receipts", async () => {
  const registration = await register(directoryHandle("invalid-limit-root", []), "invalid_limit_app");
  const result = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "invalid_limit_app",
    registryRevision: registration.registryRevision,
    maxTotalBytes: -1,
  });
  assertUnavailableWithoutPartialData(result, "invalid-max-total-bytes");
});

test("directory, entry, depth, path, and time budgets fail closed", async () => {
  const nested = directoryHandle("level-1", [
    ["level-2", directoryHandle("level-2", [
      ["level-3", directoryHandle("level-3", [])],
    ])],
  ]);
  const cases = [
    {
      id: "limit_directories",
      root: directoryHandle("directories", [["a", directoryHandle("a", [])], ["b", directoryHandle("b", [])]]),
      limits: { maxDirectories: 2 },
      reason: "maximum-directory-count-reached",
    },
    {
      id: "limit_entries",
      root: directoryHandle("entries", [["a", directoryHandle("a", [])], ["b", directoryHandle("b", [])]]),
      limits: { maxEntries: 1 },
      reason: "maximum-entry-count-reached",
    },
    {
      id: "limit_depth",
      root: nested,
      limits: { maxDepth: 1 },
      reason: "maximum-directory-depth-reached",
    },
    {
      id: "limit_path",
      root: directoryHandle("paths", [["long-name.js", fileHandle("long-name.js", "x")]]),
      limits: { maxPathLength: 5 },
      reason: "maximum-path-length-reached",
    },
  ];
  for (const item of cases) {
    const registration = await register(item.root, item.id);
    const result = await browserWorkspaceAdapter.censusRegisteredWorkspace({
      workspaceId: item.id,
      registryRevision: registration.registryRevision,
      ...item.limits,
    });
    assertUnavailableWithoutPartialData(result, item.reason);
  }

  const timedRegistration = await register(
    directoryHandle("timed", [["a.js", fileHandle("a.js", "a")]]),
    "limit_duration",
  );
  let clock = 0;
  const timed = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "limit_duration",
    registryRevision: timedRegistration.registryRevision,
    maxDurationMs: 10,
    now: () => (clock += 20),
  });
  assertUnavailableWithoutPartialData(timed, "maximum-scan-duration-reached");
});

test("a multi-thousand-file workspace completes in bounded batches without losing deterministic order", async () => {
  const fileTotal = 4_096;
  const entries = Array.from({ length: fileTotal }, (_, index) => {
    const name = `module-${String(fileTotal - index).padStart(5, "0")}.js`;
    return [name, fileHandle(name, `export default ${index};`)];
  });
  const registration = await register(directoryHandle("large-real-life-app", entries), "large_real_life_app");
  const progress = [];
  let yields = 0;
  let clock = 0;
  const result = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "large_real_life_app",
    registryRevision: registration.registryRevision,
    batchSize: 128,
    progressThrottleMs: 25,
    maxDurationMs: 1_000_000,
    now: () => clock,
    onProgress(receipt) { progress.push(receipt); },
    async yieldControl() { yields += 1; clock += 1; },
  });

  assert.equal(result.authoritative, true);
  assert.equal(result.fileCount, fileTotal);
  assert.equal(result.files[0].path, "module-00001.js");
  assert.equal(result.files.at(-1).path, "module-04096.js");
  assert.ok(yields >= 64, "directory enumeration and hashing must yield between bounded batches");
  assert.ok(
    progress.filter((receipt) => receipt.phase === "scanning").length <= Math.ceil(yields / 25) + 1,
    "UI progress receipts must be throttled independently from cancellation-friendly yields",
  );
  assert.equal(progress.at(-1).phase, "complete");
  assert.equal(progress.at(-1).filesHashed, fileTotal);
  assert.ok(progress.slice(0, -1).every((receipt) => receipt.authoritative === false));
});

test("mid-scan file mutation fails closed and never publishes a mixed-time digest", async () => {
  let reads = 0;
  const changingFile = {
    kind: "file",
    name: "changing.js",
    async getFile() {
      reads += 1;
      const content = reads === 1 ? "first" : "second";
      const bytes = new TextEncoder().encode(content);
      return {
        size: bytes.byteLength,
        lastModified: reads,
        async arrayBuffer() { return bytes.buffer; },
      };
    },
  };
  const registration = await register(
    directoryHandle("changing-app", [["changing.js", changingFile]]),
    "changing_app",
  );
  const result = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "changing_app",
    registryRevision: registration.registryRevision,
  });
  assertUnavailableWithoutPartialData(result, "workspace-changed-during-census");
});

test("mid-scan directory changes fail closed before an authoritative census is returned", async () => {
  let enumeration = 0;
  const root = {
    kind: "directory",
    name: "changing-tree",
    async requestPermission() { return "granted"; },
    async queryPermission() { return "granted"; },
    async *entries() {
      enumeration += 1;
      yield ["stable.js", fileHandle("stable.js", "stable")];
      if (enumeration > 1) yield ["new.js", fileHandle("new.js", "new")];
    },
  };
  const registration = await register(root, "changing_tree");
  const result = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "changing_tree",
    registryRevision: registration.registryRevision,
  });
  assertUnavailableWithoutPartialData(result, "workspace-changed-during-census");
});

test("a stalled read, a huge file, an unreadable sub-folder and archive folders are skipped while the scan completes", async () => {
  const stalled = { kind: "file", name: "stalled.bin", async getFile() { return new Promise(() => {}); } };
  const huge = fileHandle("huge.log", "x".repeat(64));
  const root = directoryHandle("mixed-root", [
    ["app.js", fileHandle("app.js", "console.log(1)")],
    ["stalled.bin", stalled],
    ["huge.log", huge],
    ["locked-dir", directoryHandle("locked-dir", [["inner.js", fileHandle("inner.js", "x")]], { entriesError: namedError("NotReadableError") })],
    ["_archive", directoryHandle("_archive", [["old.js", fileHandle("old.js", "old")]])],
    ["node_modules", directoryHandle("node_modules", [["dep.js", fileHandle("dep.js", "dep")]])],
  ]);
  const registration = await register(root, "mixed_app");
  const census = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "mixed_app",
    registryRevision: registration.registryRevision,
    maxFileBytes: 32,
    fileReadTimeoutMs: 50,
  });
  assert.equal(census.authoritative, true);
  assert.deepEqual(census.files.map((file) => file.path), ["app.js"]);
  assert.deepEqual(census.skipped.map(({ path, reason }) => [path, reason]), [
    ["_archive", "generated-or-dependency-directory-excluded"],
    ["huge.log", "file-too-large"],
    ["locked-dir", "folder-unreadable"],
    ["node_modules", "generated-or-dependency-directory-excluded"],
    ["stalled.bin", "file-read-timed-out"],
  ]);
});

test(".gitignore entries are skipped and listed, and the content budget skips instead of failing", async () => {
  const root = directoryHandle("gitignore-root", [
    [".gitignore", fileHandle(".gitignore", "# comment\n/public/generated/\n*.log\nsecrets\n!keep.log\n")],
    ["app.js", fileHandle("app.js", "a")],
    ["debug.log", fileHandle("debug.log", "x")],
    ["secrets", directoryHandle("secrets", [["k.txt", fileHandle("k.txt", "k")]])],
    ["public", directoryHandle("public", [
      ["generated", directoryHandle("generated", [["big.json", fileHandle("big.json", "{}")]])],
      ["index.html", fileHandle("index.html", "<p>")],
    ])],
    ["zz-large.js", fileHandle("zz-large.js", "y".repeat(20))],
  ]);
  const registration = await register(root, "gitignore_app");
  const census = await browserWorkspaceAdapter.censusRegisteredWorkspace({
    workspaceId: "gitignore_app",
    registryRevision: registration.registryRevision,
    maxTotalBytes: 70,
  });
  assert.equal(census.authoritative, true);
  assert.deepEqual(census.files.map((file) => file.path), [".gitignore", "app.js", "public/index.html"]);
  assert.deepEqual(census.skipped.map(({ path, reason }) => [path, reason]), [
    ["debug.log", "ignored-by-gitignore"],
    ["public/generated", "ignored-by-gitignore"],
    ["secrets", "ignored-by-gitignore"],
    ["zz-large.js", "scan-size-budget-reached"],
  ]);
});

test("secret files (.env, keys, certificates) are listed as skipped and never read or hashed", async () => {
  const reads = [];
  const tracked = (name, content) => {
    const handle = fileHandle(name, content);
    return { ...handle, async getFile() { reads.push(name); return handle.getFile(); } };
  };
  const root = directoryHandle("secret-root", [
    [".env", tracked(".env", "API_KEY=live")],
    [".env.local", tracked(".env.local", "TOKEN=live")],
    [".env.example", tracked(".env.example", "API_KEY=")],
    ["app.js", tracked("app.js", "a")],
    ["config", directoryHandle("config", [
      ["server.pem", tracked("server.pem", "-----BEGIN")],
      ["tls.key", tracked("tls.key", "-----BEGIN")],
      ["id_rsa", tracked("id_rsa", "-----BEGIN")],
      ["id_ed25519.pub", tracked("id_ed25519.pub", "ssh-ed25519")],
      ["cert.p12", tracked("cert.p12", "x")],
      ["keyboard.js", tracked("keyboard.js", "k")],
    ])],
  ]);
  const registration = await register(root, "secret_app");
  const census = await browserWorkspaceAdapter.censusRegisteredWorkspace({ workspaceId: "secret_app", registryRevision: registration.registryRevision });
  assert.equal(census.authoritative, true);
  assert.deepEqual(census.files.map((file) => file.path), [".env.example", "app.js", "config/id_ed25519.pub", "config/keyboard.js"]);
  assert.deepEqual(census.skipped.map(({ path, reason }) => [path, reason]), [
    [".env", "secret-file-not-read"],
    [".env.local", "secret-file-not-read"],
    ["config/cert.p12", "secret-file-not-read"],
    ["config/id_rsa", "secret-file-not-read"],
    ["config/server.pem", "secret-file-not-read"],
    ["config/tls.key", "secret-file-not-read"],
  ]);
  for (const name of [".env", ".env.local", "server.pem", "tls.key", "id_rsa", "cert.p12"]) assert.ok(!reads.includes(name), `${name} must never be opened`);
});
