// Canonical JSON and entry hashing for the Perfect Planner ledger (Core Spec §2).
// Canonical form: object keys sorted recursively, no whitespace, undefined object
// members omitted. The entry hash is sha256 hex over the canonical JSON of the
// entry WITHOUT its `hash` field (the `prev` link is included).
import { createHash } from "node:crypto";

export function canonicalJson(value) {
  return serialize(value);
}

function serialize(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite numbers are not representable");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : serialize(item))).join(",")}]`;
      if (typeof value.toJSON === "function") return serialize(value.toJSON());
      const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function entryHash(entryWithoutHash) {
  if (!entryWithoutHash || typeof entryWithoutHash !== "object") throw new TypeError("entryHash: entry object required");
  const { hash: _ignored, ...rest } = entryWithoutHash;
  return sha256Hex(canonicalJson(rest));
}
