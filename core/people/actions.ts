import type { Actor, Ledger, LedgerEntry } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import { assertPerson, isSlug, PeopleError } from "./errors";
import { isDocPath, replayRoster } from "./model";
import { photoFile, validatePhoto, type PhotoStore } from "./photos";
import { installPeopleRules } from "./rules";
import type { Approval, PeopleEvent, Role } from "./types";

/**
 * Writing people changes. Each one is a `decision.made` entry numbered D-n,
 * with the change in `data.people`; the ledger's rules (installPeopleRules)
 * decide whether the actor may make it.
 */
function record(ledger: Ledger, actor: Actor, event: PeopleEvent, summary: string, reason: string, evidence: string[] = []): LedgerEntry {
  installPeopleRules(ledger);
  return appendNumbered(ledger, { actor, type: "decision.made", summary, reason, evidence, refs: [], data: { people: { ...event } } });
}

const ROLE_WORD: Record<Role, string> = { owner: "owner", helper: "a helper", viewer: "a viewer" };

export interface NewMember {
  person: string;
  name: string;
  role: Role;
  approves?: Approval[];
  agents?: string[];
}

export function addMember(ledger: Ledger, actor: Actor, member: NewMember, reason?: string): LedgerEntry {
  assertPerson(member.person);
  const event: PeopleEvent = { op: "member.added", person: member.person, name: member.name.trim(), role: member.role };
  if (member.approves?.length) event.approves = [...member.approves];
  if (member.agents?.length) event.agents = [...member.agents];
  const summary = `${event.name} joins as ${ROLE_WORD[member.role]}`;
  return record(ledger, actor, event, summary, reason ?? summary);
}

/** Starts a project's roster: the person writing becomes its owner. */
export function claimOwnership(ledger: Ledger, actor: Actor, name: string, reason = "Owner of the project"): LedgerEntry {
  return addMember(ledger, actor, { person: actor.id, name, role: "owner" }, reason);
}

export interface MemberChange {
  name?: string;
  role?: Role;
  approves?: Approval[];
  agents?: string[];
}

export function changeMember(ledger: Ledger, actor: Actor, person: string, change: MemberChange, reason?: string): LedgerEntry {
  assertPerson(person);
  const event: PeopleEvent = { op: "member.changed", person };
  if (change.name !== undefined) event.name = change.name.trim();
  if (change.role !== undefined) event.role = change.role;
  if (change.approves !== undefined) event.approves = [...change.approves];
  if (change.agents !== undefined) event.agents = [...change.agents];
  const name = replayRoster(ledger.entries()).members.get(person)?.name ?? person;
  const parts: string[] = [];
  if (change.role !== undefined) parts.push(`is now ${ROLE_WORD[change.role]}`);
  if (change.approves !== undefined) parts.push(change.approves.length ? `can approve ${change.approves.join(", ")}` : "approves nothing");
  if (change.agents !== undefined) parts.push(`has ${change.agents.length} agent${change.agents.length === 1 ? "" : "s"}`);
  if (change.name !== undefined) parts.push(`is now called ${event.name}`);
  const summary = `${name} ${parts.join(" and ") || "changed"}`;
  return record(ledger, actor, event, summary, reason ?? summary);
}

export function removeMember(ledger: Ledger, actor: Actor, person: string, reason?: string): LedgerEntry {
  assertPerson(person);
  const name = replayRoster(ledger.entries()).members.get(person)?.name ?? person;
  const summary = `${name} leaves the project`;
  return record(ledger, actor, { op: "member.removed", person }, summary, reason ?? summary);
}

/**
 * Validates a local image, stores it under .perfect-planner/people/photos/
 * and records its fingerprint. The image never leaves the project folder.
 * The entry is written first, so a refused change leaves no file behind; if
 * the file then cannot be saved, the photo is cleared again.
 */
export function setPhoto(ledger: Ledger, store: PhotoStore, actor: Actor, person: string, image: Uint8Array): LedgerEntry {
  assertPerson(person);
  const { mime, bytes, sha256 } = validatePhoto(image);
  const file = photoFile(person, sha256, mime);
  const name = replayRoster(ledger.entries()).members.get(person)?.name ?? person;
  const summary = `${name} has a new profile photo`;
  const entry = record(ledger, actor, { op: "photo.set", person, file, sha256, bytes, mime }, summary, summary, [`file:${file}`]);
  try {
    store.save(file, image);
  } catch (error) {
    const undo = `${name}'s photo could not be saved`;
    record(ledger, actor, { op: "photo.cleared", person }, undo, `${undo}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  return entry;
}

/** Clears a photo; with a store, its file is deleted too. */
export function clearPhoto(ledger: Ledger, actor: Actor, person: string, store?: PhotoStore): LedgerEntry {
  assertPerson(person);
  const before = replayRoster(ledger.entries()).members.get(person);
  const name = before?.name ?? person;
  const summary = `${name} removed their profile photo`;
  const entry = record(ledger, actor, { op: "photo.cleared", person }, summary, summary);
  if (before?.photo) store?.remove(before.photo.file);
  return entry;
}

export interface DocToShare {
  /** Stable id; defaults to a slug of the title. Sharing the same id again adds a version. */
  doc?: string;
  title: string;
  path: string;
  clauses?: string[];
}

export function docId(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "doc";
}

export function shareDoc(ledger: Ledger, actor: Actor, doc: DocToShare, reason?: string): LedgerEntry {
  const id = doc.doc ?? docId(doc.title);
  if (!isSlug(id)) throw new PeopleError("BAD_DOC", `"${id}" is not a document id (lowercase letters, digits and dashes)`);
  if (!isDocPath(doc.path.trim())) throw new PeopleError("BAD_DOC", `"${doc.path}" must be a path inside the project or an https link`);
  const event: PeopleEvent = { op: "doc.shared", doc: id, title: doc.title.trim(), path: doc.path.trim() };
  if (doc.clauses?.length) event.clauses = [...doc.clauses];
  const again = replayRoster(ledger.entries()).docs.has(id);
  const summary = again ? `New version of ${event.title} shared` : `${event.title} shared with the project`;
  const evidence = /^https:\/\//.test(event.path) ? [event.path] : [`file:${event.path}`];
  return record(ledger, actor, event, summary, reason ?? summary, evidence);
}

export function removeDoc(ledger: Ledger, actor: Actor, doc: string, reason?: string): LedgerEntry {
  if (!isSlug(doc)) throw new PeopleError("BAD_DOC", `"${doc}" is not a document id`);
  const title = replayRoster(ledger.entries()).docs.get(doc)?.title ?? doc;
  const summary = `${title} is no longer shared`;
  return record(ledger, actor, { op: "doc.removed", doc }, summary, reason ?? summary);
}
