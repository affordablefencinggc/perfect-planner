import { verifyLedger } from "./collisionEngine.js";
import { boundedFetch } from "../runtime/boundedFetch.js";

const unavailable = (planId, censusDigest, reason = "Durable collision authority is unavailable.") => ({
  schemaVersion: 1, planId, censusDigest, authority: "none", authoritative: false,
  revision: 0, headHash: "GENESIS", approvedIds: [], ledger: [], reason,
});

export function createHttpCollisionAuthorityAdapter({ baseUrl = "/api/collision-authority", fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  let token = null;
  const request = async (method, payload) => {
    if (!fetchImpl) throw new Error("HTTP transport is unavailable.");
    if (!token) {
      const session = await boundedFetch(`${baseUrl}/session`, { credentials: "same-origin", headers: { accept: "application/json" } }, { fetchImpl, timeoutMs });
      if (!session.ok) throw new Error(`Authority session refused (${session.status}).`);
      token = (await session.json()).token;
      if (!token) throw new Error("Authority session returned no capability token.");
    }
    const response = await boundedFetch(`${baseUrl}/${method}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pp-authority-token": token }, body: JSON.stringify(payload) }, { fetchImpl, timeoutMs });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? `Authority request refused (${response.status}).`);
    return result;
  };
  return { inspect: (payload) => request("inspect", payload), approve: (payload) => request("approve", payload), commit: (payload) => request("commit", payload) };
}

async function validateSnapshot(value, expected) {
  if (!value || value.schemaVersion !== 1) throw new Error("Authority response has an unsupported schema.");
  if (value.authority !== "native-journal" || value.authoritative !== true) throw new Error("Authority response is not native and verified.");
  if (value.planId !== expected.planId || value.censusDigest !== expected.censusDigest) throw new Error("Authority response is bound to a different plan census.");
  if (!Number.isInteger(value.revision) || value.revision < 0 || value.revision !== value.ledger?.length) throw new Error("Authority revision does not match its ledger.");
  const verification = await verifyLedger(value.ledger);
  if (!verification.valid) throw new Error(`Authority ledger is broken at ${verification.brokenAt}.`);
  const headHash = value.ledger.at(-1)?.hash ?? "GENESIS";
  if (value.headHash !== headHash) throw new Error("Authority head hash does not match its ledger.");
  const recorded = new Set(value.ledger.filter((entry) => entry.type === "collision.order-approved" && entry.payload?.censusDigest === expected.censusDigest).map((entry) => entry.payload.collisionId));
  const approved = [...new Set(value.approvedIds ?? [])].sort();
  if (approved.some((id) => !recorded.has(id))) throw new Error("Authority claims an approval absent from its ledger.");
  return { ...value, approvedIds: approved };
}

export function createCollisionAuthorityClient({ planId, adapter } = {}) {
  if (!planId) throw new Error("planId is required.");
  let last = null;
  const accept = async (raw, censusDigest) => {
    const next = await validateSnapshot(raw, { planId, censusDigest });
    if (last && next.censusDigest === last.censusDigest) {
      if (next.revision < last.revision) throw new Error("Stale authority revision rejected.");
      if (next.revision === last.revision && next.headHash !== last.headHash) throw new Error("Conflicting authority head rejected.");
    }
    last = next;
    return next;
  };
  const call = async (method, censusDigest, payload = {}) => {
    if (!adapter?.[method]) return unavailable(planId, censusDigest);
    try {
      return await accept(await adapter[method]({ planId, censusDigest, expectedRevision: last?.censusDigest === censusDigest ? last.revision : 0, expectedHeadHash: last?.censusDigest === censusDigest ? last.headHash : "GENESIS", ...payload }), censusDigest);
    } catch (error) {
      return unavailable(planId, censusDigest, `Authority rejected: ${error.message}`);
    }
  };
  return {
    available: Boolean(adapter),
    inspect: (censusDigest) => call("inspect", censusDigest),
    approve: (censusDigest, collision) => call("approve", censusDigest, { collision }),
    commit: (censusDigest, assessment) => call("commit", censusDigest, { assessment }),
  };
}
