// Task contracts: the "contract ledger". Planning gives every task the plain
// sentences it must meet, the files it may change, the test that proves it and a
// size cap; it is broken into tiny pieces and told to do only that. Plan approval
// signs each contract inside the plan digest, dispatch claims its files, and the
// gate (core/gate/contract.ts) measures the finished work against it. A task can
// only be widened by a person's own signed decision; a worker can only ask.
//
//   draft (guessed from the repo and the task's words)  ->  RoadmapTask.contract
//   plan.approved   data.contracts = { digest, tasks: { key: digest }, accepted: [flagged keys] }
//   task.created    data.contract, data.contractDigest, data.contractFlags     (written right after)
//   decision.made   data.contract = { op: "widened", task, files }             (the person only)
//
// Everything below is a replay of the ledger, trusting only entries a person or
// the system signed: nothing in a payload counts as authority by itself.
import { createHash } from "node:crypto";
import { isDependencyPath, isProtectedPath, isTestLike, normalizePattern, pathCovered, patternProblem } from "../gate/contractPaths";
import { isAuthoritative, type Actor, type Ledger, type LedgerEntry } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import type { RepoIndex } from "./repo";
import type { ContractFlag, SizeCap, TaskContract } from "./types";

/** Small on purpose: tasks are broken into tiny pieces. */
export const DEFAULT_SIZE_CAP: SizeCap = { maxFiles: 5, maxLines: 150 };
/** More clauses than this and the task is doing too many things at once. */
export const MAX_CLAUSES = 8;
const MAX_STORED_CLAUSES = 30;
const MAX_CLAUSE_LENGTH = 300;
const MAX_DONE_WHEN = 800;
export const MAX_LISTED_FILES = 40;
const MAX_CAP_FILES = 50;
const MAX_CAP_LINES = 2000;

/** `data.contract.op` of the person's decision that adds files to one task's contract. */
export const WIDENED_OP = "widened";

