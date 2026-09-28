import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { createDemoProjectSession, demoProjectDescriptor, isDemoProject } from "../src/demo/demoProject.js";
import { ProjectProvider, useProject } from "../src/project/ProjectProvider.jsx";
import { DEFAULT_PROJECT_REGISTRY_KEY, createMemoryStorage } from "../src/project/projectRegistry.js";

const at = "2026-09-04T01:00:00.000Z";

function input(name, rootIdentity, digest, fileCount) {
  const workspaceId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    name,
    adapter: "native",
    now: at,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\private\\${name}`,
      registryRevision: 1,
      rootIdentity,
      workspaceId,
    },
    census: {
      digest,
      fileCount,
      generatedEpochMs: Date.parse(at),
      registryRevision: 1,
      rootIdentity,
      skipped: [],
      totalBytesHashed: fileCount * 100,
      workspaceId,
    },
  };
}

function Probe() {
  const project = useProject();
  const active = project.activeProject;
  return <section aria-label="Project contract probe">
    <output aria-label="truth state">{project.state}</output>
    <output aria-label="active project">{active ? `${active.name}|${active.projectId}|${active.kind}|${active.state}|${active.census?.fileCount ?? "none"}` : "No project selected"}</output>
    <output aria-label="registry health">{`${project.registryHealth.state}|${project.registryHealth.persistence}|${project.registryHealth.reason}`}</output>
    <output aria-label="open project count">{project.projects.length}</output>
    {active && <output aria-label="fixture disclosure">{isDemoProject(active) ? demoProjectDescriptor.disclosure : "Imported project evidence"}</output>}
    <button onClick={() => project.registerImportedProject(input("Alpha App", "a".repeat(64), "1".repeat(64), 3))}>Import Alpha</button>
    <button onClick={() => project.registerImportedProject(input("Beta App", "b".repeat(64), "2".repeat(64), 8))}>Import Beta</button>
    <button onClick={() => project.registerProject(createDemoProjectSession({ now: at }))}>Open Demo</button>
    {project.projects.map((item) => <button key={item.projectId} onClick={() => project.selectProject(item.projectId, { workspace: item.name.startsWith("Alpha") ? "evidence" : "structure" })}>Select {item.name}</button>)}
  </section>;
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("foundation resilience ProjectProvider", () => {
  test("fresh state is honest and contains no implicit fixture", () => {
    render(<ProjectProvider storage={createMemoryStorage()} initialUrl="/?workspace=home"><Probe /></ProjectProvider>);
    expect(screen.getByLabelText("truth state").textContent).toBe("empty");
    expect(screen.getByLabelText("active project").textContent).toBe("No project selected");
    expect(document.body.textContent).not.toContain("PP-014");
    expect(document.body.textContent).not.toContain("PP-CLEANROOM");
  });

  test("two imports switch as whole sessions without mixing counts or truth kinds", async () => {
    const user = userEvent.setup();
    render(<ProjectProvider storage={createMemoryStorage()} initialUrl="/?workspace=home"><Probe /></ProjectProvider>);
    await user.click(screen.getByRole("button", { name: "Import Alpha" }));
    const alphaText = screen.getByLabelText("active project").textContent;
    expect(alphaText).toMatch(/^Alpha App\|pp_/);
    expect(alphaText).toContain("|imported|imported|3");
    await user.click(screen.getByRole("button", { name: "Import Beta" }));
    expect(screen.getByLabelText("active project").textContent).toMatch(/^Beta App\|pp_/);
    expect(screen.getByLabelText("active project").textContent).toContain("|imported|imported|8");
    await user.click(screen.getByRole("button", { name: "Select Alpha App" }));
    expect(screen.getByLabelText("active project").textContent).toBe(alphaText);
    expect(screen.getByLabelText("open project count").textContent).toBe("2");
  });

  test("active project and its route survive a provider reload from durable storage", async () => {
    const storage = createMemoryStorage();
    const user = userEvent.setup();
    const first = render(<ProjectProvider storage={storage} initialUrl="/?workspace=home"><Probe /></ProjectProvider>);
    await user.click(screen.getByRole("button", { name: "Import Alpha" }));
    await user.click(screen.getByRole("button", { name: "Import Beta" }));
    const betaId = screen.getByLabelText("active project").textContent.split("|")[1];
    await user.click(screen.getByRole("button", { name: "Select Beta App" }));
    expect(window.location.search).toContain(`project=${betaId}`);
    expect(window.location.search).toContain("workspace=structure");
    first.unmount();

    render(<ProjectProvider storage={storage} initialUrl={window.location.href}><Probe /></ProjectProvider>);
    expect(screen.getByLabelText("active project").textContent).toMatch(/^Beta App\|/);
    expect(screen.getByLabelText("active project").textContent).toContain("|8");
    expect(screen.getByLabelText("registry health").textContent).toBe("ready|durable|storage-ready");
  });

  test("popstate restores project and route context instead of only changing the URL", async () => {
    const user = userEvent.setup();
    render(<ProjectProvider storage={createMemoryStorage()} initialUrl="/?workspace=home"><Probe /></ProjectProvider>);
    await user.click(screen.getByRole("button", { name: "Import Alpha" }));
    const alphaId = screen.getByLabelText("active project").textContent.split("|")[1];
    await user.click(screen.getByRole("button", { name: "Import Beta" }));
    const betaId = screen.getByLabelText("active project").textContent.split("|")[1];
    expect(betaId).not.toBe(alphaId);

    await act(async () => {
      window.history.pushState({}, "", `/?project=${alphaId}&workspace=evidence`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByLabelText("active project").textContent).toMatch(/^Alpha App\|/);
    expect(window.location.search).toContain("workspace=evidence");

    await act(async () => {
      window.history.pushState({}, "", `/?project=${betaId}&workspace=structure`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByLabelText("active project").textContent).toMatch(/^Beta App\|/);
  });

  test("corrupt storage renders an empty stale state instead of fixtures", () => {
    const storage = createMemoryStorage({ [DEFAULT_PROJECT_REGISTRY_KEY]: "{broken" });
    render(<ProjectProvider storage={storage} initialUrl="/?workspace=home"><Probe /></ProjectProvider>);
    expect(screen.getByLabelText("active project").textContent).toBe("No project selected");
    expect(screen.getByLabelText("registry health").textContent).toBe("stale|memory|storage-corrupt");
    expect(document.body.textContent).not.toContain("PP-014");
    expect(document.body.textContent).not.toContain("PP-CLEANROOM");
  });

  test("write failure keeps the current project usable but labels persistence unavailable", async () => {
    const storage = {
      getItem() { return null; },
      removeItem() {},
      setItem() { throw new Error("quota exceeded"); },
    };
    const user = userEvent.setup();
    render(<ProjectProvider storage={storage} initialUrl="/?workspace=home"><Probe /></ProjectProvider>);
    await user.click(screen.getByRole("button", { name: "Import Alpha" }));
    expect(screen.getByLabelText("active project").textContent).toMatch(/^Alpha App\|/);
    expect(screen.getByLabelText("registry health").textContent).toBe("unavailable|memory|storage-write-failed");
  });

  test("Demo is disclosed and imported projects never inherit Demo truth", async () => {
    const user = userEvent.setup();
    render(<ProjectProvider storage={createMemoryStorage()} initialUrl="/?workspace=home"><Probe /></ProjectProvider>);
    await user.click(screen.getByRole("button", { name: "Open Demo" }));
    expect(screen.getByLabelText("active project").textContent).toContain("Perfect Planner Demo");
    expect(screen.getByLabelText("active project").textContent).toContain("|demo|demo|none");
    expect(screen.getByLabelText("fixture disclosure").textContent).toMatch(/Demonstration fixtures only/i);
    await user.click(screen.getByRole("button", { name: "Import Alpha" }));
    expect(screen.getByLabelText("active project").textContent).toContain("|imported|imported|3");
    expect(screen.getByLabelText("fixture disclosure").textContent).toBe("Imported project evidence");
  });
});
