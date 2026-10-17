// Architecture seed: turns the folder scan and the person's discovery answers into
// *suggestions* for the architecture draft. Pure and deterministic. Suggestions are
// proposals, not decisions: they only fill empty fields, carry their source, and the
// draft still has to be reviewed, confirmed and published by the person.
import { architectureTemplates, useCaseRulebook } from "./rulebookEngine.js";

export const architectureDraftShape = Object.freeze({
  scenarioKinds: Object.freeze(["security-breach", "data-loss", "critical-dependency-failure", "vendor-exit"]),
  scenarioFields: Object.freeze(["trigger", "detection", "owner", "immediateAction", "recovery", "verification"]),
  decisionKinds: Object.freeze(["platform", "data", "identity-auth", "state-sync", "deployment-distribution"]),
  decisionFields: Object.freeze(["choice", "rationale", "evidence", "alternativeChoice", "alternativeReason"]),
  qualityFields: Object.freeze(["performanceBudget", "securityTarget", "accessibilityTarget", "operatingCostCeiling", "recoveryTarget", "observabilityProof"]),
});

const { scenarioKinds, scenarioFields, decisionKinds, decisionFields, qualityFields } = architectureDraftShape;

export function blankArchitectureDraft() {
  return {
    templateId: "", platform: "", useCases: [], answers: {},
    scenarios: scenarioKinds.map((kind) => ({ kind, ...Object.fromEntries(scenarioFields.map((field) => [field, ""])) })),
    decisions: decisionKinds.map((kind) => ({ kind, choice: "", rationale: "", evidence: "", alternatives: [{ choice: "", rejectionReason: "" }] })),
    nonFunctional: Object.fromEntries(qualityFields.map((field) => [field, ""])),
    capabilitiesText: "[]", dependenciesText: "[]", suggestions: {},
  };
}

export const architectureQuestionsFor = (useCases = []) => [...new Set(useCases.flatMap((id) => useCaseRulebook[id]?.questions ?? []))];

/** Every required free-text field path the draft form shows for these use cases. */
export function architectureDraftFieldPaths(draft) {
  return [
    ...architectureQuestionsFor(draft?.useCases).map((question) => `answers.${question}`),
    ...scenarioKinds.flatMap((kind) => scenarioFields.map((field) => `scenarios.${kind}.${field}`)),
    ...decisionKinds.flatMap((kind) => decisionFields.map((field) => `decisions.${kind}.${field}`)),
    ...qualityFields.map((field) => `nonFunctional.${field}`),
  ];
}

const ALTERNATIVE_KEYS = { alternativeChoice: "choice", alternativeReason: "rejectionReason" };

export function readDraftField(draft, path) {
  const [group, a, b] = path.split(".");
  if (group === "answers") return draft.answers?.[a] ?? "";
  if (group === "nonFunctional") return draft.nonFunctional?.[a] ?? "";
  if (group === "scenarios") return draft.scenarios?.find((item) => item.kind === a)?.[b] ?? "";
  if (group === "decisions") {
    const decision = draft.decisions?.find((item) => item.kind === a);
    return (ALTERNATIVE_KEYS[b] ? decision?.alternatives?.[0]?.[ALTERNATIVE_KEYS[b]] : decision?.[b]) ?? "";
  }
  return "";
}

export function writeDraftField(draft, path, value) {
  const [group, a, b] = path.split(".");
  if (group === "answers") return { ...draft, answers: { ...draft.answers, [a]: value } };
  if (group === "nonFunctional") return { ...draft, nonFunctional: { ...draft.nonFunctional, [a]: value } };
  if (group === "scenarios") return { ...draft, scenarios: draft.scenarios.map((item) => (item.kind === a ? { ...item, [b]: value } : item)) };
  if (group === "decisions") {
    return {
      ...draft,
      decisions: draft.decisions.map((item) => {
        if (item.kind !== a) return item;
        if (!ALTERNATIVE_KEYS[b]) return { ...item, [b]: value };
        return { ...item, alternatives: [{ choice: "", rejectionReason: "", ...item.alternatives?.[0], [ALTERNATIVE_KEYS[b]]: value }] };
      }),
    };
  }
  throw new Error(`Unknown architecture draft field: ${path}`);
}

const scanSource = (id, label) => Object.freeze({ id, kind: "scan", label: `From the folder scan: ${label} (${id})` });
const answerSource = (item) => Object.freeze({ id: item.id, kind: "answer", label: `From your discovery answer ${item.id} (${item.title})` });

// Only findings the scan *observed* count as facts. Signals (auth/security/worker
// naming) and the deployment-file guess (S062) are too often wrong to seed answers.
const TAURI_FINDINGS = ["S012", "S022"];

/**
 * `review` is deriveDiscoveryReview(project, records). Returns suggestions with a
 * source for each, or `available: false` with a plain reason.
 */
