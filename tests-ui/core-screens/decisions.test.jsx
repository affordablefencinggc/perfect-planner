import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import DecisionsScreen from "../../src/core-screens/DecisionsScreen.jsx";
import { ViewModeContext } from "../../src/project/viewMode.js";

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const fail = (status, message, code = "ERROR") => ({ ok: false, status, json: async () => ({ ok: false, code, message }) });

const OFFLINE = { connected: false, model: null, note: "Jev is not connected: no TypeSafe key is saved in Settings. Recommendations shown are from the offline reviewer." };
const SUMMARY = (open, decided, cents = 0) => ({ open, decided, month: "2026-10", spend: { cents, label: `$${(cents / 100).toFixed(2)}` } });
const person = { kind: "person", id: "owner", name: "Dana" };

const OPEN_CARD = {
  id: "Q-2", kind: "question", title: "Which database should the invoice archive use?", status: "open", fingerprint: "fp-q2", q: "Q-2", task: "project", blocking: true, planning: false,
  options: [{ id: "option_1", label: "SQLite" }, { id: "option_2", label: "Postgres" }],
  recommendation: { option: "SQLite", optionId: "option_1", reasons: ["D-1 already decided a similar question.", "They share most key words."], confidence: 0.67, source: "offline", producedBy: "Offline reviewer", model: null, cost: null },
  askedBy: person, askedAt: "2026-10-09T10:00:00Z", cost: null,
  entries: [{ n: "L-000004", hash: "abcdef123456" }], at: "2026-10-09T10:00:00Z",
};
const NO_REC = { ...OPEN_CARD, id: "Q-3", q: "Q-3", title: "What should the app be called?", blocking: false, options: [], recommendation: null, noRecommendation: "This question has no options to choose between, so it needs your answer in your own words.", entries: [{ n: "L-000005", hash: "0123456789ab" }] };
const DECIDED = {
  id: "Q-1", kind: "question", title: "Which database should invoices use?", status: "overridden", q: "Q-1", d: "D-1", task: "project", blocking: false, planning: false,
  options: [{ id: "option_1", label: "Postgres" }, { id: "option_2", label: "SQLite" }], recommendation: null,
  outcome: { answer: "SQLite", reason: "One file is easier to back up", by: person, at: "2026-10-09T09:00:00Z", decision: "D-1" },
  cost: null, entries: [{ n: "L-000001", hash: "111111111111" }, { n: "L-000002", hash: "222222222222" }], at: "2026-10-09T09:00:00Z",
};
const REVIEW = {
  id: "L-000009", kind: "review", title: "Jev rejects the diff for T-1", status: "decided", task: "T-1", blocking: false, planning: false, options: [],
  recommendation: { option: "Reject", reasons: ["A test is weakened."], confidence: 0.9, source: "jev", producedBy: "Jev", model: "jev-latest", cost: { cents: 3, label: "$0.03" }, entry: "L-000009" },
  outcome: { answer: "Reject", by: { kind: "jev", id: "jev", name: "Jev", model: "jev-latest" }, at: "2026-10-09T11:00:00Z" },
  cost: { cents: 3, label: "$0.03" }, entries: [{ n: "L-000009", hash: "999999999999" }], at: "2026-10-09T11:00:00Z",
};
const view = (open = [OPEN_CARD, NO_REC], decided = [REVIEW, DECIDED], jev = OFFLINE) => ({ jev, summary: SUMMARY(open.length, decided.length, 3), open, decided });
const EMPTY = { jev: OFFLINE, summary: SUMMARY(0, 0), open: [], decided: [] };

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

const renderWith = (mode = "simple") =>
  render(
    <ViewModeContext.Provider value={{ mode, isAdvanced: mode === "advanced", setMode: () => {} }}>
      <DecisionsScreen />
    </ViewModeContext.Provider>,
  );

