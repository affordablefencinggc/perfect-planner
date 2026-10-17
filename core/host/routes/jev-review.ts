// The Tasks screen's two Jev reviews (spec 6.2 and 6.3), in the route layer only. Once a Jev key is saved
// the gate waits for Jev's verdict on each task's test; before this file nothing ever asked, so every task
// stayed locked. Here the Tasks routes ask, record the verdict on the ledger as the gate expects, and show
// Jev's reasons in plain words.
//
// Rules this file keeps (and tests attack):
// - Jev is a required reviewer, never a replacement: it can refuse, it cannot approve for the person.
// - Fail closed: no key, a wrong key, an outage, a timeout, a garbled reply, an unlisted choice, a spent
//   monthly budget, a diff or test too long to read in full, or a builder whose model is not known all leave
//   the work refused. Nothing is approved and nothing is skipped silently; the person is told why in plain
//   words and can ask again.
// - What the worker wrote is data. It is redacted for secrets before it leaves (core/jev), sits only in
//   `state` beside a fixed data-only instruction, and no verdict is read from free text.
import fs from "node:fs";
import path from "node:path";
import type { GateState } from "../../gate/index";
import { pinTestFiles } from "../../gate/gate";
import { REVIEW_POLICY, type LineNote, type ReviewResult } from "../../jev/index";
import { isAuthoritative, type Actor, type LedgerEntry } from "../../ledger/index";
import { lookup } from "../../lookup/index";
import type { TaskView } from "../../mcp/index";
import { redactSecrets } from "../../secrets/index";
import { evidenceValue, git } from "../../worktrees/index";
import type { CoreProject } from "../project";
import { HttpError } from "../router";
import { jevReviewerFor } from "./decisions";

/** Where a review stands, in words a person acts on. */
export type JevState =
  /** Jev read it and found nothing wrong. */
  | "approved"
  /** Jev found gaps (test) or problems (change). */
  | "gaps"
  /** Jev answered but is not sure enough for its answer to count. */
  | "unsure"
  /** Jev cannot judge this at all (builder's model unknown, too long to read in full). Asking again will not help. */
  | "cannot-review"
  /** No answer: no key, wrong key, outage, timeout, an answer Perfect Planner cannot use. */
  | "unavailable"
  /** The monthly budget is used up; the review waits for the person to raise it. */
  | "queued"
  /** Not asked yet. */
  | "waiting";

export interface JevLine {
  state: JevState;
  /** One or two plain sentences for the Tasks screen. */
  message: string;
  /** Jev's own reasons, or the fixed checks' notes, one per line. */
  reasons: string[];
  /** Asking again can change the outcome. */
  canRetry: boolean;
  entry?: string;
  /** What this call cost, in dollars (reported by Jev, else the estimate). */
  cost?: number;
}

export interface JevView {
  /** A Jev key is saved, so the gate waits for Jev's review of each test. */
  required: boolean;
  test: JevLine | null;
  diff: JevLine | null;
}

const MAX_REASONS = 8;
const MAX_REASON = 400;

// ---------- reading the ledger ----------

/** A review that Perfect Planner itself signed for Jev's job (never an entry that merely names Jev). */
function isReview(entry: LedgerEntry, label: string, kind: "test" | "diff"): boolean {
  return entry.type === "review.verdict" && entry.subject === label && entry.actor.kind === "system" && isAuthoritative(entry) && entry.data?.policy === REVIEW_POLICY && entry.data?.review === kind;
}

/** The newest signed review of this kind after `after` (a ledger number), optionally at one commit. */
function latestReview(entries: readonly LedgerEntry[], label: string, kind: "test" | "diff", options: { after?: string; commit?: string } = {}): LedgerEntry | undefined {
  const start = options.after ? entries.findIndex((e) => e.n === options.after) : -1;
  for (let i = entries.length - 1; i > start; i--) {
    const entry = entries[i]!;
    if (!isReview(entry, label, kind)) continue;
    if (options.commit && (evidenceValue(entry, "commit") ?? String(entry.data?.commit ?? "")).toLowerCase() !== options.commit.toLowerCase()) continue;
    return entry;
  }
  return undefined;
}

