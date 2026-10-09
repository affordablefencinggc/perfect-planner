import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LedgerLookupScreen from "../../src/core-screens/LedgerLookupScreen.jsx";
import { LedgerSearchBox, requestLedgerLookup, withSectionSign } from "../../src/core-screens/LedgerSearchBox.jsx";
import { ViewModeContext } from "../../src/project/viewMode.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

const AT = "2026-10-01T10:00:00Z";
const actor = { kind: "person", id: "sam" };
const e = (n, summary, extra = {}) => ({ n, at: AT, type: "task.created", subject: "T-1", summary, actor, evidence: [], refs: [], hash: "a".repeat(64), shortHash: "aaaaaaaaaaaa", ...extra });

const recent = { total: 231, entries: [e("L-000231", "Invoice identity survives reload"), e("L-000230", "Keep the draft id", { type: "decision.made", subject: "D-1" })], examples: ["P-1 §2.1", "R-1", "T-1"] };
const emptyRecent = { total: 0, entries: [], examples: [] };
const intact = { ok: true, entries: 231, head: "L-000231", headHash: "abcdef123456", brokenAt: null, problem: null, detail: null, acknowledged: [], writable: true };
const broken = { ...intact, ok: false, brokenAt: "L-000120", problem: "hash" };

const clauseLookup = {
  query: "P-1 §2.1", ref: "P-1 §2.1", kind: "clause", found: true, title: "Clause P-1 §2.1",
  text: "A new invoice keeps its identity after a reload.", status: "active",
  who: actor, when: AT, what: "Changed §2.1: offline too", why: "Offline support is in scope",
  evidence: ["https://example.test/issue/1", "commit:9f3c2e1"], refs: ["P-1 §1.1"],
  entry: e("L-000040", "Changed §2.1", { type: "clause.changed", shortHash: "c1c1c1c1c1c1" }),
  history: [], citedBy: [e("L-000012", "Invoice identity survives reload")], tasks: ["T-1"], commits: ["9f3c2e1"],
  clause: {
    number: "2.1", plan: "P-1", kind: "item", textInPlan: "A new invoice keeps its identity after a reload.",
    current: { text: "A new invoice keeps its identity after a reload, even offline.", status: "active" },
    versions: [
      { version: 1, n: "L-000003", at: AT, type: "clause.added", actor, text: "A new invoice keeps its identity after a reload.", shortHash: "d1d1d1d1d1d1" },
      { version: 2, n: "L-000040", at: AT, type: "clause.changed", actor, text: "A new invoice keeps its identity after a reload, even offline.", reason: "Offline support is in scope", shortHash: "c1c1c1c1c1c1" },
    ],
  },
};
const releaseLookup = {
  query: "R-1", ref: "R-1", kind: "release", found: true, text: "R-1 · v1.0.0 · P-1 · L-000012 · 9f3c2e1", status: "release",
  who: actor, when: AT, what: "R-1 v1.0.0 released", evidence: ["commit:9f3c2e1"], refs: [], history: [], citedBy: [], tasks: ["T-1"], commits: ["9f3c2e1"],
  entry: e("L-000013", "R-1 v1.0.0 released", { type: "release.cut", subject: "R-1" }),
  release: { release: "R-1", version: "v1.0.0", plan: "P-1", commit: "9f3c2e1", from: "L-000001", to: "L-000012", count: 2, entries: [e("L-000001", "Added §1"), e("L-000012", "Commit 9f3c2e1")], truncated: false },
};
const textSearch = (total = 1) => ({ query: "reload", ref: null, total, capped: false, page: 1, pageSize: 20, pages: Math.max(1, Math.ceil(total / 20)), hits: total ? [{ ref: "§2.1", kind: "clause", text: "A new invoice keeps its identity after a reload.", score: 2, exact: false }] : [] });

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const bad = (message, status = 500) => ({ ok: false, status, json: async () => ({ ok: false, code: "ERROR", message }) });

