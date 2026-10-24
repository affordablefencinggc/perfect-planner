import type { Finding, Review } from "./rules";

export const MARKER_PREFIX = "<!-- review-bot";

export function marker(review: Pick<Review, "headSha" | "verdict">): string {
  return `${MARKER_PREFIX} head=${review.headSha} verdict=${review.verdict} -->`;
}

/** Reads the head sha a comment was written for, or null for any other comment. */
export function markedHead(body: string): string | null {
  return /<!-- review-bot head=([0-9a-f]{40}) verdict=[A-Z-]+ -->/.exec(body)?.[1] ?? null;
}

const ICON: Record<Finding["severity"], string> = { block: "NO-GO", hold: "HOLD", wait: "WAIT", warn: "note" };
const HEADLINE = {
  GO: "Go. Every rule passed on this head.",
  "NO-GO": "No-go. At least one rule failed.",
  HOLD: "Hold. A person has to decide.",
  WAIT: "Wait. Checks are not finished.",
} as const;

export function renderReview(review: Review): string {
  const lines = [
    marker(review),
    `## Review bot: ${review.verdict}`,
    "",
    HEADLINE[review.verdict],
    "",
    `Head \`${review.headSha.slice(0, 12)}\` on base \`${review.baseSha.slice(0, 12)}\`. A new push needs a new verdict.`,
  ];
  if (review.findings.length) {
    lines.push("", "| | Rule | What | Where |", "|---|---|---|---|");
    for (const f of review.findings) {
      const where = f.file ? `\`${f.file}\`${f.line ? `:${f.line}` : ""}` : "";
      lines.push(`| ${ICON[f.severity]} | ${f.rule} | ${f.message.replace(/\|/g, "\\|")} | ${where} |`);
    }
  }
  for (const n of review.notes) lines.push("", `_${n}_`);
  return `${lines.join("\n")}\n`;
}

/** Text for the commit status (GitHub allows 140 characters). */
export function statusText(review: Review): string {
  const n = review.findings.filter((f) => f.severity !== "warn").length;
  return `${review.verdict}${n ? `: ${n} finding${n === 1 ? "" : "s"}` : ""}`.slice(0, 140);
}
