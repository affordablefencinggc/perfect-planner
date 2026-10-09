// MockJev: a deterministic stand-in for the external judge, plus the rules any
// advisor's proposal must pass before core/mvp accepts it. No network calls.

import type { Actor } from "../ledger/index";
import {
  STAGE_IDS,
  type Feature,
  type FeatureStatus,
  type Journey,
  type MvpAdvisor,
  type MvpProposal,
  type Placement,
  type ProposalInput,
  type ScannedFeature,
  type StageId,
} from "./types";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for", "from", "in",
  "into", "is", "it", "of", "on", "or", "that", "the", "their", "to", "up", "use",
  "with", "your",
]);

const JOURNEY_NAME = /end-to-end|e2e|journey/i;
const SCALE_NAME = /performance|mutation|scale|budget|certif|hardening/i;
const MAX_JOURNEY_FEATURES = 5;
const MAX_REASON_LENGTH = 200;

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function statusOf(f: Feature | ScannedFeature): FeatureStatus | undefined {
  return (f as ScannedFeature).status;
}

/**
 * The given ids plus everything they transitively depend on, restricted to ids
 * that exist in `features`. Order: discovery order. Safe on dependency cycles.
 */
export function dependencyClosure(ids: readonly string[], features: readonly Feature[]): string[] {
  const byId = new Map(features.map((f) => [f.id, f]));
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [...ids].reverse();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const f = byId.get(id);
    if (!f || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (let i = f.dependsOn.length - 1; i >= 0; i--) stack.push(f.dependsOn[i]);
  }
  return out;
}

function pickJourneyFeatures(input: ProposalInput): string[] {
  const given = input.journey?.features?.filter((id) => input.features.some((f) => f.id === id));
  if (given && given.length > 0) return given;

  const userFacing = input.features.filter((f) => f.userFacing);
  if (input.mode === "existing") {
    const e2e =
      userFacing.find((f) => JOURNEY_NAME.test(f.name) || JOURNEY_NAME.test(f.id)) ??
      input.features.find((f) => JOURNEY_NAME.test(f.name) || JOURNEY_NAME.test(f.id));
    // The journey is the e2e feature and what it touches directly; the MVP
    // still takes the full dependency closure.
    if (e2e) return [e2e.id, ...e2e.dependsOn.filter((id) => id !== e2e.id && input.features.some((f) => f.id === id))];
  }

  const goalWords = new Set(words(input.goal));
  const pool = userFacing.length > 0 ? userFacing : input.features;
  const scored = pool.map((f, index) => {
    const own = new Set(words(`${f.name} ${f.description ?? ""}`));
    let score = 0;
    for (const w of own) if (goalWords.has(w)) score++;
    return { id: f.id, score, index };
  });
  const matched = scored.filter((s) => s.score > 0);
  const ranked = (matched.length > 0 ? matched : scored).sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, MAX_JOURNEY_FEATURES).map((s) => s.id);
}

function journeySteps(ids: readonly string[], byId: ReadonlyMap<string, Feature | ScannedFeature>): string[] {
  const visible = ids.filter((id) => {
    const f = byId.get(id);
    return f !== undefined && f.userFacing && !JOURNEY_NAME.test(f.name);
  });
  return (visible.length > 0 ? visible : ids).map((id) => `Use ${byId.get(id)?.name ?? id}`);
}

function placeLater(f: Feature | ScannedFeature, mode: "new" | "existing"): { stage: StageId; reason: string } {
  const status = statusOf(f);
  if (mode === "existing" && status === "missing") {
    return { stage: "v1", reason: "Not built yet and the core journey does not need it" };
  }
  if (mode === "existing" && status === "partial") {
    return { stage: "beta", reason: "Half built; finish after the MVP journey works" };
  }
  if (!f.userFacing) {
    return SCALE_NAME.test(f.name)
      ? { stage: "scale", reason: "Internal hardening; not needed for the first user journey" }
      : { stage: "v1", reason: "Supporting tooling outside the core journey" };
  }
  return { stage: "beta", reason: "Useful, but the core journey works without it" };
}

export class MockJev implements MvpAdvisor {
  readonly actor: Actor;

  constructor(actor: Actor = { kind: "jev", id: "jev-mock", model: "mock-1" }) {
    this.actor = actor;
  }

