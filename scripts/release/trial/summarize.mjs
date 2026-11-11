// Turns every evidence folder's checks.jsonl into one Markdown table (stdout) and exits 1 if any check failed.
//   node scripts/release/trial/summarize.mjs <evidence root> [run url]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const [root, runUrl = ""] = process.argv.slice(2);
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name === "checks.jsonl") files.push(full);
  }
};
if (existsSync(root)) walk(root);
const rows = files.flatMap((file) => {
  const job = path.basename(path.dirname(file));
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => ({ job, ...JSON.parse(line) }));
});
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 300);
const lines = [`## Installer trial${runUrl ? ` ([run](${runUrl}))` : ""}`, ""];
const byJob = new Map();
for (const row of rows) byJob.set(row.job, [...(byJob.get(row.job) || []), row]);
lines.push("| Job | Passed | Failed | Skipped |", "| --- | --- | --- | --- |");
for (const [job, list] of byJob) {
  lines.push(`| ${job} | ${list.filter((r) => r.pass).length} | ${list.filter((r) => !r.pass && !r.skipped).length} | ${list.filter((r) => r.skipped).length} |`);
}
lines.push("", "| Job | Target | Check | Result | What was seen |", "| --- | --- | --- | --- | --- |");
for (const row of rows) lines.push(`| ${row.job} | ${cell(row.label)} | ${cell(row.name)} | ${row.skipped ? "SKIP" : row.pass ? "PASS" : "**FAIL**"} | ${cell(row.seen)} |`);
const failed = rows.filter((r) => !r.pass && !r.skipped).length;
lines.push("", `${rows.length - failed} of ${rows.length} checks did not fail across ${byJob.size} jobs; ${failed} failed.`);
console.log(lines.join("\n"));
process.exitCode = failed || rows.length === 0 ? 1 : 0;
