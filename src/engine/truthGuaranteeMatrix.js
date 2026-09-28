export const TRUTH_GUARANTEES = Object.freeze([
  "bounded-census",
  "stable-document-registry",
  "journal-integrity",
  "machine-proof",
  "durable-session",
  "ci-honesty",
  "confirmation-fail-closed",
  "blueprint-fail-closed",
  "rulebook-fail-closed",
  "architecture-contract-tamper-refused",
  "architecture-registry-linear-history",
  "viability-fail-closed",
  "debt-coverage-honest",
  "conveyor-claim-guard",
  "handoff-confidentiality",
  "mailbox-one-time-acceptance",
  "peer-quorum-fail-closed",
  "provider-budget-redaction",
  "screenshot-unproven-without-viewing",
  "sonar-no-auto-import",
  "autopilot-device-denial",
  "identity-private-key-redaction",
]);

const propertyName = (guarantee) => guarantee.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

export function buildTruthGuaranteeCampaign(snapshot = {}) {
  const baseline = {}; const missing = []; const falseGuarantees = [];
  for (const guarantee of TRUTH_GUARANTEES) {
    const property = propertyName(guarantee); const value = snapshot[property];
    if (typeof value !== "boolean") missing.push(guarantee); else if (value !== true) falseGuarantees.push(guarantee); else baseline[property] = true;
  }
  if (missing.length) throw new Error(`Truth guarantee snapshot is missing boolean predicates: ${missing.join(", ")}.`);
  if (falseGuarantees.length) throw new Error(`Truth guarantee baseline is already broken: ${falseGuarantees.join(", ")}.`);
  return {
    baseline,
    requiredGuarantees: [...TRUTH_GUARANTEES],
    mutations: TRUTH_GUARANTEES.map((guarantee) => {
      const property = propertyName(guarantee);
      return { id: `M-${guarantee.toUpperCase()}`, guarantee, apply: (state) => { state[property] = false; }, probe: (state) => state[property] === true };
    }),
  };
}
