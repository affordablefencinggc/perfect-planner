export type PeopleErrorCode =
  | "BAD_PERSON"
  | "BAD_ROLE"
  | "BAD_DOC"
  | "PHOTO_TYPE"
  | "PHOTO_TOO_LARGE"
  | "PHOTO_PATH"
  | "PHOTO_MISSING"
  | "STORED_VIOLATION"
  | "NO_OWNER_KEY";

export class PeopleError extends Error {
  readonly code: PeopleErrorCode;
  constructor(code: PeopleErrorCode, message: string) {
    super(message);
    this.name = "PeopleError";
    this.code = code;
  }
}

/** Person and document ids are lowercase slugs, safe in file names on every OS: "looplet-spare". */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function isSlug(id: unknown): id is string {
  return typeof id === "string" && SLUG.test(id);
}

export function assertPerson(id: unknown): asserts id is string {
  if (!isSlug(id)) throw new PeopleError("BAD_PERSON", `"${String(id)}" is not a person id (lowercase letters, digits and dashes)`);
}
