// Depth check: finds the parts of a plan that are too thin (components with
// no sub-parts) and answers that contradict each other.

import { answerText, choosesOffline, isDeclined } from "./mindmap";
import type { MindMap, PlanningAnswer } from "./types";

export interface DepthFinding {
  kind: "shallow" | "contradiction";
  message: string;
  nodes: string[];
  questions: string[];
}

export interface ContradictionRule {
  id: string;
  message: string;
  /** Returns the question ids involved when the answers contradict, or null. */
  check(answers: PlanningAnswer[]): string[] | null;
}

const says = (a: PlanningAnswer, pattern: RegExp) => pattern.test(answerText(a));

/** Pairs every answer matching `left` with every answer matching `right`; returns the involved ids. */
function pair(
  answers: PlanningAnswer[],
  left: (a: PlanningAnswer) => boolean,
  right: (a: PlanningAnswer) => boolean,
): string[] | null {
  const l = answers.filter(left);
  const r = answers.filter((a) => right(a) && !l.includes(a));
  if (!l.length || !r.length) return null;
  return [...new Set([...l, ...r].map((a) => a.questionId))].sort();
}

const SERVER_ONLY = /server[- ]only|online[- ]only|cloud[- ]only|always online|no local/;
const NO_SIGN_IN = /no sign[- ]?in|no login|no accounts?|anonymous/;
const ROLES = /\broles?\b|permissions?|\badmins?\b/;
const PAYMENTS = /payments?|stripe|paddle|checkout|subscription|paid plan|\$\d/;
const PRICING = /pricing|subscription|per month|\/mo\b|paid plan|\btiers?\b|\$\d|freemium/;
const AI_PROVIDER = /openai|anthropic|claude|\bgpt|gemini|llama|mistral|\bllm\b|ai provider|ai model|\bjev\b/;
const DESKTOP_SHELL = /tauri|electron/;
const MOBILE_CAPABLE = /mobile|ios|android|react native|capacitor|expo|flutter/;

function mobileFirst(a: PlanningAnswer): boolean {
  const t = answerText(a);
  if (/mobile[- ]first/.test(t)) return true;
  const mobile = t.search(/mobile|ios|android|phone/);
  if (mobile < 0) return false;
  const others = [t.search(/\bweb\b|browser/), t.search(/desktop|windows|mac ?os|linux/)].filter((i) => i >= 0);
  return others.every((i) => mobile < i);
}

/** Answer pairs that cannot both be true. Each rule names the questions involved. */
export const CONTRADICTION_RULES: readonly ContradictionRule[] = [
  {
    id: "offline-vs-server-only",
    message: "Offline-first was chosen, but the data store only works online (server-only). Offline needs a local copy.",
    check: (answers) =>
      pair(
        answers,
        (a) => a.area === "offline" && choosesOffline(a),
        (a) => a.area === "data" && says(a, SERVER_ONLY),
      ),
  },
  {
    id: "no-sign-in-vs-roles-or-payments",
    message: "No sign-in was chosen, but other answers need to know who the user is (roles, permissions or payments).",
    check: (answers) =>
      pair(
        answers,
        (a) => a.area === "auth" && says(a, NO_SIGN_IN),
        (a) => (a.area !== "auth" || !says(a, NO_SIGN_IN)) && !isDeclined(a) && (says(a, ROLES) || (a.area === "money" && says(a, PAYMENTS))),
      ),
  },
  {
    id: "no-payments-vs-pricing",
    message: "Payments are not in v1, but a paid pricing model was chosen. Either take payments in v1 or launch free.",
    check: (answers) =>
      pair(
        answers,
        (a) => a.area === "money" && isDeclined(a),
        (a) => !isDeclined(a) && says(a, PRICING),
      ),
  },
  {
    id: "no-ai-vs-ai-provider",
    message: "AI is not used, but an AI provider or model was chosen elsewhere.",
    check: (answers) =>
      pair(
        answers,
        (a) => a.area === "ai" && isDeclined(a),
        (a) => !isDeclined(a) && says(a, AI_PROVIDER),
      ),
  },
  {
    id: "mobile-first-vs-desktop-shell",
    message: "Mobile comes first, but the stack is a desktop-only shell (Tauri or Electron) with no mobile plan.",
    check: (answers) =>
      pair(
        answers,
        (a) => a.area === "platforms" && mobileFirst(a),
        (a) => a.area === "stack" && says(a, DESKTOP_SHELL) && !says(a, MOBILE_CAPABLE),
      ),
  },
];

export function depthCheck(map: MindMap, answers: PlanningAnswer[]): DepthFinding[] {
  const findings: DepthFinding[] = [];
  for (const node of Object.values(map.nodes)) {
    if (node.id === map.root || node.kind !== "component" || node.children.length > 0) continue;
    findings.push({
      kind: "shallow",
      message: `"${node.label}" has no parts yet: say what it is made of (screens, data, integrations).`,
      nodes: [node.id],
      questions: [...node.from],
    });
  }
  for (const rule of CONTRADICTION_RULES) {
    const questions = rule.check(answers);
    if (!questions) continue;
    const nodes = Object.values(map.nodes)
      .filter((n) => n.id !== map.root && n.from.some((q) => questions.includes(q)))
      .map((n) => n.id);
    findings.push({ kind: "contradiction", message: rule.message, nodes, questions });
  }
  return findings;
}
