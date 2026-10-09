import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { createProjectEntityId } from "../src/project/projectIds.js";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { currentComponentPlanInput } from "../src/engine/componentPlanSeed.js";
import { freezeComponentPlans } from "../src/engine/componentPlanEngine.js";
import {
  createImportedProjectSession,
  createProjectSession,
  projectAuthorityKinds,
  withProjectState,
} from "../src/project/projectSession.js";
import {
  createMemoryStorage,
  createProjectRegistry,
} from "../src/project/projectRegistry.js";

const FIXED_TIME = "2026-09-04T08:00:00.000Z";

function discovery({ signals = 0, unanswered = 0 } = {}) {
  const categories = [
    { id: "A01", state: "observed", findings: [{ id: "S001" }] },
  ];
  if (signals) {
    categories.push({
      id: "A02",
      state: "signal",
      findings: Array.from({ length: signals }, (_, index) => ({
        id: `S01${index + 2}`,
      })),
    });
  }
  if (unanswered) {
    categories.push(
      ...Array.from({ length: unanswered }, (_, index) => ({
        id: `A${String(index + 3).padStart(2, "0")}`,
        state: "unanswered",
        findings: [],
      })),
    );
  }
  return {
    categories,
    counts: { observed: 1, signals, unanswered },
    generatedAt: FIXED_TIME,
    state: "generated",
  };
}