/** Plain words: no section numbers, no secrets, bounded. */
function plain(text: string): string {
  return redactSecrets(text).replace(/\s*\(§[\d.]+\)/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
}

function noteStrings(notes: unknown): string[] {
  if (!Array.isArray(notes)) return [];
  return notes
    .map((n) => {
      if (typeof n === "string") return n;
      const note = n as Partial<LineNote> | null;
      return note && typeof note.note === "string" ? `${note.file ?? "A file"}${note.line ? ` line ${note.line}` : ""}: ${note.note}` : "";
    })
    .map(plain)
    .filter(Boolean)
    .slice(0, MAX_REASONS);
}

function unavailableMessage(problem: unknown, reason: string): string {
  const found = /\b(?:answered|status)\s+(\d{3})\b|\((\d{3})\)/.exec(reason);
  const status = Number(found?.[1] ?? found?.[2] ?? 0);
  if (problem === "no_key") return "No Jev key is saved, so Jev cannot review this. Jev's review is only required while a key is saved in Settings.";
  if (problem === "malformed") return "Jev sent back an answer Perfect Planner could not use, so nothing was approved.";
  if (status === 401 || status === 403) return "TypeSafe did not accept the saved Jev key, so nothing was approved. Check the key in Settings.";
  if (status === 429) return "Jev is busy right now, so nothing was approved.";
  if (status >= 500) return "Jev had a problem on its side, so nothing was approved.";
  return "Jev could not be reached, or took too long to answer, so nothing was approved.";
}

/** One signed review entry, in words for the screen. The same path serves a fresh answer and a page reload. */
export function lineFromEntry(entry: LedgerEntry, kind: "test" | "diff"): JevLine {
  const d = entry.data ?? {};
  const verdict = String(d.verdict ?? "");
  const reason = plain(entry.reason ?? "");
  const what = kind === "test" ? "test" : "change";
  const cost = typeof d.cost === "number" && Number.isFinite(d.cost) ? d.cost : undefined;
  const base = { entry: entry.n, ...(cost !== undefined ? { cost } : {}) };
  switch (verdict) {
    case "approve":
      return { ...base, state: "approved", message: kind === "test" ? "Jev read the test and found no gaps." : "Jev read the change and found no problems.", reasons: [], canRetry: false };
    case "reject": {
      const notes = noteStrings(d.notes);
      return {
        ...base,
        state: "gaps",
        message: kind === "test" ? "Jev found gaps in the test. The worker needs to write a better test before work can start." : "Jev sent the change back to the worker.",
        reasons: notes.length ? notes : reason ? [reason] : [],
        canRetry: false,
      };
    }
    case "escalate": {
      if (/^Not independent/i.test(reason)) return { ...base, state: "cannot-review", message: `Jev cannot review this ${what}, because it cannot show the work was built by a different model. Name the worker's model when you start it${kind === "test" ? ", or write the test yourself" : ""}. Nothing was approved.`, reasons: [reason.replace(/^Not independent:\s*/i, "")], canRetry: false };
      if (/longer than Jev reads/i.test(reason)) return { ...base, state: "cannot-review", message: `This ${what} is too long for Jev to read in full, so Jev will not approve it. Nothing was approved.`, reasons: [reason], canRetry: false };
      return { ...base, state: "unsure", message: `Jev is not sure about this ${what}, so its answer does not count. Nothing was approved.`, reasons: reason ? [reason] : [], canRetry: true };
    }
    case "unavailable":
      // The technical detail stays on the ledger entry; the screen gets the plain message.
      return { ...base, state: "unavailable", message: unavailableMessage(d.problem, reason), reasons: [], canRetry: true };
    default:
      return { ...base, state: "unavailable", message: "Jev's answer was not one Perfect Planner recognises, so nothing was approved.", reasons: [], canRetry: true };
  }
}

const QUEUED: JevLine = {
  state: "queued",
  message: "Jev's monthly budget is used up, so this review is waiting and nothing was approved. Raise the monthly budget in Settings, then ask again.",
  reasons: [],
  canRetry: true,
};

// ---------- the view ----------

/** Jev's part of a task card. No network: it only reads the ledger and the gate's state. */
export function jevView(entries: readonly LedgerEntry[], label: string, gate: GateState, required: boolean): JevView | null {
  let test: JevLine | null = null;
  const definition = gate.definition;
  if (definition) {
    if (gate.jev?.verdict === "approve") test = { state: "approved", message: "Jev read the test and found no gaps.", reasons: [], canRetry: false, entry: gate.jev.n };
    else if (gate.jev?.verdict === "gaps") {
      test = { state: "gaps", message: "Jev found gaps in the test. The worker needs to write a better test before work can start.", reasons: gate.jev.gaps.map(plain).slice(0, MAX_REASONS), canRetry: false, entry: gate.jev.n };
    } else {
      const last = latestReview(entries, label, "test", { after: definition.n });
      const ready = Boolean(gate.approval && gate.baseline && !gate.baseline.passed);
      if (last) {
        const line = lineFromEntry(last, "test");
        test = { ...line, canRetry: line.canRetry && ready };
      } else if (required) {
        test = {
          state: "waiting",
          message: ready ? "Jev has not reviewed this test yet. The worker cannot start until it has." : "Jev reviews the test once you approve it and it fails on today's code.",
          reasons: [],
          canRetry: ready,
        };
      }
    }
  }
  let diff: JevLine | null = null;
  const commit = gate.worktree?.passed ? gate.worktree.commit : undefined;
  if (commit) {
    const last = latestReview(entries, label, "diff", { commit });
    if (last) diff = lineFromEntry(last, "diff");
    else if (required) diff = { state: "waiting", message: "Jev reads the change when you press Approve diff, and you sign after it.", reasons: [], canRetry: false };
  }
  return required || test || diff ? { required, test, diff } : null;
}

// ---------- asking Jev ----------

const inFlight = new Set<string>();

/** One review of a kind per task at a time: a double click must not pay Jev twice. */
async function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) throw new HttpError(409, "JEV_BUSY", "Jev is already reading this. Wait for it to finish, then look at the screen again.");
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}

