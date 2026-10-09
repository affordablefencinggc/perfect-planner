import { realpathSync } from "node:fs";
import path from "node:path";

/** Windows and default macOS volumes compare paths without case; Linux does not. */
export const caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";

/** Forward slashes, no leading "./", no trailing slash. Used for every repo-relative path we store or compare. */
export function toRepoPath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Key for comparing repo-relative paths on this OS. */
export function pathKey(file: string): string {
  const normal = toRepoPath(file);
  return caseInsensitiveFs ? normal.toLowerCase() : normal;
}

/** Resolve symlinks and Windows 8.3 short names so two spellings of one folder compare equal. */
export function realDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

export function samePath(left: string, right: string): boolean {
  const a = path.resolve(realDir(left));
  const b = path.resolve(realDir(right));
  return caseInsensitiveFs ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Split command output on LF or CRLF and drop the trailing empty line. */
export function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}
