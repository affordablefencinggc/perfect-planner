import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PeopleScreen from "../../src/core-screens/PeopleScreen.jsx";
import { ViewModeContext } from "../../src/project/viewMode.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const owner = { person: "dana", name: "Dana Lee", role: "owner", approves: [], agents: [], since: "L-000004", presence: { entry: "L-000004", type: "decision.made", stage: "people", subject: "D-1", summary: "Dana Lee joins as owner", via: "dana", at: new Date().toISOString() } };
const helper = { person: "eli", name: "Eli Kim", role: "helper", approves: ["test"], agents: [], since: "L-000005" };
const doc = { doc: "core-specs", title: "Core specs", path: "specs/CORE.md", version: "v1", clauses: [], kind: "document", sharedBy: "dana", at: "2026-10-01T10:00:00Z", entry: "L-000006" };
const empty = { view: { members: [], docs: [] }, photos: {}, me: "owner", firstRun: true };
const ready = { view: { members: [owner, helper], owner, docs: [doc], head: "L-000006" }, photos: {}, me: "dana", firstRun: false };

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const bad = (message, status = 422) => ({ ok: false, status, json: async () => ({ ok: false, code: "REFUSED", message }) });

function stub(handler) {
  const fetch = vi.fn(async (url, init = {}) => handler(String(url), init));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderScreen(mode = "simple") {
  return render(
    <ViewModeContext.Provider value={{ mode, isAdvanced: mode === "advanced", setMode: () => {} }}>
      <PeopleScreen />
    </ViewModeContext.Provider>,
  );
}

const posts = (fetch) => fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => ({ url: String(url), body: JSON.parse(init.body) }));

describe("People screen", () => {
  it("shows loading, then the roster", async () => {
    stub(() => ok(ready));
    renderScreen();
    expect(screen.getByRole("status", { name: "Loading people" })).toBeTruthy();
    expect(await screen.findByText("Dana Lee")).toBeTruthy();
    expect(screen.getByRole("region", { name: "People" }).getAttribute("data-core-screen")).toBe("people");
    expect(screen.getByText(/what each person may do/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Core specs" })).toBeTruthy();
  });

  it("first run: shows the add-the-first-person form and claims ownership", async () => {
    let state = empty;
    const fetch = stub((url, init) => {
      if (init.method === "POST") {
        state = { view: { members: [{ ...owner }], owner, docs: [] }, photos: {}, me: "dana", firstRun: false };
        return ok({ entry: "L-000004", ...state });
      }
      return ok(state);
    });
    renderScreen();
    expect(await screen.findByRole("heading", { name: "Add the first person" })).toBeTruthy();
    expect(screen.getByText(/the first person added is the owner/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dana Lee" } });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    expect(posts(fetch)[0]).toEqual({ url: "/api/core/people/members?project=default", body: { person: "dana-lee", name: "Dana Lee", role: "owner" } });
    expect(await screen.findByText("Dana Lee is now the owner of this project.")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Add helper" })).toBeTruthy();
  });

  it("shows an error with a working retry", async () => {
    let fail = true;
    stub(() => (fail ? bad("The ledger is locked.", 500) : ok(ready)));
    renderScreen();
    expect(await screen.findByText("The ledger is locked.")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("Dana Lee")).toBeTruthy();
  });

  it("changes a role and removes a person through the routes", async () => {
    const fetch = stub((url, init) => ok(init.method === "POST" ? { entry: "L-000007", ...ready } : ready));
    renderScreen();
    fireEvent.change(await screen.findByLabelText("Role for Eli Kim"), { target: { value: "viewer" } });
    await waitFor(() => expect(posts(fetch)[0]).toEqual({ url: "/api/core/people/members/eli/role?project=default", body: { role: "viewer" } }));
    expect(await screen.findByText("Eli Kim is now a viewer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Eli Kim" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(posts(fetch)[1].url).toBe("/api/core/people/members/eli/remove?project=default"));
  });

  it("shows a refused change as an alert", async () => {
    stub((url, init) => (init.method === "POST" ? bad("only the owner changes people") : ok(ready)));
    renderScreen();
    fireEvent.change(await screen.findByLabelText("Role for Eli Kim"), { target: { value: "viewer" } });
    expect((await screen.findByText("only the owner changes people")).getAttribute("role")).toBe("alert");
  });

  it("shares a document", async () => {
    const fetch = stub((url, init) => ok(init.method === "POST" ? { entry: "L-000008", ...ready } : ready));
    renderScreen();
    const form = await screen.findByRole("form", { name: "Share a document" });
    fireEvent.change(within(form).getByLabelText("Document title"), { target: { value: "Plan notes" } });
    fireEvent.change(within(form).getByLabelText("Document path"), { target: { value: "notes/plan.md" } });
    fireEvent.click(within(form).getByRole("button", { name: "Share document" }));
    await waitFor(() => expect(posts(fetch)[0]).toEqual({ url: "/api/core/people/docs?project=default", body: { title: "Plan notes", path: "notes/plan.md" } }));
  });

  it("uploads a photo as base64", async () => {
    const fetch = stub((url, init) => ok(init.method === "POST" ? { entry: "L-000009", ...ready } : ready));
    const { container } = renderScreen();
    await screen.findByText("Dana Lee");
    const input = container.querySelector('input[type="file"]');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "me.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    expect(posts(fetch)[0]).toEqual({ url: "/api/core/people/photo?project=default", body: { image: "iVBORw==" } });
  });

  it("Advanced view adds person ids and ledger numbers; Simple view hides them", async () => {
    stub(() => ok(ready));
    renderScreen("simple");
    await screen.findByText("Dana Lee");
    expect(screen.queryByText("Ledger details")).toBeNull();
    expect(screen.queryByText("L-000005")).toBeNull();
    cleanup();
    stub(() => ok(ready));
    renderScreen("advanced");
    expect(await screen.findByText("Ledger details")).toBeTruthy();
    const table = screen.getByRole("table", { name: "People" });
    expect(within(table).getByText("eli")).toBeTruthy();
    expect(within(table).getByText("L-000005")).toBeTruthy();
    expect(screen.getByText("L-000006", { selector: "dd" })).toBeTruthy();
  });
});
