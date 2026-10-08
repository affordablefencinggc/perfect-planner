import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import {
  DEFAULT_PROJECT_REGISTRY_KEY,
  createMemoryStorage,
  createProjectRegistry,
} from "../src/project/projectRegistry.js";
import {
  createImportedProjectSession,
  withProjectState,
} from "../src/project/projectSession.js";

const FIXED_TIME = "2026-09-04T08:00:00.000Z";

const DEMO_ROUTES = Object.freeze({
  home: "Project Home workspace",
  blueprint: "Blueprint decision gates",
  structure: "Strict folder contract workspace",
  components: "Detailed component plans",
  plan: "Plan workspace",
  collision: "Collision assessment workspace",
  allocation: "Allocation workspace",
  build: "Build workspace",
  integrity: "Integrity and execution guarantees",
  evidence: "Evidence canvas",
  ledger: "To-do and document ledger",
  index: "Project index",
});

const IMPORTED_WORKFLOW_ROUTES = Object.freeze([
  "plan",
  "collision",
  "allocation",
  "build",
  "evidence",
  "integrity",
  "ledger",
  "index",
]);

const GATED_WORKSPACE_LABELS = Object.freeze({
  plan: "Plan",
  collision: "Collisions",
  allocation: "Allocation",
  build: "Build",
  evidence: "Evidence",
  integrity: "Integrity",
  ledger: "To-do / Ledger",
  index: "Index",
});

const NESTABLE_INTERACTIVE =
  'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';

