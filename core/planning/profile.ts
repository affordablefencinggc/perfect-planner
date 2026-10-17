// Reads an idea in plain words and turns it into an IdeaProfile: signals by keyword.
import { descriptionSignals, readDescription, withoutNegations } from "./description";
import type { IdeaProfile } from "./types";

/** Signal name to the keywords (or short phrases) that raise it. */
export const SIGNALS: Readonly<Record<string, readonly string[]>> = {
  offline: ["offline", "sync", "no internet"],
  payments: ["pay", "payment", "invoice", "subscription", "stripe", "billing", "pricing"],
  ai: ["ai", "llm", "gpt", "claude", "model", "agent", "chatbot"],
  mobile: ["mobile", "ios", "android", "phone"],
  desktop: ["desktop", "windows", "mac", "linux", "tauri", "electron"],
  web: ["web", "website", "browser", "saas"],
  team: ["team", "collaborate", "multiple users", "helpers", "share"],
  "personal-data": ["health", "medical", "address", "email", "personal", "customer"],
  realtime: ["realtime", "real-time", "live", "chat"],
  files: ["upload", "file", "image", "photo", "video"],
};

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-ish match: whole word, allowing a plural or simple verb ending ("agents", "shared").
function matches(text: string, keyword: string): boolean {
  const body = escape(keyword).replace(/ /g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${body}(s|es|d|ed|ing)?(?![a-z0-9])`, "i").test(text);
}

/**
 * Builds a profile from the idea text. Signals keep the SIGNALS order.
 * The idea is authoritative: a negated word ("no cloud sync") raises no
 * signal, what it rules out is dropped, and every question the description
 * settles (see readDescription) goes into `known` and `described`, so it is
 * not asked. Record those with PlanningSession.recordDescriptionFacts.
 */
export function profileIdea(
  idea: string,
  opts: { known?: Record<string, string>; team?: "solo" | "team" } = {},
): IdeaProfile {
  const text = withoutNegations(String(idea ?? ""));
  const { remove, add } = descriptionSignals(idea);
  const signals = Object.keys(SIGNALS).filter((s) => !remove.includes(s) && (add.includes(s) || SIGNALS[s].some((k) => matches(text, k))));
  const team = opts.team ?? (signals.includes("team") ? "team" : "solo");
  const { facts, ruledOut } = readDescription(idea);
  const described = Object.fromEntries(facts.map((f) => [f.id, f.text && f.choice ? `${f.choice}: ${f.text}` : (f.text ?? f.choice ?? "")]));
  return {
    idea,
    signals,
    known: { ...(opts.known ?? {}), ...described },
    team,
    ...(facts.length ? { described: facts } : {}),
    ...(ruledOut.length ? { ruledOut } : {}),
  };
}
