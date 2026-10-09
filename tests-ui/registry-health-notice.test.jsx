import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RegistryHealthNotice, registryHealthMessage } from "../src/components/RegistryHealthNotice.jsx";
import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { ProjectProvider, useProject } from "../src/project/ProjectProvider.jsx";
import { DEFAULT_PROJECT_REGISTRY_KEY, createMemoryStorage } from "../src/project/projectRegistry.js";

const at = "2026-09-04T01:00:00.000Z";
const BACKUP_PREFIX = `${DEFAULT_PROJECT_REGISTRY_KEY}.unreadable-`;

function OpenDemo() {
  const project = useProject();
  return <button type="button" onClick={() => project.registerProject(createDemoProjectSession({ now: at }))}>Open Demo</button>;
}

function SelectActive({ workspace }) {
  const project = useProject();
  return <button type="button" onClick={() => project.selectProject(project.activeProjectId, { workspace, historyMode: "push" })}>Go {workspace}</button>;
}

function renderWith(storage, extra = null) {
  return render(<ProjectProvider storage={storage} syncHistory={false}><RegistryHealthNotice /><OpenDemo />{extra}</ProjectProvider>);
}

function failingWrites(storage) {
  let fail = false;
  return {
    storage: {
      get length() { return storage.length; },
      clear: () => storage.clear(),
      getItem: (key) => storage.getItem(key),
      key: (index) => storage.key(index),
      removeItem: (key) => storage.removeItem(key),
      setItem(key, value) {
        if (fail && key === DEFAULT_PROJECT_REGISTRY_KEY) { const error = new Error("quota"); error.code = "QuotaExceededError"; throw error; }
        storage.setItem(key, value);
      },
    },
    failFromNowOn() { fail = true; },
    recover() { fail = false; },
  };
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("RegistryHealthNotice (xcut-03)", () => {
  test("a healthy registry shows nothing", () => {
    renderWith(createMemoryStorage());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("an unreadable registry is announced with its backup key, says nothing was deleted, and survives a later successful save", async () => {
    const storage = createMemoryStorage();
    storage.setItem(DEFAULT_PROJECT_REGISTRY_KEY, "{not json");
    renderWith(storage);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Saved projects could not be read");
    const backupKey = Array.from({ length: storage.length }, (_, i) => storage.key(i)).find((key) => key.startsWith(BACKUP_PREFIX));
    expect(backupKey).toBeTruthy();
    expect(storage.getItem(backupKey)).toBe("{not json");
    expect(alert.textContent).toContain(backupKey);
    expect(alert.textContent).toContain("Nothing was deleted");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open Demo" }));
    expect(screen.getByRole("alert").textContent).toContain("Saved projects could not be read");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a failed write says changes are kept in this tab only, and returns after recovery and a new failure", async () => {
    const harness = failingWrites(createMemoryStorage());
    renderWith(harness.storage);
    const user = userEvent.setup();
    expect(screen.queryByRole("alert")).toBeNull();
    harness.failFromNowOn();
    await user.click(screen.getByRole("button", { name: "Open Demo" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Changes could not be saved on this device");
    expect(alert.textContent).toContain("Changes are kept in this tab only");
    expect(alert.textContent).toContain("Nothing was deleted");

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    harness.recover();
    await user.click(screen.getByRole("button", { name: "Open Demo" }));
    expect(screen.queryByRole("alert")).toBeNull();
    harness.failFromNowOn();
    await user.click(screen.getByRole("button", { name: "Open Demo" }));
    expect(screen.getByRole("alert").textContent).toContain("Changes are kept in this tab only");
  });

  test("blocked storage and newer-version registries are both explained", () => {
    expect(registryHealthMessage({ reason: "storage-unavailable" }).body.join(" ")).toContain("kept in this tab only");
    expect(registryHealthMessage({ reason: "schema-version-unsupported" }).body.join(" ")).toContain("left untouched");
    expect(registryHealthMessage({ reason: "external-storage-invalid" }).body.join(" ")).toContain("Nothing was deleted");
    expect(registryHealthMessage({ reason: "storage-corrupt" }).body.join(" ")).toContain("a backup copy could not be made");
    for (const reason of ["storage-ready", "schema-migrated", "external-update-applied"]) expect(registryHealthMessage({ reason })).toBeNull();
  });

  test("renders nothing outside a ProjectProvider", () => {
    render(<RegistryHealthNotice />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("selectProject history guard (xcut-07)", () => {
  test("re-selecting the current workspace replaces instead of stacking duplicate Back entries", async () => {
    window.history.replaceState({}, "", "/");
    render(<ProjectProvider storage={createMemoryStorage()}><OpenDemo /><SelectActive workspace="build" /><SelectActive workspace="plan" /></ProjectProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open Demo" }));
    const start = window.history.length;
    await user.click(screen.getByRole("button", { name: "Go build" }));
    expect(window.history.length).toBe(start + 1);
    expect(new URL(window.location.href).searchParams.get("workspace")).toBe("build");
    await user.click(screen.getByRole("button", { name: "Go build" }));
    await user.dblClick(screen.getByRole("button", { name: "Go build" }));
    expect(window.history.length).toBe(start + 1);
    await user.click(screen.getByRole("button", { name: "Go plan" }));
    expect(window.history.length).toBe(start + 2);
    expect(new URL(window.location.href).searchParams.get("workspace")).toBe("plan");
  });
});
