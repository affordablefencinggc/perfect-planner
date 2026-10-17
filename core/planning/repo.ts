// Reads what an existing repository already decided, so planning never asks
// "Which UI framework?" of a React app or recommends Tauri for an Electron one.
// Text only: package.json is parsed as JSON and config files are only checked
// for existence. Nothing in the repo is imported or executed.

import * as fs from "node:fs";
import * as path from "node:path";
import { profileIdea, SIGNALS } from "./profile";
import type { IdeaProfile } from "./types";

/** One question the repo already answers. */
export interface RepoFact {
  /** Planning question id, e.g. "platforms.desktop-shell". */
  id: string;
  /** Option id when the repo matches one of the question's options. */
  choice?: string;
  /** What the repo uses, in words. */
  text: string;
  /** Repo-relative files that show it. */
  evidence: string[];
}

export interface RepoStack {
  facts: RepoFact[];
  /** Profile signals the repo implies (desktop, mobile, payments, ...). */
  signals: string[];
}

type Deps = Record<string, string>;

/** Parses a regular file inside root; a symlink (which could point outside the repo) is ignored. */
function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exists(root: string, rel: string): boolean {
  try {
    fs.statSync(path.join(root, ...rel.split("/")));
    return true;
  } catch {
    return false;
  }
}

function firstExisting(root: string, rels: readonly string[]): string | undefined {
  return rels.find((r) => exists(root, r));
}

