import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { affectedTests, ciPlanFor, estimateMonthlyCiMinutes, fullSuiteNeeded, mergeQueueRuleset, mergeQueueWorkflowYaml } from "./ciPlan";

describe("ciPlanFor", () => {
  it("sets batch and wait per preset, balanced by default", () => {
    expect(ciPlanFor("cheap").mergeQueue).toMatchObject({ batchSize: 8, maxWaitMinutes: 30 });
    expect(ciPlanFor("balanced").mergeQueue).toMatchObject({ batchSize: 5, maxWaitMinutes: 15 });
    expect(ciPlanFor("thorough").mergeQueue).toMatchObject({ batchSize: 1, maxWaitMinutes: 5 });
    expect(ciPlanFor().preset).toBe("balanced");
  });
  it("thorough runs the full suite on every merge", () => {
    expect(ciPlanFor("thorough").fullSuiteOn).toBe("every-merge");
    expect(ciPlanFor("cheap").fullSuiteOn).toBe("merge-batch");
  });
  it("fixes the safety invariants", () => {
    const p = ciPlanFor();
    expect(p.perPush).toBe("affected-only");
    expect(p.cancelSuperseded).toBe(true);
    expect(p.deployPath).toEqual(["integration", "preview", "staging", "production"]);
  });
});

describe("fullSuiteNeeded", () => {
  const plan = ciPlanFor();
  it("only merge_group and manual dispatch", () => {
    expect(fullSuiteNeeded({ name: "merge_group" }, plan)).toBe(true);
    expect(fullSuiteNeeded({ name: "workflow_dispatch" }, plan)).toBe(true);
    expect(fullSuiteNeeded({ name: "pull_request" }, plan)).toBe(false);
    expect(fullSuiteNeeded({ name: "push", branch: "feature" }, plan)).toBe(false);
    expect(fullSuiteNeeded({ name: "push", branch: "main" }, plan)).toBe(false);
  });
});

describe("affectedTests", () => {
  const all = [
    "core/release/ciPlan.test.ts", "core/release/risk.unit.test.ts", "core/release/other.test.ts",
    "core/loop/queue.test.ts", "core/loop/deep/x.test.ts", "src/app.test.ts",
  ];
  it("maps a source file to same-module tests", () => {
    expect(affectedTests(["core/release/ciPlan.ts"], all)).toEqual({
      all: false,
      tests: ["core/release/ciPlan.test.ts", "core/release/other.test.ts", "core/release/risk.unit.test.ts"],
    });
  });
  it("matches same-basename tests outside core modules", () => {
    expect(affectedTests(["src/app.ts"], all).tests).toEqual(["src/app.test.ts"]);
    expect(affectedTests(["src/other.ts"], all).tests).toEqual([]);
  });
  it("includes changed tests, dedupes, sorts, normalizes slashes", () => {
    const r = affectedTests(["core\\loop\\queue.test.ts", "core/loop/queue.test.ts"], all);
    expect(r.tests).toEqual(["core/loop/queue.test.ts"]);
  });
  it("returns everything when shared config changes", () => {
    for (const f of ["package.json", "package-lock.json", "vitest.core.config.mjs", "tsconfig.core.json", ".github/workflows/ci.yml"]) {
      const r = affectedTests([f], all);
      expect(r.all).toBe(true);
      expect(r.tests).toEqual([...all].sort());
    }
  });
});

describe("mergeQueueWorkflowYaml", () => {
  const yaml = mergeQueueWorkflowYaml(ciPlanFor());
  it("has triggers, concurrency and read-only permissions", () => {
    expect(yaml).toContain("name: Merge queue full suite");
    expect(yaml).toMatch(/^on:\n {2}pull_request:\n {2}merge_group:$/m);
    expect(yaml).toContain("group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}");
    expect(yaml).toContain("cancel-in-progress: true");
    expect(yaml).toMatch(/permissions:\n {2}contents: read/);
  });
  it("splits jobs by event", () => {
    expect(yaml).toContain("if: github.event_name == 'pull_request'");
    expect(yaml).toContain("if: github.event_name == 'merge_group'");
    expect(yaml).toContain("fetch-depth: 0");
    expect(yaml).toContain("--changed origin/${{ github.base_ref }}");
    expect(yaml).toContain("os: [ubuntu-latest, windows-latest, macos-latest]");
    expect(yaml).not.toContain("\t");
  });
  it("honours nodeVersion", () => {
    expect(mergeQueueWorkflowYaml(ciPlanFor(), { nodeVersion: 24 })).toContain("node-version: 24");
  });
  it("committed template matches the generator", () => {
    // Windows checkouts may turn LF into CRLF; compare the text, not the line endings.
    const file = readFileSync(new URL("./ci/merge-queue.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(file).toBe(mergeQueueWorkflowYaml(ciPlanFor("balanced")));
  });
});

describe("mergeQueueRuleset", () => {
  it("builds the rulesets API body", () => {
    const r = mergeQueueRuleset(ciPlanFor("cheap"), { requiredChecks: ["Full suite on ubuntu-latest"] });
    expect(r).toMatchObject({ target: "branch", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/main"] } } });
    expect(r.rules[0]).toEqual({
      type: "merge_queue",
      parameters: {
        check_response_timeout_minutes: 60, grouping_strategy: "ALLGREEN", max_entries_to_build: 8,
        max_entries_to_merge: 8, merge_method: "SQUASH", min_entries_to_merge: 1, min_entries_to_merge_wait_minutes: 30,
      },
    });
    expect(r.rules[1]).toEqual({
      type: "required_status_checks",
      parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "Full suite on ubuntu-latest" }] },
    });
  });
  it("accepts another branch", () => {
    expect(mergeQueueRuleset(ciPlanFor(), { branch: "develop", requiredChecks: [] }).conditions.ref_name.include).toEqual(["refs/heads/develop"]);
  });
});

describe("estimateMonthlyCiMinutes", () => {
  const usage = { pushesPerDay: 20, mergesPerDay: 10, fullSuiteMinutes: 10, affectedMinutes: 2, osCount: 3 };
  it("compares naive with the plan", () => {
    // naive: 30*20*10*3 = 18000; plan: 30*(20*2 + 2*10*3) = 3000
    expect(estimateMonthlyCiMinutes(usage, ciPlanFor())).toEqual({ naiveMinutes: 18000, planMinutes: 3000, savedPercent: 83.3 });
  });
  it("thorough costs more than cheap", () => {
    expect(estimateMonthlyCiMinutes(usage, ciPlanFor("thorough")).planMinutes).toBeGreaterThan(estimateMonthlyCiMinutes(usage, ciPlanFor("cheap")).planMinutes);
  });
  it("handles zero usage", () => {
    expect(estimateMonthlyCiMinutes({ ...usage, pushesPerDay: 0 }, ciPlanFor()).savedPercent).toBe(0);
  });
});
