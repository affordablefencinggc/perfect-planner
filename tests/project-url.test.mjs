import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { createImportedProjectId } from "../src/project/projectIds.js";
import {
  createProjectHistoryState,
  projectHistoryHref,
  readProjectSelection,
  resolveProjectSelection,
  withProjectSelection,
} from "../src/project/projectUrl.js";

const appA = createImportedProjectId("a".repeat(64));
const appB = createImportedProjectId("b".repeat(64));
const snapshot = {
  activeProjectId: appA,
  projectOrder: [appA, appB],
  projects: [
    { projectId: appA, view: { workspace: "structure", phase: null } },
    { projectId: appB, view: { workspace: "components", phase: "P2" } },
  ],
};

test("URL helpers preserve unrelated query parameters and hash", () => {
  const url = withProjectSelection("https://planner.test/app?keep=yes#node", { projectId: appB, workspace: "plan", phase: "P3" });
  assert.equal(url.searchParams.get("keep"), "yes");
  assert.equal(url.searchParams.get("project"), appB);
  assert.equal(url.searchParams.get("workspace"), "plan");
  assert.equal(url.searchParams.get("phase"), "P3");
  assert.equal(url.hash, "#node");
  assert.equal(projectHistoryHref(url, { projectId: appA, workspace: "home", phase: null }), `/app?keep=yes&project=${appA}&workspace=home#node`);
});

test("history selection resolves URL project first, then active project, then first project", () => {
  assert.deepEqual(resolveProjectSelection(snapshot, `/?project=${appB}&workspace=components&phase=P2`), { projectId: appB, workspace: "components", phase: "P2", source: "url" });
  assert.deepEqual(resolveProjectSelection(snapshot, "/?project=pp_unknown_123&workspace=ledger"), { projectId: appA, workspace: "ledger", phase: null, source: "registry" });
  assert.deepEqual(resolveProjectSelection({ ...snapshot, activeProjectId: null }, "/"), { projectId: appA, workspace: "structure", phase: null, source: "registry" });
  assert.deepEqual(resolveProjectSelection({ activeProjectId: null, projectOrder: [], projects: [] }, "/"), { projectId: null, workspace: "home", phase: null, source: "empty" });
});

test("selection parser ignores malformed project/workspace values", () => {
  assert.deepEqual(readProjectSelection("/?project=../../secret&workspace=unknown&phase=%00"), { projectId: null, workspace: null, phase: null });
  assert.throws(() => withProjectSelection("/", { projectId: "bad", workspace: "home" }), /project ID/);
  assert.throws(() => withProjectSelection("/", { projectId: appA, workspace: "unknown" }), /workspace/);
});

test("history state adds one namespaced selection without erasing caller state", () => {
  const state = createProjectHistoryState({ caller: "kept" }, { projectId: appB, workspace: "plan", phase: "P4" });
  assert.deepEqual(state, { caller: "kept", perfectPlanner: { projectId: appB, workspace: "plan", phase: "P4" } });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.perfectPlanner), true);
});

