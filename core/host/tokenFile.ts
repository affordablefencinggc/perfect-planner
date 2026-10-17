// Agent token files, handled safely on Windows as well as
// macOS and Linux. Mode 0600 means nothing on NTFS, so on Windows the file and
// its folder get an owner-only ACL instead; and a token path on a network share
// is refused before anything opens it (opening \\host\share leaks the NTLM hash).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLocalWindowsPath } from "../exec/index";

/**
 * True for anything that is not a plain local path. On Windows only a drive-letter path (C:\...) is
 * local: UNC, device and NT prefixes in any slash mix (\\host, //host, \/host, /\host, \\?\UNC,
 * \??\UNC) reach SMB, and rooted or relative paths depend on the current drive. Elsewhere //host is refused.
 */
export function isNetworkPath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return !isLocalWindowsPath(value);
  return value.startsWith("//");
}

export function icaclsPath(): string {
  return path.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "icacls.exe");
}

/** Removes inherited entries and grants full control to the current user alone. */
function ownerOnlyAcl(target: string): void {
  const user = os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  const who = domain ? `${domain}\\${user}` : user;
  execFileSync(icaclsPath(), [target, "/inheritance:r", "/grant:r", `${who}:F`], { stdio: "ignore", windowsHide: true });
}

/**
 * Writes text to a file only this OS user can read. An older file (or a link planted in its place)
 * is removed first, and the new one is created exclusively, so the write never follows a link.
 */
export function writeOwnerOnlyFile(file: string, text: string, platform: NodeJS.Platform = process.platform): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === "win32") ownerOnlyAcl(dir);
  else fs.chmodSync(dir, 0o700);
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  if (platform === "win32") ownerOnlyAcl(file);
}
