// Reads an idea in plain words and turns it into an IdeaProfile: signals by keyword.
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

/** Builds a profile from the idea text. Signals keep the SIGNALS order. */
export function profileIdea(
  idea: string,
  opts: { known?: Record<string, string>; team?: "solo" | "team" } = {},
): IdeaProfile {
  const signals = Object.keys(SIGNALS).filter((s) => SIGNALS[s].some((k) => matches(idea, k)));
  const team = opts.team ?? (signals.includes("team") ? "team" : "solo");
  return { idea, signals, known: { ...(opts.known ?? {}) }, team };
}
