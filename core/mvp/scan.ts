// Feature scan: finds what features a repository claims and how finished each
// one is on disk. Text only: no repo file is ever imported or executed.
// Paths in results are repo-relative with forward slashes on every platform.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Evidence, Feature, FeatureStatus, ScanResult, ScannedFeature } from "./types";

export type DeclaredFeature = Feature & { artifacts: string[] };

export interface FeatureSource {
  name: string;
  /** null means "this source does not apply here". */
  load(root: string): DeclaredFeature[] | null;
}

export interface Marker {
  line: number;
  kind: string;   // "TODO", "FIXME", "Not implemented", "stub", ...
  text: string;   // trimmed source line
}

export interface FileFact {
  path: string;       // repo-relative, forward slashes
  exists: boolean;
  markers: Marker[];  // stub markers found (empty for tests, missing and oversized files)
}

export interface Facts {
  files: FileFact[];
}

export interface Classification {
  status: FeatureStatus;
  evidence: Evidence[];
  findings: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".perfect-planner"]);
const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_MARKERS_PER_FILE = 5;
const SOURCE_EXT = /\.(jsx|tsx|js|ts|vue|svelte)$/i;
const NO_MARKER_EXT = /\.(md|markdown|json|txt|lock|csv|svg)$/i;

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isTestPath(p: string): boolean {
  const s = "/" + toPosix(p);
  // An end-to-end journey script is a test too: scripts/e2e-v1-journey.mjs.
  return /\/(tests|tests-ui|__tests__|e2e)\//.test(s) || /\.(test|spec)\./.test(s) || /\/e2e[-_.][^/]*$/.test(s);
}

// ---------------------------------------------------------------- classify