export class ContractError extends Error {
  constructor(
    readonly code: "NOT_PERSON" | "UNKNOWN_TASK" | "NO_CONTRACT" | "UNSIGNED" | "BAD_FILES" | "EMPTY",
    message: string,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((k) => record[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---------- shape, digest ----------

export type NormalizedContract = { ok: true; contract: TaskContract } | { ok: false; problem: string };

/** Checks a contract read from anywhere and returns its canonical form (trimmed, files cleaned and sorted), or why it is not one. */
export function normalizeContract(raw: unknown): NormalizedContract {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "the contract is missing" };
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.clauses) || c.clauses.length === 0 || c.clauses.length > MAX_STORED_CLAUSES) return { ok: false, problem: "the contract needs between 1 and 30 clauses" };
  const clauses = c.clauses.map((x) => (typeof x === "string" ? oneLine(x, MAX_CLAUSE_LENGTH) : ""));
  if (clauses.some((x) => !x)) return { ok: false, problem: "every clause must be a sentence" };
  if (!Array.isArray(c.allowedFiles) || c.allowedFiles.length > MAX_LISTED_FILES) return { ok: false, problem: `the contract can list at most ${MAX_LISTED_FILES} files` };
  const files: string[] = [];
  for (const file of c.allowedFiles) {
    const problem = typeof file === "string" ? patternProblem(file) : "A file path must be text.";
    if (problem) return { ok: false, problem: `${typeof file === "string" ? file : "a file"}: ${problem}` };
    files.push(normalizePattern(file as string));
  }
  const doneWhen = typeof c.doneWhen === "string" ? oneLine(c.doneWhen, MAX_DONE_WHEN) : "";
  if (!doneWhen) return { ok: false, problem: "the contract needs a done-when test or check" };
  const cap = c.sizeCap === undefined ? DEFAULT_SIZE_CAP : (c.sizeCap as Partial<SizeCap> | null);
  const maxFiles = cap?.maxFiles;
  const maxLines = cap?.maxLines;
  if (!Number.isInteger(maxFiles) || !Number.isInteger(maxLines) || maxFiles! < 1 || maxLines! < 1 || maxFiles! > MAX_CAP_FILES || maxLines! > MAX_CAP_LINES) {
    return { ok: false, problem: `the size cap must be whole numbers: 1 to ${MAX_CAP_FILES} files and 1 to ${MAX_CAP_LINES} lines` };
  }
  return { ok: true, contract: { clauses, allowedFiles: [...new Set(files)].sort(), doneWhen, sizeCap: { maxFiles: maxFiles!, maxLines: maxLines! } } };
}

/** sha256 of the contract's canonical form: any edit to a clause, a file, the test or the cap changes it. */
export function contractDigest(contract: TaskContract): string {
  const normalized = normalizeContract(contract);
  return createHash("sha256").update(stable(normalized.ok ? normalized.contract : { invalid: stable(contract) })).digest("hex");
}

/** One digest over every task's digest, by task key: what plan.approved signs. */
export function contractsDigest(tasks: Readonly<Record<string, string>>): string {
  return createHash("sha256").update(Object.keys(tasks).sort().map((key) => `${key}=${tasks[key]}`).join("\n")).digest("hex");
}

// ---------- flags ----------

const FLAG_NO_FILES =
  "No files are named for this task, so a worker could not change anything without asking. Split this into smaller tasks that each name their files, or approve it knowing the worker must ask you before it touches any file.";

/**
 * Reasons the person must look at this contract before approving. With a repo, also counts the files the
 * list already covers; `related` is how many files the guess found but could not list.
 */
export function contractFlags(contract: TaskContract, repo?: RepoIndex, related = 0): ContractFlag[] {
  const flags: ContractFlag[] = [];
  const cap = contract.sizeCap;
  if (contract.allowedFiles.length === 0) flags.push({ code: "NO_FILES", message: FLAG_NO_FILES });
  const covered = repo ? repo.files.filter((file) => contract.allowedFiles.some((p) => pathCovered(p, file))).length : 0;
  if (covered > cap.maxFiles || related > 0) {
    const count = Math.max(covered, related);
    flags.push({
      code: "TOO_MANY_FILES",
      message: `${count} files in your repo look like part of this task, but one task may change at most ${cap.maxFiles} files. Split this task into smaller ones, or approve it knowing the worker must stay inside that limit.`,
    });
  }
  if (contract.clauses.length > MAX_CLAUSES) {
    flags.push({ code: "TOO_MANY_CLAUSES", message: `This task has ${contract.clauses.length} things to do (the most for one task is ${MAX_CLAUSES}). Split it into smaller tasks.` });
  }
  return flags;
}

// ---------- guessing the files ----------

const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "py", "rb", "go", "rs", "java", "kt", "swift", "cs", "php", "dart", "css", "scss", "html", "sql"]);
const STOP = new Set(["the", "and", "for", "with", "from", "your", "into", "that", "this", "its", "up", "set", "setup", "build", "integrate", "integration", "mitigate", "screen", "page", "view", "component", "of", "to", "in", "on", "a", "an", "or", "app", "new", "first"]);

function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);
}

