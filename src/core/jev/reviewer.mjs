// Jev: Perfect Planner's built-in judge (TypeSafe "jev-latest").
//
// Jev reviews and recommends. It never writes code, merges, or changes the
// plan, and nothing here auto-approves: every outcome other than a confident
// "approve" from an independent model goes back to the task or to the owner.
// Every review, including local pre-check rejects, budget queueing and
// provider failures, is written to the ledger as review.verdict.

import { precheckDiff } from "./precheck.mjs";

export const VERDICTS = Object.freeze(["approve", "gaps", "reject", "queued", "escalate"]);
const SEVERITY = { approve: 0, gaps: 1, reject: 2 };
const DEFAULT_ALIASES = Object.freeze({ "jev-latest": "jev-1.13.0", "jev-preview": "jev-1.13.0" });

const monthOf = (date) => date.toISOString().slice(0, 7);
const certainty = (p) => Math.abs(2 * p - 1);
const round = (n, d = 6) => Number(n.toFixed(d));
const truncate = (text, max) => {
  const s = String(text ?? "");
  return s.length > max ? { text: `${s.slice(0, max)}\n[... truncated ${s.length - max} characters ...]`, truncated: true } : { text: s, truncated: false };
};

/** Sum of Jev review costs recorded in the ledger for `month` ("YYYY-MM"). */
export function spentFromLedger(entries, month) {
  let total = 0;
  for (const e of entries) {
    if (e.type !== "review.verdict" || e.actor?.kind !== "jev" || !String(e.at).startsWith(month)) continue;
    const tag = (e.evidence ?? []).find((x) => typeof x === "string" && x.startsWith("cost:"));
    const cost = tag ? Number(tag.slice(5)) : 0;
    if (Number.isFinite(cost)) total += cost;
  }
  return total;
}

function canonicalModel(model, aliases) {
  const m = String(model ?? "").trim().toLowerCase();
  return aliases[m] ?? m;
}

/** Same model, or both in the Jev family: Jev never reviews Jev's own output. */
export function sameModel(a, b, aliases = DEFAULT_ALIASES) {
  const x = canonicalModel(a, aliases);
  const y = canonicalModel(b, aliases);
  if (!x || !y) return false;
  const jev = (m) => /^jev(?:-|$)/.test(m);
  return x === y || (jev(x) && jev(y));
}

/**
 * createJev({ ledger, provider, alternateProvider?, budget: { monthlyCap, spentThisMonth? },
 *             models: { primary = "jev-latest", alternate?, aliases? }, now?, lowConfidence = 0.6,
 *             maxStateChars = 60000, onEscalate? })
 */