  async proposeMvp(input: ProposalInput): Promise<MvpProposal> {
    const journeyIds = pickJourneyFeatures(input);
    const byId = new Map(input.features.map((f) => [f.id, f]));
    const mvp = new Set(dependencyClosure(journeyIds, input.features));
    const onJourney = new Set(journeyIds);

    const placements: Placement[] = input.features.map((f) => {
      if (mvp.has(f.id)) {
        return {
          feature: f.id,
          stage: "mvp" as const,
          reason: onJourney.has(f.id) ? "On the core journey" : "Needed by the core journey",
        };
      }
      const later = placeLater(f, input.mode);
      return { feature: f.id, stage: later.stage, reason: later.reason };
    });

    const journey: Journey = {
      name: input.journey?.name ?? `Core journey: ${input.goal}`,
      steps:
        input.journey?.steps && input.journey.steps.length > 0
          ? input.journey.steps
          : journeySteps(journeyIds, byId),
      test: input.journey?.test ?? "npm run test:e2e",
      features: journeyIds,
    };

    let summary = `${mvp.size} of ${input.features.length} features in the MVP`;
    if (input.mode === "existing") {
      const done = [...mvp].filter((id) => {
        const f = byId.get(id);
        return f !== undefined && statusOf(f) === "done";
      }).length;
      summary += `, ${done} already done`;
    }

    return { by: this.actor, journey, placements, summary };
  }
}

/** Problems with a proposal; an empty list means it is acceptable. */
export function validateProposal(proposal: MvpProposal, features: readonly Feature[]): string[] {
  const problems: string[] = [];
  const known = new Set(features.map((f) => f.id));
  const stageOf = new Map<string, StageId>();
  const counts = new Map<string, number>();

  for (const p of proposal.placements) {
    if (!known.has(p.feature)) {
      problems.push(`unknown feature ${p.feature}`);
      continue;
    }
    counts.set(p.feature, (counts.get(p.feature) ?? 0) + 1);
    if (!STAGE_IDS.includes(p.stage)) {
      problems.push(`${p.feature} has unknown stage ${String(p.stage)}`);
      continue;
    }
    if (!stageOf.has(p.feature)) stageOf.set(p.feature, p.stage);
    if (p.stage !== "mvp") {
      const reason = typeof p.reason === "string" ? p.reason.trim() : "";
      if (reason === "") problems.push(`${p.feature} is placed in ${p.stage} without a reason`);
      else if (/^tbd\b\.?$/i.test(reason)) problems.push(`${p.feature} has a placeholder reason (TBD)`);
      else if (/[\r\n]/.test(reason)) problems.push(`${p.feature} reason must be a single line`);
      else if (reason.length > MAX_REASON_LENGTH) {
        problems.push(`${p.feature} reason is longer than ${MAX_REASON_LENGTH} characters`);
      }
    }
  }
  for (const f of features) {
    const n = counts.get(f.id) ?? 0;
    if (n === 0) problems.push(`${f.id} is not placed`);
    else if (n > 1) problems.push(`${f.id} is placed ${n} times`);
  }

  const journeyFeatures = proposal.journey?.features ?? [];
  for (const id of journeyFeatures) {
    if (!known.has(id)) problems.push(`journey feature ${id} is unknown`);
    else if (stageOf.get(id) !== "mvp") problems.push(`journey feature ${id} is not in the MVP`);
  }
  if (typeof proposal.journey?.test !== "string" || proposal.journey.test.trim() === "") {
    problems.push("journey has no test command");
  }

  const byId = new Map(features.map((f) => [f.id, f]));
  for (const f of features) {
    if (stageOf.get(f.id) !== "mvp") continue;
    for (const dep of f.dependsOn) {
      if (!byId.has(dep)) continue;
      const stage = stageOf.get(dep);
      if (stage !== undefined && stage !== "mvp") problems.push(`${f.id} needs ${dep} which sits in ${stage}`);
    }
  }
  return problems;
}

/** Ask an advisor and refuse any proposal that breaks the rules. */
export async function proposeWith(advisor: MvpAdvisor, input: ProposalInput): Promise<MvpProposal> {
  const proposal = await advisor.proposeMvp(input);
  const problems = validateProposal(proposal, input.features);
  if (problems.length > 0) {
    throw new Error(`Advisor ${advisor.actor.id} proposed an invalid MVP:\n- ${problems.join("\n- ")}`);
  }
  return proposal;
}