export function findMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < MAX_MARKERS_PER_FILE; i++) {
    const l = lines[i];
    let kind: string | null = null;
    // Only comments count, so a scanner's own /TODO/ pattern or a message
    // string mentioning "not implemented" is not a stub.
    const comment = commentText(l);
    const m = comment === null ? null : /\b(TODO|FIXME|XXX|HACK)\b/.exec(comment);
    if (m) kind = m[1];
    else if (/throw new Error\(["'`]Not implemented/i.test(l) || (comment !== null && /not implemented/i.test(comment))) kind = "Not implemented";
    else if (comment !== null && /\bstub\b/i.test(comment)) kind = "stub";
    if (kind) out.push({ line: i + 1, kind, text: l.trim().slice(0, 80) });
  }
  return out;
}

function commentText(line: string): string | null {
  const block = /^\s*(\*|#|<!--)/.exec(line);
  if (block) return line.slice(block.index + block[0].length);
  const at = line.search(/(^|[^:"'`\\])(\/\/|\/\*)/);
  if (at < 0) return null;
  return line.slice(at).replace(/^[^/]?(\/\/|\/\*)/, "");
}

export function classify(feature: DeclaredFeature, facts: Facts): Classification {
  const evidence: Evidence[] = [];
  const findings: string[] = [];
  const declared = facts.files;
  const existing = declared.filter((f) => f.exists);
  const missingFiles = declared.filter((f) => !f.exists);
  const tests = existing.filter((f) => isTestPath(f.path));
  const sources = existing.filter((f) => !isTestPath(f.path));

  for (const f of declared) {
    if (!f.exists) evidence.push({ file: f.path, note: "declared but missing" });
    else evidence.push({ file: f.path, note: isTestPath(f.path) ? "test present" : "source present" });
  }
  const markers: { file: string; m: Marker }[] = [];
  for (const f of sources) for (const m of f.markers.slice(0, MAX_MARKERS_PER_FILE)) markers.push({ file: f.path, m });
  for (const { file, m } of markers) {
    evidence.push({ file, line: m.line, note: `${m.kind} marker: ${m.text}`.slice(0, 120) });
  }

  if (declared.length === 0 || existing.length === 0) {
    findings.push(declared.length === 0 ? "no files are declared" : `none of the ${declared.length} declared ${declared.length === 1 ? "file exists" : "files exist"}`);
    return { status: "missing", evidence, findings };
  }

  if (missingFiles.length > 0) findings.push(`${missingFiles.length} of ${declared.length} declared files are missing`);
  if (tests.length === 0) findings.push("no test covers it");
  if (markers.length > 0) {
    const kinds = new Set(markers.map((x) => x.m.kind));
    const label = kinds.size === 1 ? [...kinds][0] : "stub";
    findings.push(`${markers.length} ${label} ${markers.length === 1 ? "marker" : "markers"}`);
  }
  return { status: findings.length > 0 ? "partial" : "done", evidence, findings };
}

// ------------------------------------------------------------ file helpers

function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function readTextSafe(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function safeRel(rel: string): string | null {
  const norm = path.posix.normalize(toPosix(rel).replace(/^\.\//, ""));
  if (!norm || norm === "." || norm.startsWith("../") || norm === ".." || path.posix.isAbsolute(norm)) return null;
  return norm;
}

function factFor(root: string, rel: string): FileFact {
  const norm = safeRel(rel);
  if (!norm) return { path: toPosix(rel), exists: false, markers: [] };
  const abs = path.join(root, ...norm.split("/"));
  let size = 0;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { path: norm, exists: false, markers: [] };
    size = st.size;
  } catch {
    return { path: norm, exists: false, markers: [] };
  }
  if (isTestPath(norm) || size > MAX_SCAN_BYTES || NO_MARKER_EXT.test(norm)) return { path: norm, exists: true, markers: [] };
  const text = readTextSafe(abs);
  if (text === null || text.includes("\0")) return { path: norm, exists: true, markers: [] };
  return { path: norm, exists: true, markers: findMarkers(text) };
}

/** Recursively list files under a repo-relative dir, as repo-relative posix paths. */
function walk(root: string, relDir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, ...relDir.split("/").filter(Boolean)), { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

// ----------------------------------------------------- literal text parser

type Lit = string | number | boolean | null | Lit[] | { [k: string]: Lit };

class Parser {
  i: number;
  constructor(private s: string, start: number) {
    this.i = start;
  }
  private ws(): void {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && /\s/.test(s[this.i])) this.i++;
      if (s.startsWith("//", this.i)) {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
      } else if (s.startsWith("/*", this.i)) {
        const e = s.indexOf("*/", this.i + 2);
        this.i = e < 0 ? s.length : e + 2;
      } else return;
    }
  }
  private str(): string {
    const s = this.s;
    const q = s[this.i++];
    let out = "";
    while (this.i < s.length && s[this.i] !== q) {
      let c = s[this.i++];
      if (c === "\\") {
        const n = s[this.i++];
        c = n === "n" ? "\n" : n === "t" ? "\t" : n === "u" ? String.fromCharCode(parseInt(s.slice(this.i, (this.i += 4)), 16)) : n;
      } else if (c === "\n" && q !== "`") throw new Error("newline in string");
      out += c;
    }
    if (s[this.i] !== q) throw new Error("unterminated string");
    this.i++;
    return out;
  }
  value(): Lit {
    this.ws();
    const s = this.s;
    const c = s[this.i];
    if (c === '"' || c === "'" || c === "`") return this.str();
    if (c === "[") {
      this.i++;
      const arr: Lit[] = [];
      for (;;) {
        this.ws();
        if (s[this.i] === "]") { this.i++; return arr; }
        arr.push(this.value());
        this.ws();
        if (s[this.i] === ",") this.i++;
        else if (s[this.i] !== "]") throw new Error("bad array");
      }
    }
    if (c === "{") {
      this.i++;
      const obj: { [k: string]: Lit } = {};
      for (;;) {
        this.ws();
        if (s[this.i] === "}") { this.i++; return obj; }
        let key: string;
        if (s[this.i] === '"' || s[this.i] === "'") key = this.str();
        else {
          const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(this.i, this.i + 80));
          if (!m) throw new Error("bad key");
          key = m[0];
          this.i += key.length;
        }
        this.ws();
        if (s[this.i] !== ":") throw new Error("expected colon");
        this.i++;
        obj[key] = this.value();
        this.ws();
        if (s[this.i] === ",") this.i++;
        else if (s[this.i] !== "}") throw new Error("bad object");
      }
    }
    const m = /^(-?\d+(\.\d+)?|true|false|null)/.exec(s.slice(this.i, this.i + 40));
    if (m) {
      this.i += m[0].length;
      return m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" ? null : Number(m[0]);
    }
    throw new Error("unsupported value");
  }
}

function tryParse(text: string, at: number): { value: Lit; end: number } | null {
  try {
    const p = new Parser(text, at);
    const value = p.value();
    return { value, end: p.i };
  } catch {
    return null;
  }
}

const ID_RE = /^[A-Za-z][\w-]*$/;

function strArray(v: Lit | undefined): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

/** Every `{ id, name, artifacts: [...] }` object literal in the text, plus `xArtifacts = { id: [...] }` maps. */
export function extractDeclared(text: string): { features: DeclaredFeature[]; extra: Record<string, string[]> } {
  const features: DeclaredFeature[] = [];
  const extra: Record<string, string[]> = {};
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") { const e = text.indexOf("\n", i); i = e < 0 ? text.length : e; continue; }
    if (ch === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      // skip string literals so braces in text are not mistaken for objects
      let j = i + 1;
      while (j < text.length && text[j] !== ch && !(text[j] === "\n" && ch !== "`")) j += text[j] === "\\" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (ch === "{") {
      const r = tryParse(text, i);
      if (r && r.value && typeof r.value === "object" && !Array.isArray(r.value)) {
        const o = r.value;
        const arts = strArray(o.artifacts);
        if (typeof o.id === "string" && ID_RE.test(o.id) && arts) {
          features.push({
            id: o.id,
            name: typeof o.name === "string" ? o.name : typeof o.title === "string" ? o.title : o.id,
            description: typeof o.description === "string" ? o.description : undefined,
            dependsOn: strArray(o.dependsOn) ?? [],
            userFacing: false,
            artifacts: [...arts],
          });
          i = r.end;
          continue;
        }
        const before = text.slice(Math.max(0, i - 80), i);
        if (/\b\w*Artifacts\s*=\s*$/.test(before)) {
          const keys = Object.keys(o);
          if (keys.length > 0 && keys.every((k) => strArray(o[k]))) {
            for (const k of keys) extra[k] = [...(extra[k] ?? []), ...(o[k] as string[])];
            i = r.end;
            continue;
          }
        }
      }
    }
    i++;
  }
  return { features, extra };
}

function relativeImports(text: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"`;]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\s*["'](\.{1,2}\/[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2]);
  return out;
}

function mergeDeclared(into: Map<string, DeclaredFeature>, f: DeclaredFeature): void {
  const cur = into.get(f.id);
  if (!cur) {
    into.set(f.id, { ...f, dependsOn: [...f.dependsOn], artifacts: [...f.artifacts] });
    return;
  }
  cur.artifacts = unique([...cur.artifacts, ...f.artifacts]);
  cur.dependsOn = unique([...cur.dependsOn, ...f.dependsOn]);
  if (cur.name === cur.id && f.name !== f.id) cur.name = f.name;
  cur.userFacing = cur.userFacing || f.userFacing;
  cur.description = cur.description ?? f.description;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function packageScriptFiles(root: string): Set<string> {
  const out = new Set<string>();
  const text = readTextSafe(path.join(root, "package.json"));
  if (!text) return out;
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
    for (const v of Object.values(scripts)) {
      if (typeof v !== "string") continue;
      for (const m of v.matchAll(/(?:^|[\s"'=])\.?\/?(scripts\/[\w./-]+\.mjs)\b/g)) out.add(m[1]);
    }
  } catch {
    // unreadable package.json: no script files
  }
  return out;
}

// ----------------------------------------------------------------- sources

export function registrySource(relPath = "src/engine/appMapRegistry.js"): FeatureSource {
  const rel = toPosix(relPath);
  return {
    name: `registry:${rel}`,
    load(root: string): DeclaredFeature[] | null {
      if (!isFile(path.join(root, ...rel.split("/")))) return null;
      const found = new Map<string, DeclaredFeature>();
      const extras: Record<string, string[]> = {};
      const seen = new Set<string>();
      const queue = [rel];
      while (queue.length > 0) {
        const cur = queue.shift() as string;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const text = readTextSafe(path.join(root, ...cur.split("/")));
        if (text === null) continue;
        const { features, extra } = extractDeclared(text);
        for (const f of features) mergeDeclared(found, f);
        for (const [k, v] of Object.entries(extra)) extras[k] = [...(extras[k] ?? []), ...v];
        for (const imp of relativeImports(text)) {
          const base = path.posix.normalize(path.posix.join(path.posix.dirname(cur), imp));
          for (const cand of [base, `${base}.js`, `${base}.mjs`, `${base}.ts`]) {
            if (isFile(path.join(root, ...cand.split("/")))) { queue.push(cand); break; }
          }
        }
      }
      const scriptFiles = packageScriptFiles(root);
      const list: DeclaredFeature[] = [];
      for (const f of found.values()) {
        f.artifacts = unique([...f.artifacts, ...(extras[f.id] ?? [])].map(toPosix));
        f.userFacing = f.artifacts.some((a) => a.startsWith("src/components/") || /\.(jsx|tsx)$/i.test(a) || scriptFiles.has(a));
        list.push(f);
      }
      return list;
    },
  };
}

function words(base: string): string[] {
  return base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function slugify(base: string): string {
  return words(base).map((w) => w.toLowerCase()).join("-");
}

export function humanName(base: string): string {
  const w = words(base).map((x) => x.toLowerCase());
  if (w.length === 0) return base;
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(" ");
}

function stemOf(file: string): string {
  const b = path.posix.basename(file);
  return b.replace(/\.(test|spec)\.[^.]+$/i, "").replace(/\.[^.]+$/, "");
}

export function folderSource(): FeatureSource {
  return {
    name: "folders",
    load(root: string): DeclaredFeature[] | null {
      const roots = ["src/components", "src/pages", "src/features", "app/routes"];
      const present = roots.filter((r) => {
        try { return fs.statSync(path.join(root, ...r.split("/"))).isDirectory(); } catch { return false; }
      });
      if (present.length === 0) return null;
      const testFiles = [...walk(root, "tests"), ...walk(root, "tests-ui"), ...walk(root, "__tests__")];
      const allSrc = walk(root, "src");
      const byDir = new Map<string, string[]>();
      for (const f of allSrc) {
        const d = path.posix.dirname(f);
        byDir.set(d, [...(byDir.get(d) ?? []), f]);
      }
      const out = new Map<string, DeclaredFeature>();
      const add = (f: DeclaredFeature): void => {
        let id = f.id;
        for (let n = 2; out.has(id); n++) id = `${f.id}-${n}`;
        out.set(id, { ...f, id });
      };
      const testsFor = (stems: Set<string>): string[] =>
        testFiles.filter((t) => stems.has(slugify(stemOf(t))));
      const isSource = (f: string): boolean => SOURCE_EXT.test(f) || /\.(vue|svelte)$/.test(f);
      for (const r of present) {
        if (r === "src/features") {
          const dirs = fs.readdirSync(path.join(root, "src", "features"), { withFileTypes: true })
            .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name).sort();
          for (const d of dirs) {
            const files = walk(root, `src/features/${d}`);
            const src = files.filter((f) => !/\.css$/i.test(f));
            if (src.filter((f) => isSource(f) && !isTestPath(f)).length === 0) continue;
            add({
              id: slugify(d), name: humanName(d), dependsOn: [], userFacing: true,
              artifacts: unique([...files, ...testsFor(new Set([slugify(d)]))]),
            });
          }
          continue;
        }
        for (const f of walk(root, r)) {
          const base = path.posix.basename(f);
          if (!isSource(f) || /\.(test|spec)\./.test(base) || /\.css$/i.test(base)) continue;
          let stem = stemOf(f);
          if (stem.toLowerCase() === "index") stem = path.posix.basename(path.posix.dirname(f));
          const slug = slugify(stem);
          if (!slug) continue;
          const dir = path.posix.dirname(f);
          const fileStem = stemOf(f);
          const siblings = (byDir.get(dir) ?? []).filter((s) => {
            if (s === f) return false;
            const sb = path.posix.basename(s);
            return (/\.css$/i.test(sb) && stemOf(s) === fileStem) || (/\.(test|spec)\./.test(sb) && stemOf(s) === fileStem);
          });
          add({
            id: slug, name: humanName(stem), dependsOn: [], userFacing: true,
            artifacts: unique([f, ...siblings, ...testsFor(new Set([slug]))]),
          });
        }
      }
      return [...out.values()];
    },
  };
}

export function plannedSource(features: DeclaredFeature[]): FeatureSource {
  return {
    name: "planned",
    load(): DeclaredFeature[] | null {
      return features.map((f) => ({ ...f, dependsOn: [...f.dependsOn], artifacts: [...f.artifacts] }));
    },
  };
}

// -------------------------------------------------------------------- scan

export function scanFeatures(root: string, opts: { sources?: FeatureSource[]; planned?: DeclaredFeature[] } = {}): ScanResult {
  const sources = opts.sources ?? [registrySource(), folderSource()];
  let sourceName = "none";
  let declared: DeclaredFeature[] = [];
  for (const s of sources) {
    const got = s.load(root);
    if (got !== null) {
      sourceName = s.name;
      declared = got;
      break;
    }
  }
  const list = declared.map((f) => ({ ...f, dependsOn: [...f.dependsOn], artifacts: [...f.artifacts] }));
  for (const p of opts.planned ?? []) {
    const lname = p.name.toLowerCase();
    const hit = list.find((f) => f.id === p.id) ?? list.find((f) => f.name.toLowerCase() === lname);
    if (hit) {
      hit.artifacts = unique([...hit.artifacts, ...p.artifacts]);
      hit.dependsOn = unique([...hit.dependsOn, ...p.dependsOn]);
      hit.userFacing = hit.userFacing || p.userFacing;
      hit.description = hit.description ?? p.description;
    } else list.push({ ...p, dependsOn: [...p.dependsOn], artifacts: [...p.artifacts] });
  }

  const cache = new Map<string, FileFact>();
  const features: ScannedFeature[] = [];
  for (const f of list) {
    const files: FileFact[] = unique(f.artifacts.map(toPosix)).map((a) => {
      const hit = cache.get(a);
      if (hit) return hit;
      const fact = factFor(root, a);
      cache.set(a, fact);
      return fact;
    });
    const c = classify(f, { files });
    const { artifacts, ...feature } = f;
    void artifacts;
    features.push({ ...feature, status: c.status, evidence: c.evidence, findings: c.findings });
  }
  features.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counts: Record<FeatureStatus, number> = { done: 0, partial: 0, missing: 0 };
  for (const f of features) counts[f.status]++;
  return { root: path.resolve(root), source: sourceName, features, counts };
}