function extensionOf(file: string): string {
  const base = file.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function slugOf(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || "task";
}

/** The top-level folder that holds most of the repo's code; "src" when the repo has none yet. */
function codeFolder(code: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const file of code) {
    const parts = file.split("/");
    if (parts.length > 1 && !parts[0]!.startsWith(".")) counts.set(parts[0]!, (counts.get(parts[0]!) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return best?.[0] ?? "src";
}

/** What kind of task a contract is for; it picks the clause sentences. */
export interface ContractSpec {
  kind: "component" | "screen" | "data" | "integration" | "risk" | "release";
  label: string;
  /** The labels of its sub-parts, when the mind map has any. */
  parts: string[];
  note?: string;
  doneWhen: string;
}

function clausesFor(spec: ContractSpec): string[] {
  const { kind, label, parts, note } = spec;
  const out: string[] = [];
  switch (kind) {
    case "component":
      out.push(`Build ${label} so that it starts and does its one job.`);
      if (parts.length) out.push(`Wire in its parts: ${parts.join(", ")}.`);
      break;
    case "screen":
      out.push(`Show the ${label} and make its main action work.`);
      break;
    case "data":
      out.push(`Set up ${label} so that a record can be written and read back unchanged.`);
      break;
    case "integration":
      out.push(`Connect to ${label}, handling both success and failure.`);
      break;
    case "risk":
      out.push(`Reduce this risk: ${label}${note ? ` (${note})` : ""}. Prove with a test that the mitigation holds.`);
      break;
    case "release":
      out.push("Cut the first release once every other task is done and the tests pass on a clean checkout.");
      break;
  }
  out.push("Change only the files this contract lists; ask the owner before touching anything else.");
  return out.map((c) => oneLine(c, MAX_CLAUSE_LENGTH));
}

/**
 * The first draft of a task's contract. Files are guessed from the repo's file list and the task's own
 * words: files whose names match the task's words (best matches first, leaving room for its test); when
 * nothing matches, a new folder named after the task beside the repo's other code. The release task gets the
 * changelog. A guess is only a start: the person reads it at plan approval, and a worker that needs another
 * file asks the owner, who widens the contract.
 */
export function draftContract(spec: ContractSpec, repo?: RepoIndex, cap: SizeCap = DEFAULT_SIZE_CAP): { contract: TaskContract; flags: ContractFlag[] } {
  const clauses = clausesFor(spec);
  const make = (allowedFiles: string[], related = 0) => {
    const contract: TaskContract = { clauses, allowedFiles: [...new Set(allowedFiles.map(normalizePattern))].sort(), doneWhen: oneLine(spec.doneWhen, MAX_DONE_WHEN), sizeCap: { ...cap } };
    return { contract, flags: contractFlags(contract, repo, related) };
  };
  if (spec.kind === "release") return make(["CHANGELOG.md", "docs/release/**"]);

  const code = (repo?.files ?? []).filter((file) => CODE_EXTENSIONS.has(extensionOf(file)) && !isTestLike(file) && !isDependencyPath(file) && !isProtectedPath(file));
  const tokens = [...new Set(wordsOf(spec.label).filter((w) => w.length >= 2 && !STOP.has(w)))];
  const limit = Math.max(1, cap.maxFiles - 1);
  if (tokens.length && code.length) {
    const scored = code
      .map((file) => {
        const parts = file.split("/");
        const stem = wordsOf((parts.pop() ?? "").replace(/\.[^.]+$/, ""));
        const dirs = parts.flatMap(wordsOf);
        return { file, score: tokens.reduce((sum, t) => sum + (stem.includes(t) ? 3 : dirs.includes(t) ? 1 : 0), 0) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1));
    if (scored.length) {
      const tier = scored.filter((s) => s.score >= Math.ceil(scored[0]!.score / 2));
      return make(tier.slice(0, limit).map((s) => s.file), tier.length > limit ? tier.length : 0);
    }
  }
  return make([`${codeFolder(code)}/${slugOf(spec.label)}/**`]);
}

// ---------- what the ledger says ----------

const TASK_BASE = /^(T-\d+)(?:\.a\d+)?$/;

export function baseTaskId(taskId: string): string {
  return TASK_BASE.exec(taskId)?.[1] ?? taskId;
}

/** A person's own entry the ledger verified. */
const byPerson = (entry: LedgerEntry): boolean => isAuthoritative(entry, { personOnly: true });

export interface Widening {
  entry: string;
  decision: string;
  by: string;
  at: string;
  files: string[];
  reason?: string;
  question?: string;
}

export interface ContractView {
  /** The task the contract belongs to (T-n; every attempt shares it). */
  task: string;
  /** "signed": the contract matches what plan approval signed. "unsigned": it does not, and nothing may be checked against it. */
  status: "signed" | "unsigned";
  problem?: string;
  /** The plan version that signed it (P-n), for planning tasks. */
  plan?: string;
  contract: TaskContract;
  digest: string;
  flags: ContractFlag[];
  /** The person accepted these flags when they approved the plan. */
  flagsAccepted: boolean;
  widened: Widening[];
  /** The signed list plus every widening: what the task may change. */
  allowedFiles: string[];
}

function widenings(entries: readonly LedgerEntry[], task: string): Widening[] {
  const out: Widening[] = [];
  for (const e of entries) {
    if (e.type !== "decision.made" || !byPerson(e)) continue;
    const c = e.data?.contract as { op?: unknown; task?: unknown; files?: unknown; question?: unknown } | undefined;
    if (!c || typeof c !== "object" || c.op !== WIDENED_OP || c.task !== task || !Array.isArray(c.files)) continue;
    const files = c.files.filter((f): f is string => typeof f === "string" && patternProblem(f) === null).map(normalizePattern);
    if (!files.length) continue;
    out.push({
      entry: e.n,
      decision: e.subject,
      by: e.actor.id,
      at: e.at,
      files,
      ...(e.reason ? { reason: e.reason } : {}),
      ...(typeof c.question === "string" ? { question: c.question } : {}),
    });
  }
  return out;
}

/** The plan approval before position `index` that signed task `key`'s contract digest, if any. */
function signingPlan(entries: readonly LedgerEntry[], index: number, key: string): { plan: string; digest: string; accepted: boolean } | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.type !== "plan.approved" || !byPerson(e)) continue;
    const signed = e.data?.contracts as { tasks?: Record<string, unknown>; accepted?: unknown } | undefined;
    const digest = signed?.tasks?.[key];
    if (typeof digest !== "string") continue;
    return { plan: e.subject, digest, accepted: Array.isArray(signed?.accepted) && signed.accepted.includes(key) };
  }
  return undefined;
}

/**
 * The contract in force for a task, or null when the task has none (a task added by hand, or one from
 * before contracts). A planning task's contract counts as signed only when its digest is the one the
 * plan approval just before it signed for that task key; anything else is "unsigned" and the host refuses
 * to dispatch or check against it. Widenings are person-signed decisions only.
 */
export function contractOf(entries: readonly LedgerEntry[], taskId: string): ContractView | null {
  const task = baseTaskId(taskId);
  // The first task.created for the task, whoever signed it: an entry that fails its signature check (edited
  // after it was written) must come back "unsigned", never "no contract".
  const index = entries.findIndex((e) => e.type === "task.created" && e.subject === task);
  if (index < 0) return null;
  const created = entries[index]!;
  if (created.data?.contract === undefined || created.data.contract === null) {
    return isAuthoritative(created) ? null : unreadable(task, "its task entry failed the signature check, so it was changed or was not signed by the app");
  }
  const parsed = normalizeContract(created.data.contract);
  const fallback: TaskContract = parsed.ok ? parsed.contract : UNREADABLE;
  const digest = contractDigest(fallback);
  const flags = Array.isArray(created.data.contractFlags) ? (created.data.contractFlags as ContractFlag[]).filter((f) => f && typeof f.message === "string") : [];
  const widened = widenings(entries, task);
  const view = (status: ContractView["status"], extra: Partial<ContractView> = {}): ContractView => ({
    task,
    status,
    contract: fallback,
    digest,
    flags,
    flagsAccepted: false,
    widened,
    allowedFiles: [...new Set([...fallback.allowedFiles, ...widened.flatMap((w) => w.files)])].sort(),
    ...extra,
  });
  if (!isAuthoritative(created)) return view("unsigned", { problem: `The contract on ${task} cannot be trusted: its task entry failed the signature check, so it was changed or was not signed by the app.` });
  if (!parsed.ok) return view("unsigned", { problem: `The contract on ${task} cannot be read (${parsed.problem}).` });
  if (created.data.contractDigest !== digest) return view("unsigned", { problem: `The contract on ${task} does not match its recorded digest, so it was changed after it was written.` });
  const key = created.data.source === "planning" && typeof created.data.key === "string" ? created.data.key : undefined;
  if (key) {
    const signed = signingPlan(entries, index, key);
    if (!signed) return view("unsigned", { problem: `The plan approval did not sign a contract for ${task}, so nothing can be checked against the one it has.` });
    if (signed.digest !== digest) return view("unsigned", { problem: `The contract on ${task} is not the one you approved with ${signed.plan}: its digest differs.` });
    return view("signed", { plan: signed.plan, flagsAccepted: signed.accepted });
  }
  // A task added by hand with a contract: the person's own signed entry is the signature.
  if (!byPerson(created)) return view("unsigned", { problem: `The contract on ${task} was not written by a person.` });
  return view("signed");
}

const UNREADABLE: TaskContract = { clauses: ["(unreadable contract)"], allowedFiles: [], doneWhen: "(unreadable)", sizeCap: { maxFiles: 1, maxLines: 1 } };

/** A task whose entry cannot be trusted and whose contract (if it ever had one) cannot be shown. */
function unreadable(task: string, why: string): ContractView {
  return {
    task,
    status: "unsigned",
    problem: `The contract on ${task} cannot be trusted: ${why}.`,
    contract: UNREADABLE,
    digest: contractDigest(UNREADABLE),
    flags: [],
    flagsAccepted: false,
    widened: [],
    allowedFiles: [],
  };
}

/** The contracts planning wrote for the roadmap, by task key (replayed from the signed task.created entries). */
export function writtenContracts(entries: readonly LedgerEntry[]): Map<string, { task: string; contract: TaskContract; flags: ContractFlag[] }> {
  const out = new Map<string, { task: string; contract: TaskContract; flags: ContractFlag[] }>();
  for (const e of entries) {
    if (e.type !== "task.created" || e.data?.source !== "planning" || typeof e.data.key !== "string" || !isAuthoritative(e)) continue;
    const parsed = normalizeContract(e.data.contract);
    if (!parsed.ok) continue;
    const flags = Array.isArray(e.data.contractFlags) ? (e.data.contractFlags as ContractFlag[]) : [];
    out.set(e.data.key, { task: e.subject, contract: parsed.contract, flags });
  }
  return out;
}

// ---------- plan approval signs the contracts ----------

export interface PlannedContract {
  key: string;
  title: string;
  contract: TaskContract;
  flags: ContractFlag[];
}

export interface PlanContractSummary {
  /** One digest over every contract: part of what the person approves. */
  digest: string;
  tasks: Record<string, string>;
  flagged: { key: string; title: string; flags: ContractFlag[] }[];
}

export function summarizeContracts(planned: readonly PlannedContract[]): PlanContractSummary {
  const tasks: Record<string, string> = {};
  for (const p of planned) tasks[p.key] = contractDigest(p.contract);
  return { digest: contractsDigest(tasks), tasks, flagged: planned.filter((p) => p.flags.length > 0).map((p) => ({ key: p.key, title: p.title, flags: p.flags })) };
}

/** The part of plan.approved's data that signs the contracts: every task's digest, and which flagged ones the person accepted. */
export function approvalContracts(summary: PlanContractSummary, accepted: readonly string[]): { digest: string; tasks: Record<string, string>; accepted: string[] } {
  const flaggedKeys = new Set(summary.flagged.map((f) => f.key));
  return { digest: summary.digest, tasks: summary.tasks, accepted: [...new Set(accepted)].filter((key) => flaggedKeys.has(key)).sort() };
}

/** Flagged tasks the person has not accepted: the plan may not be approved while any are left. */
export function unacceptedFlags(summary: PlanContractSummary, accepted: readonly string[]): PlanContractSummary["flagged"] {
  const ok = new Set(accepted);
  return summary.flagged.filter((f) => !ok.has(f.key));
}

// ---------- widening ----------

export interface WidenInput {
  task: string;
  files: readonly string[];
  /** Why the owner allows it. Required: it is the ledger's record of the decision. */
  reason: string;
  /** The worker's question (Q-n) that asked for it, when there is one. */
  question?: string;
}

/**
 * Adds files to one task's contract as the person's own signed decision. Only a person can: a worker asks
 * with ask_main and the owner decides here. Nothing about the signed contract changes, so its digest still
 * matches what plan approval signed; the widening is a separate, visible entry.
 */
export function widenContract(ledger: Ledger, actor: Actor, input: WidenInput): { decision: string; entry: string; files: string[] } {
  if (actor.kind !== "person") throw new ContractError("NOT_PERSON", `Only a person can widen a contract, not ${actor.kind} ${actor.id}. A worker can only ask.`);
  const task = baseTaskId(input.task.trim());
  const view = contractOf(ledger.entries(), task);
  if (!TASK_BASE.test(task) || !ledger.entries().some((e) => e.type === "task.created" && e.subject === task)) throw new ContractError("UNKNOWN_TASK", `${input.task} is not a task on the board.`);
  if (!view) throw new ContractError("NO_CONTRACT", `${task} has no contract to widen; it is not limited to any files.`);
  if (view.status !== "signed") throw new ContractError("UNSIGNED", `${view.problem ?? `The contract on ${task} is not signed.`} Widening it would not make it count.`);
  const reason = oneLine(String(input.reason ?? ""), 500);
  if (!reason) throw new ContractError("EMPTY", "Say why you are allowing these files.");
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > MAX_LISTED_FILES) throw new ContractError("BAD_FILES", `Name between 1 and ${MAX_LISTED_FILES} files or folders to allow.`);
  const files: string[] = [];
  for (const file of input.files) {
    const problem = typeof file === "string" ? patternProblem(file) : "A file path must be text.";
    if (problem) throw new ContractError("BAD_FILES", `${typeof file === "string" ? file : "A file"}: ${problem}`);
    files.push(normalizePattern(file));
  }
  const unique = [...new Set(files)].sort();
  const entry = appendNumbered(ledger, {
    actor,
    type: "decision.made",
    summary: oneLine(`Allowed ${task} to change ${unique.join(", ")}`, 140),
    reason,
    refs: [task, ...(input.question ? [input.question] : [])],
    data: { contract: { op: WIDENED_OP, task, files: unique, ...(input.question ? { question: input.question } : {}) } },
  });
  return { decision: entry.subject, entry: entry.n, files: unique };
}

