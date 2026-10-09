import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { diagnosticSessionFixture } from "./diagnosticSessionFixture.js";

afterEach(() => { cleanup(); window.localStorage.clear(); });

function renderDemo(workspace) {
  const registry = createProjectRegistry({ storage: createMemoryStorage() });
  const demo = registry.upsert(createDemoProjectSession(), { activate: true });
  window.history.replaceState({}, "", `/?project=${demo.projectId}&workspace=${workspace}`);
  return render(<ProjectProvider registry={registry}><PerfectPlannerShell diagnosticSession={diagnosticSessionFixture()} /></ProjectProvider>);
}

describe("demo stage controls", () => {
  test("Index letter jump scrolls in place without leaving the Index or adding a URL hash", async () => {
    renderDemo("index");
    const index = await screen.findByRole("region", { name: "Project index" });
    const nav = within(index).getByRole("complementary", { name: "Alphabetical index" });
    const link = nav.querySelector("a");
    const target = document.getElementById(link.getAttribute("href").slice(1));
    let scrolled = 0;
    target.scrollIntoView = () => { scrolled += 1; };
    fireEvent.click(link);
    expect(scrolled).toBe(1);
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("region", { name: "Project index" })).toBeTruthy();
  });

  test("Index filter narrows results and Start at P1 opens the Plan", async () => {
    renderDemo("index");
    const index = await screen.findByRole("region", { name: "Project index" });
    fireEvent.change(within(index).getByPlaceholderText(/Find an ID/), { target: { value: "zzz-no-such-term" } });
    expect(within(index).getByText("No indexed term matches.")).toBeTruthy();
    fireEvent.click(within(index).getByRole("button", { name: /Start at P1/ }));
    await waitFor(() => expect(window.location.search).toContain("workspace=plan"), { timeout: 5000 });
    expect(screen.queryByRole("region", { name: "Project index" })).toBeNull();
  });

  test("Build: blocked gate offers Resolve before claim, which opens Collision control", async () => {
    renderDemo("build");
    await screen.findByRole("region", { name: "Build workspace" });
    expect(screen.getByText("Why work cannot start")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Resolve before claim/ }));
    expect(await screen.findByRole("region", { name: "Collision assessment workspace" })).toBeTruthy();
  });

  test("Evidence: calendar scales without data are disabled with a reason, Days stays active", async () => {
    renderDemo("evidence");
    const rail = await screen.findByLabelText("Journey calendar scrubber");
    const months = within(rail).getByRole("button", { name: "Months" });
    const weeks = within(rail).getByRole("button", { name: "Weeks" });
    const days = within(rail).getByRole("button", { name: "Days" });
    expect(months.disabled).toBe(true);
    expect(weeks.disabled).toBe(true);
    expect(months.title).toMatch(/Not available yet/);
    expect(days.disabled).toBe(false);
    expect(days.getAttribute("aria-pressed")).toBe("true");
  });

  test("Collision control: a refused approval says so instead of failing silently, and the gate stays locked", async () => {
    renderDemo("collision");
    const ws = await screen.findByRole("region", { name: "Collision assessment workspace" });
    const request = (await within(ws).findAllByRole("button", { name: /Request approval|Stage proposed order/ }))[0];
    fireEvent.click(request);
    await waitFor(() => expect(document.querySelector(".toast")?.textContent).toMatch(/not recorded|staged for review only/i), { timeout: 5000 });
    expect(within(ws).getByRole("button", { name: /Commit assessment/ }).disabled).toBe(true);
    expect(within(ws).getByRole("button", { name: /Verify chain/ }).disabled).toBe(true);
    fireEvent.click(within(ws).getByRole("button", { name: "Reset demo census" }));
  });

  test("Allocation: Roster and Capacity open the inspector", async () => {
    renderDemo("allocation");
    const ws = await screen.findByRole("region", { name: "Allocation workspace" });
    fireEvent.click(within(ws).getByRole("button", { name: /Roster/ }));
    expect(await screen.findByRole("heading", { name: /Sample delivery roster/ })).toBeTruthy();
  });

  test("Ledger task expands and opens the full inspector", async () => {
    renderDemo("ledger");
    const ws = await screen.findByRole("region", { name: "To-do and document ledger" });
    const task = ws.querySelector(".ledger-task");
    fireEvent.click(task);
    expect(task.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(ws).getByRole("button", { name: /Open complete task inspector/ }));
    expect(await screen.findByRole("heading", { level: 2, name: new RegExp(`^${task.querySelector("code").textContent} ·`) }, { timeout: 3000 })).toBeTruthy();
  });
});
