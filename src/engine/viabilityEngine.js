const requiredEvidence = ["market", "competition", "build-benchmark", "security", "liability", "redundancy"];
const midpoint = (range) => range ? (Number(range.low) + Number(range.high)) / 2 : null;
const validRange = (range) => range && Number.isFinite(Number(range.low)) && Number.isFinite(Number(range.high)) && Number(range.low) >= 0 && Number(range.high) >= Number(range.low);
const money = (value) => Math.round(value * 100) / 100;

export function assessViability(input = {}, options = {}) {
  const blockers = []; const warnings = [];
  const brief = input.brief ?? {};
  for (const field of ["goal", "business", "motive", "targetAudience", "geography"]) if (!String(brief[field] ?? "").trim()) blockers.push(`Brief is missing ${field}.`);
  if (!new Set(["money", "charity", "hobby", "internal"]).has(brief.motive)) blockers.push("Motive must be money, charity, hobby, or internal.");
  const evidence = input.evidence ?? [];
  for (const kind of requiredEvidence) if (!evidence.some((item) => item.kind === kind && item.source && item.observedAt)) blockers.push(`Evidence is missing: ${kind}.`);
  const now = Number(options.now ?? Date.now());
  for (const item of evidence) {
    const ageDays = (now - Date.parse(item.observedAt)) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < 0) blockers.push(`Evidence date is invalid: ${item.kind ?? "unknown"}.`);
    else if (ageDays > Number(options.maxEvidenceAgeDays ?? 365)) warnings.push(`Evidence is stale (${Math.floor(ageDays)} days): ${item.kind}.`);
    if (!new Set(["low", "medium", "high"]).has(item.confidence)) blockers.push(`Evidence confidence is missing or invalid: ${item.kind ?? "unknown"}.`);
  }
  const competitors = input.competitors ?? [];
  if (competitors.length < 2) blockers.push("At least two named competitors or substitutes are required.");
  for (const competitor of competitors) for (const field of ["name", "audience", "price", "strength", "gap", "source"]) if (!String(competitor[field] ?? "").trim()) blockers.push(`Competitor ${competitor.name || "unnamed"} is missing ${field}.`);
  const benchmarks = input.buildBenchmarks ?? [];
  if (!benchmarks.length) blockers.push("At least one sourced historical build benchmark is required.");
  for (const benchmark of benchmarks) if (!["source", "developers", "calendarDays", "cost"].every((field) => benchmark[field] !== undefined && benchmark[field] !== "")) blockers.push("Each build benchmark requires source, developers, calendar days, and cost.");
  const costs = input.costs ?? {};
  for (const field of ["build", "monthlyFixed", "monthlyVariableAtTarget"]) if (!validRange(costs[field])) blockers.push(`Cost range is invalid or missing: ${field}.`);
  const revenue = input.revenue ?? {};
  if (brief.motive === "money") for (const field of ["monthlyAtTarget", "pricePerCustomer", "customersAtTarget"]) if (!validRange(revenue[field])) blockers.push(`Money-motivated plan is missing revenue range: ${field}.`);
  const risks = input.risks ?? [];
  for (const category of ["security", "liability", "redundancy"]) {
    const risk = risks.find((item) => item.category === category);
    if (!risk || !risk.scenario || !risk.mitigation || !risk.trigger || !risk.owner) blockers.push(`Risk register is incomplete: ${category}.`);
  }
  const assumptions = input.assumptions ?? [];
  if (!assumptions.length) blockers.push("Assumption ledger is empty.");
  for (const assumption of assumptions) if (!assumption.statement || !assumption.owner || !assumption.validateBy || !assumption.fallback) blockers.push("Every assumption needs statement, owner, validation date, and fallback.");
  const team = input.team ?? {};
  if (!Number.isInteger(team.developers) || team.developers < 1 || !Number.isFinite(team.hoursPerDay) || team.hoursPerDay <= 0 || !Number.isFinite(team.focusFactor) || team.focusFactor <= 0 || team.focusFactor > 1) blockers.push("Team pace requires developer count, positive hours/day, and focus factor between 0 and 1.");
  const work = input.work ?? [];
  if (!work.length || work.some((item) => !item.id || !Number.isFinite(item.hours) || item.hours <= 0)) blockers.push("Timeline work requires identified tasks with positive hour estimates.");
  const buildP50 = validRange(costs.build) ? midpoint(costs.build) : null;
  const buildP80 = validRange(costs.build) ? Number(costs.build.high) : null;
  const monthlyCostP50 = validRange(costs.monthlyFixed) && validRange(costs.monthlyVariableAtTarget) ? midpoint(costs.monthlyFixed) + midpoint(costs.monthlyVariableAtTarget) : null;
  const monthlyCostP80 = validRange(costs.monthlyFixed) && validRange(costs.monthlyVariableAtTarget) ? Number(costs.monthlyFixed.high) + Number(costs.monthlyVariableAtTarget.high) : null;
  const monthlyRevenueP50 = validRange(revenue.monthlyAtTarget) ? midpoint(revenue.monthlyAtTarget) : 0;
  const monthlyRevenueP80Downside = validRange(revenue.monthlyAtTarget) ? Number(revenue.monthlyAtTarget.low) : 0;
  const marginP50 = monthlyRevenueP50 > 0 && monthlyCostP50 !== null ? (monthlyRevenueP50 - monthlyCostP50) / monthlyRevenueP50 : null;
  const marginP80Downside = monthlyRevenueP80Downside > 0 && monthlyCostP80 !== null ? (monthlyRevenueP80Downside - monthlyCostP80) / monthlyRevenueP80Downside : null;
  if (brief.motive === "money" && marginP80Downside !== null && marginP80Downside <= 0) warnings.push("P80/downside operating margin is not positive.");
  const totalHours = work.reduce((sum, item) => sum + Number(item.hours || 0), 0);
  const dailyCapacity = Number(team.developers || 0) * Number(team.hoursPerDay || 0) * Number(team.focusFactor || 0);
  const calendarDaysP50 = dailyCapacity > 0 ? Math.ceil(totalHours / dailyCapacity) : null;
  const calendarDaysP80 = calendarDaysP50 === null ? null : Math.ceil(calendarDaysP50 * Number(input.scheduleRiskMultiplier ?? 1.35));
  const capital = Number(input.availableCapital ?? 0);
  const runwayMonthsP80 = monthlyCostP80 > 0 ? Math.max(0, (capital - (buildP80 ?? 0)) / monthlyCostP80) : null;
  if (capital > 0 && buildP80 !== null && capital < buildP80) blockers.push("Available capital does not cover P80 build cost.");
  return {
    ready: blockers.length === 0, verdict: blockers.length ? "BLOCKED" : "VIABLE_FOR_ARCHITECTURE_REVIEW", blockers: [...new Set(blockers)], warnings: [...new Set(warnings)],
    economics: { buildP50: buildP50 === null ? null : money(buildP50), buildP80: buildP80 === null ? null : money(buildP80), monthlyCostP50: monthlyCostP50 === null ? null : money(monthlyCostP50), monthlyCostP80: monthlyCostP80 === null ? null : money(monthlyCostP80), monthlyRevenueP50: money(monthlyRevenueP50), monthlyRevenueP80Downside: money(monthlyRevenueP80Downside), marginP50: marginP50 === null ? null : money(marginP50), marginP80Downside: marginP80Downside === null ? null : money(marginP80Downside), runwayMonthsP80: runwayMonthsP80 === null ? null : money(runwayMonthsP80) },
    delivery: { developers: team.developers ?? null, totalHours, dailyCapacity: dailyCapacity || null, calendarDaysP50, calendarDaysP80 },
    evidence: { required: requiredEvidence.length, present: requiredEvidence.filter((kind) => evidence.some((item) => item.kind === kind && item.source && item.observedAt)).length, competitors: competitors.length, benchmarks: benchmarks.length, assumptions: assumptions.length },
  };
}
