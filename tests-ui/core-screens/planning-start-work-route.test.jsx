import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import CorePlanSpine from "../../src/core-screens/CorePlanSpine.jsx";

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("Planning sends eligible work to the existing gated start controls without treating Build navigation as a launch", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url).split("?")[0].replace("/api/core", "");
    if (path === "/session") return ok({ person: true });
    if (path === "/tasks") return ok({ repo: { ok: true, root: "/finish-lines" }, tasks: [{ id: "T-6", label: "T-6", title: "Open Build from Planning", status: "open", stage: "ready-to-claim", clauses: [], proofs: [], lastProgress: null, merged: null, dispatch: { model: "gpt-5.6-terra" }, worktree: null, diffApproval: null }] });
    if (path === "/agents") return ok({ agents: [], connections: [] });
    if (path === "/planning/roadmap") return ok({ phases: [{ id: "P1", title: "Build", tasks: [{ task: "T-6", owner: "owner" }] }] });
    if (path === "/people") return ok({ view: { owner: { person: "owner" }, members: [{ person: "owner", name: "Owner", role: "owner" }] }, photos: {} });
    throw new Error(`unexpected ${path}`);
  }));
  const onWorkspace = vi.fn();
  render(<CorePlanSpine onWorkspace={onWorkspace} />);

  fireEvent.click(await screen.findByRole("button", { name: "Start work for T-6" }));
  expect(onWorkspace).toHaveBeenCalledWith("tasks");
  fireEvent.click(screen.getByRole("button", { name: "Open live Build for T-6" }));
  expect(onWorkspace).toHaveBeenLastCalledWith("build");
});