export function suggestArchitectureSeed(review) {
  const empty = (reason) => ({ available: false, reason, template: null, useCases: [], fields: {} });
  if (!review || review.state === "unanswered" || !Array.isArray(review.items)) return empty("Scan the app folder in Structure first. There is nothing to fill from yet.");
  if (review.state === "stale" || review.state === "unavailable") return empty("The folder scan is out of date. Scan the folder again in Structure before filling from it.");

  const items = new Map(review.items.map((item) => [item.id, item]));
  const findingIds = new Set(review.items.filter((item) => item.state === "observed").flatMap((item) => item.findingIds ?? []));
  const answered = (id) => {
    const item = items.get(id);
    return item?.decision?.decision === "answered" && item.decision.note.trim() ? { value: item.decision.note.trim(), source: answerSource(item) } : null;
  };
  const fields = {};
  const suggest = (path, suggestion) => { if (suggestion && !fields[path]) fields[path] = suggestion; };

  let template = null;
  const useCases = [];
  const tauriId = TAURI_FINDINGS.find((id) => findingIds.has(id));
  if (tauriId) {
    const source = scanSource(tauriId, tauriId === "S012" ? "Tauri desktop shell" : "Native application boundary");
    template = { id: "tauri-local-desktop", platform: "tauri", source };
    useCases.push({ id: "desktop-distribution", source });
  } else if (findingIds.has("S011")) {
    template = { id: null, platform: "web", source: scanSource("S011", "Next.js configuration") };
  }

  // Answers come first: the person's own words beat what file names suggest.
  const a02 = answered("A02"), a03 = answered("A03"), a04 = answered("A04"), a06 = answered("A06"), a07 = answered("A07");
  suggest("decisions.platform.choice", tauriId ? { value: "Tauri desktop app", source: template.source } : a02);
  if (tauriId) suggest("decisions.platform.evidence", { value: "The folder scan found a Tauri configuration (src-tauri/tauri.conf.json) and a src-tauri native boundary.", source: template.source });
  else if (findingIds.has("S011")) suggest("decisions.platform.evidence", { value: "The folder scan found a Next.js configuration file.", source: template.source });
  suggest("decisions.platform.rationale", a03 ?? (tauriId ? a02 : null));
  suggest("decisions.data.choice", a04);
  suggest("decisions.identity-auth.choice", a04);
  suggest("nonFunctional.securityTarget", a06);
  suggest("answers.capabilityPolicy", a06);
  suggest("decisions.deployment-distribution.choice", a07 ?? (tauriId ? { value: "Desktop installer built with Tauri", source: template.source } : null));

  const hasAnything = Boolean(template) || Object.keys(fields).length > 0;
  return {
    available: hasAnything,
    reason: hasAnything ? "" : "The scan and your discovery answers do not cover any of these questions yet. Answer the open areas in Structure, or type the answers here.",
    template, useCases, fields,
  };
}

const platformsFor = (templateId) => architectureTemplates.find((item) => item.id === templateId)?.platforms ?? [];
const isBlank = (value) => typeof value !== "string" || value.trim() === "";

/**
 * Fills only empty fields. Never changes a typed value, a chosen template or chosen
 * use cases. Returns the next draft and the paths it filled; `draft.suggestions`
 * records each filled value with its source so the form can mark it.
 */
export function applyArchitectureSeed(draft, seed) {
  if (!seed?.available) return { draft, filled: [] };
  let next = { ...draft, suggestions: { ...(draft.suggestions ?? {}) } };
  const filled = [];
  const mark = (path, value, source) => { next.suggestions[path] = { value, source }; filled.push(path); };
  if (seed.template?.id && !next.templateId) {
    next.templateId = seed.template.id;
    mark("templateId", seed.template.id, seed.template.source);
  }
  if (seed.template?.platform && !next.platform && platformsFor(next.templateId).includes(seed.template.platform)) {
    next.platform = seed.template.platform;
    mark("platform", seed.template.platform, seed.template.source);
  }
  if (!next.useCases.length && seed.useCases.length) {
    next.useCases = seed.useCases.map((item) => item.id);
    for (const item of seed.useCases) mark(`useCases:${item.id}`, true, item.source);
  }
  const visible = new Set(architectureDraftFieldPaths(next));
  for (const [path, suggestion] of Object.entries(seed.fields)) {
    if (!visible.has(path) || !isBlank(readDraftField(next, path))) continue;
    next = writeDraftField(next, path, suggestion.value);
    mark(path, suggestion.value, suggestion.source);
  }
  if (!filled.length) return { draft, filled };
  return { draft: next, filled };
}

/** Which marked suggestions still hold their suggested value (i.e. the person has not edited them). */
export function pendingSuggestionPaths(draft) {
  return architectureDraftFieldPaths(draft).filter((path) => {
    const suggestion = draft.suggestions?.[path];
    return suggestion && readDraftField(draft, path) === suggestion.value;
  });
}

/** Counts for "N of T answers filled from the scan; M still need you". */
export function architectureSeedProgress(draft) {
  const paths = architectureDraftFieldPaths(draft);
  return {
    total: paths.length,
    suggested: pendingSuggestionPaths(draft).length,
    empty: paths.filter((path) => isBlank(readDraftField(draft, path))).length,
  };
}