/** Why a ledger write that carries a contract is refused, or null. Used by the planning rules, so it holds whoever writes. */
export function contractWriteRefusal(draft: { type: string; actor?: Actor; data?: Record<string, unknown> }, entries: readonly LedgerEntry[]): string | null {
  const data = draft.data ?? {};
  if (draft.type === "task.created" && data.source === "planning" && typeof data.key === "string") {
    const parsed = normalizeContract(data.contract);
    if (!parsed.ok) return `task refused: ${data.key} has no usable contract (${parsed.problem}); every task planning writes carries one`;
    if (data.contractDigest !== contractDigest(parsed.contract)) return `task refused: the contract on ${data.key} does not match its digest`;
    return null;
  }
  const widen = draft.type === "decision.made" ? (data.contract as { op?: unknown; task?: unknown; files?: unknown } | undefined) : undefined;
  if (widen && typeof widen === "object" && widen.op === WIDENED_OP) {
    if (draft.actor?.kind !== "person") return `only a person can widen a task's contract, not ${draft.actor ? `an actor of kind "${draft.actor.kind}"` : "an unknown actor"}; a worker can only ask`;
    const task = typeof widen.task === "string" ? widen.task : "";
    if (!TASK_BASE.test(task) || baseTaskId(task) !== task) return `a widening must name a task like T-3, not "${task}"`;
    const created = entries.find((e) => e.type === "task.created" && e.subject === task);
    if (!created) return `${task} is not a task, so there is no contract to widen`;
    if (!created.data?.contract) return `${task} has no contract to widen`;
    const files = Array.isArray(widen.files) ? widen.files : [];
    if (!files.length || files.length > MAX_LISTED_FILES) return `a widening must name between 1 and ${MAX_LISTED_FILES} files`;
    const bad = files.find((f) => typeof f !== "string" || patternProblem(f) !== null);
    if (bad !== undefined) return `a widening cannot allow ${typeof bad === "string" ? `"${bad}"` : "that"}: ${typeof bad === "string" ? patternProblem(bad) : "a file path must be text"}`;
  }
  return null;
}
