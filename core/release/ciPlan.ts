// CI plan for "Shipping safely": tests run locally and only for what changed;
// CI runs on the merge queue once per batch; older runs are cancelled when a
// newer push lands; production deploys only from the integration branch
// through preview and staging.
import type { PresetName } from "./types";

export interface CiPlan {
  preset: PresetName;
  fullSuiteOn: "merge-batch" | "every-merge";
  mergeQueue: {
    batchSize: number;
    maxWaitMinutes: number;
    groupingStrategy: "ALLGREEN" | "HEADGREEN";
    checkResponseTimeoutMinutes: number;
  };
  perPush: "affected-only";
  cancelSuperseded: true;
  deployPath: ["integration", "preview", "staging", "production"];
}

export function ciPlanFor(preset: PresetName = "balanced"): CiPlan {
  const [batchSize, maxWaitMinutes] = preset === "cheap" ? [8, 30] : preset === "thorough" ? [1, 5] : [5, 15];
  return {
    preset,
    fullSuiteOn: batchSize === 1 ? "every-merge" : "merge-batch",
    mergeQueue: { batchSize, maxWaitMinutes, groupingStrategy: "ALLGREEN", checkResponseTimeoutMinutes: 60 },
    perPush: "affected-only",
    cancelSuperseded: true,
    deployPath: ["integration", "preview", "staging", "production"],
  };
}

export interface CiEvent {
  name: "push" | "pull_request" | "merge_group" | "workflow_dispatch";
  branch?: string;
}

/**
 * The full suite runs only on the merge queue (once per batch) or when someone
 * asks for it by hand. Pushes to branches and pull requests run affected tests
 * only. A push to the integration branch "main" does NOT re-run the suite: the
 * merge queue already tested exactly what lands there.
 */
export function fullSuiteNeeded(event: CiEvent, _plan?: CiPlan): boolean {
  return event.name === "merge_group" || event.name === "workflow_dispatch";
}

export interface AffectedResult { all: boolean; tests: string[] }

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const isTest = (p: string): boolean => /\.test\.[cm]?[jt]sx?$/.test(p);
const isSharedConfig = (p: string): boolean =>
  p === "package.json" || p === "package-lock.json" ||
  /^vitest[^/]*\.config\.[^/]+$/.test(p) || /^tsconfig[^/]*\.json$/.test(p) ||
  /^\.github\/workflows\/[^/]+$/.test(p);

/** Maps changed files to the tests that could be affected by them. */
export function affectedTests(changedPaths: string[], allTestPaths: string[]): AffectedResult {
  const changed = changedPaths.map(norm);
  const tests = [...new Set(allTestPaths.map(norm))].sort();
  if (changed.some(isSharedConfig)) return { all: true, tests };
  const out = new Set<string>();
  for (const c of changed) {
    if (isTest(c)) { if (tests.includes(c)) out.add(c); continue; }
    const m = /^core\/([^/]+)\//.exec(c);
    const stem = baseOf(c).replace(/\.[^.]+$/, "");
    for (const t of tests) {
      if (m && t.startsWith(`core/${m[1]}/`)) out.add(t);
      else if (dirOf(t) === dirOf(c) && baseOf(t).startsWith(`${stem}.`)) out.add(t);
    }
  }
  return { all: false, tests: [...out].sort() };
}

export function mergeQueueWorkflowYaml(_plan: CiPlan, opts: { nodeVersion?: number } = {}): string {
  const node = opts.nodeVersion ?? 22;
  const setup = [
    "      - uses: actions/setup-node@v4",
    "        with:",
    `          node-version: ${node}`,
    "          cache: npm",
    "      - run: npm ci --ignore-scripts",
    "      - run: npm run typecheck:core",
  ];
  return [
    "name: Merge queue full suite",
    "",
    "on:",
    "  pull_request:",
    "  merge_group:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  affected:",
    "    name: Affected tests",
    "    if: github.event_name == 'pull_request'",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 0",
    ...setup,
    "      - run: npm run test:core -- --changed origin/${{ github.base_ref }}",
    "",
    "  full-suite:",
    "    name: Full suite on ${{ matrix.os }}",
    "    if: github.event_name == 'merge_group'",
    "    runs-on: ${{ matrix.os }}",
    "    timeout-minutes: 30",
    "    strategy:",
    "      fail-fast: false",
    "      matrix:",
    "        os: [ubuntu-latest, windows-latest, macos-latest]",
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...setup,
    "      - run: npm run test:core",
    "",
  ].join("\n");
}

export function mergeQueueRuleset(plan: CiPlan, opts: { branch?: string; requiredChecks: string[] }) {
  const branch = opts.branch ?? "main";
  const q = plan.mergeQueue;
  return {
    name: `Merge queue (${plan.preset})`,
    target: "branch" as const,
    enforcement: "active" as const,
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] as string[] } },
    rules: [
      {
        type: "merge_queue" as const,
        parameters: {
          check_response_timeout_minutes: q.checkResponseTimeoutMinutes,
          grouping_strategy: q.groupingStrategy,
          max_entries_to_build: q.batchSize,
          max_entries_to_merge: q.batchSize,
          merge_method: "SQUASH" as const,
          min_entries_to_merge: 1,
          min_entries_to_merge_wait_minutes: q.maxWaitMinutes,
        },
      },
      {
        type: "required_status_checks" as const,
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: opts.requiredChecks.map((context) => ({ context })),
        },
      },
    ],
  };
}

export interface CiUsage {
  pushesPerDay: number;
  mergesPerDay: number;
  fullSuiteMinutes: number;
  affectedMinutes: number;
  osCount: number;
}

/** Compares "full suite on every push" with this plan over a 30-day month. */
export function estimateMonthlyCiMinutes(u: CiUsage, plan: CiPlan) {
  const naiveMinutes = 30 * u.pushesPerDay * u.fullSuiteMinutes * u.osCount;
  const batches = Math.ceil(u.mergesPerDay / plan.mergeQueue.batchSize);
  const planMinutes = 30 * (u.pushesPerDay * u.affectedMinutes + batches * u.fullSuiteMinutes * u.osCount);
  const savedPercent = naiveMinutes > 0 ? Math.round(((naiveMinutes - planMinutes) / naiveMinutes) * 1000) / 10 : 0;
  return { naiveMinutes, planMinutes, savedPercent };
}
