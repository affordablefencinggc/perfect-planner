import { createHash } from "node:crypto";
import { open, readdir, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = await realpath(process.cwd());
const args = process.argv.slice(2);
const mode = args.includes("--staged") ? "staged" : args.includes("--push") ? "push" : "workspace";
const limits = { files: 20_000, bytesPerFile: 5_000_000, totalBytes: 80_000_000, commits: 250, entries: 50_000, depth: 64, durationMs: 60_000, pushInputBytes: 64_000, pushInputMs: 5_000 };
const started = Date.now();
const ignored = new Set([".git", "node_modules", "dist", "target", "target-codex", "generated", ".codex-tmp"]);
// Exact reviewed dummy matches only; never exempt a whole file or a source marker.
const fixtureMatches = new Set([
  "scripts/generate-truth-report.mjs:generic-assignment:89bd311b7282dad1224abb5c6626b1f891a7e6a70bb72752fb7983b784cd820f:74e801ed245678d07e274cc5f005982b7bd9faa25ca54fd17cbd363804fae225",
  "tests/ci-derivation.test.mjs:bearer-token:da44f21a888d10ac38777d4c7e7b7fd2bc174e11f3639f9e96ba12551ab9dc9b:148b9c8f7e56917766dca852b224fbd12c52f24b0955c8201dd2b18cdfc4137d",
  "tests/identity-vault.test.mjs:generic-assignment:927b563b90b90c90f3ccfc8ee22f497e4086e33ea9f011a83acd248a71828cb6:972f076a6924708cd067d93ec0ac038dc18b8c4361511f3943771a55a0f78592",
  "tests/provider-review-gateway.test.mjs:private-key:3021d90eb9437b2d8f30e8363695c4418b5e5f1870801b5c317e9398ee0f572d:250d9d871be05f9e3bfad5c5acd0d2b46862d1d3908ee410103cd1f65594956a",
  "tests/provider-review.test.mjs:generic-assignment:73dc5a57856e8003501fda24b52e51bade22da6b14a878b2b3e57a7eaa931b66:45109bf7c18cbfbde91617d6626c6e76ca9e67103755408c168c2069c1424410",
  "tests/provider-review.test.mjs:generic-assignment:686546acef73a9c5b5dc697400ef33136a9a4c4a06a7d59400e178df5b9b8fa9:45109bf7c18cbfbde91617d6626c6e76ca9e67103755408c168c2069c1424410",
  "tests-ui/pp-diagnostics-120-runtime-event-ledger.test.jsx:generic-assignment:c106c11d0473b36618225a55cc61715b40a4af0713de6458713d7ac6697faa6f:561f7b7251ac7067096258a290cd26b4ac3a6bef423c55dde4860590a221d295",
  "tests-ui/pp-diagnostics-120-runtime-event-ledger.test.jsx:generic-assignment:98767fffc4d4dd8d54091aaf1f826b2314f34a2a4ad881e0f5960801e1b918d8:561f7b7251ac7067096258a290cd26b4ac3a6bef423c55dde4860590a221d295",
  "tests-ui/pp-diagnostics-120-runtime-event-ledger.test.jsx:generic-assignment:9d5ff611772d78dd28b9e0605695b8308a5e047e586190c64386fca133a2a378:561f7b7251ac7067096258a290cd26b4ac3a6bef423c55dde4860590a221d295",
  "tests-ui/pp-diagnostics-120-runtime-event-ledger.test.jsx:openai-key:a165ce0568ce01a0486c54d64fea78c7e2dd166573d7fa2fdc5de3cb42d3d910:561f7b7251ac7067096258a290cd26b4ac3a6bef423c55dde4860590a221d295",
]);
const patterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,255}\b/g],
  ["generic-assignment", /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password)["']?\s*[:=]\s*["'][^"'\r\n]{12,}["']/gi],
  ["environment-secret", /(?:^|\n)\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[A-Za-z0-9_./+~-]{16,}/g],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}\b/g],
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const receipt = { schemaVersion: 2, scanner: "perfect-planner-bounded-secret-scan", mode, state: "incomplete", scope: mode === "workspace" ? "Working files excluding listed generated directories" : mode === "staged" ? "Every blob in the Git index" : "Every tree and commit message in outgoing history, plus outgoing annotated tag bodies", excludedDirectories: mode === "workspace" ? [...ignored] : [], limits, scannedFiles: 0, scannedBytes: 0, reviewedFixtureMatches: 0, findingCount: 0, findings: [], coverageIssues: [], revisions: [], secretsReturned: false, malwareVerdict: "not-assessed", limitations: ["Pattern detection cannot prove absence of all secrets.", "No antivirus or archive extraction is performed."] };
const safePath = (file) => file && patterns.some(([, rule]) => { rule.lastIndex = 0; return rule.test(file); }) ? `[redacted-path:${sha(file).slice(0, 16)}]` : file;
const coverage = (file, reason) => { if (receipt.coverageIssues.length < 200) receipt.coverageIssues.push({ path: safePath(file), reason }); };
const checkBudget = () => { if (Date.now() - started >= limits.durationMs) throw new Error("scan-time-limit"); };
const gitRoutingOverrides = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]);
const gitEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" };
// Git normally exports GIT_INDEX_FILE=.git/index to pre-commit. Read the
// checkout's canonical index independently before accepting that one binding.
for (const key of Object.keys(gitEnvironment)) if (key.toUpperCase() === "GIT_INDEX_FILE") delete gitEnvironment[key];
async function validateGitEnvironment() {
  let suppliedIndex;
  for (const key of Object.keys(process.env)) {
    const name = key.toUpperCase();
    if (name === "GIT_INDEX_FILE" && mode === "staged") suppliedIndex = process.env[key];
    else if (gitRoutingOverrides.has(name) || name.startsWith("GIT_CONFIG")) throw new Error("git-environment-override-refused");
  }
  if (suppliedIndex !== undefined) {
    if (!suppliedIndex) throw new Error("git-index-override-refused");
    const normalIndex = await realpath(path.resolve(root, git(["rev-parse", "--git-path", "index"]).toString("utf8").trim()));
    const candidate = await realpath(path.resolve(root, suppliedIndex));
    if (path.relative(normalIndex, candidate) !== "") throw new Error("git-index-override-refused");
  }
}
function git(arguments_, maxBuffer = 4_000_000) {
  checkBudget();
  const result = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...arguments_], { cwd: root, shell: false, windowsHide: true, timeout: Math.max(1, Math.min(10_000, limits.durationMs - (Date.now() - started))), maxBuffer, env: gitEnvironment });
  if (result.error || result.status !== 0) throw new Error("git-read-failed-or-exceeded-bound");
  return result.stdout;
}
function scan(file, bytes, revision = null) {
  checkBudget();
  if (receipt.scannedFiles >= limits.files || receipt.scannedBytes + bytes.length > limits.totalBytes) throw new Error("scan-aggregate-limit");
  receipt.scannedFiles++;
  receipt.scannedBytes += bytes.length;
  let content = bytes.toString("utf8");
  const contentDigest = sha(bytes.toString("utf8").replaceAll("\r\n", "\n"));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) content = bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) { const swapped = Buffer.from(bytes.subarray(2)); if (swapped.length % 2) { coverage(file, "invalid-utf16"); return; } swapped.swap16(); content = swapped.toString("utf16le"); }
  for (const [rule, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const fingerprint = sha(match[0]);
      if (fixtureMatches.has(file + ":" + rule + ":" + fingerprint + ":" + contentDigest)) { receipt.reviewedFixtureMatches++; continue; }
      if (receipt.findings.length >= 200) throw new Error("finding-limit");
      receipt.findings.push({ path: safePath(file), line: content.slice(0, match.index).split("\n").length, rule, fingerprint, contentDigest, revision });
    }
  }
}
async function workspace() {
  const queue = [{ directory: root, depth: 0 }];
  let entries = 0;
  while (queue.length) {
    checkBudget();
    const { directory, depth } = queue.shift();
    if (depth > limits.depth) throw new Error("directory-depth-limit");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > limits.entries) throw new Error("directory-entry-limit");
      if (ignored.has(entry.name) && entry.isDirectory()) continue;
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (entry.isSymbolicLink()) { coverage(relative, "symbolic-link-not-scanned"); continue; }
      if (entry.isDirectory()) { queue.push({ directory: target, depth: depth + 1 }); continue; }
      if (!entry.isFile()) { coverage(relative, "non-regular-file"); continue; }
      const canonical = await realpath(target);
      if (canonical !== target || path.relative(root, canonical).startsWith("..")) { coverage(relative, "path-changed"); continue; }
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) { coverage(relative, "file-changed"); continue; }
      if (stat.size > limits.bytesPerFile) { coverage(relative, "file-size-limit"); continue; }
      const handle = await open(target, "r");
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.ino !== stat.ino || before.size !== stat.size) { coverage(relative, "file-changed"); continue; }
        const bytes = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
        const after = await handle.stat();
        if (length !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size) { coverage(relative, "file-changed"); continue; }
        scan(relative, bytes.subarray(0, length));
      } finally { await handle.close(); }
    }
  }
}
const seenBlobs = new Set();
function scanGitEntries(output, staged, revision) {
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const match = (staged ? /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/ : /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/).exec(record);
    if (!match) throw new Error("invalid-git-tree-entry");
    const fileMode = match[1], object = staged ? match[2] : match[3], file = match[4];
    if (staged && match[3] !== "0") { coverage(file, "unmerged-index"); continue; }
    if (!["100644", "100755"].includes(fileMode)) { coverage(file, "link-or-submodule-not-scanned"); continue; }
    if (seenBlobs.has(file + ":" + object)) continue;
    seenBlobs.add(file + ":" + object);
    if (seenBlobs.size > limits.files) throw new Error("git-file-limit");
    const size = Number(git(["cat-file", "-s", object]).toString("utf8").trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid-git-blob-size");
    if (size > limits.bytesPerFile) { coverage(file, "file-size-limit"); continue; }
    const bytes = git(["cat-file", "blob", object], limits.bytesPerFile + 1);
    if (bytes.length !== size) throw new Error("git-blob-size-mismatch");
    scan(file, bytes, revision);
  }
}
function readPushInput() {
  checkBudget();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", data);
      process.stdin.removeListener("end", end);
      process.stdin.removeListener("error", failed);
      process.stdin.pause();
      if (error) {
        process.stdin.destroy();
        reject(error);
      } else resolve(Buffer.concat(chunks, length).toString("utf8"));
    };
    const data = (chunk) => {
      length += chunk.length;
      if (length > limits.pushInputBytes) finish(new Error("push-input-limit"));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const failed = () => finish(new Error("push-input-read-failed"));
    const timer = setTimeout(() => finish(new Error("push-input-time-limit")), Math.max(1, Math.min(limits.pushInputMs, limits.durationMs - (Date.now() - started))));
    process.stdin.on("data", data);
    process.stdin.once("end", end);
    process.stdin.once("error", failed);
    process.stdin.resume();
  });
}
async function push() {
  const input = await readPushInput();
  const lines = input.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("push-refs-required");
  const commits = new Set();
  for (const line of lines) {
    const fields = line.split(" ");
    if (fields.length !== 4 || !fields.filter((_, i) => i === 1 || i === 3).every((v) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v))) throw new Error("invalid-push-refs");
    const [, local, , remote] = fields;
    if (/^0+$/.test(local)) continue;
    let tagObject = local;
    for (let depth = 0; git(["cat-file", "-t", tagObject]).toString("utf8").trim() === "tag"; depth++) {
      if (depth >= 16) throw new Error("tag-depth-limit");
      const tagSize = Number(git(["cat-file", "-s", tagObject]).toString("utf8").trim());
      if (tagSize > limits.bytesPerFile) throw new Error("tag-size-limit");
      const body = git(["cat-file", "tag", tagObject], limits.bytesPerFile + 1);
      scan("<annotated-tag>", body, tagObject);
      const next = /^object ([a-f0-9]{40,64})\n/.exec(body.toString("utf8"));
      if (!next) throw new Error("invalid-tag-object");
      tagObject = next[1];
    }
    const localCommit = git(["rev-parse", "--verify", local + "^{commit}"]).toString("utf8").trim();
    const range = /^0+$/.test(remote) ? [localCommit] : [localCommit, "^" + remote];
    for (const commit of git(["rev-list", "--max-count=" + (limits.commits + 1), ...range]).toString("utf8").trim().split("\n").filter(Boolean)) commits.add(commit);
    if (commits.size > limits.commits) throw new Error("outgoing-history-limit");
  }
  for (const commit of commits) {
    receipt.revisions.push(commit);
    const size = Number(git(["cat-file", "-s", commit]).toString("utf8").trim());
    if (size > limits.bytesPerFile) throw new Error("commit-message-size-limit");
    scan("<commit-message>", git(["cat-file", "commit", commit], limits.bytesPerFile + 1), commit);
    scanGitEntries(git(["ls-tree", "-r", "-z", "--full-tree", commit]), false, commit);
  }
}
try {
  if (args.some((arg) => !["--staged", "--push"].includes(arg)) || args.length > 1) throw new Error("invalid-scan-mode");
  if (mode !== "workspace") {
    await validateGitEnvironment();
    if (path.relative(root, await realpath(git(["rev-parse", "--show-toplevel"]).toString("utf8").trim())) !== "") throw new Error("run-from-repository-root");
  }
  if (mode === "workspace") await workspace();
  else if (mode === "staged") { const index = git(["ls-files", "--stage", "-z"]); receipt.revisions.push(sha(index)); scanGitEntries(index, true, "index"); if (!git(["ls-files", "--stage", "-z"]).equals(index)) throw new Error("index-changed-during-scan"); }
  else await push();
} catch (error) {
  coverage(null, /^[a-z-]+$/.test(error.message) ? error.message : "scan-read-failed");
}
receipt.findingCount = receipt.findings.length;
receipt.state = receipt.findingCount ? "blocked" : receipt.coverageIssues.length ? "incomplete" : "passed";
receipt.completedAt = new Date().toISOString();
receipt.receiptHash = sha(JSON.stringify(receipt));
process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
process.exitCode = receipt.state === "passed" ? 0 : receipt.state === "blocked" ? 2 : 3;
