import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PeopleError } from "./errors";
import {
  FilePhotoStore,
  MemoryPhotoStore,
  isPhotoFile,
  loadPhoto,
  photoDataUrl,
  photoExtension,
  photoFile,
  sniffPhoto,
  validatePhoto,
} from "./photos";
import { PHOTO_DIR, PHOTO_MAX_BYTES } from "./types";

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

/** A fake image: the given header followed by deterministic padding. */
function fake(header: number[], size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 37 + 11) & 0xff;
  bytes.set(header, 0);
  return bytes;
}

const PNG = fake([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = fake([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = fake([...ascii("RIFF"), 0x20, 0x00, 0x00, 0x00, ...ascii("WEBP"), ...ascii("VP8 ")]);
const GIF87 = fake(ascii("GIF87a"));
const GIF89 = fake(ascii("GIF89a"));

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof PeopleError ? err.code : `not a PeopleError: ${String(err)}`;
  }
  return undefined;
}

describe("sniffPhoto", () => {
  it("detects PNG by its 8-byte signature", () => {
    expect(sniffPhoto(PNG)).toBe("image/png");
  });

  it("detects JPEG by its FF D8 FF prefix", () => {
    expect(sniffPhoto(JPEG)).toBe("image/jpeg");
  });

  it("detects WebP by RIFF at 0 and WEBP at offset 8", () => {
    expect(sniffPhoto(WEBP)).toBe("image/webp");
  });

  it("detects GIF87a and GIF89a", () => {
    expect(sniffPhoto(GIF87)).toBe("image/gif");
    expect(sniffPhoto(GIF89)).toBe("image/gif");
  });

  it("refuses RIFF files that are not WebP (e.g. WAV)", () => {
    expect(sniffPhoto(fake([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]))).toBeUndefined();
  });

  it("refuses a PNG signature with one byte wrong", () => {
    expect(sniffPhoto(fake([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]))).toBeUndefined();
  });

  it("refuses SVG text", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(sniffPhoto(svg)).toBeUndefined();
  });

  it("refuses bytes too short to hold a signature", () => {
    expect(sniffPhoto(new Uint8Array([0x89, 0x50]))).toBeUndefined();
    expect(sniffPhoto(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
    expect(sniffPhoto(new Uint8Array(0))).toBeUndefined();
  });

  it("ignores the file type claimed by the bytes' name: only magic bytes count", () => {
    // A JPEG-looking payload is JPEG no matter what it is called; a PNG name on SVG text is still refused.
    expect(sniffPhoto(JPEG)).toBe("image/jpeg");
    expect(sniffPhoto(new TextEncoder().encode("<svg/>"))).toBeUndefined();
  });
});

describe("validatePhoto", () => {
  it("returns mime, size and lowercase sha256 for a valid image", () => {
    const result = validatePhoto(PNG);
    expect(result).toEqual({ mime: "image/png", bytes: PNG.length, sha256: sha(PNG) });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computes the known sha256 of a fixed input", () => {
    const abc = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x61, 0x62, 0x63]);
    expect(validatePhoto(abc).sha256).toBe(sha(abc));
    expect(sha(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("accepts exactly PHOTO_MAX_BYTES", () => {
    const max = fake([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], PHOTO_MAX_BYTES);
    expect(max.length).toBe(PHOTO_MAX_BYTES);
    expect(validatePhoto(max).bytes).toBe(PHOTO_MAX_BYTES);
  });

  it("refuses PHOTO_MAX_BYTES + 1 with PHOTO_TOO_LARGE", () => {
    const over = fake([0xff, 0xd8, 0xff], PHOTO_MAX_BYTES + 1);
    expect(codeOf(() => validatePhoto(over))).toBe("PHOTO_TOO_LARGE");
  });

  it("refuses an empty photo with PHOTO_TOO_LARGE", () => {
    expect(codeOf(() => validatePhoto(new Uint8Array(0)))).toBe("PHOTO_TOO_LARGE");
  });

  it("refuses SVG text with PHOTO_TYPE", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(codeOf(() => validatePhoto(svg))).toBe("PHOTO_TYPE");
  });

  it("refuses random bytes with PHOTO_TYPE", () => {
    const random = new Uint8Array(100);
    for (let i = 0; i < random.length; i++) random[i] = (i * 91 + 3) & 0xff;
    expect(random[0]).not.toBe(0x89);
    expect(codeOf(() => validatePhoto(random))).toBe("PHOTO_TYPE");
  });

  it("refuses an oversized non-image with PHOTO_TOO_LARGE before checking type", () => {
    const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
    expect(codeOf(() => validatePhoto(big))).toBe("PHOTO_TOO_LARGE");
  });
});

describe("photoExtension", () => {
  it("maps each mime to its extension", () => {
    expect(photoExtension("image/png")).toBe("png");
    expect(photoExtension("image/jpeg")).toBe("jpg");
    expect(photoExtension("image/webp")).toBe("webp");
    expect(photoExtension("image/gif")).toBe("gif");
  });
});

describe("photoFile", () => {
  const hash = "0123456789abcdef".repeat(4);

  it("builds <PHOTO_DIR>/<person>-<12 hex>.<ext> with forward slashes", () => {
    const file = photoFile("bob", hash, "image/jpeg");
    expect(file).toBe(`${PHOTO_DIR}/bob-0123456789ab.jpg`);
    expect(file).not.toContain("\\");
    expect(file.startsWith(PHOTO_DIR + "/")).toBe(true);
  });

  it("uses only the first 12 hash characters", () => {
    expect(photoFile("ann", hash, "image/png")).toBe(`${PHOTO_DIR}/ann-0123456789ab.png`);
  });

  it("produces a path that isPhotoFile accepts", () => {
    expect(isPhotoFile(photoFile("looplet-spare", hash, "image/webp"))).toBe(true);
  });

  it.each(["../x", "Bob", "", "a/b", "bob.evil", "-bob"])("throws BAD_PERSON for %j", (person) => {
    expect(codeOf(() => photoFile(person, hash, "image/png"))).toBe("BAD_PERSON");
  });
});

describe("isPhotoFile", () => {
  const good = `${PHOTO_DIR}/bob-0123456789ab.png`;

  it("accepts a path photoFile produces, for each extension", () => {
    expect(isPhotoFile(good)).toBe(true);
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789ab.jpg`)).toBe(true);
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789ab.webp`)).toBe(true);
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789ab.gif`)).toBe(true);
  });

  it("rejects parent-directory traversal", () => {
    expect(isPhotoFile(`${PHOTO_DIR}/../bob-0123456789ab.png`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}/bob/../../x-0123456789ab.png`)).toBe(false);
    expect(isPhotoFile(`../${PHOTO_DIR}/bob-0123456789ab.png`)).toBe(false);
  });

  it("rejects backslashes", () => {
    expect(isPhotoFile(`${PHOTO_DIR.replace(/\//g, "\\")}\\bob-0123456789ab.png`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}\\bob-0123456789ab.png`)).toBe(false);
  });

  it("rejects absolute paths", () => {
    expect(isPhotoFile(`/${good}`)).toBe(false);
    expect(isPhotoFile(`C:/${good}`)).toBe(false);
    expect(isPhotoFile(`/etc/passwd`)).toBe(false);
  });

  it("rejects wrong or missing extensions", () => {
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789ab.svg`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789ab.PNG`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789ab.png.exe`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789ab`)).toBe(false);
  });

  it("rejects a hash that is not exactly 12 lowercase hex", () => {
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789a.png`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789abc.png`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789AB.png`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789xz.png`)).toBe(false);
  });

  it("rejects a bad person slug", () => {
    expect(isPhotoFile(`${PHOTO_DIR}/Bob-0123456789ab.png`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}/-0123456789ab.png`)).toBe(false);
  });

  it("rejects files outside the photo directory", () => {
    expect(isPhotoFile("bob-0123456789ab.png")).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}/sub/bob-0123456789ab.png`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}x/bob-0123456789ab.png`)).toBe(false);
    expect(isPhotoFile(`${PHOTO_DIR}/bob-0123456789ab.png\n`)).toBe(false);
    expect(isPhotoFile("")).toBe(false);
  });
});

