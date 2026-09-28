import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const TOP_LEVEL_KEYS = ["blockers", "counts", "digest", "generatedAt", "globalGates", "items", "notProven", "planId", "ready", "schemaVersion", "title", "verdict"];
const exactKeys = (value, keys) => value && !Array.isArray(value) && typeof value === "object" && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
function derivedItems(source) {
  return source.map((item) => {
    const missing = [];
    if (item.built !== true) missing.push("not built");
    if (item.tested !== true) missing.push("not tested");
    if (item.proven !== true) missing.push("proof not accepted");
    return { id: String(item.id), title: String(item.title ?? item.id), built: item.built === true, tested: item.tested === true, proven: item.proven === true, missing };
  });
}
function derivedBlockers(gates, items) {
  const blockers = [];
  if (gates.approved !== true) blockers.push("plan approval is missing");
  if (gates.openGates !== 0) blockers.push(`${gates.openGates} collision or policy gate(s) remain open`);
  if (gates.truthCoreValid !== true) blockers.push("truth core is invalid or unavailable");
  if (gates.ciTier3 !== "green") blockers.push("merged-state Tier 3 CI is not green");
  if (gates.completenessReview !== true) blockers.push("completeness review is missing");
  const incomplete = items.filter((item) => item.missing.length).length;
  if (incomplete) blockers.push(`${incomplete} item(s) remain unproven`);
  return blockers;
}

export function verifyCompletionReport(report, options = {}) {
  if (!exactKeys(report, TOP_LEVEL_KEYS) || report.schemaVersion !== 2 || !Number.isFinite(Date.parse(report.generatedAt)) || new Date(report.generatedAt).toISOString() !== report.generatedAt || !String(report.planId).trim() || !String(report.title).trim()) throw new Error("Completion report schema is invalid.");
  if (options.expectedGeneratedAt && report.generatedAt !== options.expectedGeneratedAt) throw new Error("Completion report generation binding is invalid.");
  const gates = report.globalGates;
  if (!exactKeys(gates, ["approved", "ciTier3", "completenessReview", "openGates", "truthCoreValid"]) || typeof gates.approved !== "boolean" || typeof gates.truthCoreValid !== "boolean" || typeof gates.completenessReview !== "boolean" || !Number.isSafeInteger(gates.openGates) || gates.openGates < 0 || !["green", "grey", "red"].includes(gates.ciTier3)) throw new Error("Completion report global gates are invalid.");
  if (!exactKeys(report.counts, ["built", "proven", "tested", "total"]) ||
      !Object.values(report.counts).every((value) => Number.isSafeInteger(value) && value >= 0) ||
      !Array.isArray(report.blockers) || !report.blockers.every((item) => typeof item === "string") ||
      !Array.isArray(report.notProven) || typeof report.ready !== "boolean" ||
      !["GO", "NO-GO"].includes(report.verdict) || !/^[a-f0-9]{64}$/.test(report.digest)) {
    throw new Error("Completion report schema is invalid.");
  }
  if (!Array.isArray(report.items) || report.items.length < 1 || report.items.length > 10_000) throw new Error("Completion report items are invalid.");
  const ids = new Set();
  for (const item of report.items) {
    if (!exactKeys(item, ["built", "id", "missing", "proven", "tested", "title"]) || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id) || typeof item.title !== "string" || !item.title.trim() || typeof item.built !== "boolean" || typeof item.tested !== "boolean" || typeof item.proven !== "boolean" || !Array.isArray(item.missing) || !item.missing.every((entry) => typeof entry === "string")) throw new Error("Completion report items are invalid.");
    ids.add(item.id);
  }
  for (const item of report.notProven) {
    if (!exactKeys(item, ["id", "missing", "title"]) || typeof item.id !== "string" || !item.id.trim() || typeof item.title !== "string" || !item.title.trim() || !Array.isArray(item.missing) || !item.missing.every((entry) => typeof entry === "string")) throw new Error("Completion report schema is invalid.");
  }
  const items = derivedItems(report.items); const blockers = derivedBlockers(gates, items);
  const counts = { total: items.length, built: items.filter((item) => item.built).length, tested: items.filter((item) => item.tested).length, proven: items.filter((item) => item.proven).length };
  const notProven = items.filter((item) => item.missing.length).map((item) => ({ id: item.id, title: item.title, missing: item.missing }));
  const ready = blockers.length === 0; const verdict = ready ? "GO" : "NO-GO";
  const expected = { ...report, verdict, ready, counts, blockers, notProven, items };
  const { digest, ...payload } = expected;
  if (canonicalize(report.counts) !== canonicalize(counts) || canonicalize(report.blockers) !== canonicalize(blockers) || canonicalize(report.notProven) !== canonicalize(notProven) || canonicalize(report.items) !== canonicalize(items) || report.ready !== ready || report.verdict !== verdict || digest !== sha256(canonicalize(payload))) throw new Error("Completion report computed truth is inconsistent.");
  return Object.freeze({ valid: true, ready, verdict, digest });
}

