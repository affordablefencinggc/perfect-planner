import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { localAuthorityRoot, platformDataDirectory } from "../src/node/localAuthorityHost.mjs";
import { coreHostRoot } from "../src/node/coreHostVitePlugin.mjs";

// Real users' homes, not the hermetic test profile (which itself lives under the temp folder).
const HOME = "/home/riley";
const MAC_HOME = "/Users/riley";
// Windows paths are checked with Windows rules, so the result does not depend on where this checkout sits.
const underTemp = (target, platform) => {
  if (platform === "win32") return path.win32.relative(path.win32.resolve("C:\\Windows\\Temp"), target).split("\\")[0] !== "..";
  const rel = path.relative(os.tmpdir(), target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

test("saved work and core ledgers live in the platform app-data folder, never the temp folder", () => {
  const cases = [
    [{ HOME: MAC_HOME }, "darwin", path.join(MAC_HOME, "Library", "Application Support", "PerfectPlannerCleanroom", "authority")],
    [{ HOME }, "linux", path.join(HOME, ".local", "share", "PerfectPlannerCleanroom", "authority")],
    [{ HOME, XDG_DATA_HOME: "/data/riley" }, "linux", path.join("/data/riley", "PerfectPlannerCleanroom", "authority")],
    [{ HOME, XDG_DATA_HOME: "relative/dir" }, "linux", path.join(HOME, ".local", "share", "PerfectPlannerCleanroom", "authority")],
    [{ LOCALAPPDATA: "C:\\Users\\riley\\AppData\\Local" }, "win32", path.win32.join("C:\\Users\\riley\\AppData\\Local", "PerfectPlannerCleanroom", "authority")],
  ];
  for (const [env, platform, expected] of cases) {
    const root = localAuthorityRoot(env, platform);
    assert.equal(root, expected, `${platform} ${JSON.stringify(env)}`);
    assert.equal(underTemp(root, platform), false, `${platform} root ${root} is under the temp folder`);
    if (platform !== "win32") assert.equal(underTemp(coreHostRoot(root), platform), false, `${platform} core ledgers under the temp folder`);
  }
});

test("refuses to guess when there is no home folder instead of falling back to the temp folder", () => {
  assert.throws(() => platformDataDirectory({}, "linux", () => ""), /cannot find a folder to save in/);
  assert.throws(() => platformDataDirectory({}, "darwin", () => ""), /cannot find a folder to save in/);
});
