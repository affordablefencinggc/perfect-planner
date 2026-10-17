// The contract check: what a task changed, measured against what its contract
// allows. This only ADDS refusals; no other gate rule reads or depends on it.
//
// A task's contract (core/planning) lists the files it may change and caps how
// much it may change. "Check the work" asks this module for the diff from
// where the worker branched to its tip. Any file outside the list, any
// dependency or lockfile change that is not listed by name, any file another
// running task has claimed, any symlink that leads out of the task's files and
// any change past the size cap is a hard refusal that names the files. The
// result is written as the gate's own review.verdict (scope:contract), and
// contractRule() then refuses a diff or merge approval for a task under
// contract that has no passing contract verdict at that exact commit.
//
// The limits come from the signed ledger (the host reads them with
// core/planning's effective contract); a worker never supplies them.
import { isAuthoritative } from "../ledger/index";
import { runGit } from "../worktrees/git";
import { GATE_ACTOR, evidenceValue, type EntryDraft, type LedgerEntry, type LedgerPort } from "../worktrees/ports";
import { TASK_ID } from "../worktrees/types";
import { isDependencyPath, isProtectedPath, isTestLike, isWildcard, normalizePattern, oddPathProblem, pathCovered, pathCoveredFolded, patternProblem, resolveLinkTarget } from "./contractPaths";

/** A binary file has no line count; it counts as this many changed lines. */
export const BINARY_LINES = 200;
const MAX_LISTED = 15;
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export interface ContractLimits {
  /** Repo-relative paths or globs the task may change (a folder covers what is inside it). */
  allowedFiles: readonly string[];
  sizeCap: { maxFiles: number; maxLines: number };
}

export interface ContractContext {
  /** The task, for the message ("T-3"). */
  taskLabel?: string;
  /** Files other RUNNING tasks have claimed: a change there is refused even when this task's list covers it. */
  otherClaims?: readonly { taskId: string; claims: readonly string[] }[];
  /** Test files the person approved (pinned) for this task. Allowed besides the list, but only when they look like tests. */
  approvedTestFiles?: readonly string[];
}

/** One changed path between the branch point and the tip (renames are split into a delete and an add). */
export interface FileChange {
  path: string;
  /** A added, M modified, D deleted, T type changed. */
  status: string;
  oldMode: string;
  newMode: string;
  added: number;
  deleted: number;
  binary: boolean;
  /** For a symlink at the tip: where it points. */
  linkTarget?: string;
}

export type ProblemKind = "outside" | "dependency" | "protected" | "other-task" | "symlink" | "odd-name" | "too-many-files" | "too-many-lines" | "history" | "unreadable" | "no-limits";

export interface ContractProblem {
  kind: ProblemKind;
  files: string[];
  /** Extra words for the message (which task holds a file, where a link points, the numbers). */
  detail?: string;
}

export interface ContractReport {
  ok: boolean;
  /** Files changed, and lines added plus deleted (binary files count BINARY_LINES each). */
  files: number;
  lines: number;
  problems: ContractProblem[];
  /** Plain words for the person, naming the files. Only when not ok. */
  reason?: string;
  changed: string[];
}

