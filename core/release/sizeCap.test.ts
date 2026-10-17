import { describe, expect, it } from "vitest";
import { changeSize, checkSize, parseNumstat, planSplit, sizeCap } from "./sizeCap";
import type { ChangedFile } from "./types";

const f = (path: string, added: number, removed = 0, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, added, removed, ...extra });

describe("changeSize", () => {
  it("sums added and removed", () => {
    expect(changeSize([f("a.ts", 10, 5), f("b.ts", 1, 2)])).toEqual({ lines: 18, files: 2, ignoredFiles: [] });
  });
  it("counts binary as a file with zero lines", () => {
    const r = changeSize([f("a.png", 0, 0, { binary: true }), f("b.ts", 3, 1, { binary: false })]);
    expect(r.lines).toBe(4);
    expect(r.files).toBe(2);
  });
  it("ignores lockfiles, snapshots, minified and dist", () => {
    const r = changeSize([
      f("package-lock.json", 5000), f("sub/yarn.lock", 10), f("pnpm-lock.yaml", 10),
      f("x/__snapshots__/a.snap", 99), f("lib/a.min.js", 400), f("dist/out.js", 700), f("pkg/dist/x.js", 5),
      f("src/a.ts", 7),
    ]);
    expect(r.lines).toBe(7);
    expect(r.files).toBe(8);
    expect(r.ignoredFiles).toHaveLength(7);
  });
  it("does not ignore look-alikes", () => {
    expect(changeSize([f("distance/a.ts", 4), f("src/mypackage-lock.json.ts", 2)]).lines).toBe(6);
  });
  it("custom ignore replaces defaults", () => {
    const r = changeSize([f("package-lock.json", 100), f("gen/a.ts", 50)], { ignore: ["gen/"] });
    expect(r.lines).toBe(100);
    expect(r.ignoredFiles).toEqual(["gen/a.ts"]);
  });
  it("normalizes backslashes for matching", () => {
    expect(changeSize([f("dist\\a.js", 9)]).lines).toBe(0);
  });
  it("handles empty", () => {
    expect(changeSize([])).toEqual({ lines: 0, files: 0, ignoredFiles: [] });
  });
});

describe("sizeCap", () => {
  it("uses factor x plan, bounded by hard cap", () => {
    expect(sizeCap(150)).toBe(300);
    expect(sizeCap(150, { factor: 3 })).toBe(450);
    expect(sizeCap(1000)).toBe(800);
    expect(sizeCap(undefined)).toBe(800);
    expect(sizeCap(undefined, { hardCapLines: 100 })).toBe(100);
  });
});

describe("checkSize", () => {
  it("passes within the cap", () => {
    const r = checkSize({ files: [f("a.ts", 200, 100)], plannedLines: 150 });
    expect(r.check).toBe("size-cap");
    expect(r.status).toBe("pass");
    expect(r.summary).toBe("300 lines changed, plan was 150 (cap 300): within the cap");
  });
  it("holds beyond factor x plan with a split", () => {
    const r = checkSize({ files: [f("a/x.ts", 200, 112)], plannedLines: 150 });
    expect(r.status).toBe("hold");
    expect(r.summary).toBe("312 lines changed, plan was 150 (cap 300): held for splitting");
    const d = r.detail as { lines: number; cap: number; planned: number; split: { parts: unknown[] } };
    expect(d).toMatchObject({ lines: 312, cap: 300, planned: 150 });
    expect(d.split.parts).toHaveLength(1);
  });
  it("holds above hard cap without a plan", () => {
    const r = checkSize({ files: [f("a.ts", 900)] });
    expect(r.status).toBe("hold");
    expect(r.summary).toBe("900 lines changed, no plan (cap 800): held for splitting");
  });
  it("passes with no plan under the hard cap", () => {
    expect(checkSize({ files: [f("a.ts", 799)] }).status).toBe("pass");
  });
  it("hard cap applies even with a generous plan", () => {
    expect(checkSize({ files: [f("a.ts", 900)], plannedLines: 1000 }).status).toBe("hold");
  });
  it("lockfile churn does not trigger a hold", () => {
    expect(checkSize({ files: [f("package-lock.json", 5000), f("a.ts", 10)], plannedLines: 20 }).status).toBe("pass");
  });
  it("respects custom factor", () => {
    expect(checkSize({ files: [f("a.ts", 200)], plannedLines: 100 }, { factor: 3 }).status).toBe("pass");
  });
  it("treats zero plan as no plan", () => {
    expect(checkSize({ files: [f("a.ts", 10)], plannedLines: 0 }).summary).toContain("no plan");
  });
});