/** Reads the repo's stack from package.json and well-known config files. */
export function readRepoStack(root: string): RepoStack {
  const pkg = readJson(path.join(root, "package.json"));
  const deps: Deps = {
    ...((pkg?.dependencies as Deps | undefined) ?? {}),
    ...((pkg?.devDependencies as Deps | undefined) ?? {}),
  };
  const has = (name: string): boolean => name in deps;
  const hasPrefix = (prefix: string): boolean => Object.keys(deps).some((d) => d.startsWith(prefix));
  const PKG = "package.json";
  const facts: RepoFact[] = [];
  const signals = new Set<string>();
  const add = (fact: RepoFact): void => {
    facts.push(fact);
  };

  // stack
  const tsconfig = firstExisting(root, ["tsconfig.json"]);
  if (tsconfig || has("typescript")) {
    add({ id: "stack.language", choice: "typescript", text: "TypeScript", evidence: [tsconfig ?? PKG] });
  }
  if (has("next")) add({ id: "stack.framework", choice: "nextjs", text: "Next.js", evidence: [PKG] });
  else if (has("@sveltejs/kit")) add({ id: "stack.framework", choice: "sveltekit", text: "SvelteKit", evidence: [PKG] });
  else if (has("react") && has("vite")) add({ id: "stack.framework", choice: "vite-react", text: "Vite + React", evidence: [PKG] });
  else if (has("react")) add({ id: "stack.framework", text: "React", evidence: [PKG] });

  const hosts: { choice: string; label: string; file: string }[] = [];
  const vercel = firstExisting(root, ["vercel.json"]);
  if (vercel) hosts.push({ choice: "vercel", label: "Vercel", file: vercel });
  const wrangler = fs.existsSync(root)
    ? fs.readdirSync(root).find((f) => /^wrangler(\..+)?\.(toml|json|jsonc)$/.test(f))
    : undefined;
  if (wrangler) hosts.push({ choice: "cloudflare", label: "Cloudflare Workers", file: wrangler });
  const fly = firstExisting(root, ["fly.toml"]);
  if (fly) hosts.push({ choice: "fly-io", label: "Fly.io", file: fly });
  if (hosts.length === 1) add({ id: "stack.hosting", choice: hosts[0].choice, text: hosts[0].label, evidence: [hosts[0].file] });
  else if (hosts.length > 1) add({ id: "stack.hosting", text: hosts.map((h) => h.label).join(" and "), evidence: hosts.map((h) => h.file) });

  // data
  const supabaseDir = firstExisting(root, ["supabase"]);
  const supabase = has("@supabase/supabase-js") || Boolean(supabaseDir);
  const supabaseEvidence = [has("@supabase/supabase-js") ? PKG : undefined, supabaseDir].filter((x): x is string => Boolean(x));
  if (supabase || has("pg") || has("postgres")) {
    add({ id: "data.store", choice: "postgres", text: supabase ? "Supabase (Postgres)" : "Postgres", evidence: supabase ? supabaseEvidence : [PKG] });
  } else if (has("better-sqlite3") || has("sqlite3")) {
    add({ id: "data.store", choice: "sqlite-local", text: "SQLite", evidence: [PKG] });
  }
  if (has("prisma") || has("@prisma/client")) add({ id: "data.schema", choice: "prisma", text: "Prisma", evidence: [PKG] });
  else if (has("drizzle-orm")) add({ id: "data.schema", choice: "drizzle", text: "Drizzle", evidence: [PKG] });
  else if (exists(root, "supabase/migrations")) add({ id: "data.schema", choice: "raw-sql", text: "SQL migrations in supabase/migrations", evidence: ["supabase/migrations"] });

  // auth
  if (supabase) add({ id: "auth.provider", choice: "supabase-auth", text: "Supabase Auth", evidence: supabaseEvidence });
  else if (has("next-auth") || has("@auth/core")) add({ id: "auth.provider", choice: "authjs", text: "Auth.js", evidence: [PKG] });
  else if (hasPrefix("@clerk/")) add({ id: "auth.provider", choice: "clerk", text: "Clerk", evidence: [PKG] });

  // money
  if (has("stripe") || has("@stripe/stripe-js")) {
    add({ id: "money.payments", text: "Stripe", evidence: [PKG] });
    signals.add("payments");
  }

  // ai
  const aiSdks = ["@anthropic-ai/sdk", "openai", "@google/generative-ai", "ai"].filter(has);
  if (aiSdks.length > 0) {
    add({ id: "ai.model", choice: "frontier-api", text: `Hosted models (${aiSdks.join(", ")})`, evidence: [PKG] });
    signals.add("ai");
  }

  // offline
  if (hasPrefix("@powersync/")) add({ id: "offline.sync-engine", choice: "powersync", text: "PowerSync", evidence: [PKG] });
  // @electric-sql/pglite is an embedded Postgres, often only for tests; it is not the sync engine.
  else if (has("electric-sql") || has("@electric-sql/client") || has("@electric-sql/react")) add({ id: "offline.sync-engine", choice: "electric", text: "ElectricSQL", evidence: [PKG] });

  // platforms
  if (has("electron")) {
    add({ id: "platforms.desktop-shell", choice: "electron", text: "Electron", evidence: [PKG] });
    signals.add("desktop");
  } else if (hasPrefix("@tauri-apps/") || exists(root, "src-tauri")) {
    add({ id: "platforms.desktop-shell", choice: "tauri", text: "Tauri", evidence: [exists(root, "src-tauri") ? "src-tauri" : PKG] });
    signals.add("desktop");
  }
  if (has("@capacitor/core")) {
    const native = ["android", "ios"].filter((d) => exists(root, d));
    add({ id: "platforms.mobile-stack", text: `Capacitor${native.length ? ` (${native.join(", ")})` : ""}`, evidence: [PKG, ...native] });
    signals.add("mobile");
  } else if (has("expo")) {
    add({ id: "platforms.mobile-stack", choice: "expo", text: "React Native with Expo", evidence: [PKG] });
    signals.add("mobile");
  } else if (has("react-native")) {
    add({ id: "platforms.mobile-stack", choice: "native", text: "React Native", evidence: [PKG] });
    signals.add("mobile");
  }
  if (has("react") || has("vite") || has("next")) signals.add("web");

  return { facts, signals: [...signals] };
}

/**
 * profileIdea, plus what the repo already shows: its signals join the idea's,
 * and every question it answers goes into `known` so it is not asked again.
 * Record the facts as decisions with PlanningSession.recordRepoFacts.
 */
export function profileRepo(
  idea: string,
  stack: RepoStack,
  opts: { team?: "solo" | "team" } = {},
): IdeaProfile {
  const base = profileIdea(idea, opts);
  const signals = Object.keys(SIGNALS).filter((s) => base.signals.includes(s) || stack.signals.includes(s));
  const known = Object.fromEntries(stack.facts.map((f) => [f.id, f.text]));
  // The person's own description wins over what the code shows.
  return { ...base, signals, known: { ...known, ...base.known } };
}
