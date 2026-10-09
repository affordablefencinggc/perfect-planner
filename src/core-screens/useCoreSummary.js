import { useCoreResource } from "./coreApi.js";

// What the header and Home know about the core project (GET /api/core/summary, core/host/routes/summary.ts).
// Polls quietly so chips follow agents checking in. null until it loads, or when the core host is not running.
export const CORE_SUMMARY_POLL_MS = 5000;

export function useCoreSummary({ enabled = true } = {}) {
  const resource = useCoreResource("/summary", { pollMs: CORE_SUMMARY_POLL_MS, enabled });
  return resource.status === "ready" ? resource.data : null;
}

/** Header chip for the roster, or null when the core project has nobody on it. */
export function coreRosterLabel(summary) {
  const n = summary?.people?.members ?? 0;
  if (summary?.people?.ownerMissing) return "Owner key missing";
  return n ? `${n} ${n === 1 ? "person" : "people"} on this project` : null;
}

/** Header chip for agents: "checked in" is what the app knows; it is not a verification. */
export function coreAgentLabel(summary) {
  const n = summary?.agents?.checkedIn ?? 0;
  return n ? `${n} agent${n === 1 ? "" : "s"} checked in` : null;
}
