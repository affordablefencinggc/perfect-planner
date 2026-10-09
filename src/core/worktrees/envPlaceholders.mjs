// Turns a dotenv-style file into a copy whose every value is a placeholder.
// Real values never leave this function: only keys, comments and layout survive.

const ASSIGNMENT = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]).*$/;

export function placeholderFor(key) {
  return "PLACEHOLDER_" + String(key).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

export function placeholderEnv(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  const out = [];
  let inMultiline = false;
  for (const line of lines) {
    if (inMultiline) {
      // Drop the continuation lines of a quoted multi-line value entirely.
      if (/^[^"]*"\s*(#.*)?$/.test(line)) inMultiline = false;
      continue;
    }
    const match = ASSIGNMENT.exec(line);
    if (!match) {
      // Keep blank lines and comments; anything else could carry a value, so drop it.
      if (/^\s*(#.*)?$/.test(line)) out.push(line);
      continue;
    }
    const [, indent, exported = "", key, separator] = match;
    const value = line.slice(indent.length + exported.length + key.length + separator.length).trimStart();
    if (value.startsWith('"') && !/^"(?:[^"\\]|\\.)*"\s*(#.*)?$/.test(value)) inMultiline = true;
    out.push(`${indent}${exported}${key}${separator.trim() === ":" ? ": " : "="}${placeholderFor(key)}`);
  }
  return out.join("\n");
}

// Which file names count as local settings to copy into a task worktree.
export function isEnvFileName(name) {
  return /^\.env(?:$|[.\w-]*$)/.test(name) && !name.endsWith(".swp");
}