function importedProject({
  name,
  rootCharacter,
  digestCharacter,
  fileCount = 7,
  skippedCount = 0,
  discovery: discoveryInput = null,
}) {
  const workspaceId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return createImportedProjectSession({
    name,
    adapter: "native",
    now: FIXED_TIME,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\private\\home-integration\\${name}`,
      registryRevision: 12,
      rootIdentity: rootCharacter.repeat(64),
      workspaceId,
    },
    census: {
      digest: digestCharacter.repeat(64),
      fileCount,
      generatedEpochMs: Date.parse(FIXED_TIME),
      registryRevision: 12,
      rootIdentity: rootCharacter.repeat(64),
      skipped: Array.from({ length: skippedCount }, (_, index) => ({
        path: `skipped-${index}`,
        reason: "permission",
      })),
      totalBytesHashed: fileCount * 128,
      workspaceId,
    },
    discovery: discoveryInput,
  });
}

function withAuthorities(session) {
  const entityTypes = {
    architecture: "map",
    folder: "folder",
    component: "component",
    plan: "plan",
  };
  const authorities = Object.fromEntries(
    projectAuthorityKinds.map((kind, index) => [
      kind,
      {
        digest: String(index + 5).repeat(64),
        entityId: createProjectEntityId(
          session.projectId,
          entityTypes[kind],
          `${kind}-authority`,
        ),
        recordedAt: FIXED_TIME,
        revision: index + 1,
        state: "authoritative",
      },
    ]),
  );
  return createProjectSession({
    projectId: session.projectId,
    name: session.name,
    kind: session.kind,
    state: "authoritative",
    registration: session.registration,
    census: session.census,
    discovery: session.discovery,
    authorities,
    view: session.view,
    generation: session.generation + 1,
    createdAt: session.createdAt,
    updatedAt: "2026-09-04T08:30:00.000Z",
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

function renderShell(registry, project = null) {
  const query = project
    ? `/?project=${project.projectId}&workspace=home`
    : "/?workspace=home";
  window.history.replaceState({}, "", query);
  return render(
    <ProjectProvider registry={registry} initialUrl={window.location.href}>
      <PerfectPlannerShell />
    </ProjectProvider>,
  );
}

function expectOnlyModelAction(container, id, label) {
  const actions = container.querySelectorAll("[data-home-next-action]");
  expect(actions).toHaveLength(1);
  expect(actions[0].getAttribute("data-home-next-action")).toBe(id);
  expect(actions[0].textContent).toContain(label);
  const summary = container.querySelector('[aria-label="Project evidence summary"]');
  expect(actions[0].compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  return actions[0];
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "Authority unavailable in Home test" }),
    })),
  );
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("project Home consumes the project-home model", () => {
  test("empty Home is a short screen: headline, Choose app folder, and a demo link", async () => {
    const user = userEvent.setup();
    const { container } = renderShell(registryWith());

    await screen.findByRole("heading", { name: "Bring in a real app to begin" });
    expect(container.querySelector(".project-home-truth")?.dataset.homeMode).toBe("empty");
    expect(screen.queryByRole("region", { name: "Project evidence summary" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Project blockers" })).toBeNull();
    expect(container.querySelectorAll(".project-home-empty-body button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Try the demo" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Choose app folder/ }));
    expect(
      await screen.findByRole("region", { name: "Strict folder contract workspace" }),
    ).toBeTruthy();
  });

  test("with no folder imported, Home shows an approved core-loop plan instead of the folder prompt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => String(url).startsWith("/api/core/plan?")
        ? { ok: true, status: 200, json: async () => ({ ok: true, result: { approved: true, latest: { plan: "P-1", by: "owner" }, count: 1, tasks: [{ label: "T-1" }] } }) }
        : { ok: false, status: 503, json: async () => ({ error: "Authority unavailable in Home test" }) }),
    );
    const { container } = renderShell(registryWith());

    await screen.findByText("Your plan is approved and work is under way");
    expect(screen.queryByRole("heading", { name: "Bring in a real app to begin" })).toBeNull();
    expect(container.querySelector("[data-home-core-plan]")?.dataset.homeCorePlan).toBe("P-1");
    expect(container.querySelector("[data-home-core-plan]")?.textContent).toContain("Plan P-1 approved by owner, 1 task on the board.");
  });

  test("imported Home binds the current census and does not invent discovery counts", async () => {
    const user = userEvent.setup();
    const project = importedProject({
      name: "Honest Imported Home",
      rootCharacter: "a",
      digestCharacter: "1",
      fileCount: 17,
    });
    const { container } = renderShell(registryWith(project), project);

    await screen.findByRole("heading", { name: project.name });
    const home = container.querySelector(".project-home-truth");
    expect(home?.dataset.homeMode).toBe("imported");
    expect(home?.dataset.homeProjectId).toBe(project.projectId);
    expect(home?.dataset.homeGeneration).toBe(String(project.generation));
    expect(screen.getByLabelText("Current project stage").textContent).toContain(
      "Discovery snapshot required",
    );

    const summary = screen.getByRole("region", {
      name: "Project evidence summary",
    });
    expect(summary.textContent).toContain("17 files");
    expect(summary.textContent).toContain("0 skipped");
    expect(summary.textContent).toContain("111111111111");
    const discoveryCard = summary.querySelector(
      '[data-fact-state="unavailable"]:nth-child(3)',
    );
    expect(discoveryCard?.textContent).toContain("Unavailable");
    expect(discoveryCard?.textContent).not.toMatch(/\b0 observed\b/);
    expect(
      screen.getByRole("region", { name: "Project blockers" }).textContent,
    ).toContain("discovery-missing");

    const next = expectOnlyModelAction(
      container,
      "generate-discovery",
      "Generate project discovery",
    );
    await user.click(next);
    expect(window.location.search).toContain("workspace=structure");
  });

  test("review signals preempt generated authority work and remain visible", async () => {
    const project = importedProject({
      name: "Discovery Review Home",
      rootCharacter: "b",
      digestCharacter: "2",
      fileCount: 23,
      discovery: discovery({ signals: 2, unanswered: 1 }),
    });
    const { container } = renderShell(registryWith(project), project);

    await screen.findByRole("heading", { name: project.name });
    expect(container.querySelector(".project-home-truth")?.dataset.homeMode).toBe(
      "generated",
    );
    expect(screen.getByLabelText("Current project stage").textContent).toContain(
      "Discovery review required",
    );
    const summary = screen.getByRole("region", {
      name: "Project evidence summary",
    });
    expect(summary.textContent).toContain("1 observed");
    expect(summary.textContent).toContain("2 review signals");
    expect(summary.textContent).toContain("1 unanswered");
    const blockerText = screen.getByRole("region", {
      name: "Project blockers",
    }).textContent;
    expect(blockerText).toContain("discovery-signals-unreviewed");
    expect(blockerText).toContain("discovery-questions-unanswered");
    expectOnlyModelAction(container, "review-discovery", "Review discovery gaps");
  });

  test("checked parent authorities cannot make a cached Plan ready without its own checked Ledger", async () => {
    const user = userEvent.setup();
    const generated = importedProject({
      name: "Authoritative Home",
      rootCharacter: "c",
      digestCharacter: "3",
      fileCount: 31,
      discovery: discovery(),
    });
    let project = withAuthorities(generated);
    const catalog = await freezeComponentPlans({...structuredClone(currentComponentPlanInput),planId:project.projectId,architectureDigest:project.authorities.architecture.digest,architectureRevision:project.authorities.architecture.revision,folderDigest:project.authorities.folder.digest,folderRevision:project.authorities.folder.revision},{planId:project.projectId,actor:'fixture-reviewer',approvedAt:FIXED_TIME});
    project=createProjectSession({...project,authorities:{...project.authorities,component:{...project.authorities.component,digest:catalog.digest}}});
    // Full verified fixture payload, not an invented successful component count.
    const componentContext={schemaVersion:1,planId:project.projectId,state:'ready',ready:true,architectureHead:{contractDigest:project.authorities.architecture.digest,revision:project.authorities.architecture.revision},folderHead:{contractDigest:project.authorities.folder.digest,revision:project.authorities.folder.revision,architectureContractDigest:project.authorities.architecture.digest,architectureRevision:project.authorities.architecture.revision},folderNodes:[],catalogHead:{contractDigest:catalog.digest,revision:project.authorities.component.revision,registeredAt:FIXED_TIME,architectureDigest:catalog.architectureDigest,architectureRevision:catalog.architectureRevision,folderDigest:catalog.folderDigest,folderRevision:catalog.folderRevision},catalog,catalogState:'current',publicationAuthorized:false,executionAuthorized:false};
    // Controlled positive service response: cached approval alone is not current.
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (String(url) === "/api/architecture-contract/session") return { ok: true, json: async () => ({ actor: "fixture-reviewer", token: "fixture-" + "token" }) };
      if (String(url) === "/api/folder-contract/session") return { ok: true, json: async () => ({ actor: "fixture-reviewer", token: "fixture-" + "folder-" + "token" }) };
      if (String(url) === "/api/component-plans/session") return {ok:true,json:async()=>({actor:'fixture-reviewer',token:'fixture-' + 'component-' + 'token'})};
      if (String(url) === "/api/component-plans/authoring-context") {expect(JSON.parse(options.body).planId).toBe(project.projectId);return {ok:true,json:async()=>componentContext};}
      if (String(url) === "/api/folder-contract/inspect") {
        expect(JSON.parse(options.body).planId).toBe(project.projectId);
        const folder = project.authorities.folder, architecture = project.authorities.architecture;
        return { ok: true, json: async () => ({ valid: true, planId: project.projectId, head: { revision: folder.revision, contractDigest: folder.digest, registeredAt: folder.recordedAt, architectureContractDigest: architecture.digest, architectureRevision: architecture.revision } }) };
      }
      if (String(url) === "/api/architecture-contract/inspect") {
        expect(JSON.parse(options.body).planId).toBe(project.projectId);
        const architecture = project.authorities.architecture;
        return { ok: true, json: async () => ({ valid: true, planId: project.projectId, head: { revision: architecture.revision, contractDigest: architecture.digest, registeredAt: architecture.recordedAt } }) };
      }
      return originalFetch(url, options);
    }));
    const { container } = renderShell(registryWith(project), project);

    await screen.findByRole("heading", { name: project.name });
    expect(container.querySelector(".project-home-truth")?.dataset.homeMode).toBe(
      "authoritative",
    );
    await waitFor(() => expect(screen.getByLabelText("Current project stage").textContent).toContain(
      "Plan record out of date",
    ));
    expect(
      screen.getByRole("region", { name: "Project blockers" }).textContent,
    ).toContain("1 item prevent promotion");
    expect(screen.queryByText("Project status ready")).toBeNull();
    const next = expectOnlyModelAction(
      container,
      "refresh-plan-authority",
      "Refresh plan record",
    );
    await user.click(next);
    expect(window.location.search).toContain("workspace=plan");
  });

  test("cached complete approvals cannot present Home as ready when live inspection fails", async () => {
    const project = withAuthorities(importedProject({ name: "Offline approval", rootCharacter: "e", digestCharacter: "4", discovery: discovery() }));
    renderShell(registryWith(project), project);
    await screen.findByText(/Saved architecture could not be checked/);
    expect(screen.getByLabelText("Current project stage").textContent).not.toContain("Project status ready");
    expect(screen.getByText("last known · revision 1")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Project blockers" }).textContent).toContain("authority-architecture-unavailable");
  });

  test.each([
    ["stale", "Project evidence stale", "refresh-project-evidence"],
    [
      "unavailable",
      "Project record unavailable",
      "restore-project-authority",
    ],
  ])(
    "%s state overrides complete receipts without presenting a current file count",
    async (state, stageLabel, actionId) => {
      const generated = importedProject({
        name: `${state} Home`,
        rootCharacter: state === "stale" ? "d" : "e",
        digestCharacter: state === "stale" ? "4" : "5",
        fileCount: 41,
        discovery: discovery(),
      });
      const authoritative = withAuthorities(generated);
      const project = withProjectState(authoritative, state, {
        now: "2026-09-04T09:00:00.000Z",
        reason: `${state}-home-adversarial-test`,
      });
      const { container } = renderShell(registryWith(project), project);

      await screen.findByRole("heading", { name: project.name });
      expect(container.querySelector(".project-home-truth")?.dataset.homeMode).toBe(
        state,
      );
      expect(screen.getByLabelText("Current project stage").textContent).toContain(
        stageLabel,
      );
      if (state === "unavailable") {
        expect(screen.getByLabelText("Project intake evidence").textContent).toContain(
          "File scan unavailable",
        );
        expect(
          screen.getByLabelText("Project intake evidence").textContent,
        ).not.toContain("41 files captured");
      } else {
        expect(screen.getByLabelText("Project intake evidence").textContent).toContain(
          "Last known · 41 files captured",
        );
      }
      expectOnlyModelAction(container, actionId, state === "stale" ? "Refresh project evidence" : "Restore project access");
    },
  );

  test("the explicit Demo keeps its original fixture dashboard branch", async () => {
    const demo = createDemoProjectSession({ now: FIXED_TIME });
    const { container } = renderShell(registryWith(demo), demo);

    await screen.findByRole("heading", {
      name: "Local Collaboration Workspace",
    });
    expect(screen.getByText(/PP-014 · single source of project truth/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Project stage progress" })).toBeTruthy();
    expect(container.querySelector(".project-home-truth")).toBeNull();
    expect(container.querySelectorAll("[data-home-next-action]")).toHaveLength(0);
  });
});
