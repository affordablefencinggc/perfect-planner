import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppErrorBoundary, SAFE_START_KEY, enterSafeStart, isSafeStart, leaveSafeStart } from "../src/components/AppErrorBoundary.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, DEFAULT_PROJECT_REGISTRY_KEY } from "../src/project/projectRegistry.js";

function Thrower() { throw new Error("Project registry entry is malformed."); }

function fakeRuntime(href = "http://localhost/plan") {
  const session = createMemoryStorage();
  return { session, location: { href, reload: vi.fn(), assign: vi.fn() }, get sessionStorage() { return session; } };
}

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { cleanup(); try { sessionStorage.clear(); localStorage.clear(); } catch { /* jsdom only */ } });

describe("AppErrorBoundary", () => {
  test("renders children when nothing throws", () => {
    render(<AppErrorBoundary><p>Planner ready</p></AppErrorBoundary>);
    expect(screen.getByText("Planner ready")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("shows a plain-language fallback with collapsible details and both recovery actions", async () => {
    const onReload = vi.fn(), onSafeStart = vi.fn();
    render(<AppErrorBoundary onReload={onReload} onSafeStart={onSafeStart}><Thrower /></AppErrorBoundary>);
    const alert = screen.getByRole("alert");
    expect(screen.getByRole("heading", { name: "Something went wrong showing the planner" })).toBeTruthy();
    const details = alert.querySelector("details");
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(details.querySelector("pre").textContent).toBe("Project registry entry is malformed.");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await user.click(screen.getByRole("button", { name: "Open without saved projects" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onSafeStart).toHaveBeenCalledTimes(1);
  });

  test("in safe start, offers the way back to saved projects instead of the safe-start action (xcut-11)", async () => {
    const onLeaveSafeStart = vi.fn();
    render(<AppErrorBoundary safeStart onReload={() => {}} onLeaveSafeStart={onLeaveSafeStart}><Thrower /></AppErrorBoundary>);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open without saved projects" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("not caused by them");
    await userEvent.setup().click(screen.getByRole("button", { name: "Show saved projects" }));
    expect(onLeaveSafeStart).toHaveBeenCalledTimes(1);
  });

  test("moves focus to the fallback heading when a first render crashes (xcut-11)", () => {
    render(<AppErrorBoundary onReload={() => {}}><Thrower /></AppErrorBoundary>);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  test("moves focus to the fallback heading when a later render crashes, and never claims a project exists (xcut-11)", () => {
    function MaybeThrow({ crash }) { if (crash) throw new Error("later"); return <button type="button">Focused control</button>; }
    const { rerender } = render(<AppErrorBoundary onReload={() => {}}><MaybeThrow crash={false} /></AppErrorBoundary>);
    screen.getByRole("button", { name: "Focused control" }).focus();
    rerender(<AppErrorBoundary onReload={() => {}}><MaybeThrow crash /></AppErrorBoundary>);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(document.activeElement).toBe(heading);
    expect(heading.textContent).not.toMatch(/this project/i);
  });
});

describe("safe start", () => {
  test("sets a session flag and reloads without touching saved projects", () => {
    const runtime = fakeRuntime();
    expect(isSafeStart(runtime)).toBe(false);
    enterSafeStart(runtime);
    expect(runtime.session.getItem(SAFE_START_KEY)).toBe("1");
    expect(runtime.location.reload).toHaveBeenCalledTimes(1);
    expect(isSafeStart(runtime)).toBe(true);
    leaveSafeStart(runtime);
    expect(isSafeStart(runtime)).toBe(false);
  });

  test("falls back to a query parameter when sessionStorage is unavailable", () => {
    const runtime = { location: { href: "http://localhost/plan", reload: vi.fn(), assign: vi.fn() }, get sessionStorage() { throw new Error("blocked"); } };
    enterSafeStart(runtime);
    expect(runtime.location.assign).toHaveBeenCalledWith("http://localhost/plan?safe-start=1");
    runtime.location.href = "http://localhost/plan?safe-start=1";
    expect(isSafeStart(runtime)).toBe(true);
  });

  test("the safe-start registry props leave the saved registry in localStorage untouched", () => {
    const saved = "{\"not\":\"a valid registry\"";
    localStorage.setItem(DEFAULT_PROJECT_REGISTRY_KEY, saved);
    render(<ProjectProvider storage={createMemoryStorage()} storageKey={`${DEFAULT_PROJECT_REGISTRY_KEY}.safe-start`} syncHistory={false}><p>Empty planner</p></ProjectProvider>);
    expect(screen.getByText("Empty planner")).toBeTruthy();
    expect(localStorage.getItem(DEFAULT_PROJECT_REGISTRY_KEY)).toBe(saved);
  });
});
