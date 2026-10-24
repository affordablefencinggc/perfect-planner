import { describe, expect, it } from "vitest";
import { agentLaunch } from "./agentLaunch";

// Windows PATH with an npm folder first, whose claude.cmd points at a package that is not installed there,
// and the standalone claude.exe later: Connect agent must use the .exe, not give up on the broken shim.
const NPM = "C:\\Users\\me\\AppData\\Roaming\\npm";
const LOCAL = "C:\\Users\\me\\.local\\bin";
const files = new Set([`${NPM}\\claude.cmd`, `${LOCAL}\\claude.exe`]);
const io = { realpath: (f: string) => f, isProgram: (f: string) => files.has(f) };
const env = { PATH: `${NPM};${LOCAL}` };

describe("agentLaunch on Windows", () => {
  it("falls through to claude.exe when the npm shim's package is missing", () => {
    expect(agentLaunch("claude", ["mcp", "list"], env, "C:\\work", [], "win32", io)).toEqual({ command: `${LOCAL}\\claude.exe`, args: ["mcp", "list"] });
  });

  it("finds nothing when only the broken shim exists", () => {
    expect(agentLaunch("claude", [], { PATH: NPM }, "C:\\work", [], "win32", io)).toBeNull();
  });

  it("still never starts a .cmd", () => {
    const launch = agentLaunch("claude", [], env, "C:\\work", [], "win32", io);
    expect(launch?.command.toLowerCase().endsWith(".cmd")).toBe(false);
  });
});