function oneLine(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function listed(files: readonly string[]): string {
  const shown = files.slice(0, MAX_LISTED).join(", ");
  return files.length > MAX_LISTED ? `${shown} and ${files.length - MAX_LISTED} more` : shown;
}

function validCap(cap: unknown): cap is ContractLimits["sizeCap"] {
  const c = cap as { maxFiles?: unknown; maxLines?: unknown } | null;
  return Boolean(c) && Number.isInteger(c!.maxFiles) && Number.isInteger(c!.maxLines) && (c!.maxFiles as number) >= 1 && (c!.maxLines as number) >= 1;
}

/**
 * Judge the changes against the limits. Pure. Anything the rules cannot place is refused: a path that is
 * not covered by the list is outside, a limit that is missing or unusable refuses everything.
 */
export function evaluateContract(changes: readonly FileChange[], limits: ContractLimits, context: ContractContext = {}): ContractReport {
  const label = context.taskLabel ?? "This task";
  const changed = changes.map((c) => c.path).sort();
  const files = changes.length;
  const lines = changes.reduce((sum, c) => sum + (c.binary ? BINARY_LINES : c.added + c.deleted), 0);
  const problems: ContractProblem[] = [];
  const add = (kind: ProblemKind, file: string, detail?: string) => {
    const existing = problems.find((p) => p.kind === kind && p.detail === detail);
    if (existing) existing.files.push(file);
    else problems.push({ kind, files: [file], ...(detail ? { detail } : {}) });
  };

  if (!Array.isArray(limits?.allowedFiles) || !validCap(limits?.sizeCap)) {
    const report: ContractReport = { ok: false, files, lines, problems: [{ kind: "no-limits", files: [] }], changed };
    return { ...report, reason: `${label} has a contract with no usable file list or size limit, so nothing can be checked against it. Nothing was approved.` };
  }

  // A pattern the rules would not accept in a contract allows nothing.
  const patterns = limits.allowedFiles.filter((p) => typeof p === "string" && patternProblem(p) === null).map(normalizePattern);
  const tests = new Set(
    (context.approvedTestFiles ?? []).map(normalizePattern).filter((file) => file && isTestLike(file) && !isDependencyPath(file) && !isProtectedPath(file) && oddPathProblem(file) === null),
  );
  const allowedPath = (file: string): boolean => {
    // A dependency file or a submodule is allowed only when the contract names that exact path.
    if (isDependencyPath(file)) return patterns.some((p) => !isWildcard(p) && p === file);
    return patterns.some((p) => pathCovered(p, file)) || tests.has(file);
  };

  for (const change of changes) {
    const file = change.path;
    const odd = oddPathProblem(file);
    if (odd) {
      add("odd-name", file, odd);
      continue;
    }
    if (isProtectedPath(file)) {
      add("protected", file);
      continue;
    }
    const holder = (context.otherClaims ?? []).find((other) => other.claims.some((claim) => pathCoveredFolded(claim, file)));
    if (holder) {
      add("other-task", file, holder.taskId);
      continue;
    }
    if (change.oldMode === "160000" || change.newMode === "160000") {
      if (!patterns.some((p) => !isWildcard(p) && p === file)) add("dependency", file, "a submodule");
      continue;
    }
    if (!allowedPath(file)) {
      add(isDependencyPath(file) ? "dependency" : "outside", file);
      continue;
    }
    if (change.newMode === "120000") {
      const target = resolveLinkTarget(file, change.linkTarget ?? "");
      if ("problem" in target) add("symlink", file, target.problem);
      else if (isProtectedPath(target.path)) add("symlink", file, `points at ${target.path}, which belongs to Perfect Planner or git`);
      else if (!allowedPath(target.path)) add("symlink", file, `points at ${target.path}, which is not on the list`);
    }
  }

  if (files > limits.sizeCap.maxFiles) problems.push({ kind: "too-many-files", files: [], detail: `${files} files changed, the limit is ${limits.sizeCap.maxFiles}` });
  if (lines > limits.sizeCap.maxLines) problems.push({ kind: "too-many-lines", files: [], detail: `${lines} lines changed, the limit is ${limits.sizeCap.maxLines}` });

  if (!problems.length) return { ok: true, files, lines, problems, changed };
  return { ok: false, files, lines, problems, changed, reason: refusalText(label, problems) };
}

function refusalText(label: string, problems: readonly ContractProblem[]): string {
  const out = [`${label}'s contract does not allow this work.`];
  const by = (kind: ProblemKind) => problems.filter((p) => p.kind === kind);
  for (const p of by("outside")) out.push(`It changes ${p.files.length === 1 ? "a file that is" : `${p.files.length} files that are`} not on its list: ${listed(p.files)}.`);
  for (const p of by("dependency")) {
    out.push(`It changes ${p.files.length === 1 ? "a dependency file" : `${p.files.length} dependency files`} (${listed(p.files)}). A new dependency or a lockfile change is outside the contract unless that exact file is listed by name.`);
  }
  for (const p of by("other-task")) out.push(`It changes ${listed(p.files)}, which ${p.detail} has claimed. Only one task at a time may change a file.`);
  for (const p of by("protected")) out.push(`It changes ${listed(p.files)}, which belongs to Perfect Planner or git (the ledger and the contract live there). No task is ever allowed to change it.`);
  for (const p of by("symlink")) out.push(`${listed(p.files)} is a symbolic link that ${p.detail}.`);
  for (const p of by("odd-name")) out.push(`${listed(p.files)} has ${p.detail}.`);
  for (const p of by("too-many-files")) out.push(`It is too big: ${p.detail}. Split the task.`);
  for (const p of by("too-many-lines")) out.push(`It is too big: ${p.detail}. Split the task.`);
  for (const p of by("history")) out.push(p.detail ?? "The branch no longer contains the commit it started from.");
  for (const p of by("unreadable")) out.push(p.detail ?? "The changes could not be read.");
  out.push("Nothing was approved. Take those changes out of the work, or allow them yourself: only the owner can widen a contract (a worker can only ask).");
  return out.join(" ");
}

// ---------- reading the diff ----------

/** Parses `git diff --raw -z --no-renames`: `:<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0` per file. */
export function parseRaw(output: string): Omit<FileChange, "added" | "deleted" | "binary">[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const out: Omit<FileChange, "added" | "deleted" | "binary">[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const head = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(fields[i] ?? "");
    const file = fields[i + 1];
    if (!head || file === undefined) throw new Error("git printed a change list in a form this check does not understand");
    out.push({ path: file, status: head[3]!, oldMode: head[1]!, newMode: head[2]! });
  }
  return out;
}

/** Parses `git diff --numstat -z --no-renames`: `<added>\t<deleted>\t<path>\0` per file; binary files print `-`. */
export function parseNumstat(output: string): Map<string, { added: number; deleted: number; binary: boolean }> {
  const stats = new Map<string, { added: number; deleted: number; binary: boolean }>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("git printed line counts in a form this check does not understand");
    const binary = match[1] === "-" || match[2] === "-";
    stats.set(match[3]!, { added: binary ? 0 : Number(match[1]), deleted: binary ? 0 : Number(match[2]), binary });
  }
  return stats;
}