const bodyOf = (fn, path) => JSON.parse(fn.mock.calls.find(([url, init]) => String(url).includes(path) && init?.method === "POST")[1].body);

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("DecisionsScreen", () => {
  test("shows loading, then the empty state with the ask form and the honest Jev note", async () => {
    let release;
    routeFetch({ "GET /decisions": () => new Promise((resolve) => { release = () => resolve(ok(EMPTY)); }) });
    renderWith();
    expect(screen.getByRole("status", { name: "Loading decisions" })).toBeTruthy();
    await act(async () => release());
    expect(await screen.findByText("No decisions waiting.")).toBeTruthy();
    expect(screen.getByText(/When an agent or the plan needs a call, it lands here with Jev's recommendation\./)).toBeTruthy();
    expect(screen.getByText(/Jev is not connected/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ask for a decision" })).toBeTruthy();
  });

  test("shows an error and retries", async () => {
    let calls = 0;
    routeFetch({ "GET /decisions": () => (++calls === 1 ? fail(500, "The ledger could not be read.") : ok(view())) });
    renderWith();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("The ledger could not be read.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText(OPEN_CARD.title)).toBeTruthy();
  });

  test("ready: summary, open cards first with recommendation, reasons, chips; decided collapsed", async () => {
    routeFetch({ "GET /decisions": () => ok(view()) });
    const { container } = renderWith();
    const card = (await screen.findByText(OPEN_CARD.title)).closest("article");
    const summary = screen.getByLabelText("Decisions summary");
    expect(within(summary).getByText("Waiting for you").nextSibling.textContent).toBe("2");
    expect(within(summary).getByText("$0.03")).toBeTruthy();
    expect(within(card).getByText("SQLite", { selector: "strong" })).toBeTruthy();
    expect(within(card).getByRole("meter", { name: "Confidence in SQLite" }).getAttribute("aria-valuenow")).toBe("67");
    expect(within(card).getByText("D-1 already decided a similar question.")).toBeTruthy();
    expect(within(card).getByText("Offline reviewer · no model")).toBeTruthy();
    expect(within(card).getByText("No cost")).toBeTruthy();
    expect(within(card).getByText("Holding up work")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Accept recommendation/ })).toBeTruthy();
    const noRec = screen.getByText(NO_REC.title).closest("article");
    expect(within(noRec).queryByRole("button", { name: /Accept recommendation/ })).toBeNull();
    expect(within(noRec).getByText(/needs your answer in your own words/)).toBeTruthy();
    const details = container.querySelector("details.decisions-decided");
    expect(details.open).toBe(false);
    expect(details.querySelector("summary").textContent).toContain("Decided (2)");
    const decided = screen.getByText(DECIDED.title).closest("article");
    expect(within(decided).getByText("Chose something else")).toBeTruthy();
    expect(within(decided).getByText("One file is easier to back up")).toBeTruthy();
    const review = screen.getByText(REVIEW.title).closest("article");
    expect(within(review).getByText("Jev · jev-latest")).toBeTruthy();
    expect(within(review).getByText("Cost $0.03")).toBeTruthy();
    // Open before decided in document order.
    expect(card.compareDocumentPosition(decided) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("accepting the recommendation posts the question number and reloads", async () => {
    let decidedNow = false;
    const fn = routeFetch({
      "GET /decisions": () => ok(decidedNow ? view([NO_REC], [{ ...OPEN_CARD, status: "accepted", d: "D-2", outcome: { answer: "SQLite", by: person, at: "2026-10-09T12:00:00Z" } }, DECIDED]) : view()),
      "POST /decisions/accept": () => { decidedNow = true; return ok({ q: "Q-2", decision: "D-2", answer: "SQLite", status: "accepted" }); },
    });
    renderWith();
    const card = (await screen.findByText(OPEN_CARD.title)).closest("article");
    fireEvent.click(within(card).getByRole("button", { name: /Accept recommendation/ }));
    await waitFor(() => expect(bodyOf(fn, "/decisions/accept")).toEqual({ q: "Q-2", fingerprint: "fp-q2" }));
    await waitFor(() => expect(screen.getByLabelText("Decisions summary").textContent).toContain("Waiting for you1"));
  });

  test("choosing something else requires a reason, then posts the choice and reason", async () => {
    const fn = routeFetch({
      "GET /decisions": () => ok(view()),
      "POST /decisions/override": () => ok({ q: "Q-2", decision: "D-2", answer: "Postgres", status: "overridden" }),
    });
    renderWith();
    const card = (await screen.findByText(OPEN_CARD.title)).closest("article");
    const toggle = within(card).getByRole("button", { name: "Choose something else" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(card).getByLabelText("Postgres").checked).toBe(true);
    fireEvent.click(within(card).getByRole("button", { name: "Save decision" }));
    expect(within(card).getByRole("alert").textContent).toMatch(/Say why/);
    expect(fn.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.change(within(card).getByLabelText(/Why \(required\)/), { target: { value: "We already run Postgres" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save decision" }));
    await waitFor(() => expect(bodyOf(fn, "/decisions/override")).toEqual({ q: "Q-2", fingerprint: "fp-q2", choice: "option_2", reason: "We already run Postgres" }));
  });

  test("a free-text decision on a question without options", async () => {
    const fn = routeFetch({ "GET /decisions": () => ok(view()), "POST /decisions/override": () => ok({ q: "Q-3", decision: "D-2", answer: "Ledgerly", status: "overridden" }) });
    renderWith();
    const card = (await screen.findByText(NO_REC.title)).closest("article");
    fireEvent.click(within(card).getByRole("button", { name: "Decide" }));
    fireEvent.change(within(card).getByLabelText("Your answer"), { target: { value: "Ledgerly" } });
    fireEvent.change(within(card).getByLabelText(/Why \(required\)/), { target: { value: "Short" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save decision" }));
    await waitFor(() => expect(bodyOf(fn, "/decisions/override")).toEqual({ q: "Q-3", fingerprint: "fp-q2", text: "Ledgerly", reason: "Short" }));
  });

  test("asking for a decision from the empty state posts the question and options", async () => {
    let asked = false;
    const fn = routeFetch({
      "GET /decisions": () => ok(asked ? view([NO_REC], []) : EMPTY),
      "POST /decisions/ask": () => { asked = true; return ok({ q: "Q-1", status: "open", paused: false }); },
    });
    renderWith();
    await screen.findByText("No decisions waiting.");
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Ship on Fridays?" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Yes" } });
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "No" } });
    fireEvent.click(screen.getByRole("button", { name: "Add another option" }));
    expect(screen.getByLabelText("Option 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Raise this decision" }));
    await waitFor(() => expect(bodyOf(fn, "/decisions/ask")).toEqual({ question: "Ship on Fridays?", options: ["Yes", "No"], blocking: false }));
    expect(await screen.findByText(NO_REC.title)).toBeTruthy();
  });

  test("a refused save shows the server's message", async () => {
    routeFetch({ "GET /decisions": () => ok(view()), "POST /decisions/accept": () => fail(409, "Q-2 was already decided: SQLite") });
    renderWith();
    const card = (await screen.findByText(OPEN_CARD.title)).closest("article");
    fireEvent.click(within(card).getByRole("button", { name: /Accept recommendation/ }));
    expect(await within(card).findByText("Q-2 was already decided: SQLite")).toBeTruthy();
  });

  test("a stale approval reloads the card and shows the server's message", async () => {
    let reads = 0;
    const message = "The question and recommendation changed since you looked at it. Review the new version, then approve again.";
    const fn = routeFetch({
      "GET /decisions": () => { reads++; return ok(view([reads > 1 ? { ...OPEN_CARD, fingerprint: "fp-new" } : OPEN_CARD])); },
      "POST /decisions/accept": () => fail(409, message, "STALE"),
    });
    renderWith();
    const card = (await screen.findByText(OPEN_CARD.title)).closest("article");
    fireEvent.click(within(card).getByRole("button", { name: /Accept recommendation/ }));
    expect(await within(card).findByText(message)).toBeTruthy();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    fireEvent.click(within(card).getByRole("button", { name: /Accept recommendation/ }));
    await waitFor(() => expect(fn.mock.calls.filter(([u, i]) => i?.method === "POST").map(([, i]) => JSON.parse(i.body).fingerprint)).toEqual(["fp-q2", "fp-new"]));
  });

  test("Advanced view adds Q-/D- numbers, ledger entries and hash prefixes; Simple hides them", async () => {
    routeFetch({ "GET /decisions": () => ok(view()) });
    renderWith("simple");
    await screen.findByText(OPEN_CARD.title);
    expect(screen.queryByText(/L-000004 #abcdef123456/)).toBeNull();
    cleanup();
    routeFetch({ "GET /decisions": () => ok(view()) });
    renderWith("advanced");
    const card = (await screen.findByText(OPEN_CARD.title)).closest("article");
    expect(within(card).getByText(/Q-2 · task project · L-000004 #abcdef123456/)).toBeTruthy();
    expect(screen.getByText(/Q-1 · D-1 · task project · L-000001 #111111111111, L-000002 #222222222222/)).toBeTruthy();
  });

  test("a connected Jev shows no warning in Simple view", async () => {
    routeFetch({ "GET /decisions": () => ok(view(undefined, undefined, { connected: true, model: "jev-latest", note: "Jev is connected." })) });
    renderWith();
    await screen.findByText(OPEN_CARD.title);
    expect(screen.queryByText(/Jev is not connected/)).toBeNull();
  });
});
