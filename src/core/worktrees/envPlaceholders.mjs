// Turns a dotenv-style file into a copy whose every value is a placeholder.
// Real values never leave this function: only keys, comments and layout survive.

const ASSIGNMENT = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]).*$/;

const QUOTES = ['"', "'", "`"];

// True when `text` contains an unescaped closing `quote` followed only by an
// optional comment.
function closesQuote(text, quote) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && quote !== "'") { i++; continue; }
    if (text[i] === quote) return /^\s*(#.*)?$/.test(text.slice(i + 1));
  }
  return false;
}

export function placeholderFor(key) {
  return "PLACEHOLDER_" + String(key).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

export function placeholderEnv(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  const out = [];
  // The quote character (", ' or `) of a multi-line value still open, or null.
  let openQuote = null;
  for (const line of lines) {
    if (openQuote) {
      // Drop the continuation lines of a quoted multi-line value entirely,
      // including ones that look like comments.
      if (closesQuote(line, openQuote)) openQuote = null;
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
    const quote = QUOTES.includes(value[0]) ? value[0] : null;
    if (quote && !closesQuote(value.slice(1), quote)) openQuote = quote;
    out.push(`${indent}${exported}${key}${separator.trim() === ":" ? ": " : "="}${placeholderFor(key)}`);
  }
  return out.join("\n");
}

// Which file names count as local settings to copy into a task worktree.
export function isEnvFileName(name) {
  return /^\.env(?:$|[.\w-]*$)/.test(name) && !name.endsWith(".swp");
}
