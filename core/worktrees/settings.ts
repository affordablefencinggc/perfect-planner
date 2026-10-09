import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SECRET_PATTERNS } from "./hooks/secret-scan.mjs";

export const PLACEHOLDER = "PLACEHOLDER";
const LOCAL_SETTINGS = /^\.env(?:\..+)?$/;
/** Settings that are safe to copy as-is when the value itself doesn't look like a secret. Everything else becomes a placeholder. */
const SAFE_NAME = /^(?:NODE_ENV|APP_ENV|ENV|ENVIRONMENT|DEBUG|LOG_LEVEL|LOG_FORMAT|TZ|LANG|LOCALE|CI|PORT|HOST|HOSTNAME|BASE_PATH|PUBLIC_PATH|[A-Z0-9_]*_(?:PORT|HOST|HOSTNAME|ENV|ENABLED|DISABLED|MODE|LEVEL|TIMEOUT|TIMEOUT_MS|VERSION|REGION|LOCALE)|(?:VITE|NEXT_PUBLIC|REACT_APP|PUBLIC)_[A-Z0-9_]*(?:PORT|HOST|ENV|MODE|ENABLED|VERSION|TITLE|NAME))$/i;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PRIVATE|CREDENTIAL|AUTH|SESSION|COOKIE|SALT|SIGNATURE|CERT|DSN|CONN|DATABASE_URL)/i;
const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]*@/i;

/** Keep a value only when its name is on the safe list and the value itself doesn't look like a secret. */
function keepValue(name: string, value: string): boolean {
  if (!SAFE_NAME.test(name) || SECRET_NAME.test(name)) return false;
  const bare = value.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (URL_CREDENTIALS.test(bare)) return false;
  if (SECRET_PATTERNS.some(([, pattern]) => pattern.test(`${name}=${bare}`) || pattern.test(bare))) return false;
  // Long unbroken random-looking strings are treated as secrets whatever they're called.
  return !/^[A-Za-z0-9+/_=.-]{24,}$/.test(bare) || /^[a-z0-9.-]+$/.test(bare);
}

/**
 * Replace every value in a .env-style file with a placeholder unless its name is on a short
 * safe list (ports, hosts, modes) and the value doesn't look secret. Comments, blank lines,
 * empty values and line endings are kept.
 */
export function placeholderSecrets(text: string): string {
  return text
    .split(/(\r?\n)/)
    .map((line) => {
      const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/.exec(line);
      if (!match || match[4].trim() === "" || keepValue(match[2], match[4])) return line;
      return `${match[1]}${match[2]}${match[3]}${PLACEHOLDER}`;
    })
    .join("");
}

/**
 * Copy untracked local settings (.env, .env.local, ...) from the main checkout
 * into a task worktree, with secrets swapped for placeholders. Tracked files
 * already arrive through git, and an existing file in the worktree is never overwritten.
 */
export function copyLocalSettings(repoRoot: string, worktreePath: string, tracked: Set<string>): string[] {
  const copied: string[] = [];
  for (const name of readdirSync(repoRoot)) {
    if (!LOCAL_SETTINGS.test(name) || tracked.has(name)) continue;
    const source = path.join(repoRoot, name);
    const target = path.join(worktreePath, name);
    if (existsSync(target)) continue;
    writeFileSync(target, placeholderSecrets(readFileSync(source, "utf8")));
    copied.push(name);
  }
  return copied.sort();
}