describe("FilePhotoStore", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function tempRoot(): string {
    dir = mkdtempSync(path.join(os.tmpdir(), "pp-photos-"));
    return dir;
  }

  const file = `${PHOTO_DIR}/bob-0123456789ab.png`;

  it("round-trips bytes through disk", () => {
    const store = new FilePhotoStore(tempRoot());
    store.save(file, PNG);
    expect(store.load(file)).toEqual(PNG);
    expect(existsSync(path.join(dir!, ...file.split("/")))).toBe(true);
  });

  it("creates the photo directory on first save", () => {
    const root = tempRoot();
    new FilePhotoStore(root).save(file, PNG);
    expect(readdirSync(path.join(root, ...PHOTO_DIR.split("/")))).toEqual(["bob-0123456789ab.png"]);
  });

  it("returns undefined for a photo that does not exist", () => {
    const store = new FilePhotoStore(tempRoot());
    expect(store.load(file)).toBeUndefined();
  });

  it("leaves no temp files behind after save", () => {
    const root = tempRoot();
    const store = new FilePhotoStore(root);
    store.save(file, PNG);
    store.save(file, JPEG);
    const entries = readdirSync(path.join(root, ...PHOTO_DIR.split("/")));
    expect(entries).toEqual(["bob-0123456789ab.png"]);
  });

  it.each([
    ["traversal", "../x.png"],
    ["absolute", "/etc/passwd"],
    ["backslash", `${PHOTO_DIR}\\bob-0123456789ab.png`],
    ["wrong extension", `${PHOTO_DIR}/bob-0123456789ab.svg`],
  ])("refuses a %s path on save and load with PHOTO_PATH", (_label, bad) => {
    const store = new FilePhotoStore(tempRoot());
    expect(codeOf(() => store.save(bad, PNG))).toBe("PHOTO_PATH");
    expect(codeOf(() => store.load(bad))).toBe("PHOTO_PATH");
  });

  it("loadPhoto returns undefined when the file was tampered with", () => {
    const root = tempRoot();
    const store = new FilePhotoStore(root);
    store.save(file, PNG);
    const photo = { file, sha256: sha(PNG) };
    expect(loadPhoto(store, photo)).toEqual(PNG);
    writeFileSync(path.join(root, ...file.split("/")), JPEG);
    expect(loadPhoto(store, photo)).toBeUndefined();
  });
});

