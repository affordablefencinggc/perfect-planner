function clone(value) { return structuredClone(value); }

export async function runMutationCampaign(input = {}) {
  const mutations = input.mutations ?? [];
  if (!mutations.length) return { verdict: "BLOCKED", blockers: ["Mutation campaign contains no adversarial mutations."], results: [], totals: { total: 0, killed: 0, survived: 0, errors: 0 }, coverage: { required: input.requiredGuarantees?.length ?? 0, covered: 0, missing: input.requiredGuarantees ?? [] } };
  const ids = new Set(); const results = [];
  for (const mutation of mutations) {
    if (!mutation.id || ids.has(mutation.id) || !mutation.guarantee || typeof mutation.apply !== "function" || typeof mutation.probe !== "function") throw new Error("Each mutation needs a unique id, guarantee, apply function, and probe function.");
    ids.add(mutation.id);
    const original = clone(input.baseline);
    const mutated = clone(input.baseline);
    try {
      await mutation.apply(mutated);
      const probePassed = await mutation.probe(mutated);
      results.push({ id: mutation.id, guarantee: mutation.guarantee, state: probePassed === false ? "KILLED" : "SURVIVED", probePassed: probePassed === true, note: probePassed === false ? "The focused probe detected the broken guarantee." : "The focused probe stayed green after the guarantee was broken." });
    } catch (error) {
      results.push({ id: mutation.id, guarantee: mutation.guarantee, state: "ERROR", probePassed: false, note: `Mutation or probe crashed: ${error.message}` });
    }
    if (JSON.stringify(input.baseline) !== JSON.stringify(original)) throw new Error(`Mutation ${mutation.id} changed the authoritative baseline.`);
  }
  const required = [...new Set(input.requiredGuarantees ?? [])]; const covered = new Set(results.map((result) => result.guarantee)); const missing = required.filter((guarantee) => !covered.has(guarantee));
  const totals = { total: results.length, killed: results.filter((result) => result.state === "KILLED").length, survived: results.filter((result) => result.state === "SURVIVED").length, errors: results.filter((result) => result.state === "ERROR").length };
  const blockers = [];
  if (totals.survived) blockers.push(`${totals.survived} mutation(s) survived their focused probes.`);
  if (totals.errors) blockers.push(`${totals.errors} mutation/probe error(s) are unresolved.`);
  if (missing.length) blockers.push(`Mutation coverage is missing: ${missing.join(", ")}.`);
  return { verdict: blockers.length ? "BLOCKED" : "CERTIFIED", blockers, results, totals, coverage: { required: required.length, covered: required.length - missing.length, missing } };
}
