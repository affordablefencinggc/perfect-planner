// People screen (spec §9): who is on the project, their roles, photos and
// presence, and the documents everyone can see. Everything is read from and
// written to the ledger through core/people; photos live under the project
// root in .perfect-planner/people/photos/ (FilePhotoStore).
import type { Actor } from "../../ledger/index";
import {
  APPROVALS,
  FilePhotoStore,
  PHOTO_MAX_BYTES,
  ROLES,
  addMember,
  buildPeopleView,
  changeMember,
  claimOwnership,
  isSlug,
  photoSources,
  removeMember,
  replayRoster,
  setPhoto,
  shareDoc,
  validatePhoto,
  type Approval,
  type PeopleView,
  type Role,
} from "../../people/index";
import type { CoreProject } from "../project";
import { HttpError, type Router } from "../router";

/** Who is using this app on this computer before anyone is on the roster. */
export const DEFAULT_LOCAL_PERSON = "owner";

/**
 * The person at this computer. This app runs locally for the project's owner,
 * so it is the owner once there is one, else the "owner" slug (solo first:
 * an empty roster restricts nobody). Other screens that write as a person
 * should use this id, or the people rules refuse them once a roster exists.
 */
export function localPersonId(project: CoreProject): string {
  return buildPeopleView(project.entries(), { owner: project.ledger.owner }).owner?.person ?? DEFAULT_LOCAL_PERSON;
}

export function localPerson(project: CoreProject): Actor {
  return { kind: "person", id: localPersonId(project) };
}

function body(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "INVALID", `Please give ${label}.`);
  if (value.trim().length > max) throw new HttpError(400, "INVALID", `${label[0]!.toUpperCase()}${label.slice(1)} is too long (${max} characters at most).`);
  return value.trim();
}

function person(value: unknown): string {
  if (!isSlug(value)) throw new HttpError(400, "BAD_PERSON", "A person id uses lowercase letters, digits and dashes, up to 40 characters.");
  return value;
}

function role(value: unknown): Role {
  if (!(ROLES as readonly unknown[]).includes(value)) throw new HttpError(400, "BAD_ROLE", "The role must be owner, helper or viewer.");
  return value as Role;
}

function approvals(value: unknown): Approval[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((a) => (APPROVALS as readonly unknown[]).includes(a))) {
    throw new HttpError(400, "INVALID", "Approvals must be some of plan, test, release and review.");
  }
  return [...new Set(value as Approval[])];
}

export interface PeopleResult {
  view: PeopleView;
  photos: Record<string, string>;
  /** The person at this computer. */
  me: string;
  /** True when nobody is on the roster yet: the first person added becomes the owner. */
  firstRun: boolean;
  /** The person who first wrote to this project; only they may become its owner. */
  starter?: string;
  /**
   * True when this device has no owner key for the project (lost, or not pinned yet): nobody can
   * add people or share documents here, so the screen says so instead of offering "Add the first person".
   */
  ownerMissing?: boolean;
}

/** Who may become the owner: the person whose key is pinned as the owner key. */
function starter(project: CoreProject): string | undefined {
  if (!project.ledger.ownerKeyPinned) return undefined;
  return replayRoster(project.entries(), project.ledger.owner).pinnedOwner ?? (project.entries().some((e) => e.actor?.kind === "person") ? undefined : DEFAULT_LOCAL_PERSON);
}

/** No owner key for this project on this device: nobody can start the roster or share documents here. */
function ownerMissing(project: CoreProject): boolean {
  return !project.ledger.ownerKeyPinned;
}

function peopleResult(project: CoreProject): PeopleResult {
  const view = buildPeopleView(project.entries(), { owner: project.ledger.owner });
  return {
    view,
    photos: photoSources(view, new FilePhotoStore(project.root)),
    me: view.owner?.person ?? DEFAULT_LOCAL_PERSON,
    firstRun: view.members.length === 0 && !ownerMissing(project),
    ...(view.members.length === 0 && starter(project) ? { starter: starter(project) } : {}),
    ...(ownerMissing(project) ? { ownerMissing: true } : {}),
  };
}

