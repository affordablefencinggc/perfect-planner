import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShareScreen from "../../src/core-screens/ShareScreen.jsx";
import { ViewModeContext } from "../../src/project/viewMode.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const bad = (message) => ({ ok: false, status: 400, json: async () => ({ ok: false, code: "BUNDLE", message }) });
const base = { outbox: [], inbox: [{ name: "from-ana.ppb", bytes: 10 }], branches: ["pp/T-1"], received: ["ana/pp/T-1"], signed: false };

function stub(handler) {
  const fetch = vi.fn(async (url, init = {}) => handler(String(url), init));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const renderScreen = () => render(<ViewModeContext.Provider value={{ mode: "simple", isAdvanced: false, setMode: () => {} }}><ShareScreen /></ViewModeContext.Provider>);

describe("Share screen", () => {
  it("makes a file from the picked branches", async () => {
    const fetch = stub((url, init) => (init.method === "POST" ? ok({ file: "my-work.ppb", branches: ["pp/T-1"], entries: 3, signed: false }) : ok(base)));
    renderScreen();
    fireEvent.click(await screen.findByLabelText("pp/T-1"));
    fireEvent.click(screen.getByRole("button", { name: "Make the file" }));
    expect(await screen.findByText("my-work.ppb")).toBeTruthy();
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(post[1].body)).toEqual({ name: "my-work", branches: ["pp/T-1"] });
  });

  it("shows the clashing files in plain words and says nothing was merged", async () => {
    stub((url, init) => (init.method === "POST" ? ok({ base: "main", clean: false, conflicts: ["README.md"] }) : ok(base)));
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Will it merge?" }));
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(screen.getByText(/Nothing was merged/)).toBeTruthy();
  });

  it("shows a refusal message when the file is damaged", async () => {
    stub((url, init) => (init.method === "POST" ? bad("This is not a Perfect Planner bundle.") : ok(base)));
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Check and receive" }));
    expect(await screen.findByText(/not a Perfect Planner bundle/)).toBeTruthy();
  });
});
