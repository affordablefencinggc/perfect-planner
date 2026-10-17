const machineProvenance = new Set(["local-runner", "ci-runner"]);

export function auditProofPack(item, journal = [], artifacts = {}) {
  const fatal = [];
  const weak = [];
  if (!item?.tested) return { ok: false, fatal: ["item is not proven"], weak, state: "open" };
  if (!item.builtBy?.actor || !item.builtBy?.at || !item.builtBy?.commit) fatal.push("built stamp is incomplete");
  const proof = item.proof ?? {};
  if (![...machineProvenance, "human-confirmation"].includes(proof.by)) fatal.push("proof provenance is missing or unrecognised");
  if (!proof.at) fatal.push("proof timestamp is missing");
  if (proof.by === "human-confirmation") {
    if (!proof.confirmedBy || !proof.note) fatal.push("human confirmation needs an identity and viewing note");
  } else {
    if (!proof.verify) fatal.push("machine proof has no verification command");
    if (!proof.artifact || !proof.sha256) fatal.push("machine proof has no hashed output artifact");
    const artifact = proof.artifact ? artifacts[proof.artifact] : null;
    if (!artifact || artifact.sha256 !== proof.sha256) fatal.push("proof artifact is missing or its hash does not match");
    const journalMatch = journal.some((entry) => entry.action === "prove" && entry.itemId === item.id && entry.artifact === proof.artifact && entry.sha256 === proof.sha256 && entry.exit === 0);
    if (!journalMatch) fatal.push("no successful journal entry matches this proof");
  }
  if (item.ui && (!proof.screenshot || !proof.viewedNote)) fatal.push("UI proof needs a screenshot and viewing attestation");
  if (!proof.environment) weak.push("execution environment was not captured");
  if (!proof.loc) weak.push("LOC delta was not captured");
  if (proof.tokensEstimate == null) weak.push("token figure is absent; never present it as measured");
  return { ok: fatal.length === 0, fatal, weak, state: fatal.length ? "stop" : weak.length ? "weak" : "proven" };
}

export function assessCompletion(plan, journal = [], artifacts = {}) {
  const audits = (plan.items ?? []).map((item) => ({ itemId: item.id, ...auditProofPack(item, journal, artifacts) }));
  const reasons = [];
  for (const audit of audits.filter((item) => !item.ok)) reasons.push(`${audit.itemId}: ${audit.fatal.join("; ")}`);
  if (!plan.approved) reasons.push("spine approval is missing");
  if (plan.openGates > 0) reasons.push(`${plan.openGates} collision gate${plan.openGates === 1 ? " remains" : "s remain"} open`);
  if (plan.ciTier3 !== "green") reasons.push("merged-state Tier 3 CI is not green");
  if (plan.truthCoreValid !== true) reasons.push("local truth-core report is missing or invalid");
  if (!plan.completenessReview) reasons.push("no completeness review is recorded");
  return {
    ready: reasons.length === 0,
    reasons,
    audits,
    built: (plan.items ?? []).filter((item) => item.built).length,
    proven: audits.filter((audit) => audit.ok).length,
    total: (plan.items ?? []).length,
  };
}