export function createJev({
  ledger,
  provider,
  alternateProvider = null,
  budget = {},
  models = {},
  now = () => new Date(),
  lowConfidence = 0.6,
  maxStateChars = 60_000,
  onEscalate = null,
} = {}) {
  if (!ledger || typeof ledger.append !== "function" || typeof ledger.entries !== "function") throw new TypeError("createJev needs a ledger.");
  if (!provider || typeof provider.evaluate !== "function") throw new TypeError("createJev needs a provider with evaluate().");
  let monthlyCap = Number(budget.monthlyCap);
  if (!Number.isFinite(monthlyCap) || monthlyCap <= 0) throw new TypeError("createJev needs a positive budget.monthlyCap (USD per month).");
  const primary = models.primary ?? "jev-latest";
  const alternate = models.alternate ?? null;
  const aliases = { ...DEFAULT_ALIASES, ...(models.aliases ?? {}) };

  let month = monthOf(now());
  let spent = Number.isFinite(Number(budget.spentThisMonth)) ? Number(budget.spentThisMonth) : spentFromLedger(ledger.entries(), month);
  const queue = [];

  function rollMonth() {
    const current = monthOf(now());
    if (current !== month) {
      month = current;
      spent = spentFromLedger(ledger.entries(), month);
    }
  }

  const warnedThisMonth = () => ledger.entries().some((e) => e.type === "budget.warning" && e.subject === `jev-budget:${month}`);

  async function maybeWarn() {
    if (spent < 0.8 * monthlyCap || warnedThisMonth()) return;
    await ledger.append({
      actor: { kind: "system", id: "jev-budget" },
      type: "budget.warning",
      subject: `jev-budget:${month}`,
      summary: `Jev spend for ${month} reached ${Math.round((spent / monthlyCap) * 100)}% of the monthly cap ($${round(spent)} of $${monthlyCap}); at 100% reviews queue.`,
      reason: "Monthly Jev budget passed the 80% warning threshold.",
      evidence: [`spent:${round(spent)}`, `cap:${monthlyCap}`],
      refs: [],
    });
  }

  /** Picks the reviewing model. Returns null when no independent model is configured. */
  function pickReviewer(buildModel) {
    if (!buildModel) return null;
    if (!sameModel(primary, buildModel, aliases)) return { model: primary, provider };
    if (alternate && !sameModel(alternate, buildModel, aliases)) return { model: alternate, provider: alternateProvider ?? provider };
    return null;
  }

  async function record(phase, input, result, reason) {
    const evidence = [`phase:${phase}`, `verdict:${result.verdict}`, `model:${result.model ?? "none"}`, `cost:${round(result.cost ?? 0, 9)}`, `confidence:${result.confidence === null ? "none" : round(result.confidence, 3)}`];
    if (result.modelVerdict) evidence.push(`model-verdict:${result.modelVerdict}`);
    for (const note of result.notes.slice(0, 20)) if (note.file) evidence.push(`note:${note.rule}:${note.file}${note.line ? `:${note.line}` : ""}`);
    const summaryBits = [result.confidence === null ? null : `confidence ${round(result.confidence, 2)}`, `$${round(result.cost ?? 0, 6)}`, result.model ?? "no model call"].filter(Boolean);
    const entry = await ledger.append({
      actor: result.model ? { kind: "jev", id: "jev", model: result.model } : { kind: "jev", id: "jev" },
      type: "review.verdict",
      subject: input.task.id,
      summary: `Jev ${phase} review of ${input.task.id}: ${result.verdict} (${summaryBits.join(", ")})`,
      reason: String(reason || result.notes.map((n) => n.note).join(" ") || `Jev ${result.verdict}.`).slice(0, 1000),
      evidence,
      refs: (input.clauses ?? []).map((c) => c.ref).filter(Boolean),
    });
    const out = Object.freeze({ ...result, notes: Object.freeze(result.notes.map((n) => Object.freeze({ ...n }))), ledger: entry.n });
    if (out.verdict === "escalate" && typeof onEscalate === "function") {
      try { await onEscalate({ phase, task: input.task, result: out }); } catch { /* the ledger entry already routes it */ }
    }
    return out;
  }

  const note = (rule, text, file = null, line = null) => ({ file, line, rule, note: text });

  function validateInput(phase, input) {
    if (!input?.task?.id || typeof input.task.id !== "string") throw new TypeError(`${phase} review needs task.id.`);
    if (!Array.isArray(input.clauses)) throw new TypeError(`${phase} review needs a clauses array.`);
  }

  async function judge(phase, input, state, questions, combine, extraNotes = [], confidenceCap = 1) {
    rollMonth();
    const reviewer = pickReviewer(input.buildModel);
    if (!reviewer) {
      return record(phase, input, { verdict: "escalate", notes: [...extraNotes, note("independence", input.buildModel ? `No reviewing model independent of the building model (${input.buildModel}) is configured; the owner must review.` : "The building model was not given, so reviewer independence cannot be shown; the owner must review.")], confidence: null, model: null, cost: 0 });
    }
    const estimate = typeof reviewer.provider.estimateCost === "function" ? reviewer.provider.estimateCost({ state, questions }) : 0;
    if (spent >= monthlyCap || spent + estimate > monthlyCap) {
      queue.push({ phase, input, queuedAt: now().toISOString() });
      return record(phase, input, { verdict: "queued", notes: [...extraNotes, note("budget-cap", `Monthly Jev cap reached ($${round(spent)} of $${monthlyCap}); the review is queued until the budget allows it.`)], confidence: null, model: reviewer.model, cost: 0 });
    }
    let response;
    try {
      response = await reviewer.provider.evaluate({ model: reviewer.model, state, questions });
    } catch (error) {
      return record(phase, input, { verdict: "escalate", notes: [...extraNotes, note("provider-error", `Jev could not review (${error?.code ?? "PROVIDER_FAILED"}): ${String(error?.message ?? "").slice(0, 200)}`)], confidence: null, model: reviewer.model, cost: 0 });
    }
    const cost = Number(response.cost) || 0;
    spent += cost;
    let combined;
    try {
      combined = combine(response.answers);
      if (!(response.answers.verdict?.choice in SEVERITY) || !Number.isFinite(response.answers.verdict?.confidence)) throw new Error("verdict");
      if (combined.confidences.some((c) => !Number.isFinite(c))) throw new Error("noul");
    } catch {
      const result = await record(phase, input, { verdict: "escalate", notes: [...extraNotes, note("provider-bad-answer", "Jev's answers were incomplete or malformed; the owner must review.")], confidence: null, model: response.model ?? reviewer.model, cost }, null);
      await maybeWarn();
      return result;
    }
    const { ruleVerdict, notes, confidences } = combined;
    const choice = response.answers.verdict;
    const modelVerdict = SEVERITY[ruleVerdict] >= SEVERITY[choice.choice] ? ruleVerdict : choice.choice;
    const confidence = Math.min(confidenceCap, choice.confidence, ...confidences);
    const verdict = confidence < lowConfidence ? "escalate" : modelVerdict;
    const allNotes = [...extraNotes, ...notes];
    if (verdict === "escalate") allNotes.push(note("low-confidence", `Jev leaned "${modelVerdict}" with confidence ${round(confidence, 2)} (below ${lowConfidence}); the owner decides.`));
    const result = await record(phase, input, { verdict, notes: allNotes, confidence, model: response.model ?? reviewer.model, cost, modelVerdict }, null);
    await maybeWarn();
    return result;
  }

  async function reviewTest(input) {
    validateInput("test", input);
    const { task, clauses, testSource, preRun } = input;
    const local = [];
    if (!String(testSource ?? "").trim()) local.push(note("test-missing", "No test source was supplied."));
    if (!clauses.length) local.push(note("clauses-missing", "The task cites no clauses, so test coverage cannot be judged."));
    if (preRun && preRun.exitCode === 0) local.push(note("passes-before-work", `The test already passes on current code (\`${preRun.command ?? "test command"}\` exited 0), so it cannot show the work was done.`));
    if (local.length) return record("test", input, { verdict: "reject", notes: local, confidence: 1, model: null, cost: 0 });
    const extra = preRun ? [] : [note("fails-first-unchecked", "No fails-first run was supplied to this review; Perfect Planner must confirm the test fails on current code.")];
    const source = truncate(testSource, maxStateChars);
    const state = { task: { id: task.id, title: task.title ?? "" }, clauses: clauses.map((c) => ({ ref: c.ref, text: c.text })), testSource: source.text };
    const questions = {
      trivial: {
        type: "noul",
        instructions: "Could the test in `testSource` pass even if the behavior it is meant to check did not exist? Count tests that only assert constants, mock the code under test, swallow failures, or are skipped.",
        criteria: { true: "The test could pass without the behavior existing", false: "The test can only pass when real behavior is present" },
      },
      verdict: {
        type: "choice",
        instructions: "As an acceptance-test reviewer, judge whether the test in `testSource` is a sound done-when check for the task `task` and every clause in `clauses`.",
        criteria: {
          approve: "Meaningfully checks every cited clause and would fail without the work",
          gaps: "Meaningful, but leaves at least one cited clause unchecked",
          reject: "Trivially passing, broken, or not testing the cited clauses",
        },
      },
    };
    clauses.forEach((c, i) => {
      questions[`clause_${i}`] = {
        type: "noul",
        instructions: `Would the test in \`testSource\` fail if the behavior required by \`clauses[${i}].text\` (clause ${c.ref}) were missing or wrong?`,
        criteria: { true: "A failing assertion would catch it", false: "Nothing in the test would catch it" },
      };
    });
    return judge("test", input, state, questions, (answers) => {
      const notes = [];
      const confidences = [certainty(answers.trivial.noul)];
      let ruleVerdict = "approve";
      if (answers.trivial.noul >= 0.5) { ruleVerdict = "reject"; notes.push(note("trivial-test", `The test looks like it could pass without the behavior (p=${round(answers.trivial.noul, 2)}).`)); }
      clauses.forEach((c, i) => {
        const p = answers[`clause_${i}`].noul;
        confidences.push(certainty(p));
        if (p < 0.5) { if (ruleVerdict === "approve") ruleVerdict = "gaps"; notes.push(note("clause-unchecked", `Clause ${c.ref} does not appear to be checked by the test (p=${round(p, 2)}).`)); }
      });
      return { ruleVerdict, notes, confidences };
    }, [...extra, ...(source.truncated ? [note("truncated", "The test source was truncated for review; the owner should check the rest.")] : [])], source.truncated ? 0.5 : 1);
  }

  async function reviewDiff(input) {
    validateInput("diff", input);
    const { task, diff, testOutput, clauses, files } = input;
    const pre = precheckDiff({ diff, files });
    const local = [...pre.notes];
    if (!String(diff ?? "").trim()) local.push(note("diff-empty", "The diff is empty."));
    if (!clauses.length) local.push(note("clauses-missing", "The task cites no clauses, so coverage cannot be judged."));
    if (local.length) return record("diff", input, { verdict: "reject", notes: local, confidence: 1, model: null, cost: 0 });
    const body = truncate(diff, maxStateChars);
    const output = truncate(testOutput, 8_000);
    const state = { task: { id: task.id, title: task.title ?? "" }, clauses: clauses.map((c) => ({ ref: c.ref, text: c.text })), files, diff: body.text, testOutput: output.text };
    const questions = {
      weakens: {
        type: "noul",
        instructions: "Does the change in `diff` weaken safety: disable or bypass validation, error handling, permission or security checks, or make tests easier to pass without fixing behavior?",
        criteria: { true: "It weakens a safeguard or a test", false: "No safeguard or test is weakened" },
      },
      verdict: {
        type: "choice",
        instructions: "As a merge reviewer, judge whether the change in `diff` for task `task` correctly implements every clause in `clauses`, stays within `files`, and is safe to merge given `testOutput`.",
        criteria: {
          approve: "Implements every cited clause safely and is ready to merge",
          reject: "Misses a cited clause, is unsafe, or is not ready to merge",
        },
      },
    };
    clauses.forEach((c, i) => {
      questions[`clause_${i}`] = {
        type: "noul",
        instructions: `Does the change in \`diff\` implement the behavior required by \`clauses[${i}].text\` (clause ${c.ref})?`,
        criteria: { true: "The diff implements it", false: "The diff does not implement it" },
      };
    });
    return judge("diff", input, state, questions, (answers) => {
      const notes = [];
      const confidences = [certainty(answers.weakens.noul)];
      let ruleVerdict = "approve";
      if (answers.weakens.noul >= 0.5) { ruleVerdict = "reject"; notes.push(note("weakens-safety", `The change appears to weaken a safeguard or test (p=${round(answers.weakens.noul, 2)}).`)); }
      clauses.forEach((c, i) => {
        const p = answers[`clause_${i}`].noul;
        confidences.push(certainty(p));
        if (p < 0.5) { ruleVerdict = "reject"; notes.push(note("clause-not-implemented", `Clause ${c.ref} does not appear to be implemented (p=${round(p, 2)}).`)); }
      });
      return { ruleVerdict, notes, confidences };
    }, body.truncated ? [note("truncated", "The diff was truncated for review; Jev did not see all of it.")] : [], body.truncated ? 0.5 : 1);
  }

  /** Re-runs queued reviews in order while the budget allows. Returns the new results. */
  async function retryQueued() {
    rollMonth();
    const results = [];
    while (queue.length && spent < monthlyCap) {
      const item = queue.shift();
      const result = item.phase === "test" ? await reviewTest(item.input) : await reviewDiff(item.input);
      results.push(result);
      if (result.verdict === "queued") { queue.unshift(queue.pop()); break; }
    }
    return results;
  }

  return Object.freeze({
    reviewTest,
    reviewDiff,
    retryQueued,
    pending: () => queue.map((q) => ({ phase: q.phase, task: q.input.task.id, queuedAt: q.queuedAt })),
    budget: () => { rollMonth(); return { month, spent: round(spent, 9), monthlyCap, ratio: spent / monthlyCap }; },
    setBudget: ({ monthlyCap: cap }) => {
      const n = Number(cap);
      if (!Number.isFinite(n) || n <= 0) throw new TypeError("monthlyCap must be positive.");
      monthlyCap = n;
    },
  });
}
