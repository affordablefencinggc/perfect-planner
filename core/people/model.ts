import type { LedgerEntry } from "../ledger/index";
import { isSlug } from "./errors";
import {
  APPROVALS,
  PEOPLE_OPS,
  PHOTO_MAX_BYTES,
  PHOTO_MIMES,
  ROLES,
  type Approval,
  type PeopleEvent,
  type Photo,
  type Role,
} from "./types";

/** The people event an entry carries, or undefined when it is not a valid people entry. */
export function peopleEvent(entry: Pick<LedgerEntry, "type" | "data">): PeopleEvent | undefined {
  if (entry.type !== "decision.made") return undefined;
  return parsePeopleEvent(entry.data?.people);
}

/** True when the entry claims to be a people entry, valid or not. */
export function claimsPeople(entry: Pick<LedgerEntry, "type" | "data">): boolean {
  return entry.type === "decision.made" && entry.data !== undefined && "people" in entry.data;
}

const isRole = (v: unknown): v is Role => (ROLES as readonly unknown[]).includes(v);
const isText = (v: unknown, max = 200): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;
const isApprovals = (v: unknown): v is Approval[] =>
  Array.isArray(v) && v.every((a) => (APPROVALS as readonly unknown[]).includes(a)) && new Set(v).size === v.length;
const isIds = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 50 && v.every((a) => isText(a, 100)) && new Set(v).size === v.length;
const optional = <T>(v: unknown, check: (x: unknown) => x is T): boolean => v === undefined || check(v);

/** Validates the shape of a `data.people` payload. Permission checks live in rules.ts. */
export function parsePeopleEvent(raw: unknown): PeopleEvent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  if (!(PEOPLE_OPS as readonly unknown[]).includes(e.op)) return undefined;
  switch (e.op) {
    case "member.added":
      if (!isSlug(e.person) || !isText(e.name, 80) || !isRole(e.role)) return undefined;
      if (!optional(e.approves, isApprovals) || !optional(e.agents, isIds)) return undefined;
      return raw as PeopleEvent;
    case "member.changed":
      if (!isSlug(e.person)) return undefined;
      if (!optional(e.name, (v): v is string => isText(v, 80)) || !optional(e.role, isRole)) return undefined;
      if (!optional(e.approves, isApprovals) || !optional(e.agents, isIds)) return undefined;
      if (e.name === undefined && e.role === undefined && e.approves === undefined && e.agents === undefined) return undefined;
      return raw as PeopleEvent;
    case "member.removed":
    case "photo.cleared":
      return isSlug(e.person) ? (raw as PeopleEvent) : undefined;
    case "photo.set":
      if (!isSlug(e.person) || !isText(e.file, 300)) return undefined;
      if (typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.sha256)) return undefined;
      if (typeof e.bytes !== "number" || !Number.isInteger(e.bytes) || e.bytes <= 0 || e.bytes > PHOTO_MAX_BYTES) return undefined;
      if (!(PHOTO_MIMES as readonly unknown[]).includes(e.mime)) return undefined;
      return raw as PeopleEvent;
    case "doc.shared":
      if (!isSlug(e.doc) || !isText(e.title, 200) || !isText(e.path, 500)) return undefined;
      if (!optional(e.clauses, isIds)) return undefined;
      return raw as PeopleEvent;
    case "doc.removed":
      return isSlug(e.doc) ? (raw as PeopleEvent) : undefined;
  }
  return undefined;
}

export interface MemberState {
  person: string;
  name: string;
  role: Role;
  approves: Approval[];
  agents: string[];
  photo?: Photo;
  since: string;
}

export interface DocState {
  doc: string;
  title: string;
  path: string;
  clauses: string[];
  versions: number;
  sharedBy: string;
  at: string;
  entry: string;
}

export interface Roster {
  /** Current members, in the order they joined. */
  members: Map<string, MemberState>;
  docs: Map<string, DocState>;
  /** Agents of people who were removed; they may no longer write. */
  retiredAgents: Set<string>;
}

export function emptyRoster(): Roster {
  return { members: new Map(), docs: new Map(), retiredAgents: new Set() };
}

/** Applies one entry to the roster in place. Entries that are not people entries are ignored. */
export function applyEntry(roster: Roster, entry: LedgerEntry): void {
  const event = peopleEvent(entry);
  if (!event) return;
  const { members, docs, retiredAgents } = roster;
  if ("agents" in event && event.agents) for (const agent of event.agents) retiredAgents.delete(agent);
  switch (event.op) {
    case "member.added":
      members.set(event.person, {
        person: event.person,
        name: event.name.trim(),
        role: event.role,
        approves: event.role === "helper" ? [...(event.approves ?? [])] : [],
        agents: [...(event.agents ?? [])],
        since: entry.n,
      });
      return;
    case "member.changed": {
      const m = members.get(event.person);
      if (!m) return;
      if (event.name !== undefined) m.name = event.name.trim();
      if (event.role !== undefined) m.role = event.role;
      if (event.approves !== undefined) m.approves = [...event.approves];
      if (event.agents !== undefined) m.agents = [...event.agents];
      if (m.role !== "helper") m.approves = [];
      return;
    }
    case "member.removed":
      for (const agent of members.get(event.person)?.agents ?? []) retiredAgents.add(agent);
      members.delete(event.person);
      return;
    case "photo.set": {
      const m = members.get(event.person);
      if (m) m.photo = { file: event.file, sha256: event.sha256, bytes: event.bytes, mime: event.mime, entry: entry.n };
      return;
    }
    case "photo.cleared": {
      const m = members.get(event.person);
      if (m) delete m.photo;
      return;
    }
    case "doc.shared": {
      const before = docs.get(event.doc);
      docs.set(event.doc, {
        doc: event.doc,
        title: event.title.trim(),
        path: event.path.trim(),
        clauses: [...(event.clauses ?? [])],
        versions: (before?.versions ?? 0) + 1,
        sharedBy: entry.actor.id,
        at: entry.at,
        entry: entry.n,
      });
      return;
    }
    case "doc.removed":
      docs.delete(event.doc);
      return;
  }
}

export function replayRoster(entries: readonly LedgerEntry[]): Roster {
  const roster = emptyRoster();
  for (const entry of entries) applyEntry(roster, entry);
  return roster;
}

export function ownerOf(roster: Roster): MemberState | undefined {
  for (const m of roster.members.values()) if (m.role === "owner") return m;
  return undefined;
}

/** The member an actor speaks for: the person themselves, or the person whose agent it is. */
export function memberForActor(roster: Roster, actor: LedgerEntry["actor"]): MemberState | undefined {
  if (actor.kind === "person") return roster.members.get(actor.id);
  if (actor.kind === "agent" || actor.kind === "jev") {
    for (const m of roster.members.values()) if (m.agents.includes(actor.id)) return m;
  }
  return undefined;
}
