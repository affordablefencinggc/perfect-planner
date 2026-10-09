// "Each task has a planned size. A change far beyond it is held and split, not pushed."
import type { ChangedFile, ChangeSet, CheckResult } from "./types";

export interface SizeCapOptions {
  /** Hold when changed lines exceed factor x planned lines. Default 2. */
  factor?: number;
  /** Hold any change above this many lines, even without a plan. Default 800. */
  hardCapLines?: number;
  /** Glob-ish patterns counted as zero lines. Replaces the defaults when given. */
  ignore?: string[];
}

export interface SizeSummary {
  lines: number;
  files: number;
  ignoredFiles: string[];
}

export interface SplitPart {
  files: string[];
  lines: number;
  label: string;
}

export interface SplitPlan {
  parts: SplitPart[];
  oversizedFiles: string[];
}

export const DEFAULT_IGNORE: readonly string[] = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "*.snap",
  "*.min.js",
  "dist/",
];

const DEFAULT_FACTOR = 2;
const DEFAULT_HARD_CAP = 800;

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchesIgnore(path: string, pattern: string): boolean {
  const p = norm(path);
  const pat = norm(pattern);
  if (pat.endsWith("/")) return p.startsWith(pat) || p.includes("/" + pat);
  if (pat.startsWith("*")) return p.endsWith(pat.slice(1));
  return p === pat || p.endsWith("/" + pat);
}

export function isIgnored(path: string, options: SizeCapOptions = {}): boolean {
  const patterns = options.ignore ?? DEFAULT_IGNORE;
  return patterns.some((pat) => matchesIgnore(path, pat));
}

function fileLines(file: ChangedFile, options: SizeCapOptions): number {
  if (file.binary || isIgnored(file.path, options)) return 0;
  return Math.max(0, file.added) + Math.max(0, file.removed);
}

export function changeSize(files: readonly ChangedFile[], options: SizeCapOptions = {}): SizeSummary {
  let lines = 0;
  const ignoredFiles: string[] = [];
  for (const f of files) {
    if (isIgnored(f.path, options)) {
      ignoredFiles.push(norm(f.path));
      continue;
    }
    lines += fileLines(f, options);
  }
  return { lines, files: files.length, ignoredFiles };
}

/** The line count above which a change is held. */
export function sizeCap(plannedLines: number | undefined, options: SizeCapOptions = {}): number {
  const hard = options.hardCapLines ?? DEFAULT_HARD_CAP;
  if (plannedLines === undefined || plannedLines <= 0) return hard;
  const factor = options.factor ?? DEFAULT_FACTOR;
  return Math.min(Math.ceil(plannedLines * factor), hard);
}

export function checkSize(change: ChangeSet, options: SizeCapOptions = {}): CheckResult {
  const { lines } = changeSize(change.files, options);
  const planned = change.plannedLines !== undefined && change.plannedLines > 0 ? change.plannedLines : undefined;
  const cap = sizeCap(planned, options);
  const planText = planned === undefined ? "no plan" : `plan was ${planned}`;
  if (lines <= cap) {
    return {
      check: "size-cap",
      status: "pass",
      summary: `${lines} lines changed, ${planText} (cap ${cap}): within the cap`,
      detail: { lines, cap, planned },
    };
  }
  const split = planSplit(change.files, cap, options);
  return {
    check: "size-cap",
    status: "hold",
    summary: `${lines} lines changed, ${planText} (cap ${cap}): held for splitting`,
    detail: { lines, cap, planned, split },
  };
}

// ---------------------------------------------------------------------------
// Splitting

interface Item {
  files: { path: string; lines: number }[];
  lines: number;
  dir: string;
}

function folderOf(path: string): string {
  const segs = norm(path).split("/");
  if (segs.length === 1) return "(root)";
  if (segs[0] === "core" && segs.length >= 3) return `core/${segs[1]}`;
  return segs[0] ?? "(root)";
}

function pairKey(path: string): string {
  return norm(path)
    .replace(/\.[^./]+$/, "")
    .replace(/\.(unit\.)?(test|spec)$/, "");
}

function mkItem(dir: string, files: { path: string; lines: number }[]): Item {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: sorted, lines: sorted.reduce((n, f) => n + f.lines, 0), dir };
}

