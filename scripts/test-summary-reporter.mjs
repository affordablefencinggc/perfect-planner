// node:test reporter that writes one JSON document describing every test
// that ran, failed or was skipped (with its reason). run-tests.mjs turns it
// into the short summary shown in the terminal and the CI job summary.
import path from "node:path";

export default async function* summaryReporter(source) {
  const results = [];
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { data } = event;
    // Count tests the way node:test's own totals do: every test and subtest,
    // never the suite wrappers around them.
    if (data.details?.type === "suite") continue;
    const file = data.file ? path.relative(process.cwd(), data.file).replaceAll("\\", "/") : null;
    const outcome = data.skip !== undefined ? "skipped" : data.todo !== undefined ? "todo" : event.type === "test:pass" ? "passed" : "failed";
    const reason = outcome === "skipped" ? (typeof data.skip === "string" ? data.skip : "") : outcome === "todo" ? (typeof data.todo === "string" ? data.todo : "") : undefined;
    const error = outcome === "failed" ? String(data.details?.error?.cause?.message ?? data.details?.error?.message ?? "").split("\n")[0].slice(0, 240) : undefined;
    results.push({ file, name: data.name, nesting: data.nesting, outcome, reason, error, durationMs: Math.round(data.details?.duration_ms ?? 0) });
  }
  yield JSON.stringify({ schemaVersion: 1, results }) + "\n";
}
