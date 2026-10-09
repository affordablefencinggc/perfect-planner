// Plan approval in the strict ledger's encoding (core/ledger rules.mjs, replay.mjs).
//
// planApprovalEntries({ plan, markdown, previous?, actor, title? }) is pure: it numbers
// the plan with numberPlan() and returns the append() inputs, in order:
//   clause.added      subject "P-1 §2", summary = clause text, data { text, kind }
//   clause.changed    subject "P-2 §2", summary = new text,    data { text, kind, oldText }
//   clause.withdrawn  subject "P-2 §3", summary "Withdrawn: <old text>", data { oldText }
//   plan.approved     subject "P-1",    summary = title,       data { title, clauses }
// A new plan version (P-2) inherits the earlier version's clauses in the ledger, so
// only its changes are written; pass the earlier numbered clauses as `previous`.
// The ledger accepts plan and clause entries from a person only.
//
// approvePlan(ledger, options) appends those entries one by one and returns
// { plan, clauses, changes, entries }.
import { numberPlan } from "./numbering.mjs";

const PLAN_ID = /^P-[1-9]\d*$/;

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function planApprovalEntries({ plan, markdown, previous, actor, title } = {}) {
  if (typeof plan !== "string" || !PLAN_ID.test(plan)) throw new TypeError(`plan must be a plan id such as P-1; got ${String(plan)}`);
  if (!actor || typeof actor !== "object") throw new TypeError("actor is required (the owner who approves the plan)");
  const numbered = numberPlan(markdown, previous);
  const inputs = [];
  for (const change of numbered.changes) {
    const clause = numbered.clauses.find((item) => item.id === change.clause) ?? null;
    const subject = `${plan} ${change.clause}`;
    if (change.type === "clause.added") {
      inputs.push({ actor, type: "clause.added", subject, summary: oneLine(change.newText), data: { text: change.newText, kind: clause?.kind ?? null } });
    } else if (change.type === "clause.changed") {
      inputs.push({ actor, type: "clause.changed", subject, summary: oneLine(change.newText), data: { text: change.newText, kind: clause?.kind ?? null, oldText: change.oldText } });
    } else if (change.type === "clause.withdrawn") {
      inputs.push({ actor, type: "clause.withdrawn", subject, summary: oneLine(`Withdrawn: ${change.oldText}`), data: { oldText: change.oldText } });
    }
  }
  const active = numbered.clauses.filter((clause) => clause.status !== "withdrawn").length;
  const planTitle = oneLine(title) || `Plan ${plan} approved with ${active} clauses`;
  inputs.push({ actor, type: "plan.approved", subject: plan, summary: planTitle, data: { title: planTitle, clauses: active } });
  return { plan, clauses: numbered.clauses, changes: numbered.changes, inputs };
}

export async function approvePlan(ledger, options = {}) {
  if (!ledger || typeof ledger.append !== "function") throw new TypeError("approvePlan needs a ledger with append()");
  const { plan, clauses, changes, inputs } = planApprovalEntries(options);
  const entries = [];
  for (const input of inputs) entries.push(await ledger.append(input));
  return { plan, clauses, changes, entries };
}