function cmpItems(a: Item, b: Item): number {
  if (b.lines !== a.lines) return b.lines - a.lines;
  const ap = a.files[0]?.path ?? "";
  const bp = b.files[0]?.path ?? "";
  return ap < bp ? -1 : ap > bp ? 1 : 0;
}

export function planSplit(files: readonly ChangedFile[], capLines: number, options: SizeCapOptions = {}): SplitPlan {
  const cap = Math.max(1, capLines);
  const byFolder = new Map<string, { path: string; lines: number }[]>();
  for (const f of files) {
    const dir = folderOf(f.path);
    const list = byFolder.get(dir) ?? [];
    list.push({ path: norm(f.path), lines: fileLines(f, options) });
    byFolder.set(dir, list);
  }

  const oversized = new Set<string>();
  const items: Item[] = [];
  for (const dir of [...byFolder.keys()].sort()) {
    const group = mkItem(dir, byFolder.get(dir) ?? []);
    if (group.lines <= cap) {
      items.push(group);
      continue;
    }
    const byPair = new Map<string, { path: string; lines: number }[]>();
    for (const f of group.files) {
      const k = pairKey(f.path);
      byPair.set(k, [...(byPair.get(k) ?? []), f]);
    }
    for (const unitFiles of byPair.values()) {
      const unit = mkItem(dir, unitFiles);
      if (unit.lines <= cap) {
        items.push(unit);
        continue;
      }
      for (const f of unit.files) {
        if (f.lines > cap) oversized.add(f.path);
        items.push(mkItem(dir, [f]));
      }
    }
  }

  items.sort(cmpItems);
  const bins: Item[][] = [];
  const loads: number[] = [];
  for (const item of items) {
    let idx = -1;
    for (let i = 0; i < bins.length; i++) {
      if ((loads[i] ?? 0) + item.lines <= cap) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      bins.push([item]);
      loads.push(item.lines);
    } else {
      bins[idx]?.push(item);
      loads[idx] = (loads[idx] ?? 0) + item.lines;
    }
  }

  const raw = bins.map((bin) => {
    const paths = bin.flatMap((i) => i.files.map((f) => f.path)).sort();
    const lines = bin.reduce((n, i) => n + i.lines, 0);
    const dirs = [...new Set(bin.map((i) => i.dir))].sort();
    return { paths, lines, dirs };
  });
  raw.sort((a, b) => (a.paths[0] ?? "") < (b.paths[0] ?? "") ? -1 : (a.paths[0] ?? "") > (b.paths[0] ?? "") ? 1 : 0);

  const parts: SplitPart[] = raw.map((r) => {
    const shown = r.dirs.slice(0, 3).join(", ") + (r.dirs.length > 3 ? ` +${r.dirs.length - 3} more` : "");
    const n = r.paths.length;
    return {
      files: r.paths,
      lines: r.lines,
      label: `${shown} (${n} ${n === 1 ? "file" : "files"}, ${r.lines} ${r.lines === 1 ? "line" : "lines"})`,
    };
  });
  // Disambiguate identical labels deterministically.
  const seen = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const p of parts) totals.set(p.label, (totals.get(p.label) ?? 0) + 1);
  for (const p of parts) {
    if ((totals.get(p.label) ?? 0) > 1) {
      const k = (seen.get(p.label) ?? 0) + 1;
      seen.set(p.label, k);
      p.label = `${p.label} - part ${k}`;
    }
  }

  return { parts, oversizedFiles: [...oversized].sort() };
}

// ---------------------------------------------------------------------------
// git diff --numstat

function resolveRename(raw: string): string {
  const brace = raw.match(/^(.*)\{(.*?) => (.*?)\}(.*)$/);
  if (brace) {
    const [, pre = "", , to = "", post = ""] = brace;
    return (pre + to + post).replace(/\/{2,}/g, "/");
  }
  const arrow = raw.indexOf(" => ");
  if (arrow >= 0) return raw.slice(arrow + 4);
  return raw;
}

export function parseNumstat(text: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const [, a = "", r = "", rawPath = ""] = m;
    let path = resolveRename(rawPath.trim());
    if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) path = path.slice(1, -1);
    path = norm(path);
    if (a === "-" || r === "-") out.push({ path, added: 0, removed: 0, binary: true });
    else out.push({ path, added: Number(a), removed: Number(r) });
  }
  return out;
}
