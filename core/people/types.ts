import type { EntryType } from "../ledger/index";

/**
 * People on a project (spec §9). Every membership, photo and shared-document
 * change is a ledger entry; the views in this module are rebuilt by replaying
 * the ledger and keep no state of their own.
 */

export const ROLES = ["owner", "helper", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Approvals the owner can grant a helper (§9.2). The owner always has all of them. */
export const APPROVALS = ["plan", "test", "release", "review"] as const;
export type Approval = (typeof APPROVALS)[number];

/** Ledger entry types each approval unlocks. */
export const APPROVAL_TYPES: Record<Approval, readonly EntryType[]> = {
  plan: ["plan.approved", "clause.added", "clause.changed", "clause.withdrawn"],
  test: ["test.approved"],
  release: ["release.cut", "release.rollback"],
  review: ["review.verdict"],
};

/**
 * People operations, carried in `data.people` of a `decision.made` entry
 * (numbered D-n by core/numbering). See README for why they ride on
 * `decision.made` rather than new entry types.
 */
export const PEOPLE_OPS = [
  "member.added",
  "member.changed",
  "member.removed",
  "photo.set",
  "photo.cleared",
  "doc.shared",
  "doc.removed",
] as const;
export type PeopleOp = (typeof PEOPLE_OPS)[number];

export interface MemberAdded {
  op: "member.added";
  person: string;
  name: string;
  role: Role;
  approves?: Approval[];
  /** Agent actor ids that work for this person (§9.5); their entries count as this person's presence. */
  agents?: string[];
}
export interface MemberChanged {
  op: "member.changed";
  person: string;
  name?: string;
  role?: Role;
  approves?: Approval[];
  agents?: string[];
}
export interface MemberRemoved { op: "member.removed"; person: string }
export interface PhotoSet {
  op: "photo.set";
  person: string;
  /** Path relative to the project root, always under .perfect-planner/people/photos/. */
  file: string;
  sha256: string;
  bytes: number;
  mime: PhotoMime;
}
export interface PhotoCleared { op: "photo.cleared"; person: string }
export interface DocShared {
  op: "doc.shared";
  doc: string;
  title: string;
  /** Path relative to the project root, or an https URL. */
  path: string;
  /** Clauses in this version, e.g. ["§1", "§2.1"]. */
  clauses?: string[];
}
export interface DocRemoved { op: "doc.removed"; doc: string }

export type PeopleEvent =
  | MemberAdded
  | MemberChanged
  | MemberRemoved
  | PhotoSet
  | PhotoCleared
  | DocShared
  | DocRemoved;

export const PHOTO_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type PhotoMime = (typeof PHOTO_MIMES)[number];
/** Profile photos are small local images; anything larger is refused. */
export const PHOTO_MAX_BYTES = 512 * 1024;
export const PHOTO_DIR = ".perfect-planner/people/photos";

export interface Photo {
  file: string;
  sha256: string;
  bytes: number;
  mime: PhotoMime;
  /** Ledger entry that set it. */
  entry: string;
}

/** Where a person's work sits in the core loop, from the group of their latest entry type. */
export const STAGES = ["plan", "task", "relay", "git", "proof", "release", "people", "housekeeping"] as const;
export type Stage = (typeof STAGES)[number];

export interface Presence {
  /** Ledger entry the presence is read from. */
  entry: string;
  at: string;
  type: EntryType;
  stage: Stage;
  /** What they last touched: "T-14", "P-2 §3.1", "D-3". */
  subject: string;
  /** The task they are on, when the latest task-related entry names one (T-n). */
  task?: string;
  summary: string;
  /** Actor that wrote it: the person, or one of their agents. */
  via: string;
}

export interface Member {
  person: string;
  name: string;
  role: Role;
  approves: Approval[];
  agents: string[];
  photo?: Photo;
  presence?: Presence;
  /** Ledger entry that added the person. */
  since: string;
}

export interface SharedDoc {
  doc: string;
  title: string;
  path: string;
  /** "v1", "v2" … one per time it was shared; plans use their P-n. */
  version: string;
  clauses: string[];
  kind: "plan" | "document";
  sharedBy: string;
  at: string;
  entry: string;
}

export interface PeopleView {
  /** Members in the order they joined; the owner first. */
  members: Member[];
  owner?: Member;
  docs: SharedDoc[];
  /** Ledger head the view was built from. */
  head?: string;
}
