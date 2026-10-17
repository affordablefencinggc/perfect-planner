// A key that cannot leak by accident: printing, logging, JSON-encoding or
// string-concatenating it yields "[redacted]". Only reveal() returns the
// value, and only the Jev transport calls it, to build one request header.
import { inspect } from "node:util";

const REDACTED = "[redacted]";
const values = new WeakMap<SecretKey, string>();

export class SecretKey {
  constructor(value: string) {
    values.set(this, value);
    Object.freeze(this);
  }

  reveal(): string {
    return values.get(this) ?? "";
  }

  /** Remove every occurrence of the key from text that is about to leave (errors, logs). */
  scrub(text: string): string {
    const value = this.reveal();
    return value.length >= 4 ? text.split(value).join(REDACTED) : text;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `SecretKey(${REDACTED})`;
  }
}

/** Same rules as PR #2's Settings field (src-tauri/src/jev_keychain.rs validate_key). */
export function validateKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw new Error("Enter a key before saving.");
  if (Buffer.byteLength(key, "utf8") > 512) throw new Error("That key is longer than 512 characters.");
  if (/[\p{Cc}]/u.test(key)) throw new Error("The key contains control characters.");
  return key;
}
