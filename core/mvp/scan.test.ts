import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classify, findMarkers, folderSource, isTestPath, plannedSource, registrySource, scanFeatures } from "./scan";
import type { DeclaredFeature, FileFact } from "./scan";

const dirs: string[] = [];
function tmp(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mvp-scan-"));
  dirs.push(d);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(d, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const feat = (artifacts: string[]): DeclaredFeature => ({ id: "F1", name: "F one", dependsOn: [], userFacing: false, artifacts });
const fact = (p: string, exists = true, markers: FileFact["markers"] = []): FileFact => ({ path: p, exists, markers });

describe("classify", () => {
  it("done: all files, a test, no markers", () => {
    const r = classify(feat(["src/a.js", "tests/a.test.mjs"]), { files: [fact("src/a.js"), fact("tests/a.test.mjs")] });
    expect(r.status).toBe("done");
    expect(r.findings).toEqual([]);
    expect(r.evidence.map((e) => e.note)).toEqual(["source present", "test present"]);
  });
  it("missing: nothing on disk or nothing declared", () => {
    expect(classify(feat(["a.js"]), { files: [fact("a.js", false)] }).status).toBe("missing");
    expect(classify(feat([]), { files: [] }).status).toBe("missing");
  });
  it("partial: some declared files missing", () => {
    const r = classify(feat(["a.js", "b.js", "t.test.js"]), { files: [fact("a.js"), fact("b.js", false), fact("t.test.js")] });
    expect(r.status).toBe("partial");
    expect(r.findings).toContain("1 of 3 declared files are missing");
    expect(r.evidence).toContainEqual({ file: "b.js", note: "declared but missing" });
  });
  it("partial: no test", () => {
    const r = classify(feat(["a.js"]), { files: [fact("a.js")] });
    expect(r.status).toBe("partial");
    expect(r.findings).toContain("no test covers it");
  });
  it("partial: stub markers, ignored in test files", () => {
    const m = [{ line: 3, kind: "TODO", text: "// TODO fix" }];
    const r = classify(feat(["a.js", "a.test.js"]), { files: [fact("a.js", true, m), fact("a.test.js", true, m)] });
    expect(r.status).toBe("partial");
    expect(r.findings).toEqual(["1 TODO marker"]);
    expect(r.evidence.filter((e) => e.note.startsWith("TODO marker"))).toEqual([{ file: "a.js", line: 3, note: "TODO marker: // TODO fix" }]);
  });
  it("detects test paths on any separator", () => {
    expect(isTestPath("tests-ui/x.jsx")).toBe(true);
    expect(isTestPath("src\\__tests__\\x.js")).toBe(true);
    expect(isTestPath("scripts/e2e-v1-journey.mjs")).toBe(true);
    expect(isTestPath("src/e2eHelpers.js")).toBe(false);
    expect(isTestPath("src/x.spec.ts")).toBe(true);
    expect(isTestPath("src/x.ts")).toBe(false);
  });
});

describe("registrySource", () => {
  const registry = `import { extra } from './more.js';
export const r = {
  maps: [{ id: "M01", title: "x", portals: [] }],
  components: [
    ...extra,
    { id: "C001", name: "Alpha", maps: ["M01"], dependsOn: ["C002"], artifacts: ["src/components/A.jsx", "tests/a.test.mjs"] },
      { id: "C002", name: "Beta", maps: [], dependsOn: [], artifacts: ["scripts/run.mjs"] },
  ]
};`;
  const more = `export const extra = [ { "dependsOn": ["C001"], "artifacts": ["src/x.js"], "id": "C003", "name": "Gamma" } ];
export const moreArtifacts = { "C002": ["src/b.js"] };`;

  it("returns null when the file is missing", () => {
    expect(registrySource().load(tmp({}))).toBeNull();
  });
  it("extracts entries, follows relative imports, merges extra artifacts", () => {
    const root = tmp({
      "src/engine/appMapRegistry.js": registry,
      "src/engine/more.js": more,
      "package.json": JSON.stringify({ scripts: { go: "node scripts/run.mjs" } }),
    });
    const list = registrySource().load(root) as DeclaredFeature[];
    const by = Object.fromEntries(list.map((f) => [f.id, f]));
    expect(Object.keys(by).sort()).toEqual(["C001", "C002", "C003"]);
    expect(by.C001.dependsOn).toEqual(["C002"]);
    expect(by.C001.userFacing).toBe(true);
    expect(by.C002.userFacing).toBe(true);
    expect(by.C002.artifacts).toEqual(["scripts/run.mjs", "src/b.js"]);
    expect(by.C003.userFacing).toBe(false);
  });
  it("scanFeatures labels the source", () => {
    const root = tmp({ "src/engine/appMapRegistry.js": registry, "src/engine/more.js": more });
    const r = scanFeatures(root);
    expect(r.source).toBe("registry:src/engine/appMapRegistry.js");
    expect(r.features.map((f) => f.id)).toEqual(["C001", "C002", "C003"]);
  });
});

describe("folderSource", () => {
  it("returns null with no known folders", () => {
    expect(folderSource().load(tmp({ "README.md": "x" }))).toBeNull();
  });
  it("makes one feature per component with css and tests", () => {
    const root = tmp({
      "src/components/ViewModeToggle.jsx": "export default 1;",
      "src/components/ViewModeToggle.css": "a{}",
      "src/components/ViewModeToggle.test.jsx": "",
      "src/components/Other.jsx": "export default 2;",
      "src/components/Other.css": "",
      "tests-ui/other.test.jsx": "",
      "src/pages/Home.tsx": "export default 3;",
      "src/features/billing/index.ts": "export {};",
      "node_modules/x/src/components/Bad.jsx": "",
    });
    const list = folderSource().load(root) as DeclaredFeature[];
    const by = Object.fromEntries(list.map((f) => [f.id, f]));
    expect(Object.keys(by).sort()).toEqual(["billing", "home", "other", "view-mode-toggle"]);
    expect(by["view-mode-toggle"].name).toBe("View mode toggle");
    expect(by["view-mode-toggle"].artifacts).toEqual([
      "src/components/ViewModeToggle.jsx", "src/components/ViewModeToggle.css", "src/components/ViewModeToggle.test.jsx",
    ]);
    expect(by.other.artifacts).toContain("tests-ui/other.test.jsx");
    const r = scanFeatures(root, { sources: [folderSource()] });
    expect(r.features.find((f) => f.id === "view-mode-toggle")?.status).toBe("done");
    expect(r.features.find((f) => f.id === "home")?.status).toBe("partial");
  });
  it("counts co-located and dotted tests anywhere under src", () => {
    // Found on Looplet: 2,018 tests live beside the code, so 580 features read as untested.
    const root = tmp({
      "src/components/SiteAuditModal.tsx": "export default 1;",
      "src/components/SiteAuditModal.pricing-visibility.test.tsx": "",
      "src/components/ui/Stepper.tsx": "export default 2;",
      "src/components/ui/__tests__/Stepper.test.tsx": "",
      "src/pages/Quotes.tsx": "export default 3;",
      "src/services/quotes.test.ts": "",
      "src/pages/Lonely.tsx": "export default 4;",
    });
    const r = scanFeatures(root, { sources: [folderSource()] });
    const status = Object.fromEntries(r.features.map((f) => [f.id, f.status]));
    expect(status).toEqual({ "site-audit-modal": "done", stepper: "done", quotes: "done", lonely: "partial" });
  });
});

describe("scanFeatures", () => {
  it("detects markers and merges planned features", () => {
    const root = tmp({
      "src/a.js": "x\n// TODO later\nthrow new Error('Not implemented');\n",
      "tests/a.test.js": "",
    });
    const base: DeclaredFeature = { id: "A", name: "Alpha", dependsOn: [], userFacing: false, artifacts: ["src/a.js", "tests/a.test.js"] };
    const planned: DeclaredFeature[] = [
      { id: "Z", name: "alpha", dependsOn: ["B"], userFacing: true, artifacts: [] },
      { id: "N", name: "New thing", dependsOn: [], userFacing: true, artifacts: ["src/new.js"] },
    ];
    const r = scanFeatures(root, { sources: [plannedSource([base])], planned });
    expect(r.source).toBe("planned");
    expect(r.features.map((f) => f.id)).toEqual(["A", "N"]);
    const a = r.features[0];
    expect(a.status).toBe("partial");
    expect(a.dependsOn).toEqual(["B"]);
    expect(a.userFacing).toBe(true);
    expect(a.evidence.filter((e) => e.line).map((e) => e.line)).toEqual([2, 3]);
    expect(r.features[1].status).toBe("missing");
    expect(r.counts).toEqual({ done: 0, partial: 1, missing: 1 });
  });
  it("no applicable source gives an empty result", () => {
    const r = scanFeatures(tmp({}));
    expect(r.features).toEqual([]);
    expect(r.counts).toEqual({ done: 0, partial: 0, missing: 0 });
  });
});

describe("this repository", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  it("scans the app map registry", () => {
    const r = scanFeatures(root);
    expect(r.source.startsWith("registry:")).toBe(true);
    expect(r.features.length).toBeGreaterThanOrEqual(40);
    expect(r.features.find((f) => f.id === "C057")?.name).toBe("End-to-end v1 journey in a real browser");
    expect(r.features.some((f) => f.id === "C058")).toBe(true);
    expect(r.counts.done + r.counts.partial + r.counts.missing).toBe(r.features.length);
    const ids = r.features.map((f) => f.id);
    expect(ids).toEqual([...ids].sort());
    for (const f of r.features) {
      for (const e of f.evidence) {
        expect(e.file).not.toContain("\\");
        if (e.note === "source present" || e.note === "test present") {
          expect(fs.existsSync(path.join(root, ...e.file.split("/")))).toBe(true);
        }
      }
    }
  });
});

describe("findMarkers", () => {
  it("counts markers in comments and Not implemented throws", () => {
    const text = [
      "// TODO: wire the export",
      "const a = 1; /* FIXME later */",
      " * HACK around the API",
      "# XXX shell note",
      'throw new Error("Not implemented");',
    ].join("\n");
    expect(findMarkers(text).map((m) => m.kind)).toEqual(["TODO", "FIXME", "HACK", "XXX", "Not implemented"]);
    expect(findMarkers("// this is a stub for now").map((m) => m.kind)).toEqual(["stub"]);
  });

  it("ignores markers in code, regexes and strings", () => {
    const text = [
      "const pattern = /\\b(?:TODO|FIXME|HACK|XXX)\\b/i;",
      'const message = "Feature not implemented on this platform";',
      'const url = "https://example.com/TODO";',
      "const stub = makeStub();",
    ].join("\n");
    expect(findMarkers(text)).toEqual([]);
  });
});

describe("symlinks and marker text", () => {
  it("does not follow a symlink that points outside the repository", () => {
    const outside = tmp({ "secret.js": "// TODO: leaked outside text\n" });
    const root = tmp({ "tests/a.test.mjs": "" });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    try {
      fs.symlinkSync(path.join(outside, "secret.js"), path.join(root, "src", "a.js"), "file");
    } catch {
      return; // the OS refused to create a symlink (Windows without privilege); nothing to escape through
    }
    const r = scanFeatures(root, { sources: [plannedSource([feat(["src/a.js", "tests/a.test.mjs"])])] });
    const f = r.features[0];
    expect(f.evidence.some((e) => e.note.includes("leaked"))).toBe(false);
    expect(f.evidence.find((e) => e.file === "src/a.js")?.note).toBe("declared but missing");
  });

  it("keeps a symlink that stays inside the repository", () => {
    const root = tmp({ "src/real.js": "export const a = 1;\n", "tests/a.test.mjs": "" });
    try {
      fs.symlinkSync(path.join(root, "src", "real.js"), path.join(root, "src", "a.js"), "file");
    } catch {
      return;
    }
    const r = scanFeatures(root, { sources: [plannedSource([feat(["src/a.js", "tests/a.test.mjs"])])] });
    expect(r.features[0].status).toBe("done");
  });

  it("records only the comment text of a marker, not the code on its line", () => {
    const [m] = findMarkers('const apiKey = "sk-live-123"; // TODO rotate this');
    expect(m.kind).toBe("TODO");
    expect(m.text).not.toContain("sk-live");
    expect(m.text).toContain("TODO rotate this");
  });
});
