import { describe, expect, it } from "vitest";
import { fileSetKey, findCollisions } from "./collisions";

describe("findCollisions", () => {
  it("finds each overlapping pair once, sorted", () => {
    expect(
      findCollisions([
        { taskId: "T-10", files: ["src/a.ts", "src/z.ts"] },
        { taskId: "T-2", files: ["src/a.ts", "src/b.ts"] },
        { taskId: "T-3", files: ["src/b.ts", "src/z.ts"] },
        { taskId: "T-4", files: ["docs/x.md"] },
      ]),
    ).toEqual([
      { tasks: ["T-2", "T-3"], files: ["src/b.ts"] },
      { tasks: ["T-2", "T-10"], files: ["src/a.ts"] },
      { tasks: ["T-3", "T-10"], files: ["src/z.ts"] },
    ]);
  });

  it("treats case-only and slash differences as the same file", () => {
    expect(findCollisions([{ taskId: "T-1", files: ["Src/App.ts"] }, { taskId: "T-2", files: ["src\\app.ts"] }])).toEqual([
      { tasks: ["T-1", "T-2"], files: ["Src/App.ts", "src/app.ts"] },
    ]);
  });

  it("is order independent and ignores a task with itself", () => {
    const a = { taskId: "T-1", files: ["x", "y"] };
    const b = { taskId: "T-2", files: ["y", "x"] };
    expect(findCollisions([a, b])).toEqual(findCollisions([b, a]));
    expect(findCollisions([a, { taskId: "T-1", files: ["x"] }])).toEqual([]);
    expect(findCollisions([])).toEqual([]);
  });

  it("keys a file set without regard to case or order", () => {
    expect(fileSetKey(["B.ts", "a.ts"])).toBe(fileSetKey(["a.ts", "b.ts", "A.ts"]));
  });
});
