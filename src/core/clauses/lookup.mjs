// lookup(ref, { entries, plans }) -> { ref, text, history, citedBy } or null.
// Pure: entries are ledger entries in order; plans is { "P-2": { clauses: [...] } }.

import { canonicalRef, parseRef } from "./refs.mjs";

function planNumber(planId) {
  const parsed = parseRef(planId);
  return parsed && parsed.kind === "plan" ? Number(planId.slice(2)) : 0;
}

// The plan to read a clause from: the named plan, or else the latest plan that has it.
function resolveClause(parsed, plans) {
  const planIds = parsed.plan
    ? [parsed.plan]
    : Object.keys(plans ?? {}).sort((a, b) => planNumber(b) - planNumber(a));
  for (const planId of planIds) {
    const clauses = plans?.[planId]?.clauses;
    if (!Array.isArray(clauses)) continue;
    const found = clauses.find((clause) => clause && clause.id === parsed.clause);
    if (found) return { planId, text: found.text ?? null };
  }
  return { planId: parsed.plan ?? null, text: null };
}

function entryRefs(entry) {
  return Array.isArray(entry?.refs) ? entry.refs : [];
}

// Does a parsed reference (from an entry's refs or subject) point at the target?
function pointsAt(parsed, target) {
  if (!parsed) return false;
  if (target.kind === "clause") {
    // A bare clause matches the same clause number in any plan.
    return (parsed.kind === "clause" || parsed.kind === "plan-clause") && parsed.clause === target.clause;
  }
  if (target.kind === "plan-clause") {
    return parsed.kind === "plan-clause" && parsed.plan === target.plan && parsed.clause === target.clause;
  }
  if (target.kind === "plan") {
    return (parsed.kind === "plan" && parsed.id === target.id) || (parsed.kind === "plan-clause" && parsed.plan === target.id);
  }
  if (target.kind === "entry") return parsed.kind === "entry" && parsed.id === target.id;
  return parsed.id === target.id;
}

function subjectRef(entry) {
  return parseRef(entry?.subject);
}

function citesTarget(entry, target) {
  return entryRefs(entry).some((ref) => pointsAt(parseRef(ref), target));
}

function isClauseHistory(entry, target) {
  return typeof entry?.type === "string"
    && entry.type.startsWith("clause.")
    && (citesTarget(entry, target) || pointsAt(subjectRef(entry), target));
}

function isSubjectHistory(entry, target) {
  if (target.kind === "entry") return parseRef(entry?.n)?.id === target.id;
  if (target.kind === "clause" || target.kind === "plan-clause") return false;
  const subject = subjectRef(entry);
  return subject !== null && subject.id === target.id;
}

function textFor(target, entries, plans, resolved) {
  if (target.kind === "clause" || target.kind === "plan-clause") return resolved.text;
  if (target.kind === "plan") {
    const plan = plans?.[target.id];
    if (plan && typeof plan.text === "string") return plan.text;
  }
  const first = entries.find((entry) => (target.kind === "entry" ? parseRef(entry?.n)?.id === target.id : subjectRef(entry)?.id === target.id));
  return first && typeof first.summary === "string" ? first.summary : null;
}

export function lookup(ref, { entries = [], plans = {} } = {}) {
  const target = parseRef(ref);
  if (!target) return null;
  const list = Array.isArray(entries) ? entries : [];
  const planMap = plans ?? {};
  const resolved = target.kind === "clause" || target.kind === "plan-clause"
    ? resolveClause(target, planMap)
    : { planId: null, text: null };
  const isClause = target.kind === "clause" || target.kind === "plan-clause";

  const history = [];
  const citedBy = [];
  for (const entry of list) {
    const inHistory = isClause ? isClauseHistory(entry, target) : isSubjectHistory(entry, target);
    if (inHistory) {
      history.push(entry);
      continue;
    }
    if (isClause && typeof entry?.type === "string" && entry.type.startsWith("clause.")) continue;
    if (citesTarget(entry, target)) citedBy.push(entry);
  }

  return {
    ref: canonicalRef(target),
    text: textFor(target, list, planMap, resolved),
    history,
    citedBy,
  };
}
