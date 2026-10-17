// A window without the person's session (not opened from a one-time link) gets 401 PERSON_REQUIRED
// on every read (core/host/host.ts). It must show the shared notice, not loading or an error box.
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import MvpBoardScreen from "../../src/core-screens/MvpBoardScreen.jsx";
import { coreGet, coreReadAccess, resetPersonSession, useCorePlanApproval } from "../../src/core-screens/coreApi.js";
import { useCoreSummary } from "../../src/core-screens/useCoreSummary.js";
import { ViewModeContext } from "../../src/project/viewMode.js";

const SECRET = "c".repeat(43);
const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const noSession = () => ({ ok: false, status: 401, json: async () => ({ ok: false, code: "PERSON_REQUIRED", message: "Open Perfect Planner from a one-time link to see this project." }) });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetPersonSession();
  window.history.replaceState(null, "", "/");
});

describe("a window without a session", () => {
  test("shows the notice instead of an error box or a loader", async () => {
    const fetchMock = vi.fn(async () => noSession());
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ViewModeContext.Provider value={{ mode: "simple", isAdvanced: false, setMode: () => {} }}>
        <MvpBoardScreen />
      </ViewModeContext.Provider>,
    );
    await waitFor(() => expect(document.querySelector("[data-core-screen]")?.getAttribute("data-state")).toBe("no-session"));
    expect(screen.getByRole("note").textContent).toMatch(/cannot show or change anything until it is opened from a one-time link/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("This screen could not load.")).toBeNull();
    expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
    expect(coreReadAccess()).toBe("no");
  });

  test("summary and plan approval settle on nothing known, not loading forever", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => noSession()));
    const summary = renderHook(() => useCoreSummary());
    const plan = renderHook(() => useCorePlanApproval("default", { pollMs: 0 }));
    await waitFor(() => expect(coreReadAccess()).toBe("no"));
    expect(summary.result.current).toBeNull();
    expect(plan.result.current).toBeNull();
  });

  test("coreGet rejects with the plain no-session message", async () => {
    const fetchImpl = vi.fn(async () => noSession());
    await expect(coreGet("/status", "p", { fetchImpl })).rejects.toMatchObject({ code: "PERSON_REQUIRED", message: expect.stringMatching(/cannot show or change anything/) });
  });

  test("claims the launch secret from the address bar before the first read", async () => {
    window.history.replaceState(null, "", `/#pp-launch=${SECRET}`);
    const fetchImpl = vi.fn(async (url) => (String(url).endsWith("/session/claim") ? ok({ csrf: "csrf-token-1234567890" }) : ok({ fine: true })));
    expect(await coreGet("/status", "p", { fetchImpl })).toEqual({ fine: true });
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split("?")[0])).toEqual(["/api/core/session/claim", "/api/core/status"]);
    expect(coreReadAccess()).toBe("yes");
  });
});
