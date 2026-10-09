import type { Ledger, LedgerEntry } from "../ledger/index";
import { baseNumber, parseNumber } from "../numbering/index";
import { claimsPeople, memberForActor, ownerOf, replayRoster, type MemberState, type Roster } from "./model";
import { loadPhoto, photoDataUrl, type PhotoStore } from "./photos";
import type { Member, PeopleView, Presence, SharedDoc, Stage } from "./types";

/** The stage of the core loop an entry type belongs to. */
export function stageOf(entry: Pick<LedgerEntry, "type" | "data">): Stage {
  const { type } = entry;
  if (claimsPeople(entry)) return "people";
  if (type === "plan.approved" || type.startsWith("clause.")) return "plan";
  if (type.startsWith("task.")) return "task";
  if (type.startsWith("question.") || type === "decision.made") return "relay";
  if (type.startsWith("worktree.") || type === "commit.observed" || type.startsWith("collision.") || type === "merge.done") return "git";
  if (type.startsWith("test.") || type === "review.verdict") return "proof";
  if (type.startsWith("release.")) return "release";
  return "housekeeping";
}

function taskOf(subject: string): string | undefined {
  const parsed = parseNumber(subject.split(" ")[0] ?? "");
  return parsed?.series === "T" ? baseNumber(subject.split(" ")[0]!) : undefined;
}

/**
 * Where each member is (§9.4): their latest work entry, written by them or by
 * one of their agents. People changes (photos, membership) only count when
 * the person has done nothing else yet. `task` is the newest task they touched
 * that is not done.
 */
function presences(roster: Roster, entries: readonly LedgerEntry[]): Map<string, Presence> {
  const latestWork = new Map<string, LedgerEntry>();
  const latestAny = new Map<string, LedgerEntry>();
  const lastTask = new Map<string, string>();
  const done = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "task.done") done.add(baseNumber(entry.subject));
    if (entry.type === "task.reopened") done.delete(baseNumber(entry.subject));
    const member = memberForActor(roster, entry.actor);
    if (!member) continue;
    latestAny.set(member.person, entry);
    if (!claimsPeople(entry)) latestWork.set(member.person, entry);
    const task = taskOf(entry.subject);
    if (task) lastTask.set(member.person, task);
  }
  const out = new Map<string, Presence>();
  for (const member of roster.members.values()) {
    const entry = latestWork.get(member.person) ?? latestAny.get(member.person);
    if (!entry) continue;
    const task = lastTask.get(member.person);
    const presence: Presence = {
      entry: entry.n,
      at: entry.at,
      type: entry.type,
      stage: stageOf(entry),
      subject: entry.subject,
      summary: entry.summary,
      via: entry.actor.id,
    };
    if (task && !done.has(task)) presence.task = task;
    out.set(member.person, presence);
  }
  return out;
}

/** The latest approved plan, with the clauses it currently has (§9.3). */
function planDoc(entries: readonly LedgerEntry[]): SharedDoc | undefined {
  let plan: LedgerEntry | undefined;
  for (const entry of entries) if (entry.type === "plan.approved") plan = entry;
  if (!plan) return undefined;
  const clauses = new Set<string>();
  for (const entry of entries) {
    if (!entry.type.startsWith("clause.")) continue;
    const [version, clause] = entry.subject.split(" ");
    if (!clause) continue;
    // Clauses carry over between plan versions, so every P-n clause counts.
    if (!version || parseNumber(version)?.series !== "P") continue;
    if (entry.type === "clause.withdrawn") clauses.delete(clause);
    else clauses.add(clause);
  }
  const data = plan.data ?? {};
  return {
    doc: "plan",
    title: typeof data.title === "string" && data.title.trim() ? data.title : plan.summary,
    path: typeof data.path === "string" ? data.path : "",
    version: plan.subject,
    clauses: [...clauses],
    kind: "plan",
    sharedBy: plan.actor.id,
    at: plan.at,
    entry: plan.n,
  };
}

function toMember(m: MemberState, presence: Presence | undefined): Member {
  const member: Member = { person: m.person, name: m.name, role: m.role, approves: [...m.approves], agents: [...m.agents], since: m.since };
  if (m.photo) member.photo = { ...m.photo };
  if (presence) member.presence = presence;
  return member;
}

/** Rebuilds who is on the project, where they are and what they share, from the ledger alone. */
export function buildPeopleView(entries: readonly LedgerEntry[], options: { owner?: string } = {}): PeopleView {
  const roster = replayRoster(entries, options.owner);
  const where = presences(roster, entries);
  const members = [...roster.members.values()]
    .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner"))
    .map((m) => toMember(m, where.get(m.person)));
  const docs: SharedDoc[] = [];
  const plan = planDoc(entries);
  if (plan) docs.push(plan);
  for (const d of roster.docs.values()) {
    docs.push({ doc: d.doc, title: d.title, path: d.path, version: `v${d.versions}`, clauses: [...d.clauses], kind: "document", sharedBy: d.sharedBy, at: d.at, entry: d.entry });
  }
  const view: PeopleView = { members, docs };
  const owner = ownerOf(roster);
  if (owner) view.owner = members.find((m) => m.person === owner.person);
  const head = entries[entries.length - 1]?.n;
  if (head) view.head = head;
  return view;
}

/** The view of an open ledger, with the owner the ledger verified from the pinned owner key. */
export function peopleView(ledger: Pick<Ledger, "entries" | "owner">): PeopleView {
  const owner = ledger.owner;
  return buildPeopleView(ledger.entries(), owner === undefined ? {} : { owner });
}

/** Data URLs for members' photos, for the panel. Missing or altered photos are left out. */
export function photoSources(view: PeopleView, store: PhotoStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of view.members) {
    if (!m.photo) continue;
    const bytes = loadPhoto(store, m.photo);
    if (bytes) out[m.person] = photoDataUrl(bytes, m.photo.mime);
  }
  return out;
}