/** Decodes a base64 (or data: URL) image and checks it before anything is written. */
function decodePhoto(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value) throw new HttpError(400, "INVALID", "Please choose an image.");
  const b64 = value.replace(/^data:[^;,]*;base64,/, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new HttpError(400, "INVALID", "The image could not be read.");
  if (Math.floor((b64.replace(/\s/g, "").length * 3) / 4) > PHOTO_MAX_BYTES + 2) {
    throw new HttpError(413, "PHOTO_TOO_LARGE", "Photos must be 512 KB or smaller.");
  }
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  validatePhoto(bytes); // PeopleError (422) for empty, too large or not PNG/JPEG/WebP/GIF
  return bytes;
}

export function registerPeopleRoutes(router: Router): void {
  router.get("/people", ({ project }) => peopleResult(project));

  // First run: the first person added becomes the owner (and the person at this computer).
  router.post("/people/claim", ({ project, body: raw, host }) => {
    const b = body(raw);
    if (buildPeopleView(project.entries(), { owner: project.ledger.owner }).members.length > 0) throw new HttpError(409, "HAS_OWNER", "This project already has an owner.");
    const id = person(b.person ?? DEFAULT_LOCAL_PERSON);
    host.ensurePersonKey(id); // the person naming themselves, in their own window
    const entry = claimOwnership(project.ledger, { kind: "person", id }, text(b.name, "a name"));
    return { entry: entry.n, ...peopleResult(project) };
  });

  router.post("/people/members", ({ project, body: raw, host }) => {
    const b = body(raw);
    const id = person(b.person);
    const name = text(b.name, "a name");
    const r = b.role === undefined ? undefined : role(b.role);
    const roster = buildPeopleView(project.entries(), { owner: project.ledger.owner });
    if (roster.members.length === 0) {
      if (r !== undefined && r !== "owner") throw new HttpError(422, "FIRST_IS_OWNER", "The first person on a project is its owner. Add yourself as owner first, then add helpers.");
      host.ensurePersonKey(id);
      const entry = claimOwnership(project.ledger, { kind: "person", id }, name);
      return { entry: entry.n, ...peopleResult(project) };
    }
    const entry = addMember(project.ledger, localPerson(project), { person: id, name, role: r ?? "helper", approves: approvals(b.approves) });
    return { entry: entry.n, ...peopleResult(project) };
  });

  router.post("/people/members/:person/role", ({ project, params, body: raw }) => {
    const b = body(raw);
    const change: { role: Role; approves?: Approval[] } = { role: role(b.role) };
    const a = approvals(b.approves);
    if (a !== undefined) change.approves = a;
    else if (change.role !== "helper") change.approves = [];
    const entry = changeMember(project.ledger, localPerson(project), person(params.person), change);
    return { entry: entry.n, ...peopleResult(project) };
  });

  router.post("/people/members/:person/remove", ({ project, params, body: raw }) => {
    const b = body(raw);
    const reason = b.reason === undefined ? undefined : text(b.reason, "a reason", 500);
    const entry = removeMember(project.ledger, localPerson(project), person(params.person), reason);
    return { entry: entry.n, ...peopleResult(project) };
  });

  router.post("/people/photo", ({ project, body: raw }) => {
    const b = body(raw);
    const me = localPerson(project);
    const target = b.person === undefined ? me.id : person(b.person);
    const bytes = decodePhoto(b.image);
    const entry = setPhoto(project.ledger, new FilePhotoStore(project.root), me, target, bytes);
    return { entry: entry.n, ...peopleResult(project) };
  });

  router.post("/people/docs", ({ project, body: raw }) => {
    const b = body(raw);
    const title = text(b.title, "a document title");
    const path = text(b.path, "a document path", 500);
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^https:\/\//i.test(path)) throw new HttpError(400, "INVALID", "Share a path inside the project or an https link.");
    if (path.split(/[\\/]/).includes("..") || path.startsWith("/")) throw new HttpError(400, "INVALID", "Share a path inside the project, like specs/plan.md.");
    const entry = shareDoc(project.ledger, localPerson(project), { title, path });
    return { entry: entry.n, ...peopleResult(project) };
  });
}