/** The plan's text for each clause the task cites, from signed entries only. */
function clausesFor(project: CoreProject, task: TaskView): { ref: string; text: string }[] {
  const signed = project.entries().filter((e) => isAuthoritative(e));
  return task.clauses.map((ref) => ({ ref, text: lookup(signed, ref).text ?? "(the plan text for this clause could not be found)" }));
}

/**
 * The text of the approved test files, as they are in the worktree now. Links, folders and anything that
 * resolves outside the worktree are never read (a test file that is a link to a private file would otherwise
 * be sent to a third party). Null when nothing could be read.
 */
export function readTestSource(root: string, files: readonly string[]): string | null {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const rel of files) {
    try {
      const file = path.resolve(root, rel);
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      const real = fs.realpathSync(file);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
      // Past the review limit the reviewer refuses to approve, so the first 40,000 bytes are enough to tell.
      const fd = fs.openSync(real, "r");
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, 40_000));
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        parts.push(`// file: ${rel}\n${buffer.toString("utf8")}${stat.size > buffer.length ? "\n// (the rest of the file is longer than Jev reads)" : ""}`);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
  }
  return parts.length ? parts.join("\n\n") : null;
}

function modelOf(project: CoreProject, entryN: string | undefined): string {
  const entry = entryN ? project.ledger.get(entryN) : undefined;
  return typeof entry?.data?.jevModel === "string" ? entry.data.jevModel : "jev-latest";
}

/**
 * Jev reviews the approved test (spec 6.2), after the person approved it and Perfect Planner saw it fail on
 * today's code. The verdict is recorded as the gate expects (scope:test, the definition it read), so only an
 * approval lets work start. Never throws for Jev's own failures: they come back as a line that keeps the task
 * refused. `failsFirst` is a fact the caller verified, not an assumption.
 */
