import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from "react";
import "./viewMode.css";

// Simple/Advanced is a presentation preference only. It never touches project
// state, records or safety rules; both views read exactly the same data.
export const VIEW_MODE_STORAGE_KEY = "perfect-planner.view-mode.v1";
export const VIEW_MODES = Object.freeze(["simple", "advanced"]);
export const DEFAULT_VIEW_MODE = "simple";

export function normalizeViewMode(value) {
  return value === "advanced" ? "advanced" : DEFAULT_VIEW_MODE;
}

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readStoredViewMode(storage = defaultStorage()) {
  try {
    return normalizeViewMode(storage?.getItem(VIEW_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_VIEW_MODE;
  }
}

export function writeStoredViewMode(mode, storage = defaultStorage()) {
  try {
    storage?.setItem(VIEW_MODE_STORAGE_KEY, normalizeViewMode(mode));
    return true;
  } catch {
    return false;
  }
}

export const ViewModeContext = createContext(null);

export function useViewModeState() {
  const [mode, setModeState] = useState(() => readStoredViewMode());
  const setMode = useCallback((next) => {
    const normalized = normalizeViewMode(next);
    setModeState(normalized);
    writeStoredViewMode(normalized);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onStorage = (event) => {
      if (event.key === VIEW_MODE_STORAGE_KEY) setModeState(normalizeViewMode(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return useMemo(() => ({ mode, isAdvanced: mode === "advanced", setMode }), [mode, setMode]);
}

export function ViewModeProvider({ children }) {
  const value = useViewModeState();
  return createElement(ViewModeContext.Provider, { value }, children);
}

const NO_PROVIDER = Object.freeze({ mode: DEFAULT_VIEW_MODE, isAdvanced: false, setMode: () => {} });

export function useViewMode() {
  return useContext(ViewModeContext) ?? NO_PROVIDER;
}
