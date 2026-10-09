import type { LedgerEntry } from "../ledger/index";
import { baseNumber, findRelease, releaseRange, releaseStamp } from "../numbering/index";
import { planClauses, planIndex, sortedClauses } from "./clauses";
import { lookup } from "./lookup";

/**
 * Docs are views of ledger entries: each render is rebuilt from the entries
 * alone, so the same ledger always gives the same text.
 */

/** The plan as approved in a version (or the current draft), with § numbers and withdrawn clauses listed. */
export function renderPlan(entries: readonly LedgerEntry[], plan?: string): string {
  const clauses = planClauses(entries, plan);
  if (!clauses) return `# ${plan}\n\n${plan} has not been approved.\n`;
  const approval = plan ? entries[planIndex(entries, plan)] : undefined;
  const lines: string[] = [`# Plan ${plan ?? "(draft)"}`, ""];
  if (approval) lines.push(`Approved ${approval.at} by ${actorName(approval)} in ${approval.n}.`, "");
  const withdrawn: string[] = [];
  for (const clause of sortedClauses(clauses)) {
    if (clause.status === "withdrawn") {
      withdrawn.push(`- §${clause.clause} withdrawn in ${clause.withdrawnBy}: ~~${clause.text}~~`);
      continue;
    }
    const depth = clause.clause.split(".").length;
    if (clause.kind === "heading") lines.push(`${"#".repeat(Math.min(depth + 1, 6))} §${clause.clause} ${clause.text}`, "");
    else if (clause.kind === "item") lines.push(`- §${clause.clause} ${clause.text}`);
    else lines.push(`§${clause.clause} ${clause.text}`, "");
  }
  if (withdrawn.length) lines.push("", "## Withdrawn", "", ...withdrawn);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** Release notes: stamp, range, and what was done, decided and corrected inside it. */
export function renderReleaseNotes(entries: readonly LedgerEntry[], release: string): string {
  const record = findRelease(entries, release);
  if (!record) return `# ${release}\n\n${release} was never released.\n`;
  const range = releaseRange(entries, release);
  const lines = [`# ${release} ${record.version}`, "", `\`${releaseStamp(entries, release)}\``, ""];
  if (record.restores) lines.push(`Rolls back to ${record.restores}.`, "");
  lines.push(range.length ? `Ledger range ${record.from} to ${record.to} (${range.length} entries).` : "No ledger entries in range.", "");
  const done = range.filter((e) => e.type === "task.done");
  const decisions = range.filter((e) => e.type === "decision.made");
  const corrections = range.filter((e) => e.type === "correction");
  section(lines, "Done", done.map((e) => `- ${e.subject}: ${taskTitle(entries, e.subject)} (${e.n})`));
  section(lines, "Decisions", decisions.map((e) => `- ${e.subject}: ${e.summary} (${e.n})`));
  section(lines, "Corrections", corrections.map((e) => `- ${e.n} corrects ${e.corrects}: ${e.summary}`));
  return `${lines.join("\n").trim()}\n`;
}

/** One task's story: clauses it implements, every entry about it, its commits. */
export function renderTask(entries: readonly LedgerEntry[], task: string): string {
  const result = lookup(entries, task);
  if (!result.found) return `# ${task}\n\n${result.problem}.\n`;
  const created = result.history.find((e) => e.type === "task.created");
  const lines = [`# ${result.ref} ${result.text}`, "", `Status: ${result.status}.`, ""];
  if (created?.refs.length) lines.push(`Implements: ${created.refs.join(", ")}`, "");
  section(lines, "History", result.history.map((e) => `- ${e.n} ${e.at} ${e.type} by ${actorName(e)}: ${e.summary}`));
  section(lines, "Commits", result.commits.map((sha) => `- ${sha}`));
  return `${lines.join("\n").trim()}\n`;
}

/** The raw ledger as a table, for exports and the audit view. */
export function renderLedger(entries: readonly LedgerEntry[]): string {
  const rows = entries.map((e) => `| ${e.n} | ${e.at} | ${actorName(e)} | ${e.type} | ${e.subject} | ${escape(e.summary)} | ${escape(e.reason ?? "")} | ${e.hash.slice(0, 12)} |`);
  return ["| n | at | actor | type | subject | summary | reason | hash |", "|---|---|---|---|---|---|---|---|", ...rows].join("\n") + "\n";
}

function section(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push(`## ${title}`, "", ...items, "");
}

function taskTitle(entries: readonly LedgerEntry[], task: string): string {
  const base = baseNumber(task);
  return entries.find((e) => e.type === "task.created" && e.subject === base)?.summary ?? "";
}

function actorName(entry: LedgerEntry): string {
  return entry.actor.model ? `${entry.actor.id} (${entry.actor.model})` : entry.actor.id;
}

function escape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
