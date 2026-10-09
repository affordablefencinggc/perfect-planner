import { describe, expect, it } from "vitest";
import { parseImplements, parseRef, refMatchesClause } from "./refs";

describe("parseRef", () => {
  it("parses a bare clause reference", () => {
    const ref = parseRef("§3.1");
    expect(ref).toEqual({ kind: "clause", clause: "3.1", text: "§3.1" });
    expect(ref && ref.kind === "clause" ? ref.plan : "set").toBeUndefined();
  });

  it("parses a plan-qualified clause reference, with or without a space before §", () => {
    expect(parseRef("P-2 §3.1")).toEqual({ kind: "clause", plan: "P-2", clause: "3.1", text: "P-2 §3.1" });
    expect(parseRef("P-2§3.1")).toEqual({ kind: "clause", plan: "P-2", clause: "3.1", text: "P-2 §3.1" });
  });

  it("parses a task", () => {
    expect(parseRef("T-14")).toEqual({ kind: "number", series: "T", id: "T-14", attempt: 1, text: "T-14" });
  });

  it("parses a task attempt and keeps the task id as the base", () => {
    expect(parseRef("T-14.a2")).toEqual({ kind: "number", series: "T", id: "T-14", attempt: 2, text: "T-14.a2" });
  });

  it("parses decisions, releases, plans and ledger entries without an attempt", () => {
    expect(parseRef("D-3")).toEqual({ kind: "number", series: "D", id: "D-3", attempt: undefined, text: "D-3" });
    expect(parseRef("R-1")).toEqual({ kind: "number", series: "R", id: "R-1", attempt: undefined, text: "R-1" });
    expect(parseRef("P-2")).toEqual({ kind: "number", series: "P", id: "P-2", attempt: undefined, text: "P-2" });
    expect(parseRef("L-000231")).toEqual({ kind: "number", series: "L", id: "L-000231", attempt: undefined, text: "L-000231" });
  });

  it("trims and collapses whitespace", () => {
    expect(parseRef("  P-2    §3.1 ")).toEqual({ kind: "clause", plan: "P-2", clause: "3.1", text: "P-2 §3.1" });
  });

  it("returns undefined for garbage", () => {
    expect(parseRef("garbage")).toBeUndefined();
    expect(parseRef("")).toBeUndefined();
    expect(parseRef("§")).toBeUndefined();
    expect(parseRef("§abc")).toBeUndefined();
    expect(parseRef("L-12")).toBeUndefined(); // ledger numbers need six digits
    expect(parseRef("T-0")).toBeUndefined();
    expect(parseRef("X-1")).toBeUndefined();
    expect(parseRef("P-1.a2")).toBeUndefined();
  });
});

describe("refMatchesClause", () => {
  it("matches a plan-qualified reference only for its own plan", () => {
    expect(refMatchesClause("P-2 §3.1", "3.1", "P-2")).toBe(true);
    expect(refMatchesClause("P-2 §3.1", "3.1", "P-3")).toBe(false);
  });

  it("matches a bare reference in any plan version", () => {
    expect(refMatchesClause("§3.1", "3.1", "P-3")).toBe(true);
    expect(refMatchesClause("§3.1", "3.1")).toBe(true);
  });

  it("matches any plan when the caller names none", () => {
    expect(refMatchesClause("P-2 §3.1", "3.1")).toBe(true);
  });

  it("does not match a different clause or a non-clause ref", () => {
    expect(refMatchesClause("P-2 §3.2", "3.1", "P-2")).toBe(false);
    expect(refMatchesClause("§3.10", "3.1")).toBe(false);
    expect(refMatchesClause("T-14", "3.1")).toBe(false);
    expect(refMatchesClause("nonsense", "3.1")).toBe(false);
  });
});

describe("parseImplements", () => {
  it("reads the citation at the end of a multi-line commit message", () => {
    const message = [
      "Fix login redirect",
      "",
      "The redirect lost the return path when the session expired.",
      "",
      "Implements: P-2 §3.1, P-2 §4 (T-14)",
    ].join("\n");
    expect(parseImplements(message)).toEqual({ refs: ["P-2 §3.1", "P-2 §4"], task: "T-14" });
  });

  it("reads a task attempt and accepts semicolons between refs", () => {
    expect(parseImplements("Work\n\nImplements: P-2 §3.1; P-2 §4.2 (T-14.a2)")).toEqual({
      refs: ["P-2 §3.1", "P-2 §4.2"],
      task: "T-14.a2",
    });
  });

  it("returns no task when the citation has none", () => {
    expect(parseImplements("Work\n\nImplements: P-2 §3.1")).toEqual({ refs: ["P-2 §3.1"], task: undefined });
  });

  it("handles CRLF line endings", () => {
    expect(parseImplements("Subject\r\n\r\nImplements: P-2 §3.1 (T-14)")).toEqual({ refs: ["P-2 §3.1"], task: "T-14" });
  });

  it("drops entries that are not clause references", () => {
    expect(parseImplements("Implements: P-2 §3.1, T-14, D-3 (T-14)")?.refs).toEqual(["P-2 §3.1"]);
  });

  it("returns undefined when no Implements line is present", () => {
    expect(parseImplements("Fix login redirect\n\nNo citation here.")).toBeUndefined();
    expect(parseImplements("")).toBeUndefined();
  });
});
