import { boundedFetch } from "./boundedFetch.js";
import { verifyArchitectureContract } from "../engine/architectureContractVerification.js";

async function request(operation, body, token) {
  const response = await boundedFetch(`/api/architecture-contract/${operation}`, {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", ...(token ? { "x-pp-architecture-token": token } : {}) },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Architecture service unavailable.");
  return result;
}
async function session() {
  const identity = await request("session", {});
  if (!identity.actor || !identity.token) throw new Error("Architecture session is incomplete.");
  return identity;
}
function checkedState(state, planId, actor) {
  if (state.valid !== true || state.planId !== planId) throw new Error("Architecture receipt belongs to a different project or is invalid.");
  return { ...state, actor, headDigest: state.head?.contractDigest ?? null };
}
export async function inspectArchitecture(planId) {
  const identity = await session();
  return checkedState(await request("inspect", { planId }, identity.token), planId, identity.actor);
}
export async function publishArchitecture(planId, contract, { expectedHeadDigest, actor }) {
  const verification = await verifyArchitectureContract(contract);
  if (!verification.valid || contract.planId !== planId || contract.actor !== actor)
    throw new Error("Review does not match this project and approver.");
  const identity = await session();
  if (identity.actor !== actor) throw new Error("Approver changed. Review again.");
  const receipt = await request("publish", { contract, supersedes: expectedHeadDigest }, identity.token);
  const state = checkedState(await request("inspect", { planId }, identity.token), planId, identity.actor);
  if (receipt.contractDigest !== contract.digest || state.headDigest !== contract.digest || state.head?.revision !== receipt.revision)
    throw new Error("Publication outcome needs reconciliation. Refresh saved architecture before retrying.");
  return state;
}
