import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConnectionCards } from "../../src/core-screens/ConnectionCards.jsx";

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

describe("ConnectionCards", () => {
  test("shows real states and never calls an unconfigured provider connected", async () => {
    routeFetch({
      "GET /agents": () => ok({ agents: [], connections: [] }),
      "GET /agents/codex-login": () => ok({ installed: true, loggedIn: true, method: "chatgpt", state: "done" }),
      "GET /github/status": () => ok({ state: "not-configured", reason: "No GitHub sign-in recorded.", remote: null, checks: [] }),
      "GET /terminal/scripts": () => ok({ scripts: [{ id: "github-login" }, { id: "codex-login" }] }),
    });
    render(<ConnectionCards />);
    expect(await screen.findByText("Codex")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getAllByText("Not configured").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText(/2 one-click scripts/)).toBeTruthy();
  });

  test("a failed status read says unavailable, not connected", async () => {
    routeFetch({
      "GET /agents": () => ok({ agents: [], connections: [] }),
      "GET /agents/codex-login": () => ({ ok: false, status: 500, json: async () => ({ ok: false, code: "ERROR", message: "Codex status unavailable." }) }),
      "GET /github/status": () => ({ ok: false, status: 500, json: async () => ({ ok: false, code: "ERROR", message: "GitHub status unavailable." }) }),
      "GET /terminal/scripts": () => ok({ scripts: [] }),
    });
    render(<ConnectionCards />);
    expect(await screen.findAllByText("Unavailable")).not.toHaveLength(0);
    expect(screen.queryByText("Connected")).toBeNull();
  });
});
