// The app window claims its one-time launch secret and sends the CSRF token on writes (core/host/session.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimPersonSession, corePost, CSRF_HEADER, hasPersonSession, resetPersonSession, takeDesktopLaunch, takeLaunchSecret } from "../../src/core-screens/coreApi.js";

const SECRET = "a".repeat(43);
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

afterEach(() => {
  resetPersonSession();
  window.history.replaceState(null, "", "/");
});

describe("person session in the app window", () => {
  it("takes the launch secret out of the address bar and keeps the rest", () => {
    window.history.replaceState(null, "", `/?project=p#pp-launch=${SECRET}&tab=x`);
    expect(takeLaunchSecret()).toBe(SECRET);
    expect(window.location.hash).toBe("#tab=x");
    expect(window.location.search).toBe("?project=p");
    expect(takeLaunchSecret()).toBeNull();
  });

  it("claims once, then sends the CSRF token on writes", async () => {
    window.history.replaceState(null, "", `/#pp-launch=${SECRET}`);
    const fetchImpl = vi.fn(async (url) => (String(url).endsWith("/session/claim") ? reply(200, { ok: true, result: { csrf: "csrf-token-1234567890" } }) : reply(200, { ok: true, result: { done: true } })));
    expect(await claimPersonSession(fetchImpl)).toBe(true);
    expect(hasPersonSession()).toBe(true);
    expect(window.location.hash).toBe("");
    const claim = fetchImpl.mock.calls[0];
    expect(JSON.parse(claim[1].body)).toEqual({ launch: SECRET });
    await corePost("/planning/start", "p", { idea: "x" }, { fetchImpl });
    const write = fetchImpl.mock.calls.find(([url]) => String(url).startsWith("/api/core/planning/start"));
    expect(write[1].headers[CSRF_HEADER]).toBe("csrf-token-1234567890");
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/session/claim"))).toHaveLength(1);
  });

  it("stays read-only without a launch secret and says how to get one", async () => {
    const fetchImpl = vi.fn(async () => reply(401, { ok: false, code: "PERSON_REQUIRED", message: "Only the person..." }));
    expect(await claimPersonSession(fetchImpl)).toBe(false);
    await expect(corePost("/planning/start", "p", {}, { fetchImpl })).rejects.toMatchObject({ code: "PERSON_REQUIRED", message: expect.stringMatching(/press Enter there for a new one/) });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/session"))).toBe(false);
  });
});

describe("desktop shell hand-off", () => {
  it("takes the secret over IPC in the desktop shell only, and claims it", async () => {
    const invoke = vi.fn(async (command) => (command === "take_core_launch" ? SECRET : null));
    expect(await takeDesktopLaunch({}, invoke)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(await takeDesktopLaunch({ __TAURI_INTERNALS__: {} }, invoke)).toBe(SECRET);
    expect(await takeDesktopLaunch({ __TAURI_INTERNALS__: {} }, async () => { throw new Error("no command"); })).toBeNull();

    const fetchImpl = vi.fn(async () => reply(200, { ok: true, result: { csrf: "csrf-from-desktop-12345" } }));
    expect(await claimPersonSession(fetchImpl, async () => SECRET)).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ launch: SECRET });
    expect(hasPersonSession()).toBe(true);
  });

  it("prefers the launch link when the window has one", async () => {
    window.history.replaceState(null, "", `/#pp-launch=${SECRET}`);
    const desktop = vi.fn(async () => "b".repeat(43));
    const fetchImpl = vi.fn(async () => reply(200, { ok: true, result: { csrf: "csrf-token-1234567890" } }));
    await claimPersonSession(fetchImpl, desktop);
    expect(desktop).not.toHaveBeenCalled();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ launch: SECRET });
  });
});

describe("agent model label", () => {
  it("shows a model the agent named itself as self-reported", async () => {
    const { modelLabel } = await import("../../src/core-screens/CoreAgentConnect.jsx");
    expect(modelLabel("unverified:claude-opus")).toBe("claude-opus, self-reported");
    expect(modelLabel("claude-opus")).toBe("claude-opus");
    expect(modelLabel(undefined)).toBe("");
  });
});
