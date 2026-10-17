// Appends one trial check to <out>/checks.jsonl so OS-level checks sit next to the WebDriver ones.
//   node scripts/release/trial/record-check.mjs <out> <label> <name> <pass|fail> <what was seen>
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const [out, label, name, verdict, ...seen] = process.argv.slice(2);
if (!out || !label || !name || !["pass", "fail", "skip"].includes(verdict)) {
  throw new Error("usage: record-check.mjs <out> <label> <name> <pass|fail|skip> <seen>");
}
mkdirSync(out, { recursive: true });
const entry = { label, name, pass: verdict === "pass", skipped: verdict === "skip" || undefined, seen: seen.join(" ").trim() };
appendFileSync(path.join(out, "checks.jsonl"), JSON.stringify(entry) + "\n");
console.log(`${verdict.toUpperCase()} ${label} ${name}: ${entry.seen}`);
