import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ComponentPlansWorkspace } from "../src/components/ComponentPlansWorkspace.jsx";
import { createImportedProjectSession, withProjectState } from "../src/project/projectSession.js";

const CAPTURED_AT = "2026-09-04T08:00:00.000Z";

function importedProject({ discovery = null, name = "Imported Product", rootCharacter = "a", digestCharacter = "1" } = {}) {
  const workspaceId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return createImportedProjectSession({
    name,
    adapter: "native",
    now: CAPTURED_AT,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\private\\component-intake\\${name}`,
      registryRevision: 4,
      rootIdentity: rootCharacter.repeat(64),
      workspaceId,
    },
    census: {
      digest: digestCharacter.repeat(64),
      fileCount: 12,
      generatedEpochMs: Date.parse(CAPTURED_AT),
      registryRevision: 4,
      rootIdentity: rootCharacter.repeat(64),
      skipped: [],
      totalBytesHashed: 4096,
      workspaceId,
    },
    discovery,
  });
}

function discoverySnapshot() {
  return {
    state: "generated",
    generatedAt: CAPTURED_AT,
    counts: { observed: 1, signals: 1, unanswered: 1 },
    categories: [
      { id: "A01", state: "observed", findings: [{ id: "S001" }] },
      { id: "A02", state: "signal", findings: [{ id: "S013" }] },
      { id: "A04", state: "unanswered", findings: [] },
    ],
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: "Demo registry unavailable in focused test" }),
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ComponentPlansWorkspace imported-project catalog start", () => {
  test("shows only registered census facts when component discovery is unavailable", async () => {
    const user = userEvent.setup();
    const onOpenStructure = vi.fn();
    const project = importedProject();
    const { container } = render(<ComponentPlansWorkspace activeProject={project} onOpenStructure={onOpenStructure} />);

    expect(screen.getByRole("region", { name: "Project component catalog start" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Component contracts" })).toBeTruthy();
    expect(screen.getAllByText("Imported Product")).toHaveLength(2);
    expect(screen.getByText("12 files")).toBeTruthy();
    expect(screen.getByText(/digest 111111111111/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "No component contracts have been generated" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add component" })).toBeTruthy();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(8);
    expect(screen.getByText("Which runtime and framework are present?")).toBeTruthy();
    expect(container.textContent).not.toContain("PP-CLEANROOM");
    expect(container.textContent).not.toContain("Component contract registry");
    expect(container.textContent).not.toContain("C001");

    await user.click(screen.getByText('Reference · folder intake and discovery evidence'));
    await user.click(screen.getByRole("button", { name: "Review Structure intake" }));
    expect(onOpenStructure).toHaveBeenCalledTimes(1);
  });

  test("labels persisted discovery records as Observed, Needs review, or Unavailable", () => {
    const project = importedProject({ discovery: discoverySnapshot() });
    const { container } = render(<ComponentPlansWorkspace activeProject={project} />);

    const identity = container.querySelector('[data-discovery-category="A01"]');
    const runtime = container.querySelector('[data-discovery-category="A02"]');
    const tenancy = container.querySelector('[data-discovery-category="A04"]');
    expect(identity.textContent).toContain("Observed");
    expect(identity.textContent).toContain("S001");
    expect(runtime.textContent).toContain("Needs review");
    expect(runtime.textContent).toContain("S013");
    expect(tenancy.textContent).toContain("Unavailable");
    expect(screen.getByText("1 observed · 1 review")).toBeTruthy();
    expect(screen.getByText(/1 unanswered/)).toBeTruthy();
    expect(container.textContent).not.toContain("React-style component files");
  });

  test("downgrades last-known observed evidence when the project is stale or unavailable", () => {
    const generated = importedProject({ discovery: discoverySnapshot(), name: "Aging Product", rootCharacter: "b", digestCharacter: "2" });
    const stale = withProjectState(generated, "stale", { now: "2026-09-04T09:00:00.000Z", reason: "census-outdated" });
    const first = render(<ComponentPlansWorkspace activeProject={stale} />);
    expect(screen.getByText("Last-known discovery needs review")).toBeTruthy();
    expect(first.container.querySelector('[data-discovery-category="A01"]').textContent).toContain("Needs review");
    first.unmount();

    const unavailable = withProjectState(generated, "unavailable", { now: "2026-09-04T09:00:00.000Z", reason: "folder-permission-lost" });
    const second = render(<ComponentPlansWorkspace activeProject={unavailable} />);
    expect(screen.getByText("Component evidence unavailable")).toBeTruthy();
    expect(second.container.querySelector('[data-discovery-category="A01"]').textContent).toContain("Unavailable");
  });

  test("keeps the established Demo component-contract workspace available", () => {
    const { container } = render(<ComponentPlansWorkspace activeProject={{ kind: "demo" }} />);

    expect(screen.getByRole("region", { name: "Detailed component plans" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Component Contracts" })).toBeTruthy();
    expect(container.textContent).toContain("Component contract registry");
    expect(container.textContent).toContain("C001");
    expect(screen.getByRole("button", { name: /Open map atlas/ })).toBeTruthy();
  });
});
