import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TeamPanel } from "../../src/core-screens/TeamPanel.jsx";

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

function routeFetch(routes) {
  const fn = vi.fn(async (url, init = {}) => {
    const path = String(url).split("?")[0].replace("/api/core", "");
    const handler = routes[`${init.method ?? "GET"} ${path}`];
    if (!handler) throw new Error(`unexpected ${init.method ?? "GET"} ${path}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("TeamPanel", () => {
  test("says the roster is empty instead of inventing a teammate", async () => {
    routeFetch({ "GET /teams": () => ok({ members: [] }) });
    render(<TeamPanel />);
    expect(await screen.findByText(/Roster empty/)).toBeTruthy();
    expect(screen.getByText(/working alone/i)).toBeTruthy();
  });

  test("shows each member, role, availability and active task", async () => {
    const onOpenTask = vi.fn();
    routeFetch({
      "GET /teams": () => ok({
        members: [
          { id: "danie", name: "Daniel Sivyer", role: "owner", availability: "online", activeTask: { id: "T-1", title: "Add search", stage: "building", health: "working" } },
          { id: "mira", name: "Mira Chen", role: "reviewer", availability: "busy", activeTask: null },
        ],
      }),
    });
    render(<TeamPanel onOpenTask={onOpenTask} />);
    expect(await screen.findByText("Daniel Sivyer")).toBeTruthy();
    expect(screen.getByText(/Owner · On/)).toBeTruthy();
    expect(screen.getByText("Mira Chen")).toBeTruthy();
    expect(screen.getByText("free")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /T-1/ }));
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "T-1" }));
  });

  test("a failed roster read says so and does not show a fake team", async () => {
    routeFetch({ "GET /teams": () => ({ ok: false, status: 500, json: async () => ({ ok: false, code: "ERROR", message: "Roster unavailable." }) }) });
    render(<TeamPanel />);
    expect(await screen.findByText(/Team roster could not be read/)).toBeTruthy();
  });
});
