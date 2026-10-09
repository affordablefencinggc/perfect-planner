import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PLACEHOLDER = "PLACEHOLDER";
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH)/i;
const LOCAL_SETTINGS = /^\.env(?:\..+)?$/;

/** Replace the value of every secret-looking KEY=value line with a placeholder. Comments and other values are kept. */
export function placeholderSecrets(text: string): string {
  return text
    .split(/(\r?\n)/)
    .map((line) => {
      const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/.exec(line);
      if (!match || !SECRET_NAME.test(match[2]) || match[4].trim() === "") return line;
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
    if (/\.example$|\.sample$|\.template$/.test(name)) copyFileSync(source, target);
    else writeFileSync(target, placeholderSecrets(readFileSync(source, "utf8")));
    copied.push(name);
  }
  return copied.sort();
}
