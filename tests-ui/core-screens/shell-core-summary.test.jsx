import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { PerfectPlannerShell } from "../../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../../src/project/projectRegistry.js";
import { diagnosticSessionFixture } from "../diagnosticSessionFixture.js";

const started = {
  project: "default",
  started: true,
  people: { members: 2, ownerMissing: false },
  agents: { checkedIn: 3, names: ["a", "b", "c"] },
  plan: { approved: true, latest: "P-2", tasks: 5, idea: "A very long idea about a fencing quote calculator app" },
};

function stubSummary(summary) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).includes("/api/core/summary")) {
      return summary
        ? { ok: true, status: 200, json: async () => ({ ok: true, result: summary }) }
        : { ok: false, status: 503, json: async () => ({ ok: false, message: "down" }) };
    }
    return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
  }));
}

function renderShell() {
  window.history.replaceState({}, "", "/?workspace=home");
  const registry = createProjectRegistry({ storage: createMemoryStorage(), now: () => Date.parse("2026-09-04T06:00:00.000Z") });
  return render(
    <ProjectProvider registry={registry} initialUrl={window.location.href}>
      <PerfectPlannerShell diagnosticSession={diagnosticSessionFixture(createMemoryStorage())} />
    </ProjectProvider>,
  );
}

beforeEach(() => { vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

describe("shell with a core project but no imported project", () => {
  test("header chips, project tab and Home show core facts", async () => {
    stubSummary(started);
    renderShell();
    expect(await screen.findByText("2 people on this project")).toBeTruthy();
    expect(screen.getByText("3 agents checked in")).toBeTruthy();
    expect(screen.queryByText("Roster not connected")).toBeNull();
    expect(screen.queryByText("No project selected")).toBeNull();
    expect(screen.queryByText("Bring in a real app to begin")).toBeNull();
    expect(document.querySelector("[data-core-project-tab] span").textContent).toBe("A very long idea about a fencin…");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("fencing quote calculator");
    expect(screen.getByText("Plan approved (P-2), 5 tasks")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open Deep planning/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Choose app folder/ })).toBeTruthy();
  });

  test.each([["unreachable", null], ["not started", { ...started, started: false, people: { members: 0 }, agents: { checkedIn: 0 } }]])(
    "stays as before when the summary is %s",
    async (_name, summary) => {
      stubSummary(summary);
      renderShell();
      expect(await screen.findByText("Bring in a real app to begin")).toBeTruthy();
      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      expect(screen.getByText("Roster not connected")).toBeTruthy();
      expect(screen.getByText("No project selected")).toBeTruthy();
      expect(screen.queryByText(/agents? checked in/)).toBeNull();
    },
  );
});
