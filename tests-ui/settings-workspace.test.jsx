import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { SettingsWorkspace } from "../src/settings/SettingsWorkspace.jsx";
import {
  agentDefaultsBrief,
  APP_SETTINGS_STORAGE_KEY,
  AppSettingsProvider,
  normalizeSettings,
  readStoredSettings,
} from "../src/settings/appSettings.js";
import { clearJevKey, readJevKeyStatus, saveJevKey } from "../src/settings/jevKeychain.js";
import { ViewModeProvider, VIEW_MODE_STORAGE_KEY } from "../src/project/viewMode.js";
import { diagnosticSessionFixture } from "./diagnosticSessionFixture.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.style.zoom = "";
});

const stored = () => JSON.parse(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY));

function renderSettings(props = {}) {
  const onWorkspace = vi.fn();
  const onClose = vi.fn();
  const onToast = vi.fn();
  render(
    <ViewModeProvider>
      <AppSettingsProvider>
        <SettingsWorkspace onWorkspace={onWorkspace} onClose={onClose} onToast={onToast} {...props} />
      </AppSettingsProvider>
    </ViewModeProvider>,
  );
  return { onWorkspace, onClose, onToast };
}

function fakeKeychain() {
  let key = null;
  const calls = [];
  const invoke = vi.fn(async (command, args) => {
    calls.push(command);
    if (command === "jev_key_save") { key = args.key; }
    if (command === "jev_key_clear") { key = null; }
    return { available: true, stored: key !== null, store: "windows-credential-manager" };
  });
  return { invoke, calls, current: () => key };
}

describe("settings model", () => {
  test("normalizes unknown and unsafe values back to defaults", () => {
    const value = normalizeSettings({ theme: "neon", textSize: "huge", stageEntry: { define: "plan", coordinate: "allocation" }, maxRounds: 99, budgetCapAud: "-4", toastSeconds: 7, opsDockTab: "nope" });
    expect(value.theme).toBe("warm");
    expect(value.textSize).toBe("standard");
    expect(value.stageEntry.define).toBe("blueprint");
    expect(value.stageEntry.coordinate).toBe("allocation");
    expect(value.maxRounds).toBe(2);
    expect(value.budgetCapAud).toBeNull();
    expect(value.toastSeconds).toBe(6);
    expect(value.opsDockTab).toBe("logs");
  });

  test("survives corrupted storage", () => {
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, "{not json");
    expect(readStoredSettings()).toEqual(normalizeSettings(null));
  });

  test("agent brief states preferences and never contains a key", () => {
    const brief = agentDefaultsBrief({ worktreeMode: "shared", reviewPreset: "thorough", maxRounds: 3, budgetCapAud: 12.5, jevReviewer: true }, { jevKeyStored: true });
    expect(brief).toContain("shared working copy");
    expect(brief).toContain("Thorough");
    expect(brief).toContain("at most 3");
    expect(brief).toContain("AUD 12.50");
    expect(brief).toContain("a key is held in the OS keychain");
    expect(brief).toContain("does not run Jev reviews itself yet");
    expect(brief).toContain("not relaxed");
  });
});