/**
 * Everything that changed from `base` to `tip`, with renames split into a delete of the old path and an
 * add of the new one (so a file moved out of the list is seen at both ends). Reads only git objects:
 * nothing in the worktree is executed or followed.
 */
export async function readChanges(cwd: string, base: string, tip: string): Promise<FileChange[]> {
  const common = ["-c", "core.quotePath=false", "diff", "-z", "--no-renames"];
  const raw = await runGit(cwd, [...common, "--raw", "--no-abbrev", base, tip, "--"]);
  if (raw.code !== 0) throw new Error(`git could not list the changes (${oneLine(raw.stderr || raw.stdout, 200)})`);
  const stat = await runGit(cwd, [...common, "--numstat", base, tip, "--"]);
  if (stat.code !== 0) throw new Error(`git could not count the changes (${oneLine(stat.stderr || stat.stdout, 200)})`);
  const stats = parseNumstat(stat.stdout);
  const changes: FileChange[] = [];
  for (const entry of parseRaw(raw.stdout)) {
    const counts = stats.get(entry.path);
    // A path git listed but did not count is treated as binary, so it can only make the result stricter.
    const change: FileChange = { ...entry, added: counts?.added ?? 0, deleted: counts?.deleted ?? 0, binary: counts?.binary ?? true };
    if (change.newMode === "120000") {
      const blob = await runGit(cwd, ["cat-file", "blob", `${tip}:${entry.path}`]);
      if (blob.code !== 0) throw new Error(`git could not read the symbolic link ${entry.path}`);
      change.linkTarget = blob.stdout.slice(0, 4096);
    }
    changes.push(change);
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface ContractCheck extends ContractReport {
  base: string;
  tip: string;
}

/**
 * The contract check for one task: the diff from `base` (the commit its worktree branched from, as the
 * signed worktree.created entry recorded it) to `tip` (the worktree's HEAD), judged against `limits`.
 * Never throws: anything that cannot be read is a refusal.
 */
export async function checkContract(cwd: string, input: { base: string; tip: string; limits: ContractLimits; context?: ContractContext }): Promise<ContractCheck> {
  const { base, tip, limits } = input;
  const context = input.context ?? {};
  const failed = (kind: "history" | "unreadable", detail: string): ContractCheck => ({
    ok: false,
    base,
    tip,
    files: 0,
    lines: 0,
    changed: [],
    problems: [{ kind, files: [], detail }],
    reason: refusalText(context.taskLabel ?? "This task", [{ kind, files: [], detail }]),
  });
  if (!SHA.test(base) || !SHA.test(tip)) return failed("unreadable", "The commits to compare are not full commit hashes, so nothing could be compared.");
  try {
    const ancestor = await runGit(cwd, ["merge-base", "--is-ancestor", base, tip]);
    if (ancestor.code === 1) return failed("history", "The branch no longer contains the commit it started from, so its history was rewritten and its changes cannot be measured.");
    if (ancestor.code !== 0) return failed("unreadable", `Git could not compare the branch with where it started (${oneLine(ancestor.stderr || ancestor.stdout, 200)}).`);
    const report = evaluateContract(await readChanges(cwd, base, tip), limits, context);
    return { ...report, base, tip };
  } catch (error) {
    return failed("unreadable", `The changes could not be read: ${oneLine((error as Error).message, 300)}.`);
  }
}

// ---------- the ledger side ----------

const MAX_EVIDENCE_FILES = 20;

/** Writes the gate's own record of a contract check (review.verdict, scope:contract) for the task at `tip`. */
export function recordContractVerdict(ledger: LedgerPort, taskId: string, check: ContractCheck): LedgerEntry {
  const verdict = check.ok ? "approve" : "refuse";
  const named = check.problems.flatMap((p) => p.files).slice(0, MAX_EVIDENCE_FILES);
  return ledger.append({
    type: "review.verdict",
    actor: GATE_ACTOR,
    subject: taskId,
    summary: check.ok ? `${taskId} stays inside its contract at ${check.tip.slice(0, 12)}` : `${taskId} breaks its contract at ${check.tip.slice(0, 12)}`,
    ...(check.ok ? {} : { reason: oneLine(check.reason ?? "The contract check failed.") }),
    evidence: ["scope:contract", `verdict:${verdict}`, `commit:${check.tip}`, `base:${check.base}`, `files:${check.files}`, `lines:${check.lines}`, ...named.map((file) => `file:${file}`)],
    data: { scope: "contract", verdict, commit: check.tip, base: check.base, files: check.files, lines: check.lines, problems: check.problems.map((p) => ({ kind: p.kind, files: p.files.slice(0, MAX_EVIDENCE_FILES), ...(p.detail ? { detail: p.detail } : {}) })) },
  });
}

function baseId(taskId: string): string {
  return /^(T-\d+)(?:\.a\d+)?$/.exec(taskId)?.[1] ?? taskId;
}

/**
 * Is the task under contract: its task entry carries one. The entry's signature is deliberately not asked
 * about here: an entry that fails its signature check was edited or forged, and treating it as "no
 * contract" would let an edit remove the check. A forged contract can only add a refusal.
 */
export function isUnderContract(entries: readonly LedgerEntry[], taskId: string): boolean {
  const id = baseId(taskId);
  return entries.some((e) => e.type === "task.created" && e.subject === id && typeof e.data?.contract === "object" && e.data.contract !== null);
}

/** The latest contract verdict the GATE signed for this task at this exact commit. A person's or Jev's entry is not a measurement. */
export function contractVerdictAt(entries: readonly LedgerEntry[], taskId: string, commit: string): { n: string; ok: boolean; reason?: string } | undefined {
  const wanted = commit.trim().toLowerCase();
  let found: { n: string; ok: boolean; reason?: string } | undefined;
  for (const e of entries) {
    if (e.type !== "review.verdict" || e.subject !== taskId || !isAuthoritative(e) || e.actor.kind !== GATE_ACTOR.kind || e.actor.id !== GATE_ACTOR.id) continue;
    if (evidenceValue(e, "scope") !== "contract" || (evidenceValue(e, "commit") ?? "").toLowerCase() !== wanted) continue;
    found = { n: e.n, ok: evidenceValue(e, "verdict") === "approve", ...(e.reason ? { reason: e.reason } : {}) };
  }
  return found;
}

/** The last contract check the GATE signed for this task (any commit), for the screen: "stays inside" or "breaks" and why. */
export function latestContractVerdict(entries: readonly LedgerEntry[], taskId: string): { n: string; ok: boolean; commit: string; reason?: string; files: number; lines: number } | undefined {
  let found: { n: string; ok: boolean; commit: string; reason?: string; files: number; lines: number } | undefined;
  for (const e of entries) {
    if (e.type !== "review.verdict" || e.subject !== taskId || !isAuthoritative(e) || e.actor.kind !== GATE_ACTOR.kind || e.actor.id !== GATE_ACTOR.id) continue;
    if (evidenceValue(e, "scope") !== "contract") continue;
    found = {
      n: e.n,
      ok: evidenceValue(e, "verdict") === "approve",
      commit: (evidenceValue(e, "commit") ?? "").toLowerCase(),
      files: Number(evidenceValue(e, "files") ?? 0) || 0,
      lines: Number(evidenceValue(e, "lines") ?? 0) || 0,
      ...(e.reason ? { reason: e.reason } : {}),
    };
  }
  return found;
}

/**
 * A ledger rule (register with ledger.addRule), only ever adding a refusal: an approval of a task's diff or
 * merge is refused when the task is under contract and the gate has not recorded a passing contract check
 * at that exact commit. Tasks without a contract are not affected, and rejecting a diff is never blocked.
 */
export function contractRule(): (draft: EntryDraft, ledger: Pick<LedgerPort, "entries">) => string | null {
  return (draft, ledger) => {
    if (draft.type !== "review.verdict") return null;
    const scope = evidenceValue(draft, "scope") ?? (typeof draft.data?.scope === "string" ? draft.data.scope : undefined);
    if (scope !== "diff" && scope !== "merge") return null;
    const verdict = evidenceValue(draft, "verdict") ?? (typeof draft.data?.verdict === "string" ? draft.data.verdict : undefined);
    if (verdict !== "approve") return null;
    const subject = draft.subject.trim();
    if (!TASK_ID.test(subject)) return null;
    const entries = ledger.entries();
    if (!isUnderContract(entries, subject)) return null;
    const commit = (evidenceValue(draft, "commit") ?? (typeof draft.data?.commit === "string" ? draft.data.commit : "")).trim().toLowerCase();
    const seen = commit ? contractVerdictAt(entries, subject, commit) : undefined;
    if (seen?.ok) return null;
    const at = commit ? ` at ${commit.slice(0, 12)}` : "";
    return seen
      ? `${subject} breaks its contract${at}, so its ${scope} cannot be approved: ${seen.reason ?? "see the contract check"}`
      : `${subject} has a contract, and its work${at} has not passed the contract check. Press "Check the work" first; nothing is approved until it passes.`;
  };
}
