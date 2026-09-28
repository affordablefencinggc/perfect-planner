import { createHash } from "node:crypto";
import path from "node:path";

const CAPABILITIES = Object.freeze({
  "filesystem.read": { scope: "roots", proof: ["resolved path", "content hash"] },
  "filesystem.write": { scope: "roots", human: true, proof: ["resolved path", "before hash", "after hash"] },
  "process.execute": { scope: "executables", proof: ["executable", "arguments", "exit", "output hash"] },
  "network.request": { scope: "hosts", proof: ["HTTPS host", "method", "response hash"] },
  "secret.use": { scope: "providers", proof: ["secret handle", "provider", "redacted result"] },
  "git.write": { scope: "refs", human: true, proof: ["repository", "ref", "before SHA", "after SHA"] },
  "screen.capture": { scope: "surfaces", human: true, proof: ["surface", "image hash", "viewing attestation"] },
  "update.install": { scope: "channels", human: true, proof: ["signed manifest", "publisher", "package hash"] },
  "device.control": { scope: "devices", human: true, autopilotForbidden: true, proof: ["device identity", "user gesture", "action journal"] },
});

const SHELLS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "sh", "zsh", "fish"]);
const INLINE_EVAL = new Set(["-e", "--eval", "-c", "/c", "/k", "-command", "-encodedcommand"]);
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const stable = (value) => JSON.stringify(canonical(value));
const digest = (value) => createHash("sha256").update(stable(value)).digest("hex");
const cleanList = (value) => [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))].sort();

function contained(candidate, root) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function deny(operationHash, capability, reason, proof = []) {
  return Object.freeze({ allowed: false, capability, operationHash, reasons: [reason], requiredProof: proof });
}

export function compileNativeCapabilityPolicy(input = {}) {
  if (!String(input.planId ?? "").trim() || !String(input.taskId ?? "").trim()) throw new Error("Native capability policy requires exact plan and task identities.");
  if (input.defaultDecision && input.defaultDecision !== "deny") throw new Error("Native capability policy is deny-by-default and cannot be relaxed.");
  const grants = [];
  for (const candidate of input.grants ?? []) {
    const capability = String(candidate.capability ?? "");
    const definition = CAPABILITIES[capability];
    if (!definition) throw new Error(`Unknown native capability: ${capability || "(blank)"}.`);
    if (grants.some((grant) => grant.capability === capability)) throw new Error(`Duplicate native capability grant: ${capability}.`);
    const values = cleanList(candidate[definition.scope]);
    if (values.length === 0 || values.some((value) => value === "*" || value.includes("**"))) throw new Error(`${capability} requires bounded ${definition.scope}; wildcards are forbidden.`);
    grants.push(Object.freeze({ capability, [definition.scope]: values, expiresAt: candidate.expiresAt ?? null, sessionId: candidate.sessionId ?? null }));
  }
  const policy = {
    schemaVersion: 1,
    planId: String(input.planId),
    taskId: String(input.taskId),
    mode: input.mode === "autopilot" ? "autopilot" : "interactive",
    defaultDecision: "deny",
    grants: grants.sort((a, b) => a.capability.localeCompare(b.capability)),
  };
  return Object.freeze({ ...policy, policyHash: digest(policy) });
}

export function nativeOperationHash(policy, request = {}) {
  return digest({ policyHash: policy.policyHash, planId: policy.planId, taskId: policy.taskId, capability: request.capability ?? null, target: request.target ?? null, action: request.action ?? null, sessionId: request.sessionId ?? null });
}

export function authorizeNativeOperation(policy, request = {}, context = {}) {
  if (!policy?.policyHash || policy.defaultDecision !== "deny") throw new Error("A compiled deny-by-default capability policy is required.");
  const capability = String(request.capability ?? "");
  const definition = CAPABILITIES[capability];
  const operationHash = nativeOperationHash(policy, request);
  if (!definition) return deny(operationHash, capability, "Unknown capabilities are denied.");
  const grant = policy.grants.find((item) => item.capability === capability);
  if (!grant) return deny(operationHash, capability, "No exact capability grant exists.", definition.proof);
  if (request.planId !== policy.planId || request.taskId !== policy.taskId) return deny(operationHash, capability, "Operation identity does not match the policy plan and task.", definition.proof);
  if (grant.sessionId && request.sessionId !== grant.sessionId) return deny(operationHash, capability, "Operation session does not match the capability lease.", definition.proof);
  const now = Number(context.now ?? Date.now());
  if (grant.expiresAt && (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now)) return deny(operationHash, capability, "Capability lease is expired.", definition.proof);
  if (definition.autopilotForbidden && policy.mode === "autopilot") return deny(operationHash, capability, `${capability} is forbidden during autopilot, even when configured.`, definition.proof);

  if (definition.scope === "roots") {
    if (!path.isAbsolute(String(request.target ?? "")) || !grant.roots.some((root) => contained(request.target, root))) return deny(operationHash, capability, "Target path is outside every granted root.", definition.proof);
  } else if (definition.scope === "executables") {
    const executable = path.basename(String(request.target ?? "")).toLowerCase();
    const allowed = grant.executables.map((item) => path.basename(item).toLowerCase());
    const args = Array.isArray(request.args) ? request.args.map((item) => String(item).toLowerCase()) : [];
    if (request.shell !== false || SHELLS.has(executable) || !allowed.includes(executable) || args.some((arg) => INLINE_EVAL.has(arg))) return deny(operationHash, capability, "Process execution requires an exact non-shell executable and forbids inline evaluation.", definition.proof);
  } else if (definition.scope === "hosts") {
    let url;
    try { url = new URL(String(request.target ?? "")); } catch { return deny(operationHash, capability, "Network target is not a valid URL.", definition.proof); }
    if (url.protocol !== "https:" || !grant.hosts.includes(url.hostname.toLowerCase()) || url.username || url.password) return deny(operationHash, capability, "Network access requires HTTPS and an exact granted host with no embedded credentials.", definition.proof);
  } else if (definition.scope === "providers") {
    const serialized = JSON.stringify(request);
    if (!grant.providers.includes(String(request.providerId ?? "")) || !String(request.target ?? "").startsWith("secret://") || /apiKey|password|plaintextSecret|bearerToken/i.test(serialized)) return deny(operationHash, capability, "Secrets may be referenced only by an approved opaque provider handle.", definition.proof);
  } else if (definition.scope === "refs") {
    if (!grant.refs.includes(String(request.target ?? ""))) return deny(operationHash, capability, "Git write target is not an exact granted ref.", definition.proof);
  } else if (!grant[definition.scope].includes(String(request.target ?? ""))) {
    return deny(operationHash, capability, `Target is outside the granted ${definition.scope}.`, definition.proof);
  }

  if (definition.human) {
    const confirmation = context.confirmation;
    const confirmationValid = confirmation?.approved === true
      && confirmation.explicitGesture === true
      && String(confirmation.actor ?? "").trim()
      && confirmation.operationHash === operationHash
      && Number.isFinite(Date.parse(confirmation.expiresAt))
      && Date.parse(confirmation.expiresAt) > now;
    if (!confirmationValid) return deny(operationHash, capability, "A current explicit human confirmation bound to this exact operation is required.", definition.proof);
  }
  return Object.freeze({ allowed: true, capability, operationHash, reasons: [], requiredProof: definition.proof, policyHash: policy.policyHash });
}

export const nativeCapabilityCatalog = CAPABILITIES;