function importedProject({
  name = "Customer Atlas",
  rootCharacter = "a",
  digestCharacter = "1",
  fileCount = 463,
  adapter = "native",
  persistence = "durable",
} = {}) {
  const workspaceId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const rootIdentity = rootCharacter.repeat(64);
  return createImportedProjectSession({
    name,
    adapter,
    persistence,
    now: FIXED_TIME,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\private\\${workspaceId}`,
      registryRevision: 12,
      rootIdentity,
      workspaceId,
    },
    census: {
      digest: digestCharacter.repeat(64),
      fileCount,
      generatedEpochMs: Date.parse(FIXED_TIME),
      registryRevision: 12,
      rootIdentity,
      skipped: [],
      totalBytesHashed: fileCount * 512,
      workspaceId,
    },
    discovery: {
      state: "generated",
      generatedAt: FIXED_TIME,
      counts: { observed: 1, signals: 1, unanswered: 6 },
      categories: [
        { id: "A01", state: "observed", findings: [{ id: "S001" }] },
        { id: "A02", state: "signal", findings: [{ id: "S002" }] },
      ],
    },
  });
}

function registryWith(...projects) {
  const registry = createProjectRegistry({
    storage: createMemoryStorage(),
    now: () => Date.parse(FIXED_TIME),
  });
  projects.forEach((project) => registry.upsert(project));
  return registry;
}

function renderShell(registry, url) {
  window.history.replaceState({}, "", url);
  return render(
    <ProjectProvider registry={registry} initialUrl={window.location.href}>
      <PerfectPlannerShell />
    </ProjectProvider>,
  );
}

function renderDemo(route = "home", phase = null) {
  const registry = registryWith();
  const demo = registry.upsert(createDemoProjectSession({ now: FIXED_TIME }));
  const phaseQuery = phase ? `&phase=${phase}` : "";
  return {
    ...renderShell(
      registry,
      `/?project=${demo.projectId}&workspace=${route}${phaseQuery}`,
    ),
    demo,
    registry,
  };
}

function nestedInteractiveDescriptions(container) {
  return [...container.querySelectorAll(NESTABLE_INTERACTIVE)]
    .filter((candidate) => candidate.querySelector(NESTABLE_INTERACTIVE))
    .map((candidate) => {
      const ownName =
        candidate.getAttribute("aria-label") ||
        candidate.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
        candidate.tagName;
      const child = candidate.querySelector(NESTABLE_INTERACTIVE);
      const childName =
        child?.getAttribute("aria-label") ||
        child?.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
        child?.tagName;
      return `${candidate.tagName}:${ownName} -> ${child?.tagName}:${childName}`;
    });
}

function expectProjectIsolation(container, activeProjectName) {
  expect(container.querySelectorAll(".project-tabs button.active")).toHaveLength(
    1,
  );
  expect(
    container.querySelector(".project-tabs button.active")?.textContent,
  ).toContain(activeProjectName);
}

beforeEach(() => {
  document.documentElement.lang = "en";
  document.title = "Perfect Planner";
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "Authority unavailable in survival test" }),
    })),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("real-life UI survival matrix", () => {
  test.each(Object.keys(DEMO_ROUTES))(
    "empty %s route stays empty and never promotes Demo or last-known values",
    async (route) => {
      const { container } = renderShell(registryWith(), `/?workspace=${route}`);

      await waitFor(() =>
        expect(
          screen.getAllByText(/No (active )?project selected|No active project/i)
            .length,
        ).toBeGreaterThan(0),
      );
      expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
        route,
      );
      expect(container.textContent).not.toContain("PP-014");
      expect(container.textContent).not.toContain("B01");
      expect(container.textContent).not.toContain("Build Agent A");
      expect(container.textContent).not.toContain("Perfect Planner Demo");
      expect(container.textContent).not.toMatch(/\b0 collisions\b|collision-free|ready to build/i);
      expect(container.querySelectorAll(".project-tabs button.active")).toHaveLength(
        1,
      );
      expect(nestedInteractiveDescriptions(container)).toEqual([]);
    },
  );

  test.each(Object.entries(DEMO_ROUTES))(
    "direct-link Demo route %s mounts its unique public surface without nested controls",
    async (route, regionName) => {
      const { container, demo } = renderDemo(route);

      expect(await screen.findByRole("region", { name: regionName })).toBeTruthy();
      expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
        route,
      );
      expect(
        new URLSearchParams(window.location.search).get("project"),
      ).toBe(demo.projectId);
      expectProjectIsolation(container, "Perfect Planner Demo");
      expect(nestedInteractiveDescriptions(container)).toEqual([]);
    },
  );

  test("every primary header button reaches a distinct, canonical workspace", async () => {
    const user = userEvent.setup();
    const { container } = renderDemo("home");
    const destinations = [
      ["Define", "blueprint", "Blueprint decision gates"],
      ["Coordinate", "plan", "Plan workspace"],
      ["Build", "build", "Build workspace"],
      ["Prove", "integrity", "Integrity and execution guarantees"],
      ["Release", "ledger", "To-do and document ledger"],
      ["Index", "index", "Project index"],
    ];
    const reached = new Set();

    for (const [label, workspace, regionName] of destinations) {
      const trigger =
        label === "Index"
          ? within(container.querySelector(".workspace-nav")).getByRole(
              "button",
              { name: "Index" },
            )
          : container.querySelector(
              `.workspace-nav button[aria-label="${label}"]`,
            );
      await user.click(trigger);
      expect(await screen.findByRole("region", { name: regionName })).toBeTruthy();
      const actual = new URLSearchParams(window.location.search).get(
        "workspace",
      );
      expect(actual).toBe(workspace);
      reached.add(actual);
    }

    expect(reached).toEqual(
      new Set(destinations.map(([, workspace]) => workspace)),
    );
    await user.click(screen.getByRole("button", { name: "Open Perfect Planner home" }));
    expect(
      await screen.findByRole("region", { name: "Project Home workspace" }),
    ).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
      "home",
    );
  });

  test("topbar metrics open the roster, agent connections, allocation calendar and collision review", async () => {
    const user = userEvent.setup();
    renderDemo("home");

    const rosterTrigger = screen.getByRole("button", { name: /3 developers/ });
    await user.click(rosterTrigger);
    expect(screen.getByRole("dialog", { name: "Developer roster" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
      "home",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(rosterTrigger));

    await user.click(screen.getByRole("button", { name: /2 demo agents/ }));
    expect(await screen.findByRole("region", { name: "Runtime and connections" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe("home");
    await user.keyboard("{Escape}");

    const calendarTrigger = screen.getByRole("button", {
      name: /P80.*18 days/,
    });
    await user.click(calendarTrigger);
    expect(screen.getByRole("dialog", { name: "Plan calendar" })).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: /Open allocation calendar/ }),
    );
    expect(
      await screen.findByRole("region", { name: "Allocation workspace" }),
    ).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
      "allocation",
    );

    await user.click(
      screen.getByRole("button", { name: /unresolved collisions/ }),
    );
    expect(
      await screen.findByRole("region", {
        name: "Collision assessment workspace",
      }),
    ).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
      "collision",
    );
  });

  test("More actions exposes separate roster, calendar, runtime, MCP, invitation, and organization views", async () => {
    const user = userEvent.setup();
    renderDemo("home");
    const trigger = screen.getByRole("button", { name: "More actions" });
    const openMenu = async () => {
      if (!screen.queryByRole("dialog", { name: "More actions" })) {
        await user.click(trigger);
      }
      return screen.getByRole("dialog", { name: "More actions" });
    };
    const back = async () => {
      await user.click(screen.getByRole("button", { name: "Back to more actions" }));
    };

    let dialog = await openMenu();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(nestedInteractiveDescriptions(dialog)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: /People & roster/ }));
    expect(within(dialog).getByText("Project membership must come from a connected organization")).toBeTruthy();
    await back();

    await user.click(within(dialog).getByRole("button", { name: /Delivery calendar/ }));
    expect(within(dialog).getByText("Demonstration forecast")).toBeTruthy();
    await back();

    await user.click(within(dialog).getByRole("button", { name: /Runtime & connections/ }));
    expect(
      await within(dialog).findByRole("region", { name: "Runtime and connections" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Receipts are project-bound and time-limited. Preferences and configured settings never establish availability.",
      ),
    ).toBeTruthy();
    await back();

    await user.click(within(dialog).getByRole("button", { name: /MCP access/ }));
    expect(within(dialog).getByText("Allow MCP context in this session")).toBeTruthy();
    await back();

    await user.click(within(dialog).getByRole("button", { name: /Invite to organization/ }));
    expect(within(dialog).getByRole("button", { name: /Create invitation draft/ })).toBeTruthy();
    await back();

    await user.click(within(dialog).getByRole("button", { name: /Organization settings/ }));
    expect(within(dialog).getByPlaceholderText("No organization connected")).toBeTruthy();
    expect(nestedInteractiveDescriptions(dialog)).toEqual([]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "More actions" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("More actions opens agent connections without navigation and routes collision review", async () => {
    const user = userEvent.setup();
    renderDemo("home");

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Agent connection/ }));
    expect(await screen.findByRole("region", { name: "Runtime and connections" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe("home");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Collision review/ }));
    expect(
      await screen.findByRole("region", {
        name: "Collision assessment workspace",
      }),
    ).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
      "collision",
    );
  });

  test("MCP preference changes and runtime failures remain visible in the project-scoped diagnostics console", async () => {
    const user = userEvent.setup();
    renderDemo("structure");

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /MCP access/ }));
    const checkbox = screen.getByRole("checkbox", {
      name: /Allow MCP context in this session/,
    });
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(await screen.findByText("MCP context paused for this session.")).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Diagnostics console/ }));
    expect(screen.getByRole("log", { name: "Application errors" })).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(
        new ErrorEvent("error", { message: "Survival probe runtime failure" }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByText("Survival probe runtime failure")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "MCP events" }));
    const mcpLog = screen.getByRole("log", { name: "MCP events" });
    expect(within(mcpLog).getByText("MCP context paused for this session.")).toBeTruthy();
    expect(within(mcpLog).queryByText("Survival probe runtime failure")).toBeNull();
  });

  test("valid invitations and organization drafts report honestly without claiming delivery or persistence", async () => {
    const user = userEvent.setup();
    renderDemo("home");

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Invite to organization/ }));
    await user.type(screen.getByPlaceholderText("name@company.com"), "reviewer@example.com");
    await user.selectOptions(screen.getByRole("combobox", { name: /ROLE/ }), "Reviewer");
    await user.click(screen.getByRole("button", { name: /Create invitation draft/ }));
    expect(
      await screen.findByText(
        "Invitation drafted for reviewer@example.com as Reviewer. Delivery connection is still required.",
      ),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Organization settings/ }));
    await user.type(
      screen.getByPlaceholderText("No organization connected"),
      "Survival Lab",
    );
    await user.click(screen.getByRole("button", { name: "Keep session draft" }));
    expect(
      await screen.findByText("Organization name kept as a session-only draft."),
    ).toBeTruthy();
  });

  test("project receipt export is bound to the active project and empty state refuses it", async () => {
    const user = userEvent.setup();
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:perfect-planner-survival");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const { demo, unmount } = renderDemo("home");

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Export project record/ }));
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:perfect-planner-survival");
    expect(
      await screen.findByText(
        "Current project status exported as a redacted local JSON file.",
      ),
    ).toBeTruthy();
    const payload = JSON.parse(await createObjectUrl.mock.calls[0][0].text());
    expect(payload.project.projectId).toBe(demo.projectId);
    expect(payload.workspace).toBe("home");

    unmount();
    renderShell(registryWith(), "/?workspace=home");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Export project record/ }));
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("Select or import a project before exporting."),
    ).toBeTruthy();
  });

  test("plan cards keep one worker, one owner, one human photo, and no nested profile control", async () => {
    const { container } = renderDemo("plan");
    expect(await screen.findByRole("region", { name: "Plan workspace" })).toBeTruthy();

    const cards = [...container.querySelectorAll(".plan-node")];
    expect(cards.length).toBeGreaterThan(0);
    cards.forEach((card) => {
      expect(card.querySelectorAll(":scope > .perimeter-worker")).toHaveLength(1);
      expect(card.querySelectorAll(".owner-badge")).toHaveLength(1);
      expect(card.querySelectorAll(".owner-badge[role='button']")).toHaveLength(0);
      expect(
        card.querySelectorAll(".owner-badge > .owner-avatar"),
      ).toHaveLength(1);
      expect(
        card.querySelectorAll(
          ".owner-profile-popover > .profile-preview-avatar",
        ).length,
      ).toBeLessThanOrEqual(1);
    });
    expect(nestedInteractiveDescriptions(container)).toEqual([]);

    cleanup();
    const focused = renderDemo("plan", "P1");
    expect(
      await screen.findByRole("region", { name: "Whole-plan phase map" }),
    ).toBeTruthy();
    focused.container
      .querySelectorAll(".map-phase-row.focused .map-node-pill")
      .forEach((card) => {
        expect(card.querySelectorAll(":scope > .perimeter-worker")).toHaveLength(1);
        expect(card.querySelectorAll(".owner-badge")).toHaveLength(1);
        expect(card.querySelectorAll(".owner-badge[role='button']")).toHaveLength(0);
      });
    expect(nestedInteractiveDescriptions(focused.container)).toEqual([]);
  });

  test("keyboard focus enters and exits menus, drawers, and owner profiles without getting stranded", async () => {
    const user = userEvent.setup();
    renderDemo("plan", "P1");

    const more = screen.getByRole("button", { name: "More actions" });
    more.focus();
    await user.keyboard("{Enter}");
    const menu = screen.getByRole("dialog", { name: "More actions" });
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(more));

    const repositories = screen.getByRole("button", {
      name: "Open Repositories",
    });
    repositories.focus();
    await user.keyboard("{Enter}");
    const drawer = screen
      .getByRole("button", { name: "Close repository drawer" })
      .closest("aside");
    expect(drawer?.hasAttribute("inert")).toBe(false);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(repositories));
    expect(drawer?.hasAttribute("inert")).toBe(true);

    const owner = screen.getAllByRole("button", { name: /View .* profile/ })[0];
    owner.focus();
    await waitFor(() => expect(owner.getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getByRole("dialog", { name: /profile/ })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(owner.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(owner);
  });

  test("Demo and imported projects can be switched repeatedly without leaking identities, tasks, counts, or view state", async () => {
    const user = userEvent.setup();
    const customer = importedProject({
      name: "Customer Atlas",
      rootCharacter: "b",
      digestCharacter: "2",
      fileCount: 17,
    });
    const demo = createDemoProjectSession({ now: FIXED_TIME });
    const registry = registryWith(customer, demo);
    registry.updateView(customer.projectId, { workspace: "components" });
    registry.updateView(demo.projectId, { workspace: "plan", phase: "P1" });
    registry.setActive(customer.projectId);
    const { container } = renderShell(
      registry,
      `/?project=${customer.projectId}&workspace=components`,
    );

    expect(
      await screen.findByRole("region", { name: "Project component catalog start" }),
    ).toBeTruthy();
    expectProjectIsolation(container, "Customer Atlas");
    expect(container.querySelector(".workspace-stage").textContent).not.toContain(
      "B01",
    );

    await user.click(screen.getByRole("button", { name: /Perfect Planner Demo.*Demo/i }));
    expect(
      await screen.findByRole("region", { name: "Whole-plan phase map" }),
    ).toBeTruthy();
    expectProjectIsolation(container, "Perfect Planner Demo");
    expect(container.querySelector(".workspace-stage").textContent).toContain(
      "B01",
    );

    await user.click(screen.getByRole("button", { name: "Customer Atlas" }));
    expect(
      await screen.findByRole("region", { name: "Project component catalog start" }),
    ).toBeTruthy();
    expectProjectIsolation(container, "Customer Atlas");
    expect(container.querySelector(".workspace-stage").textContent).not.toContain(
      "B01",
    );
    expect(container.querySelector(".workspace-stage").textContent).not.toContain(
      "Build Agent A",
    );
  });

  test.each(IMPORTED_WORKFLOW_ROUTES)(
    "imported %s route renders only project-bound receipts and never confident Demo state",
    async (route) => {
      const project = importedProject();
      const registry = registryWith(project);
      const { container } = renderShell(
        registry,
        `/?project=${project.projectId}&workspace=${route}`,
      );
      const region = await screen.findByRole("region", {
        name: `Customer Atlas ${route} workflow`,
      });

      expect(region.getAttribute("data-project-id")).toBe(project.projectId);
      expect(region.getAttribute("data-project-generation")).toBe(
        String(registry.getSnapshot().activeProject.generation),
      );
      expect(region.getAttribute("data-page-state")).toBe("unanswered");
      expectProjectIsolation(container, "Customer Atlas");
      expect(region.textContent).not.toContain("B01");
      expect(region.textContent).not.toContain("Build Agent A");
      expect(region.textContent).not.toContain("PP-014");
      expect(region.textContent).not.toMatch(/\b0 collisions\b|collision-free|ready to build/i);
      if (route === "collision") {
        expect(region.textContent).toContain("collisions not evaluated");
      }
      expect(nestedInteractiveDescriptions(container)).toEqual([]);
    },
  );

  test.each(["stale", "unavailable"])(
    "%s imported authority remains explicitly degraded on every downstream workflow",
    async (state) => {
      const current = importedProject({
        name: `${state} Atlas`,
        rootCharacter: state === "stale" ? "c" : "d",
        digestCharacter: state === "stale" ? "3" : "4",
      });
      const project = withProjectState(current, state, {
        now: "2026-09-04T09:00:00.000Z",
        reason: `${state}-survival-probe`,
      });

      for (const route of IMPORTED_WORKFLOW_ROUTES) {
        const mounted = renderShell(
          registryWith(project),
          `/?project=${project.projectId}&workspace=${route}`,
        );
        const region = await screen.findByRole("region", {
          name: `${GATED_WORKSPACE_LABELS[route]} unavailable`,
        });
        expect(region.querySelector(`.project-truth-workspace-state--${state}`)).toBeTruthy();
        expect(region.textContent).toMatch(new RegExp(state, "i"));
        expect(within(region).getByRole("button", { name: "Return to Structure" })).toBeTruthy();
        expect(region.textContent).not.toMatch(/\b0 collisions\b|collision-free|ready to build/i);
        mounted.unmount();
      }
    },
  );

  test("durable registry and canonical URL survive a full unmount/remount without changing project or route", async () => {
    const storage = createMemoryStorage();
    const registry = createProjectRegistry({
      storage,
      now: () => Date.parse(FIXED_TIME),
    });
    const project = importedProject({
      name: "Reload Atlas",
      rootCharacter: "e",
      digestCharacter: "5",
      fileCount: 91,
    });
    registry.upsert(project);
    registry.updateView(project.projectId, { workspace: "ledger" });
    const canonicalUrl = `/?project=${project.projectId}&workspace=ledger`;

    const first = renderShell(registry, canonicalUrl);
    expect(
      await screen.findByRole("region", {
        name: "Reload Atlas ledger workflow",
      }),
    ).toBeTruthy();
    first.unmount();

    const reloadedRegistry = createProjectRegistry({
      storage,
      now: () => Date.parse(FIXED_TIME),
    });
    expect(reloadedRegistry.getSnapshot().activeProjectId).toBe(
      project.projectId,
    );
    expect(reloadedRegistry.get(project.projectId)?.view.workspace).toBe(
      "ledger",
    );
    renderShell(reloadedRegistry, canonicalUrl);

    expect(
      await screen.findByRole("region", {
        name: "Reload Atlas ledger workflow",
      }),
    ).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("project")).toBe(
      project.projectId,
    );
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
      "ledger",
    );
    expect(screen.getAllByText("91 files", { exact: false }).length).toBeGreaterThan(
      0,
    );
  });

  test("browser popstate restores both project and route, including a prior phase focus", async () => {
    const alpha = importedProject({
      name: "History Alpha",
      rootCharacter: "f",
      digestCharacter: "6",
    });
    const demo = createDemoProjectSession({ now: FIXED_TIME });
    const registry = registryWith(alpha, demo);
    registry.setActive(alpha.projectId);
    renderShell(
      registry,
      `/?project=${alpha.projectId}&workspace=components`,
    );
    expect(
      await screen.findByRole("region", { name: "Project component catalog start" }),
    ).toBeTruthy();

    await act(async () => {
      window.history.pushState(
        {},
        "",
        `/?project=${demo.projectId}&workspace=plan&phase=P2`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(
      await screen.findByRole("region", { name: "Whole-plan phase map" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: /P2.*Architecture Contract/ })).toBeTruthy();

    await act(async () => {
      window.history.pushState(
        {},
        "",
        `/?project=${alpha.projectId}&workspace=components`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(
      await screen.findByRole("region", { name: "Project component catalog start" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Whole-plan phase map" })).toBeNull();
  });

  test("corrupted persisted metadata recovers to an honest empty UI instead of rendering last-known or Demo data", async () => {
    const storage = createMemoryStorage({
      [DEFAULT_PROJECT_REGISTRY_KEY]: JSON.stringify({
        schemaVersion: 999,
        projects: [{ projectId: "forged-demo", name: "Forged live app" }],
      }),
    });
    const registry = createProjectRegistry({
      storage,
      now: () => Date.parse(FIXED_TIME),
    });
    const { container } = renderShell(registry, "/?workspace=home");

    expect(
      await screen.findByRole("heading", { name: "Bring in a real app to begin" }),
    ).toBeTruthy();
    expect(registry.getSnapshot().health.state).toBe("stale");
    expect(registry.getSnapshot().health.reason).toBe(
      "schema-version-unsupported",
    );
    expect(container.textContent).not.toContain("Forged live app");
    expect(container.textContent).not.toContain("PP-014");
    expect(container.textContent).not.toContain("Build Agent A");
  });

  test("unknown route input is fail-closed and canonicalized to Project Home", async () => {
    const { container } = renderShell(
      registryWith(),
      "/?workspace=definitely-not-a-workspace&phase=forged",
    );
    expect(
      await screen.findByRole("region", { name: "Project Home workspace" }),
    ).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe(
      "home",
    );
    expect(new URLSearchParams(window.location.search).has("phase")).toBe(false);
    expect(container.textContent).not.toContain("definitely-not-a-workspace");
    expect(nestedInteractiveDescriptions(container)).toEqual([]);
  });
});
