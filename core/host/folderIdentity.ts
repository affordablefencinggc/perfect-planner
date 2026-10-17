// When are two folder names the same folder? The host asks before it opens a second project, and before it
// hands a git folder to a second project, so one folder never carries two projects' ledgers, tokens or
// worktrees. Real paths settle links and junctions; the rest is how each OS compares names:
//   - Windows ignores case, and drops trailing dots and spaces from every name ("beta." is "beta").
//   - macOS volumes ignore case by default and treat composed and decomposed accents alike.
//   - Linux compares names exactly.
// The result is only ever compared with another identity, never used as a path.
import fs from "node:fs";
import path from "node:path";

export function folderIdentity(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  realpath: (file: string) => string = fs.realpathSync.native,
): string {
  let real: string;
  try {
    real = realpath(dir);
  } catch {
    real = path.resolve(dir);
  }
  const parts = real.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  const lead = /^[\\/]/.test(real) ? "/" : "";
  let name = parts
    .map((part) => (platform === "win32" && !/^\.+$/.test(part) ? part.replace(/[. ]+$/, "") : part))
    .join("/");
  if (platform === "win32") name = name.toLowerCase();
  if (platform === "darwin") name = name.normalize("NFC").toLowerCase();
  return `${lead}${name}`;
}

/** True when `inner` is `outer` or sits below it, by identity (see folderIdentity). */
export function identityWithin(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
}
