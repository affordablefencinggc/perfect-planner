import { describe, expect, it } from "vitest";
import { showMoreLabel, treeCountsLabel } from "../src/components/StructureWorkspace.jsx";

describe("structure tree labels", () => {
  it("uses singular and plural and drops zero parts", () => {
    expect(treeCountsLabel(0, 1)).toBe("1 file");
    expect(treeCountsLabel(0, 5)).toBe("5 files");
    expect(treeCountsLabel(1, 0)).toBe("1 folder");
    expect(treeCountsLabel(2, 1)).toBe("2 folders · 1 file");
    expect(treeCountsLabel(0, 0)).toBe("empty");
    expect(treeCountsLabel(1, 1, "root ")).toBe("1 root folder · 1 root file");
  });
  it("never repeats the same number on the show button", () => {
    expect(showMoreLabel(24, 5, false)).toBe("Show 5 files");
    expect(showMoreLabel(24, 1, false)).toBe("Show 1 file");
    expect(showMoreLabel(48, 5, true)).toBe("Show 5 more");
    expect(showMoreLabel(24, 100, false)).toBe("Show 24 more · 76 left");
  });
});
