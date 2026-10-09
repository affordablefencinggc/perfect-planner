// Commit-time secret scan for task worktrees. Standalone on purpose: Perfect Planner
// copies this file into the managed repo's git dir, so it may import nothing but Node.
// Patterns mirror scripts/verify-secrets.mjs.
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SECRET_PATTERNS = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ["openai-key", /\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,255}\b/],
  ["generic-assignment", /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password)["']?\s*[:=]\s*["'][^"'\r\n]{12,}["']/i],
  ["environment-secret", /^\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[A-Za-z0-9_./+~-]{16,}/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/],
];

/** Scan a unified diff (-U0) and return findings for added lines only. Never returns the secret itself. */
export function scanDiff(diff) {
  const findings = [];
  let file = null;
  let line = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) { file = raw.slice(4).replace(/^b\//, ""); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith("+") && file) {
      const text = raw.slice(1);
      for (const [rule, pattern] of SECRET_PATTERNS) if (pattern.test(text)) findings.push({ file, line, rule });
      line += 1;
    }
  }
  return findings;
}

const isProgram = (file, windows) => {
  try {
    if (!statSync(file).isFile()) return false;
    if (!windows) accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The absolute git to run, never one in the repo (on Windows, spawn("git") with the repo as cwd would run
 * a planted git.exe). Prefers the git that started this hook (GIT_EXEC_PATH), else walks PATH skipping
 * empty, relative, network and in-repo entries; the same rule as core/exec's gitExecutable, inlined
 * because this file is copied out of the app. Returns null when nothing qualifies. `io` is for tests.
 */
export function resolveGit(env, cwd, platform = process.platform, io = {}) {
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const name = windows ? "git.exe" : "git";
  // Compare real paths: a PATH folder can reach the repo through a symlink or junction (macOS /var -> /private/var).
  const real = (file) => {
    try {
      return (io.realpath ?? realpathSync.native)(file);
    } catch {
      return null;
    }
  };
  const program = io.isProgram ?? isProgram;
  const within = (root, candidate) => {
    const relative = p.relative(p.resolve(root), p.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !p.isAbsolute(relative));
  };
  // On Windows only a local drive-letter path (core/exec's isLocalWindowsPath): never UNC in any spelling,
  // checked on the written path and again on the real one (a link can point at a share).
  const local = (file) => !windows || /^[A-Za-z]:[\\/]/.test(file);
  const repo = [p.resolve(cwd), real(cwd)].filter(Boolean);
  const inRepo = (file) => repo.some((root) => within(root, file));
  const usable = (dir) => Boolean(dir) && p.isAbsolute(dir) && local(dir) && !inRepo(dir);
  const found = (dir) => {
    if (!usable(dir)) return null;
    const realDir = real(dir);
    const realFile = real(p.join(dir, name));
    if (!realDir || !realFile || !local(realDir) || !local(realFile)) return null;
    if (inRepo(realDir) || inRepo(realFile) || !program(realFile, windows)) return null;
    return realFile;
  };
  const viaExecPath = found((env.GIT_EXEC_PATH ?? "").trim());
  if (viaExecPath) return viaExecPath;
  const pathValue = Object.entries(env).find(([key]) => (windows ? key.toUpperCase() === "PATH" : key === "PATH"))?.[1] ?? "";
  for (const entry of pathValue.split(windows ? ";" : ":")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    const file = found(dir);
    if (file) return file;
  }
  return null;
}

function main() {
  const git = resolveGit(process.env, process.cwd());
  if (!git) {
    process.stderr.write("Perfect Planner secret scan could not find git outside this repo on PATH, so it could not check the commit.\n");
    process.exit(1);
  }
  const result = spawnSync(git, ["-c", "core.quotepath=off", "diff", "--cached", "--no-color", "--no-ext-diff", "-U0", "--diff-filter=ACMR"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    // Keep Windows (and anything git starts) from searching the repo for programs.
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
  });
  if (result.status !== 0) {
    process.stderr.write(`Perfect Planner secret scan could not read the staged changes: ${result.stderr || result.error}\n`);
    process.exit(1);
  }
  const findings = scanDiff(result.stdout);
  if (!findings.length) return;
  process.stderr.write("Perfect Planner blocked this commit: it looks like it contains a secret.\n");
  for (const finding of findings) process.stderr.write(`  ${finding.file}:${finding.line} (${finding.rule})\n`);
  process.stderr.write("Remove the value, keep it in the system key store, and commit again.\n");
  process.exit(1);
}

// Run only as the hook itself. A bundle that includes this module (the core host, connect.mjs)
// shares import.meta.url with its own entry, so the address alone would start the scan there too.
if (
  process.argv[1] &&
  path.basename(process.argv[1]) === "secret-scan.mjs" &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
