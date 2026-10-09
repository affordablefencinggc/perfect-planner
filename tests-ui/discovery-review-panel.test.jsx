import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiscoveryReviewPanel } from "../src/components/DiscoveryReviewPanel.jsx";
import { readSection, readWorkRecords } from "../src/project/projectWorkRecords.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";
import { deriveImportedProjectWorkflowModel } from "../src/project/importedProjectWorkflowModel.js";
import { saveDiscoveryFindings } from "../src/project/discoveryReviewModel.js";
import { ProjectProvider, useProject } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { buildWorkspaceDiscovery } from "../src/engine/workspaceDiscoveryEngine.js";

const AT = "2026-09-04T11:00:00.000Z";

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}

function project({ generatedAt = AT } = {}) {
  const rootIdentity = "c".repeat(64);
  return createImportedProjectSession({
    name: "Looplet",
    adapter: "browser",
    persistence: "reselect-required",
    now: AT,
    registration: { access: "metadata-read-only", canonicalRoot: "Looplet", registryRevision: 1, rootIdentity, workspaceId: "looplet" },
    census: { digest: "d".repeat(64), fileCount: 3, generatedEpochMs: Date.parse(AT), registryRevision: 1, rootIdentity, skipped: [], totalBytesHashed: 10, workspaceId: "looplet" },
    discovery: {
      state: "generated",
      generatedAt,
      counts: { observed: 1, signals: 1, unanswered: 6 },
      categories: [
        { id: "A01", state: "observed", findings: [{ id: "S001" }] },
        { id: "A02", state: "signal", findings: [{ id: "S013" }] },
      ],
    },
  });
}

afterEach(cleanup);

