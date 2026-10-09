// Plain-words Markdown views of a scan and a board, for the PR, the CLI and
// the confirm screen. Pure functions of their inputs.

import type { FeatureStatus, ScanResult, ScannedFeature, StageBoard } from "./types";

const STATUS_LABEL: Record<FeatureStatus, string> = { done: "Done", partial: "Partial", missing: "Missing" };

export function scanReport(scan: ScanResult): string {
  const lines = [
    `# Feature scan`,
    ``,
    `${scan.features.length} features from ${scan.source}: ${scan.counts.done} done, ${scan.counts.partial} partial, ${scan.counts.missing} missing.`,
    ``,
    `| Id | Feature | Status | Why |`,
    `|---|---|---|---|`,
  ];
  for (const f of scan.features) lines.push(`| ${f.id} | ${cell(f.name)} | ${STATUS_LABEL[f.status]} | ${cell(why(f))} |`);
  return lines.join("\n") + "\n";
}

export function boardReport(board: StageBoard, features: readonly ScannedFeature[]): string {
  const byId = new Map(features.map((f) => [f.id, f]));
  const lines = [`# Stages`, ``, board.confirmed ? `MVP line confirmed by ${board.confirmedBy}.` : `MVP line proposed, waiting for confirmation.`, ``];
  if (board.journey) {
    lines.push(`**Done when:** ${board.journey.name} passes (\`${board.journey.test}\`).`, ``);
    board.journey.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push(``);
  }
  for (const stage of [...board.stages].sort((a, b) => a.order - b.order)) {
    const placed = board.placements.filter((p) => p.stage === stage.id);
    lines.push(`## ${stage.name} (${placed.length})`, ``);
    for (const p of placed) {
      const f = byId.get(p.feature);
      const status = f ? ` · ${STATUS_LABEL[f.status]}` : "";
      const reason = stage.id === "mvp" ? "" : ` · ${p.reason}`;
      lines.push(`- ${p.feature} ${f?.name ?? ""}${status}${reason}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

function why(f: ScannedFeature): string {
  if (f.findings.length) return f.findings.join("; ");
  return f.status === "done" ? "all files present and tested" : "";
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
