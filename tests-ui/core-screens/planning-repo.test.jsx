import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeepPlanningScreen from "../../src/core-screens/DeepPlanningScreen.jsx";
import { ViewModeProvider, VIEW_MODE_STORAGE_KEY } from "../../src/project/viewMode.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  try { window.localStorage.clear(); } catch { /* jsdom */ }
});

const LIST = {
  templates: [
    { id: "web-app", title: "New web app", description: "A web app from nothing.", depth: "standard", tasks: 8, askFirst: [], usuallySkip: [] },
    { id: "add-feature", title: "Add a feature to an existing app", description: "One new feature in an app that already works.", depth: "quick", tasks: 5, askFirst: [], usuallySkip: [] },
  ],
  blank: { id: "blank", title: "Start blank", description: "No starter." },
  current: null,
  note: "A starter only suggests.",
};
const notStarted = { started: false, idea: null, areas: [], blockers: [], template: null, signals: [], person: "owner", research: { live: false, note: "" }, progress: { answered: 0, total: 0, open: 0, blockingOpen: 0 }, approval: { canApprove: false, message: "", approved: [] } };
const READ = { known: true, root: "/r/needle-main", name: "needle-main", facts: [{ id: "stack.framework", text: "Vite + React" }, { id: "data.store", text: "Supabase (Postgres)" }], fileCount: 120, truncated: false, tests: "npm test", suggestedTemplate: "add-feature" };

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
function mockApi(handlers) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const path = String(url).split("?")[0].replace("/api/core", "");
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = handlers[`${method} ${path}`];
    return handler ? handler() : { ok: false, status: 404, json: async () => ({ ok: false, code: "NOT_FOUND", message: "none" }) };
  }));
  return calls;
}
function renderScreen() {
  window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, "simple");
  return render(<ViewModeProvider><DeepPlanningScreen /></ViewModeProvider>);
}

describe("Deep planning with a repo", () => {
  beforeEach(() => window.localStorage.clear());

  it("says what it read and starts on 'Add a feature to an existing app'", async () => {
    mockApi({ "GET /planning": () => ok(notStarted), "GET /planning/templates": () => ok(LIST), "GET /planning/repo": () => ok(READ) });
    renderScreen();
    expect(await screen.findByText(/What do you want to do in needle-main\?/)).toBeTruthy();
    expect(screen.getByText(/120 files, Vite \+ React, Supabase \(Postgres\), tests run with npm test/)).toBeTruthy();
    expect((await screen.findByRole("radio", { name: /Add a feature to an existing app/ })).checked).toBe(true);
  });

  it("keeps the person's own pick instead of the suggestion", async () => {
    mockApi({ "GET /planning": () => ok(notStarted), "GET /planning/templates": () => ok(LIST), "GET /planning/repo": () => ok(READ) });
    renderScreen();
    // Wait for the repo to be read first: the suggestion lands then, and must not undo a pick made after it.
    await screen.findByText(/What do you want to do in needle-main\?/);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Add a feature to an existing app/ }).checked).toBe(true));
    fireEvent.click(screen.getByRole("radio", { name: /New web app/ }));
    expect(screen.getByRole("radio", { name: /New web app/ }).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /Add a feature to an existing app/ }).checked).toBe(false);
  });

  it("asks for the repo folder when none was read, and sends it", async () => {
    let pointed = false;
    const calls = mockApi({
      "GET /planning": () => ok(notStarted),
      "GET /planning/templates": () => ok(LIST),
      "GET /planning/repo": () => ok(pointed ? READ : { ...READ, known: false, root: null, suggestedTemplate: null }),
      "POST /planning/repo": () => { pointed = true; return ok({ root: "/r/needle-main" }); },
    });
    renderScreen();
    fireEvent.change(await screen.findByLabelText(/Plan from your existing repo/), { target: { value: "/r/needle-main" } });
    fireEvent.click(screen.getByRole("button", { name: "Read this folder" }));
    expect(await screen.findByText(/Read your repo/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.path === "/planning/repo").body).toEqual({ path: "/r/needle-main" });
  });
});

describe("the folder scanned in Structure", () => {
  it("is handed to planning by itself when the project's name has a remembered folder", async () => {
    const { rememberProjectFolder } = await import("../../src/project/projectFolders.js");
    rememberProjectFolder("needle-main", "C:\\repos\\needle-main");
    let pointed = false;
    const calls = mockApi({
      "GET /planning": () => ok(notStarted),
      "GET /planning/templates": () => ok(LIST),
      "GET /planning/repo": () => ok(pointed ? READ : { ...READ, known: false, root: null, suggestedTemplate: null }),
      "POST /planning/repo": () => { pointed = true; return ok({ root: "C:\\repos\\needle-main" }); },
    });
    vi.doMock("../../src/project/ProjectProvider.jsx", async (orig) => ({ ...(await orig()), useOptionalProject: () => ({ activeProject: { name: "needle-main" }, activeProjectId: "p1" }) }));
    vi.resetModules();
    const { default: Screen } = await import("../../src/core-screens/DeepPlanningScreen.jsx");
    const { ViewModeProvider: VMP } = await import("../../src/project/viewMode.js");
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, "simple");
    render(<VMP><Screen /></VMP>);
    expect(await screen.findByText(/Read your repo/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.path === "/planning/repo").body).toEqual({ path: "C:\\repos\\needle-main" });
    vi.doUnmock("../../src/project/ProjectProvider.jsx");
  });
});