describe("Review what we found", () => {
  test("lists every area and saves confirm, not applicable, and written answers for this scan", async () => {
    const user = userEvent.setup();
    const storage = memoryStorage();
    const session = project();
    const live = { categories: [{ id: "A02", findings: [{ id: "S013", label: "React-style component files", certainty: "signal", detail: "2 JSX files" }] }] };
    render(<DiscoveryReviewPanel project={session} storage={storage} liveDiscovery={live} liveCensusDigest={"d".repeat(64)} />);

    expect(screen.getByText("7 of 7 areas still need your answer.")).toBeTruthy();
    expect(screen.getAllByRole("listitem", { name: /./ }).filter((node) => node.classList.contains("discovery-review-row"))).toHaveLength(8);
    const runtime = screen.getByRole("listitem", { name: "Runtime & framework" });
    expect(within(runtime).getByText("React-style component files")).toBeTruthy();

    await user.click(within(runtime).getByRole("button", { name: /Looks right/ }));
    expect(within(screen.getByRole("listitem", { name: "Runtime & framework" })).getByRole("status").textContent).toContain("Looks right");
    await user.click(within(screen.getByRole("listitem", { name: "Credentials & security" })).getByRole("button", { name: /Not applicable/ }));

    const gaps = screen.getByRole("listitem", { name: "Unknowns & gaps" });
    await user.click(within(gaps).getByRole("button", { name: /Answer/ }));
    const save = within(screen.getByRole("listitem", { name: "Unknowns & gaps" })).getByRole("button", { name: "Save answer" });
    expect(save.disabled).toBe(true);
    await user.type(within(screen.getByRole("listitem", { name: "Unknowns & gaps" })).getByRole("textbox"), "No background workers yet.");
    await user.click(within(screen.getByRole("listitem", { name: "Unknowns & gaps" })).getByRole("button", { name: "Save answer" }));

    const saved = readSection(session.projectId, "discoveryReview", storage);
    expect(saved.revision).toBe(3);
    expect(saved.data.snapshot.generatedAt).toBe(AT);
    expect(saved.data.categories.A02.decision).toBe("confirmed");
    expect(saved.data.categories.A06.decision).toBe("not-applicable");
    expect(saved.data.categories.A08).toMatchObject({ decision: "answered", note: "No background workers yet." });
    expect(screen.getByText("4 of 7 areas still need your answer.")).toBeTruthy();

    for (const name of ["Application layers", "Data, tenancy & auth", "Dependencies & integrations", "Tests, CI & deployment"]) {
      await user.click(within(screen.getByRole("listitem", { name })).getByRole("button", { name: /Looks right/ }));
    }
    expect(screen.getByText("All 7 areas that needed a look have your answer.")).toBeTruthy();
    const plan = deriveImportedProjectWorkflowModel(session, "plan", readWorkRecords(session.projectId, storage));
    expect(plan.requirements.find((item) => item.id === "REC-DISCOVERY").state).toBe("recorded");

    await user.click(within(screen.getByRole("listitem", { name: "Runtime & framework" })).getByRole("button", { name: /Undo/ }));
    expect(screen.getByText("1 of 7 areas still need your answer.")).toBeTruthy();
  });

  test("a newer scan shows earlier answers as no longer counting and hides findings from another scan", () => {
    const storage = memoryStorage();
    const first = project();
    storage.setItem(`perfect-planner.work-records.v1:${first.projectId}`, JSON.stringify({ schemaVersion: 1, projectId: first.projectId, sections: { discoveryReview: { revision: 1, recordedAt: AT, data: { schemaVersion: 1, snapshot: { censusDigest: "d".repeat(64), generatedAt: AT, generation: null }, categories: { A02: { decision: "confirmed", note: "", decidedAt: AT } } } } } }));
    const rescanned = project({ generatedAt: "2026-09-05T09:00:00.000Z" });
    const live = { categories: [{ id: "A02", findings: [{ id: "S013", label: "React-style component files", certainty: "signal", detail: "" }] }] };
    render(<DiscoveryReviewPanel project={rescanned} storage={storage} liveDiscovery={live} liveCensusDigest={"e".repeat(64)} />);
    expect(screen.getByText(/earlier answers no longer count/)).toBeTruthy();
    expect(screen.getByText("7 of 7 areas still need your answer.")).toBeTruthy();
    expect(screen.queryByText("React-style component files")).toBeNull();
  });

  test("after a reload the saved finding labels and evidence paths are shown without scanning again", () => {
    const storage = memoryStorage();
    const session = project();
    const scan = { categories: [
      { id: "A01", findings: [{ id: "S001", label: "JavaScript or TypeScript app", certainty: "observed", evidence: ["package.json"], evidenceCount: 1, detail: "A package manifest exists at the app root." }] },
      { id: "A02", findings: [{ id: "S013", label: "React-style component files", certainty: "signal", evidence: ["src/App.jsx", "src/main.jsx", "src/Nav.jsx"], evidenceCount: 12, detail: "12 JSX/TSX files suggest React-style UI." }] },
    ] };
    saveDiscoveryFindings(session, scan, { storage, now: () => AT });
    // No live scan in this session: only what was saved with the scan.
    render(<DiscoveryReviewPanel project={session} storage={storage} />);
    const runtime = screen.getByRole("listitem", { name: "Runtime & framework" });
    expect(within(runtime).getByText("React-style component files")).toBeTruthy();
    expect(within(runtime).getByText("src/App.jsx")).toBeTruthy();
    expect(within(runtime).getByText(/and 9 more/)).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "App identity" })).getByText("package.json")).toBeTruthy();
    expect(screen.queryByText(/scan the folder again in this session/i)).toBeNull();
  });

  test("details saved for an older scan are not shown for a newer one", () => {
    const storage = memoryStorage();
    saveDiscoveryFindings(project(), { categories: [{ id: "A02", findings: [{ id: "S013", label: "React-style component files", certainty: "signal", evidence: ["src/App.jsx"], evidenceCount: 1, detail: "" }] }] }, { storage, now: () => AT });
    render(<DiscoveryReviewPanel project={project({ generatedAt: "2026-09-05T09:00:00.000Z" })} storage={storage} />);
    expect(screen.queryByText("React-style component files")).toBeNull();
    expect(screen.getAllByText(/scan the folder again in this session/i).length).toBeGreaterThan(0);
  });

  test("importing a scanned folder saves its finding details so the review shows them after a reload", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const rootIdentity = "f".repeat(64);
    const census = { digest: "9".repeat(64), fileCount: 3, generatedEpochMs: Date.parse(AT), registryRevision: 1, rootIdentity, skipped: [{ path: ".git", reason: "generated-or-dependency-directory-excluded", size: null }], totalBytesHashed: 30, workspaceId: "reload-app",
      files: [{ path: "package.json" }, { path: "src/App.jsx" }, { path: ".openai/hosting.json" }] };
    const discovery = buildWorkspaceDiscovery(census, { appName: "Reload App" });
    function Importer() {
      const projects = useProject();
      return <button onClick={() => projects.registerImportedProject({ name: "Reload App", adapter: "native", now: AT, registration: { access: "metadata-read-only", canonicalRoot: "C:\\private\\Reload App", registryRevision: 1, rootIdentity, workspaceId: "reload-app" }, census, discovery })}>Import</button>;
    }
    const first = render(<ProjectProvider storage={storage} initialUrl="/?workspace=structure"><Importer /></ProjectProvider>);
    await user.click(screen.getByRole("button", { name: "Import" }));
    first.unmount();

    // Reload: a new registry reads the saved project; no scan exists in this session.
    const saved = createProjectRegistry({ storage }).getSnapshot().activeProject;
    expect(saved.name).toBe("Reload App");
    render(<DiscoveryReviewPanel project={saved} storage={storage} />);
    const identity = screen.getByRole("listitem", { name: "App identity" });
    expect(within(identity).getByText("Git metadata present")).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "Tests, CI & deployment" })).getByText(".openai/hosting.json")).toBeTruthy();
    expect(screen.queryByText(/scan the folder again in this session/i)).toBeNull();
  });

  test("renders nothing for the Demo project", () => {
    const { container } = render(<DiscoveryReviewPanel project={{ kind: "demo", projectId: "demo" }} storage={memoryStorage()} />);
    expect(container.innerHTML).toBe("");
  });
});
