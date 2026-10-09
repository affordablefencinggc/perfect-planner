import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { projectLabelFromRoot, projectRegistrationLabelFromRoot } from "../src/project/projectLabel.js";
import { createStableProjectId } from "../src/project/projectIds.js";

test("browser project label uses folder name rather than opaque identity", () => {
  assert.equal(projectLabelFromRoot("browser://upstream/0123456789abcdef01234567"), "upstream");
  assert.equal(projectLabelFromRoot("browser://My%20App/opaque"), "My App");
  assert.equal(projectLabelFromRoot("browser://Legacy"), "Legacy");
});
test("native paths and missing names retain readable fallbacks", () => {
  for (const path of ["C:\\repos\\my-app\\", "/repos/my-app/", "//server/repos/my-app"]) {
    assert.equal(projectLabelFromRoot(path), "my-app");
  }
  assert.equal(projectLabelFromRoot(null), "Imported project");
  assert.equal(projectLabelFromRoot("browser:///opaque"), "Imported project");
  assert.equal(projectLabelFromRoot("browser://bad%name/opaque"), "bad%name");
  assert.equal(projectLabelFromRoot("C:\\repos\\My%20App"), "My%20App");
});
test("display correction preserves the historical registration ID", () => {
  const root = "browser://upstream/0123456789abcdef01234567";
  assert.equal(createStableProjectId(projectRegistrationLabelFromRoot(root), root), createStableProjectId("0123456789abcdef01234567", root));
  assert.equal(projectLabelFromRoot(root), "upstream");
});
test("identical display labels do not collapse different folder identities", () => {
  const a = "browser://same/first", b = "browser://same/second";
  assert.equal(projectLabelFromRoot(a), projectLabelFromRoot(b));
  assert.notEqual(createStableProjectId(projectLabelFromRoot(a), a), createStableProjectId(projectLabelFromRoot(b), b));
});
