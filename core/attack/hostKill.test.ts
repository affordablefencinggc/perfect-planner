import { describe, expect, it } from "vitest";
import { hostKillPlan } from "./helpers";

describe("how the crash tests kill the host", () => {
  it("signals the whole process group on POSIX", () => {
    expect(hostKillPlan(4242, "linux")).toEqual({ kind: "signal", group: -4242 });
    expect(hostKillPlan(4242, "darwin")).toEqual({ kind: "signal", group: -4242 });
  });

  it("runs the full-path taskkill on the whole tree on Windows, ignoring a poisoned SystemRoot", () => {
    expect(hostKillPlan(4242, "win32", { SystemRoot: "D:\\Win" })).toEqual({ kind: "taskkill", file: "D:\\Win\\System32\\taskkill.exe", args: ["/pid", "4242", "/T", "/F"] });
    expect(hostKillPlan(4242, "win32", { SystemRoot: "\\\\evil\\share" })).toMatchObject({ file: "C:\\Windows\\System32\\taskkill.exe" });
  });
});
