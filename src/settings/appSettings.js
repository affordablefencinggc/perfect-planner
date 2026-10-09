import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from "react";

// App settings are presentation and navigation preferences plus agent defaults.
// None of them touches project records, proof, or safety rules. Secrets never
// live here: the Jev key is held by the operating-system keychain only.
export const APP_SETTINGS_STORAGE_KEY = "perfect-planner.settings.v1";

export const STAGE_PAGES = Object.freeze({
  define: ["blueprint", "structure", "components"],
  coordinate: ["plan", "collision", "allocation"],
  build: ["build"],
  prove: ["integrity", "evidence"],
  release: ["ledger"],
});

export const THEMES = Object.freeze(["warm", "contrast"]);
export const TEXT_SIZES = Object.freeze({ standard: 1, large: 1.1, larger: 1.2 });
export const START_PAGES = Object.freeze(["home", "last"]);
export const DOCK_TABS = Object.freeze(["logs", "errors", "mcp", "branches", "merge", "delivery", "guards"]);
export const TOAST_SECONDS = Object.freeze([3, 6, 10, 0]);
export const WORKTREE_MODES = Object.freeze(["isolated", "shared"]);
export const REVIEW_PRESETS = Object.freeze({
  quick: "Quick: one reviewer, checks must pass",
  standard: "Standard: one reviewer, checks and screenshot proof",
  strict: "Strict: two reviewers, checks, screenshot proof and a clean collision record",
});

export const DEFAULT_SETTINGS = Object.freeze({
  theme: "warm",
  textSize: "standard",
  reduceMotion: false,
  startPage: "home",
  lastWorkspace: "home",
  stageEntry: Object.freeze({ define: "blueprint", coordinate: "plan", build: "build", prove: "integrity", release: "ledger" }),
  opsDockOpenOnLaunch: false,
  opsDockTab: "logs",
  developerNotesVisible: true,
  toastSeconds: 6,
  worktreeMode: "isolated",
  reviewPreset: "standard",
  maxRounds: 2,
  budgetCapAud: null,
  jevReviewer: false,
});

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

export function normalizeSettings(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const stageEntry = {};
  for (const [stage, pages] of Object.entries(STAGE_PAGES)) {
    stageEntry[stage] = pick(input.stageEntry?.[stage], pages, DEFAULT_SETTINGS.stageEntry[stage]);
  }
  const budget = Number(input.budgetCapAud);
  const rounds = Math.round(Number(input.maxRounds));
  return {
    theme: pick(input.theme, THEMES, DEFAULT_SETTINGS.theme),
    textSize: pick(input.textSize, Object.keys(TEXT_SIZES), DEFAULT_SETTINGS.textSize),
    reduceMotion: input.reduceMotion === true,
    startPage: pick(input.startPage, START_PAGES, DEFAULT_SETTINGS.startPage),
    lastWorkspace: typeof input.lastWorkspace === "string" ? input.lastWorkspace : "home",
    stageEntry,
    opsDockOpenOnLaunch: input.opsDockOpenOnLaunch === true,
    opsDockTab: pick(input.opsDockTab, DOCK_TABS, DEFAULT_SETTINGS.opsDockTab),
    developerNotesVisible: input.developerNotesVisible !== false,
    toastSeconds: pick(Number(input.toastSeconds), TOAST_SECONDS, DEFAULT_SETTINGS.toastSeconds),
    worktreeMode: pick(input.worktreeMode, WORKTREE_MODES, DEFAULT_SETTINGS.worktreeMode),
    reviewPreset: pick(input.reviewPreset, Object.keys(REVIEW_PRESETS), DEFAULT_SETTINGS.reviewPreset),
    maxRounds: rounds >= 1 && rounds <= 5 ? rounds : DEFAULT_SETTINGS.maxRounds,
    budgetCapAud: input.budgetCapAud != null && input.budgetCapAud !== "" && Number.isFinite(budget) && budget > 0 ? Math.round(budget * 100) / 100 : null,
    jevReviewer: input.jevReviewer === true,
  };
}

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readStoredSettings(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(APP_SETTINGS_STORAGE_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeSettings(null);
  }
}

export function writeStoredSettings(settings, storage = defaultStorage()) {
  try {
    storage?.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

// The text an agent receives when the user copies their defaults from Settings.
// It states preferences only; the app's own gates still decide what may run.
export function agentDefaultsBrief(settings, { jevKeyStored = false } = {}) {
  const s = normalizeSettings(settings);
  return [
    "Perfect Planner agent defaults (user preferences, not permissions):",
    `- Worktree mode: ${s.worktreeMode === "isolated" ? "one isolated worktree per task" : "shared working copy, one task at a time"}`,
    `- Review preset: ${REVIEW_PRESETS[s.reviewPreset]}`,
    `- Orchestration rounds: at most ${s.maxRounds}`,
    `- Budget cap per run: ${s.budgetCapAud == null ? "none set" : `AUD ${s.budgetCapAud.toFixed(2)}`}`,
    `- Jev as reviewer: ${s.jevReviewer ? `requested by the user; Perfect Planner does not run Jev reviews itself yet${jevKeyStored ? " (a key is held in the OS keychain)" : " (no key stored)"}` : "no"}`,
    "Planner gates (collisions, proof, review) still apply and are not relaxed by these settings.",
  ].join("\n");
}

export const AppSettingsContext = createContext(null);

export function useAppSettingsState(storage) {
  const [settings, setSettings] = useState(() => readStoredSettings(storage));
  const update = useCallback((patch) => {
    setSettings((current) => {
      const next = normalizeSettings({ ...current, ...(typeof patch === "function" ? patch(current) : patch) });
      writeStoredSettings(next, storage);
      return next;
    });
  }, [storage]);
  const reset = useCallback(() => {
    const next = normalizeSettings(null);
    writeStoredSettings(next, storage);
    setSettings(next);
  }, [storage]);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onStorage = (event) => {
      if (event.key === APP_SETTINGS_STORAGE_KEY) setSettings(readStoredSettings(storage));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storage]);
  return useMemo(() => ({ settings, update, reset }), [settings, update, reset]);
}

export function AppSettingsProvider({ children }) {
  const value = useAppSettingsState();
  return createElement(AppSettingsContext.Provider, { value }, children);
}

const NO_PROVIDER = Object.freeze({ settings: normalizeSettings(null), update: () => {}, reset: () => {} });

export function useAppSettings() {
  return useContext(AppSettingsContext) ?? NO_PROVIDER;
}
