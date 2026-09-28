import { evaluateArchitectureRulebook } from "./rulebookEngine.js";
import { assessViability } from "./viabilityEngine.js";
import { assessTechnicalDebt } from "./debtEngine.js";
import { assessFolderContract } from "./folderContractEngine.js";
import { currentFolderContractInput } from "./folderContractSeed.js";

export const currentRulebookInput = {
  templateId: "ai-autopilot-control-plane", templateVersion: 1, platform: "tauri",
  brief: { autopilot: true, localFirst: true },
  useCases: ["ai-autopilot", "desktop-distribution"],
  answers: { collisionPolicy: "fail closed", proofPolicy: "paired evidence", capabilityPolicy: "deny by default" },
  capabilities: [{ id: "native-process", necessity: "mandatory" }],
  scenarios: [], dependencies: [], decisions: [], nonFunctional: {},
};
export const currentBlueprintInput = currentRulebookInput;
export const currentViabilityInput = { brief: { goal: "Stop unsafe agent builds", business: "Local planning control plane", motive: "money", targetAudience: "Software teams", geography: "Not yet evidenced" } };
export const currentDebtSnapshot = {
  scanId: "DEBT-SCAN-NATIVE-ANALYZED", capturedAt: "2026-09-03T00:00:00.000Z", coveredSurfaces: ["ui", "engine", "storage", "native"],
  budget: { critical: 0, high: 0, medium: 10, low: 25 }, maxAgeDays: { critical: 0, high: 30, medium: 90, low: 180 },
  findings: [
    { id: "DEBT-6E8FE128A100F9F8", severity: "medium", surface: "ui", category: "maintainability", introducedAt: "2026-09-03T00:00:00.000Z", status: "open", owner: "UI owner", evidence: "src/styles.css:1" },
    { id: "DEBT-EDF05737C8B3366A", severity: "medium", surface: "ui", category: "maintainability", introducedAt: "2026-09-03T00:00:00.000Z", status: "open", owner: "UI owner", evidence: "src/PerfectPlannerShell.jsx:1" },
  ],
};
const decisionTitle = (key) => key
  .replace(/:/g, " · ")
  .replace(/-/g, " ")
  .replace(/([a-z])([A-Z])/g, "$1 $2")
  .replace(/^./, (value) => value.toUpperCase());

export function buildBlueprintWorkspaceModel(input = {}) {
  const rulebook = evaluateArchitectureRulebook(input.rulebook ?? input.blueprint ?? currentRulebookInput);
  const viability = assessViability(input.viability ?? currentViabilityInput, { now: input.now ?? Date.parse("2026-09-02T00:00:00.000Z") });
  const debt = assessTechnicalDebt(input.debt ?? currentDebtSnapshot, input.previousDebt ?? {}, { requiredSurfaces: input.requiredDebtSurfaces ?? ["ui", "engine", "storage", "native"] });
  const folderContract = assessFolderContract(input.folderContract ?? currentFolderContractInput);
  const gates = [
    { id: "G-BLUEPRINT", title: "Template & compatibility", verdict: rulebook.verdict, status: rulebook.ready ? "clear" : "blocked", metric: `${rulebook.requiredQuestions.length} open`, detail: rulebook.ready ? "All architecture contracts answered" : `${rulebook.requiredQuestions.length} named contracts unanswered · ${rulebook.blockers.length} incompatibilities` },
    { id: "G-VIABILITY", title: "Business viability", verdict: viability.verdict, status: viability.ready ? "clear" : "blocked", metric: `${viability.evidence.present}/${viability.evidence.required}`, detail: viability.ready ? "Evidence-backed case may enter architecture review" : `${viability.blockers.length} evidence or input blockers` },
    { id: "G-DEBT", title: "Technical debt", verdict: debt.verdict, status: debt.ready ? "clear" : debt.verdict === "UNKNOWN" ? "unknown" : "blocked", metric: `${debt.coverage.covered}/${debt.coverage.required}`, detail: debt.ready ? "Covered debt remains within budget" : `${debt.coverage.missing.length} surfaces lack analyzer coverage` },
    { id: "G-STRUCTURE", title: "Folder contract", verdict: folderContract.ready ? "AWAITING FREEZE" : "BLOCKED", status: "blocked", metric: `${folderContract.nodes.length} paths`, detail: folderContract.ready ? `${folderContract.reservations.length} forward reservations ready; explicit approval has not frozen them` : `${folderContract.blockers.length} structure blockers` },
  ];
  const decisions = rulebook.requiredQuestions.map((question, index) => ({ id: `D-${String(index + 1).padStart(2, "0")}`, key: question, title: decisionTitle(question), source: question.split(":")[0], status: "required" }));
  const evidence = [
    { id: "E-MARKET", title: "Market evidence", count: viability.evidence.present, target: viability.evidence.required, note: "Market, competition, build benchmark, security, liability, and redundancy" },
    { id: "E-COMP", title: "Competitor comparisons", count: viability.evidence.competitors, target: 2, note: "Named substitutes with audience, price, strength, gap, and source" },
    { id: "E-BENCH", title: "Historical build benchmarks", count: viability.evidence.benchmarks, target: 1, note: "Developer count, calendar time, cost, and source" },
    { id: "E-ASSUME", title: "Assumptions with fallbacks", count: viability.evidence.assumptions, target: 1, note: "Statement, owner, validation date, and contingency" },
  ];
  return { canEnterPlan: gates.every((gate) => gate.status === "clear"), verdict: gates.every((gate) => gate.status === "clear") ? "ENTER PLAN" : "STOP BEFORE ARCHITECTURE", gates, blueprint: rulebook, rulebook, viability, debt, folderContract, decisions, evidence, nextAction: decisions[0]?.title ?? viability.blockers[0] ?? folderContract.blockers[0] ?? debt.blockers[0] ?? "Review and freeze the folder contract" };
}