describe("MemoryPhotoStore", () => {
  it("round-trips and copies bytes on save and load", () => {
    const store = new MemoryPhotoStore();
    const original = new Uint8Array(PNG);
    store.save(`${PHOTO_DIR}/bob-0123456789ab.png`, original);
    original[0] = 0;
    const loaded = store.load(`${PHOTO_DIR}/bob-0123456789ab.png`)!;
    expect(loaded).toEqual(PNG);
    loaded[0] = 0;
    expect(store.load(`${PHOTO_DIR}/bob-0123456789ab.png`)).toEqual(PNG);
  });

  it("returns undefined for a missing photo", () => {
    expect(new MemoryPhotoStore().load(`${PHOTO_DIR}/bob-0123456789ab.png`)).toBeUndefined();
  });
});

describe("loadPhoto", () => {
  it("returns bytes whose sha256 matches", () => {
    const store = new MemoryPhotoStore();
    const file = `${PHOTO_DIR}/bob-0123456789ab.gif`;
    store.save(file, GIF89);
    expect(loadPhoto(store, { file, sha256: sha(GIF89) })).toEqual(GIF89);
  });

  it("returns undefined when the stored bytes no longer match the hash", () => {
    const store = new MemoryPhotoStore();
    const file = `${PHOTO_DIR}/bob-0123456789ab.gif`;
    store.save(file, GIF89);
    expect(loadPhoto(store, { file, sha256: sha(GIF87) })).toBeUndefined();
  });

  it("returns undefined when the photo is missing", () => {
    const file = `${PHOTO_DIR}/bob-0123456789ab.gif`;
    expect(loadPhoto(new MemoryPhotoStore(), { file, sha256: sha(GIF89) })).toBeUndefined();
  });
});

describe("photoDataUrl", () => {
  it("prefixes with the mime and base64 encodes the bytes", () => {
    const url = photoDataUrl(PNG, "image/png");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const encoded = url.slice("data:image/png;base64,".length);
    expect(Buffer.from(encoded, "base64")).toEqual(Buffer.from(PNG));
  });

  it("works on a view with a non-zero byteOffset", () => {
    const backing = new Uint8Array([0, 0, ...PNG]);
    const view = backing.subarray(2);
    expect(photoDataUrl(view, "image/png")).toBe(photoDataUrl(PNG, "image/png"));
  });
});
