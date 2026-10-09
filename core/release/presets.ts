import type { Actor, Ledger, LedgerEntry } from "../ledger/index";
import { nextNumber } from "../numbering/index";
import type { Triage } from "./risk";
import type { PresetName } from "./types";

// Review presets (plan table "Review like CodeRabbit, priced by risk"):
//   Cheap     local checks, secret scan, small-model triage; deep review only on sensitive areas
//   Balanced  Cheap, plus deep review on anything triage rates risky (default)
//   Thorough  deep review on every change, and full tests on every merge

export interface Preset {
  name: PresetName;
  label: string;
  bestFor: string;
  /** When the expensive deep review runs. */
  deepReview: "sensitive-only" | "risky" | "always";
  /** Full test suite on every merge (merge queue batch of one) instead of once per batch. */
  fullTestsEveryMerge: boolean;
}

export const PRESETS: Readonly<Record<PresetName, Preset>> = {
  cheap: {
    name: "cheap",
    label: "Cheap",
    bestFor: "Solo projects and prototypes",
    deepReview: "sensitive-only",
    fullTestsEveryMerge: false,
  },
  balanced: {
    name: "balanced",
    label: "Balanced",
    bestFor: "Most projects",
    deepReview: "risky",
    fullTestsEveryMerge: false,
  },
  thorough: {
    name: "thorough",
    label: "Thorough",
    bestFor: "Production apps with real users or money",
    deepReview: "always",
    fullTestsEveryMerge: true,
  },
};

export const DEFAULT_PRESET: PresetName = "balanced";

export function isPresetName(value: unknown): value is PresetName {
  return value === "cheap" || value === "balanced" || value === "thorough";
}

/** Whether a triaged change gets the deep review under a preset, with the plain reason. */
export function needsDeepReview(preset: PresetName, triage: Triage): { deep: boolean; why: string } {
  const policy = PRESETS[preset].deepReview;
  const sensitive = triage.areas.filter((area) => area !== "oversize");
  if (policy === "always") return { deep: true, why: "Thorough reviews every change in depth" };
  if (sensitive.length > 0) return { deep: true, why: `sensitive area: ${sensitive.join(", ")}` };
  if (policy === "risky" && triage.level !== "low") return { deep: true, why: `triage rated it ${triage.level}: ${triage.reasons.join("; ")}` };
  return { deep: false, why: policy === "risky" ? "triage rated it low" : "Cheap only goes deep on sensitive areas" };
}

const PRESET_TOPIC = "review-preset";

/** The preset in force: the latest decision.made with topic "review-preset", else Balanced. */
export function currentPreset(entries: readonly LedgerEntry[]): PresetName {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "decision.made" && entry.data?.topic === PRESET_TOPIC && isPresetName(entry.data?.preset)) {
      return entry.data.preset;
    }
  }
  return DEFAULT_PRESET;
}

/** Records a preset choice. Only a person chooses how much review their project pays for. */
export function setPreset(ledger: Ledger, actor: Actor, preset: PresetName, reason: string): LedgerEntry {
  if (actor.kind !== "person") throw new Error("Only a person can change the review preset");
  if (!isPresetName(preset)) throw new Error(`Unknown review preset ${String(preset)}`);
  return ledger.append({
    actor,
    type: "decision.made",
    subject: nextNumber(ledger.entries(), "D"), // decisions take the next D- number

    summary: `Review preset set to ${PRESETS[preset].label}`,
    reason,
    evidence: [],
    refs: [],
    data: { topic: PRESET_TOPIC, preset },
  });
}
