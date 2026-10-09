// Runs a test suite hermetically and reports a short summary of what ran,
// failed and was skipped (with reasons). The summary goes to the terminal and,
// under GitHub Actions, to the job summary page.
//
//   node scripts/run-tests.mjs            node:test suite (tests/*.test.mjs)
//   node scripts/run-tests.mjs --ui       vitest UI suite (tests-ui)
//   node scripts/run-tests.mjs tests/x.test.mjs   only the named files
//
// Exit status is the suite's own exit status.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const ui = args.includes("--ui");
const files = args.filter(arg => !arg.startsWith("--"));
const scratch = mkdtempSync(path.join(tmpdir(), "pp-test-report-"));
const output = path.join(scratch, "results.json");

function run(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: "inherit", shell: false, windowsHide: true });
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

async function runNodeSuite() {
  const code = await run(process.execPath, [
    "--import", pathToFileURL(path.join(root, "tests/helpers/hermetic-git.mjs")).href,
    "--test",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${pathToFileURL(path.join(root, "scripts/test-summary-reporter.mjs")).href}`, `--test-reporter-destination=${output}`,
    ...(files.length ? files : ["tests/*.test.mjs"]),
  ]);
  return { code, results: JSON.parse(readFileSync(output, "utf8")).results };
}

async function runUiSuite() {
  const code = await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--reporter=default", "--reporter=json", `--outputFile.json=${output}`, ...files]);
  const report = JSON.parse(readFileSync(output, "utf8"));
  const outcome = { passed: "passed", failed: "failed", skipped: "skipped", pending: "skipped", todo: "todo", disabled: "skipped" };
  const results = report.testResults.flatMap(file => file.assertionResults.map(test => ({
    file: path.relative(root, file.name).replaceAll("\\", "/"),
    name: test.fullName ?? test.title,
    outcome: outcome[test.status] ?? test.status,
    reason: test.status === "skipped" || test.status === "pending" ? "" : undefined,
    error: test.status === "failed" ? String(test.failureMessages?.[0] ?? "").split("\n")[0].slice(0, 240) : undefined,
  })));
  return { code, results };
}

function summarize(suite, code, results) {
  const count = outcome => results.filter(result => result.outcome === outcome).length;
  const failed = results.filter(result => result.outcome === "failed");
  const skipped = results.filter(result => result.outcome === "skipped" || result.outcome === "todo");
  const byReason = new Map();
  for (const result of skipped) {
    const reason = result.reason || "no reason given";
    byReason.set(reason, [...(byReason.get(reason) ?? []), result]);
  }
  const fileCount = new Set(results.map(result => result.file)).size;
  const headline = `${suite}: ${results.length} tests in ${fileCount} files, ${count("passed")} passed, ${failed.length} failed, ${skipped.length} skipped`;
  const lines = [`### ${code === 0 ? "✅" : "❌"} ${headline}`, ""];
  if (failed.length) {
    lines.push("**Failed**", "");
    for (const result of failed.slice(0, 50)) lines.push(`- \`${result.file}\` ${result.name}${result.error ? ` — ${result.error}` : ""}`);
    if (failed.length > 50) lines.push(`- …and ${failed.length - 50} more`);
    lines.push("");
  }
  if (skipped.length) {
    lines.push("**Skipped, by reason**", "");
    for (const [reason, group] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
      const where = [...new Set(group.map(result => result.file))].map(file => `\`${file}\``).join(", ");
      lines.push(`- ${group.length} × ${reason} (${where})`);
    }
    lines.push("");
  }
  if (code !== 0 && !failed.length) lines.push(`Suite exited with status ${code} without a failing test; see the log above.`, "");
  return lines.join("\n");
}

let code = 1;
try {
  const suite = ui ? "UI tests (vitest)" : "Core tests (node:test)";
  const result = ui ? await runUiSuite() : await runNodeSuite();
  code = result.code;
  const summary = summarize(suite, code, result.results);
  process.stdout.write(`\n${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
} catch (error) {
  process.stderr.write(`Test summary unavailable: ${error.message}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(code);
