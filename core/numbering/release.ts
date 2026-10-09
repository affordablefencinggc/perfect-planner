import type { Actor, Ledger, LedgerEntry } from "../ledger/index";
import { baseNumber, highestNumber, nextNumber, parseNumber } from "./series";

export type ChangeKind = "breaking" | "feature" | "fix";

export interface ReleaseRecord {
  release: string;          // "R-2"
  entry: string;            // the release.cut / release.rollback entry, "L-000240"
  version: string;          // "v1.1.0"
  plan?: string;            // latest approved plan at release, "P-2"
  commit: string;           // short sha
  from?: string;            // first ledger entry in the range, inclusive
  to?: string;              // last ledger entry in the range, inclusive
  restores?: string;        // rollbacks only: the release whose content is restored
  at: string;
}

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(version: string): [number, number, number] | undefined {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function bumpVersion(previous: string | undefined, change: ChangeKind): string {
  const parts = previous ? parseVersion(previous) : undefined;
  if (!parts) return "v1.0.0";
  const [major, minor, patch] = parts;
  if (change === "breaking") return `v${major + 1}.0.0`;
  if (change === "feature") return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
}

/** Releases in ledger order, rebuilt from release.cut and release.rollback entries. */
export function releases(entries: readonly LedgerEntry[]): ReleaseRecord[] {
  const list: ReleaseRecord[] = [];
  for (const entry of entries) {
    if (entry.type !== "release.cut" && entry.type !== "release.rollback") continue;
    const data = (entry.data ?? {}) as Record<string, unknown>;
    list.push({
      release: entry.subject,
      entry: entry.n,
      version: String(data.version ?? ""),
      plan: typeof data.plan === "string" ? data.plan : undefined,
      commit: String(data.commit ?? ""),
      from: typeof data.from === "string" ? data.from : undefined,
      to: typeof data.to === "string" ? data.to : undefined,
      restores: typeof data.restores === "string" ? data.restores : undefined,
      at: entry.at,
    });
  }
  return list;
}

export function findRelease(entries: readonly LedgerEntry[], release: string): ReleaseRecord | undefined {
  return releases(entries).find((record) => record.release === release);
}

/** Latest approved plan version at the end of `entries`. */
export function latestPlan(entries: readonly LedgerEntry[]): string | undefined {
  const highest = highestNumber(entries, "P");
  return highest > 0 ? `P-${highest}` : undefined;
}

/** How a task changes the product, from its task.created entry's data.change (default fix). */
export function taskChange(entries: readonly LedgerEntry[], task: string): ChangeKind {
  const base = baseNumber(task);
  const created = entries.find((entry) => entry.type === "task.created" && baseNumber(entry.subject) === base);
  const change = created?.data?.change;
  return change === "breaking" || change === "feature" ? change : "fix";
}

/** The strongest change among tasks done in the entries; fix when nothing was done. */
export function strongestChange(entries: readonly LedgerEntry[], scope: readonly LedgerEntry[]): ChangeKind {
  let strongest: ChangeKind = "fix";
  for (const entry of scope) {
    if (entry.type !== "task.done") continue;
    const change = taskChange(entries, entry.subject);
    if (change === "breaking") return "breaking";
    if (change === "feature") strongest = "feature";
  }
  return strongest;
}

/** Entries after the previous release up to the end, the range a new cut would cover. */
export function unreleasedRange(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const lastRelease = [...entries].reverse().find((entry) => entry.type === "release.cut" || entry.type === "release.rollback");
  if (!lastRelease) return [...entries];
  const index = entries.indexOf(lastRelease);
  return entries.slice(index + 1);
}

/** The ledger entries a release covers (its from..to range), empty for an unknown release. */
export function releaseRange(entries: readonly LedgerEntry[], release: string): LedgerEntry[] {
  const record = findRelease(entries, release);
  if (!record?.from || !record.to) return [];
  const a = entries.findIndex((entry) => entry.n === record.from);
  const b = entries.findIndex((entry) => entry.n === record.to);
  return a < 0 || b < a ? [] : entries.slice(a, b + 1);
}

/** "R-1 · v1.0.0 · P-1 · L-000231 · 9f3c2e1" (spec §3.2). */
export function formatStamp(parts: { release?: string; version?: string; plan?: string; entry?: string; commit?: string }): string {
  return [parts.release ?? "unreleased", parts.version, parts.plan, parts.entry, parts.commit].filter((part) => part && part.length > 0).join(" · ");
}

/** Stamp of a release, or of the latest release when none is named. */
export function releaseStamp(entries: readonly LedgerEntry[], release?: string): string | undefined {
  const list = releases(entries);
  const record = release ? list.find((item) => item.release === release) : list[list.length - 1];
  if (!record) return undefined;
  return formatStamp({ release: record.release, version: record.version, plan: record.plan, entry: record.entry, commit: record.commit });
}

/** Footer stamp for the running app: latest release plus the current ledger head and commit. */
export function currentStamp(entries: readonly LedgerEntry[], commit?: string): string {
  const list = releases(entries);
  const record = list[list.length - 1];
  return formatStamp({
    release: record?.release,
    version: record?.version,
    plan: latestPlan(entries),
    entry: entries[entries.length - 1]?.n,
    commit,
  });
}

export interface CutOptions {
  commit: string;
  summary?: string;
  reason?: string;
  evidence?: string[];
  /** Override the derived change kind, e.g. a release that only ships docs. */
  change?: ChangeKind;
}

/**
 * Writes release.cut for everything since the previous release: next R
 * number, derived version, latest plan, ledger range and commit.
 */
export function cutRelease(ledger: Ledger, actor: Actor, options: CutOptions): LedgerEntry {
  const entries = ledger.entries();
  const range = unreleasedRange(entries);
  if (range.length === 0) throw new RangeError("nothing has happened since the last release");
  const previous = releases(entries).at(-1);
  const change = options.change ?? strongestChange(entries, range);
  const release = nextNumber(entries, "R");
  const version = bumpVersion(previous?.version, change);
  const plan = latestPlan(entries);
  return ledger.append({
    actor,
    type: "release.cut",
    subject: release,
    summary: options.summary ?? `${release} ${version} released`,
    reason: options.reason,
    evidence: options.evidence ?? [`commit:${options.commit}`],
    refs: [],
    data: { release, version, plan, commit: options.commit, from: range[0].n, to: range[range.length - 1].n, change },
  });
}

export interface RollbackOptions {
  /** The release whose content goes back out, "R-1". */
  to: string;
  reason: string;
  /** Commit actually deployed; defaults to the restored release's commit. */
  commit?: string;
  summary?: string;
  evidence?: string[];
}

/**
 * A rollback is a new release (spec: numbers never go back): next R number,
 * a patch bump on the latest version, carrying the old release's plan and
 * commit and the range since the previous release.
 */
export function rollbackRelease(ledger: Ledger, actor: Actor, options: RollbackOptions): LedgerEntry {
  const entries = ledger.entries();
  const target = findRelease(entries, options.to);
  if (!target) throw new RangeError(`${options.to} is not a release`);
  const latest = releases(entries).at(-1)!;
  if (parseNumber(options.to)?.n === parseNumber(latest.release)?.n) {
    throw new RangeError(`${options.to} is already the latest release`);
  }
  const range = unreleasedRange(entries);
  const release = nextNumber(entries, "R");
  const version = bumpVersion(latest.version, "fix");
  const commit = options.commit ?? target.commit;
  return ledger.append({
    actor,
    type: "release.rollback",
    subject: release,
    summary: options.summary ?? `${release} ${version} rolls back to ${options.to}`,
    reason: options.reason,
    evidence: options.evidence ?? [`commit:${commit}`],
    refs: [],
    data: {
      release,
      version,
      plan: target.plan,
      commit,
      restores: options.to,
      from: range[0]?.n,
      to: range[range.length - 1]?.n,
    },
  });
}
