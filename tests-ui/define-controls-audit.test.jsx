import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StructureWorkspace } from "../src/components/StructureWorkspace.jsx";
import { BlueprintWorkspace } from "../src/components/BlueprintWorkspace.jsx";
import { ComponentPlansWorkspace, readableTime } from "../src/components/ComponentPlansWorkspace.jsx";
import { createImportedProjectSession } from "../src/project/projectSession.js";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "unavailable in test" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const root = "b".repeat(64);
const project = createImportedProjectSession({
  name: "Audit app",
  adapter: "browser",
  registration: { workspaceId: "ws_audit", registryRevision: 1, rootIdentity: root, access: "metadata-read-only", canonicalRoot: "browser://Audit/x" },
  census: { workspaceId: "ws_audit", registryRevision: 1, rootIdentity: root, digest: "3".repeat(64), fileCount: 2, generatedAt: "2026-10-01T09:30:00.000Z", skipped: [] },
  now: Date.parse("2026-10-01T09:30:00.000Z"),
});

describe("Define controls", () => {
  test("Reset proposal in a real project empties the plan instead of loading sample folders", async () => {
    const user = userEvent.setup();
    render(<StructureWorkspace activeProject={project} workspaceAdapter={{ mode: "native" }} />);
    await user.click(screen.getByRole("button", { name: /Add folder/ }));
    const metric = () => screen.getByText("named paths").previousSibling.textContent;
    expect(metric()).toBe("1");
    // define-02: resetting discards planned folders, so it asks first and Keep changes nothing.
    await user.click(screen.getByRole("button", { name: /Reset proposal/ }));
    expect(screen.getByRole("group", { name: "Confirm reset proposal" }).textContent).toContain("Remove all 1 planned folder?");
    expect(metric()).toBe("1");
    await user.click(screen.getByRole("button", { name: "Keep my folders" }));
    expect(screen.queryByRole("group", { name: "Confirm reset proposal" })).toBeNull();
    expect(metric()).toBe("1");
    await user.click(screen.getByRole("button", { name: /Reset proposal/ }));
    await user.click(screen.getByRole("button", { name: "Yes, reset" }));
    expect(metric()).toBe("0");
    expect(screen.queryByText("F001")).toBeNull();
  });

  test("define-14: with no project chosen, Structure shows an empty plan, not the Demo's sample folders", async () => {
    const user = userEvent.setup();
    render(<StructureWorkspace workspaceAdapter={{ mode: "native" }} />);
    expect(screen.getByText("named paths").previousSibling.textContent).toBe("0");
    await user.click(screen.getByRole("button", { name: /Planned paths/ }));
    expect(screen.getByText(/Choose an app folder first/)).toBeTruthy();
    expect(screen.queryByText("F001")).toBeNull();
  });

  test("Reset proposal in the Demo restores the sample plan", async () => {
    const user = userEvent.setup();
    render(<StructureWorkspace activeProject={{ kind: "demo" }} workspaceAdapter={{ mode: "native" }} />);
    const before = screen.getByText("named paths").previousSibling.textContent;
    await user.click(screen.getByRole("button", { name: /Add folder/ }));
    expect(screen.getByText("named paths").previousSibling.textContent).toBe(String(Number(before) + 1));
    await user.click(screen.getByRole("button", { name: /Reset proposal/ }));
    await user.click(screen.getByRole("button", { name: "Yes, reset" }));
    expect(screen.getByText("named paths").previousSibling.textContent).toBe(before);
  });

  test("Demo Structure cannot pretend to freeze a revision", () => {
    render(<StructureWorkspace activeProject={{ kind: "demo" }} workspaceAdapter={{ mode: "native" }} />);
    const freeze = screen.getByRole("button", { name: /Freeze revision/ });
    expect(freeze.disabled).toBe(true);
    expect(freeze.parentElement.textContent).toContain("Demo only — sample data");
  });

  test("workspace mode buttons and Collapse all change the draft and panels", async () => {
    const user = userEvent.setup();
    render(<StructureWorkspace activeProject={project} workspaceAdapter={{ mode: "native" }} />);
    await user.click(screen.getByRole("button", { name: "git" }));
    expect(screen.getByRole("button", { name: "git" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Bring in an existing app/ }).getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.getByRole("button", { name: /Bring in an existing app/ }).getAttribute("aria-expanded")).toBe("false");
  });

  test("Structure architecture link and Blueprint structure links navigate", async () => {
    const user = userEvent.setup();
    const onOpenBlueprint = vi.fn();
    render(<StructureWorkspace activeProject={project} onOpenBlueprint={onOpenBlueprint} workspaceAdapter={{ mode: "native" }} />);
    await user.click(screen.getByRole("button", { name: "Open architecture draft" }));
    expect(onOpenBlueprint).toHaveBeenCalledTimes(1);
    cleanup();
    const onOpenStructure = vi.fn();
    const onSelect = vi.fn();
    render(<BlueprintWorkspace onSelect={onSelect} onOpenStructure={onOpenStructure} />);
    await user.click(screen.getByRole("button", { name: /Open structure builder/ }));
    expect(onOpenStructure).toHaveBeenCalledTimes(1);
    await user.click(screen.getAllByRole("button", { name: /required/ })[0]);
    // define-19: an unanswered contract is open work ("queued"), not a red hard stop.
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ status: "queued" }));
  });

  test("Component contracts: Review Structure intake navigates and the map atlas opens", async () => {
    const user = userEvent.setup();
    const onOpenStructure = vi.fn();
    render(<ComponentPlansWorkspace activeProject={project} onOpenStructure={onOpenStructure} />);
    await user.click(screen.getByText(/Reference · folder intake/));
    await user.click(screen.getByRole("button", { name: /Review Structure intake/ }));
    expect(onOpenStructure).toHaveBeenCalledTimes(1);
    cleanup();
    render(<ComponentPlansWorkspace activeProject={{ kind: "demo" }} />);
    await user.click(screen.getByRole("button", { name: /Open map atlas/ }));
    const atlas = document.querySelector(".component-map-atlas");
    await user.click(within(atlas).getAllByRole("button")[1]);
    expect(within(atlas).getByLabelText(/Mermaid source/)).toBeTruthy();
  });
  // Trial define-24: a search with no match left a blank list, "27" in the
  // header and the hidden C001 open in the dossier.
  test("Demo component search with no match says so, counts matches and hides the dossier", async () => {
    const user = userEvent.setup();
    render(<ComponentPlansWorkspace activeProject={{ kind: "demo" }} />);
    const total = document.querySelectorAll(".component-catalog-list > button").length;
    expect(total).toBeGreaterThan(1);
    await user.type(screen.getByLabelText("Find component, scope, or purpose"), "zzzz-nothing");
    expect(screen.getByRole("status").textContent).toMatch(/No component matches “zzzz-nothing”/);
    expect(screen.getByText(`0 of ${total} dossiers match`)).toBeTruthy();
    expect(document.querySelector(".component-dossier h2")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(document.querySelectorAll(".component-catalog-list > button").length).toBe(total);
    expect(document.querySelector(".component-dossier h2")).toBeTruthy();
  });

  test("Demo search that hides the selected component shows the first match instead", async () => {
    const user = userEvent.setup();
    render(<ComponentPlansWorkspace activeProject={{ kind: "demo" }} />);
    const second = document.querySelectorAll(".component-catalog-list > button")[1];
    const name = second.querySelector("strong").textContent;
    await user.type(screen.getByLabelText("Find component, scope, or purpose"), name);
    expect(document.querySelector(".component-dossier h2").textContent).toBe(name);
    expect(document.querySelector(".component-catalog-list > button.active strong").textContent).toBe(name);
  });

  // Trial define-20: the sample catalog read as a green, saved 100%.
  test("Demo catalog coverage is labelled as an unsaved sample", () => {
    render(<ComponentPlansWorkspace activeProject={{ kind: "demo" }} />);
    const state = document.querySelector(".component-catalog-state");
    expect(state.classList.contains("ready")).toBe(false);
    expect(state.textContent).toMatch(/Sample · not saved/);
  });

  // Trial define-26 (Components half): the discovery time was a raw ISO string.
  test("imported Components shows the discovery time as a readable date, not ISO", () => {
    const withDiscovery = createImportedProjectSession({
      name: "Audit app",
      adapter: "browser",
      registration: { workspaceId: "ws_audit", registryRevision: 1, rootIdentity: root, access: "metadata-read-only", canonicalRoot: "browser://Audit/x" },
      census: { workspaceId: "ws_audit", registryRevision: 1, rootIdentity: root, digest: "3".repeat(64), fileCount: 2, generatedAt: "2026-10-01T09:30:00.000Z", skipped: [] },
      discovery: { state: "generated", generatedAt: "2026-10-01T09:30:00.000Z", counts: { observed: 1, signals: 0, unanswered: 7 }, categories: [{ id: "A01", state: "observed", findings: [{ id: "S001" }] }] },
      now: Date.parse("2026-10-01T09:30:00.000Z"),
    });
    render(<ComponentPlansWorkspace activeProject={withDiscovery} />);
    const facts = screen.getByRole("region", { name: "Available project facts" }).textContent;
    expect(facts).not.toContain("2026-10-01T09:30:00.000Z");
    expect(facts).toContain(readableTime("2026-10-01T09:30:00.000Z"));
    expect(readableTime("not a date")).toBe("time unknown");
  });
});
