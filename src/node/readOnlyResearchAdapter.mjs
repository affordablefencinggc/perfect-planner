import { createHash } from "node:crypto";

const DEFAULT_MAX_BYTES = 512_000;
const localNames = new Set(["localhost", "localhost.localdomain"]);

function checkedUrl(value, allowedOrigins) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || localNames.has(url.hostname) || url.hostname.endsWith(".local")) throw new Error("Research sources require credential-free public HTTPS URLs.");
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/.test(url.hostname)) throw new Error("Research sources cannot target local or private addresses.");
  if (!allowedOrigins.has(url.origin)) throw new Error(`Research origin ${url.origin} is not approved.`);
  return url;
}

async function boundedBytes(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("Research response exceeds its byte ceiling.");
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Research response exceeds its byte ceiling.");
    return bytes;
  }
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > maxBytes) throw new Error("Research response exceeds its byte ceiling."); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
}

export function createReadOnlyResearchAdapter(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRequests = options.maxRequests ?? 8;
  if (!allowedOrigins.size) throw new Error("At least one exact research origin is required.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("Research limits must be positive safe integers.");

  async function read(request) {
    const url = checkedUrl(request?.url, allowedOrigins);
    if (!String(request?.sourceId ?? "").trim() || !String(request?.evidenceKind ?? "").trim()) throw new Error("Research sourceId and evidenceKind are required.");
    const response = await fetchImpl(url, { method: "GET", redirect: "error", credentials: "omit", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Research source ${request.sourceId} returned HTTP ${response.status}.`);
    const contentType = response.headers?.get?.("content-type") ?? ""; if (!contentType.toLowerCase().includes("application/json")) throw new Error("Research sources must return JSON evidence.");
    const bytes = await boundedBytes(response, maxBytes); let data; try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Research source returned invalid JSON."); }
    return Object.freeze({ sourceId: request.sourceId, evidenceKind: request.evidenceKind, sourceUrl: url.href, capturedAt: request.capturedAt ?? new Date().toISOString(), byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), data, authority: "UNTRUSTED_EXTERNAL_EVIDENCE", action: "ASSESS_ONLY" });
  }

  return Object.freeze({
    read,
    async readBatch(requests) {
      if (!Array.isArray(requests) || requests.length === 0 || requests.length > maxRequests) throw new Error(`Research batches require 1-${maxRequests} requests.`);
      const seen = new Set(); for (const request of requests) { if (seen.has(request.sourceId)) throw new Error(`Duplicate research sourceId ${request.sourceId}.`); seen.add(request.sourceId); }
      const records = []; for (const request of requests) records.push(await read(request)); return Object.freeze(records);
    },
  });
}