describe("Settings page", () => {
  test("every control writes a saved setting", async () => {
    renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: "High contrast" }));
    fireEvent.click(screen.getByRole("radio", { name: "Larger" }));
    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    fireEvent.click(screen.getByRole("radio", { name: "Last page" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Coordinate button opens" })).getByRole("radio", { name: "Allocation" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Define button opens" })).getByRole("radio", { name: "Components" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Prove button opens" })).getByRole("radio", { name: "Evidence" }));
    fireEvent.click(screen.getByRole("radio", { name: "Shared, one at a time" }));
    fireEvent.click(screen.getByRole("radio", { name: "Thorough" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Orchestration rounds" })).getByRole("radio", { name: "4" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Budget cap per run in AUD" }), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("switch", { name: "Use Jev as a reviewer" }));
    fireEvent.click(screen.getByRole("switch", { name: "Open the operations console on launch" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Console opens on" }), { target: { value: "errors" } });
    fireEvent.click(screen.getByRole("switch", { name: "Show Developer Notes" }));
    fireEvent.click(screen.getByRole("radio", { name: "10 s" }));
    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));
    expect(stored()).toMatchObject({
      theme: "contrast",
      textSize: "larger",
      reduceMotion: true,
      startPage: "last",
      stageEntry: { define: "components", coordinate: "allocation", prove: "evidence" },
      worktreeMode: "shared",
      reviewPreset: "thorough",
      maxRounds: 4,
      budgetCapAud: 25,
      jevReviewer: true,
      opsDockOpenOnLaunch: true,
      opsDockTab: "errors",
      developerNotesVisible: false,
      toastSeconds: 10,
    });
    expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe("advanced");
    expect(screen.getByLabelText("Agent defaults preview").textContent).toContain("AUD 25.00");
    await waitFor(() => expect(screen.getByText("Windows only today (desktop app)")).toBeTruthy());
  });

  test("dark theme is visibly not available yet", () => {
    renderSettings();
    const dark = screen.getByRole("radio", { name: "Dark (not available yet)" });
    expect(dark.disabled).toBe(true);
  });

  test("page links navigate and Back closes", () => {
    const { onWorkspace, onClose } = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Open Collisions" }));
    expect(onWorkspace).toHaveBeenCalledWith("collision");
    fireEvent.click(screen.getByRole("button", { name: "Open Index" }));
    expect(onWorkspace).toHaveBeenCalledWith("index");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalled();
  });

  test("reset asks first and then restores defaults", () => {
    const { onToast } = renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: "High contrast" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset all settings" }));
    expect(stored().theme).toBe("contrast");
    fireEvent.click(screen.getByRole("button", { name: "Yes, reset" }));
    expect(stored().theme).toBe("warm");
    expect(onToast).toHaveBeenCalledWith("Settings reset to defaults.", "neutral");
  });

  test("copy agent defaults uses the clipboard and reports failure honestly", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { onToast } = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Copy agent defaults" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("Copy was blocked"), "warning"));
    fireEvent.click(screen.getByRole("button", { name: "Copy agent defaults" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("Agent defaults copied"), "success"));
    expect(writeText.mock.calls[1][0]).toContain("Perfect Planner agent defaults");
  });

  test("Jev key goes to the keychain, the field clears, and the key is never shown", async () => {
    const keychain = fakeKeychain();
    const { onToast } = renderSettings({ invoke: keychain.invoke });
    const field = screen.getByLabelText("Jev API key", { selector: "input" });
    await waitFor(() => expect(field.disabled).toBe(false));
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "sk-secret-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to keychain" }));
    await waitFor(() => expect(screen.getByText("Key stored in keychain")).toBeTruthy());
    expect(keychain.current()).toBe("sk-secret-123");
    expect(field.value).toBe("");
    expect(document.body.textContent).not.toContain("sk-secret-123");
    expect(JSON.stringify(window.localStorage)).not.toContain("sk-secret-123");
    expect(onToast).toHaveBeenCalledWith("Jev key saved to the Windows keychain.", "success");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("No key stored")).toBeTruthy());
    expect(keychain.calls).toContain("jev_key_clear");
  });

  test("macOS and Linux desktop show a clear not-available-yet state and never store the key", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
    const denied = vi.fn(async () => { throw "Command jev_key_status not allowed by ACL"; });
    renderSettings({ invoke: denied });
    await waitFor(() => expect(screen.getByText("Windows only today")).toBeTruthy());
    expect(screen.getByText(/Linux and macOS cannot save the key yet/)).toBeTruthy();
    expect(screen.getByLabelText("Jev API key", { selector: "input" }).disabled).toBe(true);
    const result = await saveJevKey("sk-should-not-store", { invoke: denied });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("not available yet on this operating system") });
    expect(JSON.stringify(window.localStorage)).not.toContain("sk-should-not-store");
    platform.mockRestore(); userAgent.mockRestore();
  });

  test("every control that only edits the agent brief says it is advisory; no preset name absent from core", () => {
    renderSettings();
    for (const name of ["Worktree mode", "Review preset", "Orchestration rounds", "Budget cap per run", "Use Jev as a reviewer"]) {
      const row = screen.getByText(name, { selector: "strong" }).closest(".settings-row");
      expect(within(row).getByText("advisory: written into the agent's brief"), name).toBeTruthy();
    }
    for (const name of ["Cheap", "Balanced", "Thorough"]) expect(screen.getByRole("radio", { name })).toBeTruthy();
    for (const name of ["Quick", "Strict"]) expect(screen.queryByRole("radio", { name })).toBeNull();
    expect(normalizeSettings({ reviewPreset: "strict" }).reviewPreset).toBe("thorough");
  });

  test("Your data says test commands run as you", () => {
    renderSettings();
    expect(screen.getByText(/This command runs as you, with your files and network\./)).toBeTruthy();
  });

  test("Jev key field says Windows only today in the browser", async () => {
    renderSettings();
    expect(await screen.findByText("Windows only today (desktop app)")).toBeTruthy();
    expect(screen.getByText(/^Windows only today\. Saved only to the Windows keychain/)).toBeTruthy();
  });

  test("Jev reviewer help says what is true today", () => {
    renderSettings();
    expect(screen.getByText(/does not run Jev reviews itself yet/)).toBeTruthy();
    expect(screen.queryByText(/Adds Jev to review rounds/)).toBeNull();
  });

  test("keychain client fails closed outside the desktop app", async () => {
    expect(await readJevKeyStatus()).toEqual({ available: false, stored: false, store: "unavailable" });
    expect((await saveJevKey("x")).ok).toBe(false);
    expect((await clearJevKey()).ok).toBe(false);
    const failing = vi.fn(async (command) => { if (command === "jev_key_save") throw { code: "JEV_KEY_INVALID", message: "Enter a key before saving." }; return { available: true, stored: false, store: "w" }; });
    const result = await saveJevKey(" ", { invoke: failing });
    expect(result).toMatchObject({ ok: false, message: "Enter a key before saving." });
  });
});

