import type { PushProtectionResult } from "./pushProtection";
import { checkIgnoreList, scanText } from "./secrets";

// The four secret layers as one report (plan: "No scanner catches 100% alone,
// so the guarantee comes from layering"). Layers 1 and 2 are installed by
// core/worktrees (placeholder env files, commit-time scan); layer 3 is this
// module's pre-push scan plus the ignore list; layer 4 is GitHub's own push
// protection. This only reads facts the caller gathered and says plainly
// which layer is missing; it never claims a layer it could not check.

export interface PostureInput {
  /** Env files copied into worktrees, to confirm they only hold placeholders (layer 1). */
  worktreeEnvFiles?: { file: string; text: string }[];
  /** Whether each worktree has the commit-time scan as its hook (layer 2). Undefined: not checked. */
  commitScanInstalled?: boolean;
  /** Whether the pre-push scan is installed (layer 3). Undefined: not checked. */
  prePushInstalled?: boolean;
  /** The repo's .gitignore text (layer 3, enforced ignore list). */
  gitignoreText?: string;
  /** GitHub push protection (layer 4). */
  pushProtection?: PushProtectionResult;
}

export type LayerState = "on" | "off" | "unchecked";

export interface LayerReport {
  layer: 1 | 2 | 3 | 4;
  name: string;
  state: LayerState;
  summary: string;
}

export interface Posture {
  /** True only when every layer was checked and is on. */
  ok: boolean;
  layers: LayerReport[];
}

function flag(value: boolean | undefined, on: string, off: string): { state: LayerState; summary: string } {
  if (value === undefined) return { state: "unchecked", summary: "Not checked yet" };
  return value ? { state: "on", summary: on } : { state: "off", summary: off };
}

export function secretPosture(input: PostureInput): Posture {
  const layers: LayerReport[] = [];

  // Layer 1: agents never hold real secrets.
  if (!input.worktreeEnvFiles) {
    layers.push({ layer: 1, name: "Agents hold placeholders only", state: "unchecked", summary: "Not checked yet" });
  } else {
    const leaks = input.worktreeEnvFiles.flatMap((env) => scanText(env.file, env.text));
    layers.push({
      layer: 1,
      name: "Agents hold placeholders only",
      state: leaks.length === 0 ? "on" : "off",
      summary: leaks.length === 0
        ? `${input.worktreeEnvFiles.length} worktree env file${input.worktreeEnvFiles.length === 1 ? "" : "s"} hold placeholders only`
        : `Real-looking values in ${[...new Set(leaks.map((leak) => leak.file))].join(", ")}`,
    });
  }

  // Layer 2: scan on every commit.
  layers.push({ layer: 2, name: "Scan on every commit", ...flag(input.commitScanInstalled, "Commit-time scan installed in every worktree", "A worktree has no commit-time scan") });

  // Layer 3: whole-branch scan before push, plus the ignore list.
  const ignore = input.gitignoreText === undefined ? undefined : checkIgnoreList(input.gitignoreText);
  if (input.prePushInstalled === undefined && ignore === undefined) {
    layers.push({ layer: 3, name: "Whole-branch scan before push", state: "unchecked", summary: "Not checked yet" });
  } else {
    const problems: string[] = [];
    if (input.prePushInstalled === false) problems.push("pre-push scan not installed");
    if (input.prePushInstalled === undefined) problems.push("pre-push scan not checked");
    if (ignore && !ignore.ok) problems.push(`.gitignore misses ${ignore.missing.join(", ")}`);
    if (ignore === undefined) problems.push(".gitignore not checked");
    const off = (input.prePushInstalled === false) || (ignore !== undefined && !ignore.ok);
    layers.push({
      layer: 3,
      name: "Whole-branch scan before push",
      state: problems.length === 0 ? "on" : off ? "off" : "unchecked",
      summary: problems.length === 0 ? "Pre-push scan installed and env files and keys are ignored" : problems.join("; "),
    });
  }

  // Layer 4: GitHub push protection.
  const pp = input.pushProtection;
  layers.push({
    layer: 4,
    name: "GitHub push protection",
    state: !pp || pp.status === "unknown" ? "unchecked" : pp.status === "enabled" ? "on" : "off",
    summary: pp ? pp.detail : "Not checked yet",
  });

  return { ok: layers.every((layer) => layer.state === "on"), layers };
}

/**
 * A git hook shim that runs the pre-push scan. Git runs hooks through sh on
 * every platform (Git for Windows ships one), so the same text works on
 * Windows, macOS and Linux. Paths use forward slashes.
 */
export function prePushShim(hookScriptPath: string): string {
  const path = hookScriptPath.replace(/\\/g, "/").replace(/"/g, '\\"');
  return `#!/bin/sh\n# Perfect Planner: whole-branch secret scan before any push (layer 3).\nexec node "${path}" "$@"\n`;
}