export async function reviewTestWithJev(project: CoreProject, task: TaskView, label: string, state: GateState, worktree: string): Promise<JevLine> {
  return once(`${project.key}:${label}:test`, async () => {
    const definition = state.definition;
    if (!definition) return { state: "waiting", message: "There is no test for Jev to read yet.", reasons: [], canRetry: false };
    // Already approved for this exact test: asking again would only cost money.
    if (state.jev?.verdict === "approve") return { state: "approved", message: "Jev read the test and found no gaps.", reasons: [], canRetry: false, entry: state.jev.n };
    const files = Object.keys(state.approval?.pins ?? {});
    // Jev must read the test exactly as the person approved it.
    const now = pinTestFiles(worktree, files);
    if (!files.length || files.some((file) => now[file] !== state.approval!.pins[file])) {
      return { state: "cannot-review", message: "The test files changed after you approved them, so Jev was not asked and nothing was approved. Restore them, or ask the worker to propose the test again.", reasons: [], canRetry: false };
    }
    const source = readTestSource(worktree, files);
    if (source === null) return { state: "unavailable", message: "Perfect Planner could not read the test files to show Jev, so nothing was approved.", reasons: [], canRetry: true };
    // A person's own test counts as built by a human; an agent's model is whatever the person set when dispatching it.
    const author: Actor = definition.actor.kind === "person" ? { ...definition.actor, model: "human" } : definition.actor;
    const reviewer = jevReviewerFor(project);
    const result: ReviewResult = await reviewer.reviewTest({
      task: label,
      title: task.title,
      clauses: clausesFor(project, task),
      test: { command: definition.command, source },
      failsFirst: true,
      author,
      definition: definition.n,
    });
    return lineOf(project, result, "test");
  });
}

/** The diff as the screen shows it, Jev's job (spec 6.3). Nothing here approves; the person signs after. */
export async function reviewDiffWithJev(
  project: CoreProject,
  task: TaskView,
  label: string,
  input: { worktree: string; baseSha: string; commit: string; state: GateState },
): Promise<{ line: JevLine }> {
  return once(`${project.key}:${label}:diff`, async () => {
    const entries = project.entries();
    // Already approved at exactly this commit (a commit is its content): asking again would only cost money.
    const prior = latestReview(entries, label, "diff", { commit: input.commit });
    if (prior?.data?.verdict === "approve") return { line: lineFromEntry(prior, "diff") };
    const text = await git(input.worktree, ["diff", "--no-color", "--no-renames", input.baseSha, input.commit]);
    const owner = task.owner;
    let author: Actor = { kind: "agent", id: owner ?? "unknown", model: "unknown" };
    for (let i = entries.length - 1; owner && i >= 0; i--) {
      const actor = entries[i]!.actor;
      if (actor.kind === "agent" && actor.id === owner) {
        author = { kind: "agent", id: actor.id, model: actor.model ?? "unknown" };
        break;
      }
    }
    const run = input.state.worktree;
    const ranTest = run?.commit?.toLowerCase() === input.commit.toLowerCase() && run.passed;
    const result = await jevReviewerFor(project).reviewDiff({
      task: label,
      clauses: clausesFor(project, task),
      diff: text,
      // The run's own output is not kept; what Jev gets is the fact Perfect Planner recorded, never the worker's say-so.
      testOutput: ranTest ? `Perfect Planner ran the approved test (${input.state.definition?.command ?? "unknown command"}) in the task's worktree at ${input.commit}. It passed.` : "The approved test has not passed at this commit.",
      allowedFiles: [],
      author,
      attempt: task.attempt,
      commit: input.commit,
    });
    return { line: lineOf(project, result, "diff") };
  });
}

function lineOf(project: CoreProject, result: ReviewResult, kind: "test" | "diff"): JevLine {
  if (result.verdict === "queued" || !result.entry) return QUEUED;
  const entry = project.ledger.get(result.entry);
  return entry ? lineFromEntry(entry, kind) : QUEUED;
}

/** Jev's notes for a send-back, as plain sentences the worker can act on. */
export function sendBackNotes(line: JevLine): string[] {
  return line.reasons.length ? line.reasons : [line.message];
}

export function jevActor(project: CoreProject, line: JevLine): Actor {
  return { kind: "jev", id: "jev", model: modelOf(project, line.entry) };
}

/** True when a signed Jev review approved exactly this commit's change. */
export function jevApprovedDiff(entries: readonly LedgerEntry[], label: string, commit: string): boolean {
  const last = latestReview(entries, label, "diff", { commit });
  return last !== undefined && last.data?.verdict === "approve";
}