export function generateCompletionReport(plan, options = {}) {
  if (!plan || !String(plan.planId ?? "").trim() || !Array.isArray(plan.items) || plan.items.length === 0) throw new Error("Completion report requires a plan id and at least one item.");
  const ids = new Set();
  for (const item of plan.items) {
    if (!String(item.id ?? "").trim() || ids.has(item.id)) throw new Error("Completion report item ids must be non-empty and unique.");
    ids.add(item.id);
  }
  const globalGates = { approved: plan.approved === true, openGates: Number(plan.openGates ?? 0), truthCoreValid: plan.truthCoreValid === true, ciTier3: ["green", "grey", "red"].includes(plan.ciTier3) ? plan.ciTier3 : "grey", completenessReview: plan.completenessReview === true };
  if (!Number.isSafeInteger(globalGates.openGates) || globalGates.openGates < 0) throw new Error("Completion report open gates must be a non-negative integer.");
  const items = derivedItems(plan.items); const blockers = derivedBlockers(globalGates, items);
  const counts = { total: items.length, built: items.filter((item) => item.built).length, tested: items.filter((item) => item.tested).length, proven: items.filter((item) => item.proven).length };
  const payload = { schemaVersion: 2, generatedAt: options.generatedAt ?? new Date().toISOString(), planId: String(plan.planId), title: String(plan.title ?? plan.planId), globalGates, verdict: blockers.length ? "NO-GO" : "GO", ready: blockers.length === 0, counts, blockers, notProven: items.filter((item) => item.missing.length).map((item) => ({ id: item.id, title: item.title, missing: item.missing })), items };
  const report = { ...payload, digest: sha256(canonicalize(payload)) }; verifyCompletionReport(report); return report;
}

export function renderCompletionMarkdown(report) {
  const blockers = report.blockers.length ? report.blockers.map((item) => `- ${item}`).join("\n") : "- None";
  const notProven = report.notProven.length ? report.notProven.map((item) => `- ${item.id} · ${item.title}: ${item.missing.join(", ")}`).join("\n") : "- None";
  return `# ${report.planId} — Completion report\n\n**Verdict: ${report.verdict}**  \nGenerated: ${report.generatedAt}  \nIntegrity digest: \`${report.digest}\`\n\n## Computed totals\n\n- Total: ${report.counts.total}\n- Built: ${report.counts.built}\n- Tested: ${report.counts.tested}\n- Proven: ${report.counts.proven}\n\n## Release blockers\n\n${blockers}\n\n## What is not proven\n\n${notProven}\n`;
}

export async function writeCompletionReport(outputDirectory, plan, options = {}) {
  const report = generateCompletionReport(plan, options);
  await mkdir(outputDirectory, { recursive: true });
  const suffix = `${process.pid}.${randomUUID()}.tmp`;
  const jsonPath = path.join(outputDirectory, "completion-report.json");
  const markdownPath = path.join(outputDirectory, "completion-report.md");
  const jsonTemporary = `${jsonPath}.${suffix}`;
  const markdownTemporary = `${markdownPath}.${suffix}`;
  await writeFile(jsonTemporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  await writeFile(markdownTemporary, renderCompletionMarkdown(report), { flag: "wx" });
  await rename(jsonTemporary, jsonPath);
  await rename(markdownTemporary, markdownPath);
  return { report, jsonPath, markdownPath };
}