describe("planSplit", () => {
  it("groups by top-level folder and core module", () => {
    const p = planSplit([f("core/release/a.ts", 10), f("core/other/b.ts", 10), f("src/c.ts", 10), f("README.md", 1)], 100);
    expect(p.parts).toHaveLength(1);
    expect(p.parts[0]?.lines).toBe(31);
    const p2 = planSplit([f("core/release/a.ts", 60), f("core/other/b.ts", 60), f("src/c.ts", 30)], 100);
    expect(p2.parts.map((x) => x.files)).toEqual([["core/other/b.ts", "src/c.ts"], ["core/release/a.ts"]]);
  });
  it("labels plainly", () => {
    const p = planSplit([f("core/release/a.ts", 100), f("core/release/b.ts", 110)], 300);
    expect(p.parts[0]?.label).toBe("core/release (2 files, 210 lines)");
    expect(planSplit([f("a/x.ts", 1)], 10).parts[0]?.label).toBe("a (1 file, 1 line)");
  });
  it("keeps tests with their source when splitting a big folder", () => {
    const files = [
      f("core/m/a.ts", 50), f("core/m/a.test.ts", 40),
      f("core/m/b.ts", 50), f("core/m/b.unit.test.ts", 40),
      f("core/m/c.ts", 50),
    ];
    const p = planSplit(files, 100);
    const partOf = (path: string) => p.parts.findIndex((x) => x.files.includes(path));
    expect(partOf("core/m/a.ts")).toBe(partOf("core/m/a.test.ts"));
    expect(partOf("core/m/b.ts")).toBe(partOf("core/m/b.unit.test.ts"));
    for (const part of p.parts) expect(part.lines).toBeLessThanOrEqual(100);
    expect(p.oversizedFiles).toEqual([]);
  });
  it("splits an over-cap unit by file and flags oversized files", () => {
    const p = planSplit([f("core/m/a.ts", 150), f("core/m/a.test.ts", 80), f("core/m/b.ts", 20)], 100);
    expect(p.oversizedFiles).toEqual(["core/m/a.ts"]);
    const big = p.parts.find((x) => x.files.includes("core/m/a.ts"));
    expect(big?.files).toEqual(["core/m/a.ts"]);
    expect(big?.lines).toBe(150);
    expect(p.parts.flatMap((x) => x.files).sort()).toEqual(["core/m/a.test.ts", "core/m/a.ts", "core/m/b.ts"]);
  });
  it("bin-packs first-fit decreasing", () => {
    const p = planSplit([f("a/1.ts", 60), f("b/1.ts", 50), f("c/1.ts", 40), f("d/1.ts", 30), f("e/1.ts", 20)], 100);
    expect(p.parts.map((x) => x.lines).sort((x, y) => y - x)).toEqual([100, 100]);
  });
  it("is deterministic regardless of input order", () => {
    const files = [f("b/1.ts", 70), f("a/1.ts", 70), f("c/1.ts", 70), f("a/2.ts", 5)];
    const a = planSplit(files, 100);
    const b = planSplit([...files].reverse(), 100);
    expect(a).toEqual(b);
  });
  it("disambiguates identical labels", () => {
    const p = planSplit([f("a/1.ts", 90), f("b/1.ts", 90)].map((x) => x), 100);
    expect(new Set(p.parts.map((x) => x.label)).size).toBe(p.parts.length);
    const q = planSplit([f("a/1.ts", 90), f("a/2.ts", 90)], 100);
    expect(q.parts.map((x) => x.label)).toEqual(["a (1 file, 90 lines) - part 1", "a (1 file, 90 lines) - part 2"]);
  });
  it("counts ignored and binary files as zero lines but keeps them", () => {
    const p = planSplit([f("package-lock.json", 9000), f("a.png", 0, 0, { binary: true }), f("x.ts", 10)], 50);
    expect(p.parts).toHaveLength(1);
    expect(p.parts[0]?.lines).toBe(10);
    expect(p.parts[0]?.files).toHaveLength(3);
  });
  it("handles empty input", () => {
    expect(planSplit([], 100)).toEqual({ parts: [], oversizedFiles: [] });
  });
});

describe("parseNumstat", () => {
  it("parses plain lines and CRLF", () => {
    expect(parseNumstat("10\t2\tsrc/a.ts\r\n3\t0\tb.ts\r\n")).toEqual([
      { path: "src/a.ts", added: 10, removed: 2 },
      { path: "b.ts", added: 3, removed: 0 },
    ]);
  });
  it("parses binaries", () => {
    expect(parseNumstat("-\t-\timg/a.png\n")).toEqual([{ path: "img/a.png", added: 0, removed: 0, binary: true }]);
  });
  it("parses plain and brace renames", () => {
    const r = parseNumstat("1\t1\told.ts => new.ts\n2\t3\tsrc/{a => b}/c.ts\n0\t0\t{ => lib}/d.ts\n4\t4\tsrc/{x.ts => y.ts}\n");
    expect(r.map((x) => x.path)).toEqual(["new.ts", "src/b/c.ts", "lib/d.ts", "src/y.ts"]);
    expect(r[1]).toMatchObject({ added: 2, removed: 3 });
  });
  it("collapses empty brace sides", () => {
    expect(parseNumstat("1\t0\tsrc/{old => }/c.ts\n")[0]?.path).toBe("src/c.ts");
  });
  it("skips blank and junk lines", () => {
    expect(parseNumstat("\n\nnot a line\n")).toEqual([]);
    expect(parseNumstat("")).toEqual([]);
  });
  it("round-trips into changeSize", () => {
    expect(changeSize(parseNumstat("5\t5\ta.ts\n-\t-\tb.png\n")).lines).toBe(10);
  });
});