function stub(routes) {
  const fetch = vi.fn(async (url) => {
    const u = new URL(String(url), "http://local");
    const route = u.pathname.replace("/api/core", "");
    const handler = routes[route];
    if (!handler) return bad(`no route ${route}`, 404);
    return typeof handler === "function" ? handler(u) : ok(handler);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderScreen(mode = "simple") {
  return render(
    <ViewModeContext.Provider value={{ mode, isAdvanced: mode === "advanced", setMode: () => {} }}>
      <LedgerLookupScreen />
    </ViewModeContext.Provider>,
  );
}

describe("Ledger search screen", () => {
  it("shows loading, then recent entries, examples and an intact chain badge", async () => {
    stub({ "/recent": recent, "/verify": intact });
    renderScreen();
    expect(screen.getByRole("status", { name: "Loading ledger search" })).toBeTruthy();
    expect(await screen.findByText("Invoice identity survives reload")).toBeTruthy();
    expect(await screen.findByText(/Ledger intact · 231 entries/)).toBeTruthy();
    expect(screen.getByText("Entry 231")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Look up P-1 §2.1" })).toBeTruthy();
  });

  it("empty ledger: says so and offers examples to click", async () => {
    stub({ "/recent": emptyRecent, "/verify": { ...intact, entries: 0, head: null } });
    renderScreen();
    expect(await screen.findByText("The ledger has no entries yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Look up L-000001" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Reference or words to find" })).toBeTruthy();
  });

  it("error: shows the problem and retries", async () => {
    let fail = true;
    const fetch = stub({ "/recent": () => (fail ? bad("The ledger could not be read.") : ok(recent)), "/verify": intact });
    renderScreen();
    expect(await screen.findByText("The ledger could not be read.")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("Invoice identity survives reload")).toBeTruthy();
    expect(fetch.mock.calls.filter(([u]) => String(u).includes("/recent")).length).toBe(2);
  });

  it("shows a broken chain", async () => {
    stub({ "/recent": recent, "/verify": broken });
    renderScreen();
    expect(await screen.findByText(/Ledger broken at L-000120/)).toBeTruthy();
  });

  it("an exact clause reference shows the detail card with versions, evidence and refs", async () => {
    const fetch = stub({ "/recent": recent, "/verify": intact, "/lookup": clauseLookup, "/search": { ...textSearch(1), hits: [{ ref: "P-1 §2.1", kind: "clause", text: "x", score: 100, exact: true }] } });
    renderScreen();
    const input = await screen.findByRole("searchbox", { name: "Reference or words to find" });
    fireEvent.change(input, { target: { value: "P-1 s2.1" } });
    expect(input.value).toBe("P-1 §2.1");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const card = await screen.findByRole("article", { name: "Clause P-1 §2.1" });
    expect(within(card).getByText("As approved in P-1")).toBeTruthy();
    expect(within(card).getByText("A new invoice keeps its identity after a reload, even offline.", { selector: "blockquote" })).toBeTruthy();
    expect(within(card).getByRole("region", { name: "Version history" })).toBeTruthy();
    expect(within(card).getAllByText(/Offline support is in scope/).length).toBeGreaterThan(0);
    expect(within(card).getByRole("link", { name: /example\.test/ }).getAttribute("href")).toBe("https://example.test/issue/1");
    expect(within(card).getByText("commit 9f3c2e1")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Look up P-1 §1.1" })).toBeTruthy();
    expect(within(card).queryByText("L-000040 · c1c1c1c1c1c1", { exact: false })).toBeNull();
    const lookupUrl = fetch.mock.calls.map(([u]) => String(u)).find((u) => u.includes("/lookup"));
    expect(new URL(lookupUrl, "http://local").searchParams.get("ref")).toBe("P-1 §2.1");

    // Clicking a referenced clause looks it up.
    fireEvent.click(within(card).getByRole("button", { name: "Look up P-1 §1.1" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => new URL(String(u), "http://local").searchParams.get("ref") === "P-1 §1.1")).toBe(true));
  });

  it("Advanced shows full entry numbers, hashes, models and commits", async () => {
    stub({ "/recent": recent, "/verify": intact, "/lookup": clauseLookup, "/search": textSearch(0) });
    renderScreen("advanced");
    expect(await screen.findByText("L-000231")).toBeTruthy();
    expect(screen.queryByText("Entry 231")).toBeNull();
    expect(await screen.findByText(/head L-000231 abcdef123456/)).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Reference or words to find" }), { target: { value: "P-1 §2.1" } });
    fireEvent.submit(screen.getByRole("search", { name: "Search the ledger" }));
    const card = await screen.findByRole("article", { name: "Clause P-1 §2.1" });
    expect(within(card).getAllByText(/L-000040 · c1c1c1c1c1c1/).length).toBeGreaterThan(0);
    expect(within(card).getAllByText("9f3c2e1").length).toBeGreaterThan(0);
  });

  it("a release shows its range and entries", async () => {
    stub({ "/recent": recent, "/verify": intact, "/lookup": releaseLookup, "/search": textSearch(0) });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Look up R-1" }));
    const card = await screen.findByRole("article", { name: "Release R-1" });
    expect(within(card).getByText(/Entry 1 to Entry 12 \(2 entries\)/)).toBeTruthy();
    expect(within(card).getByText("v1.0.0")).toBeTruthy();
    expect(within(card).getByText(/Show the 2 entries/)).toBeTruthy();
  });

  it("free text lists ranked matches; an unknown reference explains why", async () => {
    stub({
      "/recent": recent,
      "/verify": intact,
      "/lookup": (u) => ok({ query: u.searchParams.get("ref"), ref: u.searchParams.get("ref"), kind: null, found: false, problem: "R-9 was never released" }),
      "/search": (u) => ok(u.searchParams.get("q") === "reload" ? textSearch(1) : textSearch(0)),
    });
    renderScreen();
    const input = await screen.findByRole("searchbox", { name: "Reference or words to find" });
    fireEvent.change(input, { target: { value: "reload" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("1 match")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open §2.1/ })).toBeTruthy();

    fireEvent.change(input, { target: { value: "R-9" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/R-9 was never released/)).toBeTruthy();
  });

  it("picks up a query handed over by the header box", async () => {
    stub({ "/recent": recent, "/verify": intact, "/lookup": releaseLookup, "/search": textSearch(0) });
    requestLedgerLookup("R-1");
    renderScreen();
    expect(await screen.findByRole("article", { name: "Release R-1" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Reference or words to find" }).value).toBe("R-1");
  });
});

describe("Header search box", () => {
  it("turns s / sec into §, hands the query over on Enter and opens the lookup workspace", async () => {
    const onWorkspace = vi.fn();
    render(<LedgerSearchBox onWorkspace={onWorkspace} />);
    const input = screen.getByRole("searchbox", { name: /Find a plan clause/ });
    expect(input.getAttribute("placeholder")).toBe("Find P-12 §3.2, R-5…");
    fireEvent.change(input, { target: { value: "P-12 sec 3.2" } });
    expect(input.value).toBe("P-12 §3.2");
    const heard = vi.fn();
    window.addEventListener("pp:ledger-lookup", heard);
    fireEvent.submit(screen.getByRole("search", { name: "Ledger search" }));
    window.removeEventListener("pp:ledger-lookup", heard);
    expect(onWorkspace).toHaveBeenCalledWith("lookup");
    expect(heard).toHaveBeenCalled();
    expect(window.sessionStorage.getItem("perfect-planner.ledger-lookup.query")).toBe("P-12 §3.2");
    expect(input.value).toBe("");
  });

  it("focuses on / unless the person is typing in a field", () => {
    render(<div><input aria-label="Other field" /><LedgerSearchBox onWorkspace={() => {}} /></div>);
    const input = screen.getByRole("searchbox", { name: /Find a plan clause/ });
    const other = screen.getByRole("textbox", { name: "Other field" });
    other.focus();
    act(() => { fireEvent.keyDown(other, { key: "/" }); });
    expect(document.activeElement).toBe(other);
    other.blur();
    act(() => { fireEvent.keyDown(document.body, { key: "/" }); });
    expect(document.activeElement).toBe(input);
  });

  it("withSectionSign leaves plain words alone", () => {
    expect(withSectionSign("s3.2")).toBe("§3.2");
    expect(withSectionSign("section 4")).toBe("§4");
    expect(withSectionSign("invoices 3")).toBe("invoices 3");
  });
});