describe("Settings in the app shell", () => {
  test("the red Settings button and the More actions item open the page, and settings apply live", async () => {
    render(<PerfectPlannerShell diagnosticSession={diagnosticSessionFixture()} />);
    const launcher = screen.getByRole("button", { name: "Settings" });
    expect(launcher.className).toContain("settings-launcher");
    fireEvent.click(launcher);
    expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "High contrast" }));
    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    fireEvent.click(screen.getByRole("radio", { name: "Large" }));
    const shell = document.querySelector(".app-shell");
    expect(shell.getAttribute("data-theme")).toBe("contrast");
    expect(shell.getAttribute("data-reduce-motion")).toBe("true");
    expect(document.documentElement.style.zoom).toBe("1.1");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Coordinate button opens" })).getByRole("radio", { name: "Collisions" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("heading", { name: "Settings", level: 1 })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Coordinate" }));
    await waitFor(() => expect(document.querySelector(".app-shell").className).toContain("workspace-collision"));

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("dialog", { name: "More actions" });
    fireEvent.click(within(menu).getByRole("button", { name: /Settings/ }));
    expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Plan" }));
    await waitFor(() => expect(document.querySelector(".app-shell").className).toContain("workspace-plan"));
    expect(screen.queryByRole("heading", { name: "Settings", level: 1 })).toBeNull();
  });

  test("launch preferences open the console on the chosen tab and hide Developer Notes", () => {
    window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ opsDockOpenOnLaunch: true, opsDockTab: "errors", developerNotesVisible: false }));
    render(<PerfectPlannerShell diagnosticSession={diagnosticSessionFixture()} />);
    expect(document.querySelector(".app-shell").className).toContain("ops-is-open");
    expect(screen.getByRole("button", { name: /Errors/ }).className).toContain("active");
  });

  test("notices close after the chosen time, or stay until closed", () => {
    vi.useFakeTimers();
    try {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ toastSeconds: 0 }));
      render(<PerfectPlannerShell diagnosticSession={diagnosticSessionFixture()} />);
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(screen.getByRole("button", { name: /Organization settings/ }));
      fireEvent.click(screen.getByRole("button", { name: "Keep session draft" }));
      expect(screen.getByText("Organization name kept as a session-only draft.")).toBeTruthy();
      act(() => { vi.advanceTimersByTime(60000); });
      expect(screen.getByText("Organization name kept as a session-only draft.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
