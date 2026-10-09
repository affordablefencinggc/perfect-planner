import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PeopleError, assertPerson } from "./errors";
import { PHOTO_DIR, PHOTO_MAX_BYTES, type Photo, type PhotoMime } from "./types";

/**
 * Profile photos (spec §9). Type is decided by the bytes, never by the file
 * name. Only raster images are accepted; SVG can carry script and is refused.
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIG = [0xff, 0xd8, 0xff];

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

/** Detects the image type from its magic bytes, or undefined for anything else. */
export function sniffPhoto(bytes: Uint8Array): PhotoMime | undefined {
  if (startsWith(bytes, PNG_SIG)) return "image/png";
  if (startsWith(bytes, JPEG_SIG)) return "image/jpeg";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  return undefined;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Checks size and type of a candidate photo and returns what the ledger records. */
export function validatePhoto(bytes: Uint8Array): { mime: PhotoMime; bytes: number; sha256: string } {
  if (bytes.length === 0 || bytes.length > PHOTO_MAX_BYTES) {
    throw new PeopleError(
      "PHOTO_TOO_LARGE",
      bytes.length === 0
        ? "photo is empty"
        : `photo is ${bytes.length} bytes; the limit is ${PHOTO_MAX_BYTES}`,
    );
  }
  const mime = sniffPhoto(bytes);
  if (!mime) throw new PeopleError("PHOTO_TYPE", "photo must be a PNG, JPEG, WebP or GIF image");
  return { mime, bytes: bytes.length, sha256: sha256Hex(bytes) };
}

const EXTENSION: Record<PhotoMime, "png" | "jpg" | "webp" | "gif"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function photoExtension(mime: PhotoMime): "png" | "jpg" | "webp" | "gif" {
  return EXTENSION[mime];
}

/** Project-relative POSIX path for a photo, e.g. ".perfect-planner/people/photos/bob-1a2b3c4d5e6f.png". */
export function photoFile(person: string, sha256: string, mime: PhotoMime): string {
  assertPerson(person);
  return `${PHOTO_DIR}/${person}-${sha256.slice(0, 12)}.${photoExtension(mime)}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Same slug rule as core/people/errors.ts, followed by 12 hex digits and a known extension.
const PHOTO_FILE = new RegExp(
  "^" +
    escapeRegExp(PHOTO_DIR) +
    "/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?-[0-9a-f]{12}\\.(?:png|jpg|webp|gif)$",
);

/** True only for a path that photoFile() could have produced. */
export function isPhotoFile(file: string): boolean {
  return typeof file === "string" && PHOTO_FILE.test(file);
}

export interface PhotoStore {
  save(file: string, bytes: Uint8Array): void;
  load(file: string): Uint8Array | undefined;
  /** Deletes the file; does nothing when it is already gone. */
  remove(file: string): void;
}

/** In-memory store, for tests and for previews that never touch disk. */
export class MemoryPhotoStore implements PhotoStore {
  private readonly files = new Map<string, Uint8Array>();

  save(file: string, bytes: Uint8Array): void {
    this.files.set(file, new Uint8Array(bytes));
  }

  load(file: string): Uint8Array | undefined {
    const bytes = this.files.get(file);
    return bytes ? new Uint8Array(bytes) : undefined;
  }

  remove(file: string): void {
    this.files.delete(file);
  }
}

/** Photos on disk under `root`, which is the project root. */
export class FilePhotoStore implements PhotoStore {
  constructor(private readonly root: string) {}

  private resolve(file: string): string {
    if (!isPhotoFile(file)) throw new PeopleError("PHOTO_PATH", `"${file}" is not a photo path`);
    return path.join(this.root, ...file.split("/"));
  }

  save(file: string, bytes: Uint8Array): void {
    const target = this.resolve(file);
    mkdirSync(path.dirname(target), { recursive: true });
    // Write beside the target, then rename, so a crash never leaves a half-written photo.
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, bytes);
      renameSync(temp, target);
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
  }

  remove(file: string): void {
    rmSync(this.resolve(file), { force: true });
  }

  load(file: string): Uint8Array | undefined {
    try {
      return new Uint8Array(readFileSync(this.resolve(file)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
}

/** Loads a photo only if its bytes still match the hash in the ledger. */
export function loadPhoto(store: PhotoStore, photo: Pick<Photo, "file" | "sha256">): Uint8Array | undefined {
  const bytes = store.load(photo.file);
  if (!bytes || sha256Hex(bytes) !== photo.sha256) return undefined;
  return bytes;
}

export function photoDataUrl(bytes: Uint8Array, mime: PhotoMime): string {
  return `data:${mime};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
}
