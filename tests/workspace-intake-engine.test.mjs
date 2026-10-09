import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { assessWorkspaceIntake, redactWorkspaceIntakeSummary, workspaceIntakeStageState } from "../src/engine/workspaceIntakeEngine.js";

const sha = (value) => value.repeat(64);
const registration = { authoritative: true, access: "metadata-read-only", workspaceId: "planner_app", registryRevision: 1, rootIdentity: sha("a") };
const census = { authoritative: true, contentReturned: false, workspaceId: "planner_app", registryRevision: 1, rootIdentity: sha("a"), digest: sha("b"), fileCount: 1, files: [{ path: "src/app.js" }], skipped: [] };
const gaps = { censusDigest: sha("b"), completionPercentage: 80, gaps: [{}], unexpected: [], mutationAuthorized: false };

test("selection alone grants no read authority", () => {
  const state = assessWorkspaceIntake({ selectedPath: "C:/repo" });
  assert.equal(state.state, "selected");
  assert.equal(state.mutationAuthorized, false);
});

test("a valid census remains useful while architecture is unresolved", () => {
  const state = assessWorkspaceIntake({ selectedPath: "C:/repo", registration, census, contractAssessment: { ready: false } });
  assert.equal(state.state, "inventory-ready");
  assert.match(state.reason, /Architecture must be approved/);
});

test("registration and census identity drift is blocked", () => {
  const state = assessWorkspaceIntake({ selectedPath: "C:/repo", registration, census: { ...census, rootIdentity: sha("c") }, contractAssessment: { ready: true } });
  assert.equal(state.state, "blocked");
});

test("skipped files produce partial rather than complete intake", () => {
  const state = assessWorkspaceIntake({ selectedPath: "C:/repo", registration, census: { ...census, skipped: [{ path: "large.bin" }] }, gaps, contractAssessment: { ready: true } });
  assert.equal(state.state, "partial");
  assert.equal(state.skipped, 1);
});

test("review-ready summary is redacted and never authorizes mutation", () => {
  const state = assessWorkspaceIntake({ selectedPath: "C:/repo", registration, census, gaps, contractAssessment: { ready: true } });
  assert.equal(state.state, "review-ready");
  assert.equal(workspaceIntakeStageState(state.state, 4), "current");
  const summary = redactWorkspaceIntakeSummary({ registration, census, gaps });
  assert.equal("canonicalRoot" in summary, false);
  assert.equal(summary.fileCount, 1);
  assert.equal(summary.mutationAuthorized, false);
});
