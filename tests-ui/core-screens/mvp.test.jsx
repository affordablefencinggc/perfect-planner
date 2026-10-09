import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import MvpBoardScreen from "../../src/core-screens/MvpBoardScreen.jsx";
import { ViewModeContext } from "../../src/project/viewMode.js";

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const refuse = (status, code, message) => ({ ok: false, status, json: async () => ({ ok: false, code, message }) });

const STAGES = [
  { id: "mvp", name: "MVP", order: 0 },
  { id: "beta", name: "Beta", order: 1 },
  { id: "v1", name: "v1", order: 2 },
  { id: "scale", name: "Scale", order: 3 },
];
const EMPTY = { staged: false, stages: STAGES, features: [], confirmed: false };
const feature = (o) => ({ description: undefined, evidence: [], findings: [], dependsOn: [], userFacing: true, reason: "", onJourney: false, missingDependencies: [], ...o });
const board = (o = {}) => ({
  staged: true,
  fingerprint: "fp-board-1",
  mode: "existing",
  goal: "Write and share notes",
  stages: STAGES,
  counts: { done: 1, partial: 1, missing: 0 },
  features: [
    feature({
      id: "note-editor", name: "Note editor", status: "done", stage: "mvp", onJourney: true, reason: "On the core journey",
      evidence: [{ file: "src/components/NoteEditor.jsx", note: "source present" }, { file: "tests/NoteEditor.test.jsx", note: "test present" }],
    }),
    feature({
      id: "share-dialog", name: "Share dialog", status: "partial", stage: "beta", reason: "Half built; finish after the MVP journey works",
      evidence: [{ file: "src/components/ShareDialog.jsx", line: 1, note: "TODO marker" }],
      dependsOn: [{ id: "note-editor", name: "Note editor", stage: "mvp" }],
    }),
  ],
  journey: { name: "Core journey: Write and share notes", steps: ["Use Note editor"], test: "npm run test:e2e", features: ["note-editor"] },
  confirmed: false,
  doneWhen: { done: false, journeyPassed: false, blocking: ["MVP line not confirmed", "Journey test has not passed yet: npm run test:e2e"], todo: ["Confirm the MVP line.", "Run the journey test and see it pass."] },
  warnings: [],
  proposal: { by: { kind: "jev", id: "jev-mock", model: "mock-1" }, offline: true, summary: "1 of 2 features in the MVP, 1 already done", at: "2026-10-09T10:00:00Z", entry: "L-000003", subject: "D-2" },
  source: { kind: "folders", root: "/repo/notes", scannedAt: "2026-10-09T10:00:00Z", stale: false, staging: "L-000002" },
  history: [
    { n: "L-000002", subject: "D-1", kind: "staging", summary: "Scanned the code", reason: "Stage it", actor: { kind: "person", id: "owner" }, at: "2026-10-09T10:00:00Z" },
    { n: "L-000003", subject: "D-2", kind: "proposal", summary: "Proposed", reason: "Proposed MVP line", actor: { kind: "jev", id: "jev-mock" }, at: "2026-10-09T10:00:00Z" },
  ],
  ...o,
});

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
const bodyOf = (fn, method, path) => {
  const call = fn.mock.calls.find(([url, init]) => (init?.method ?? "GET") === method && String(url).includes(path));
  return call ? JSON.parse(call[1].body) : undefined;
};

const renderWith = (mode = "simple") =>
  render(
    <ViewModeContext.Provider value={{ mode, isAdvanced: mode === "advanced", setMode: () => {} }}>
      <MvpBoardScreen />
    </ViewModeContext.Provider>,
  );

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("MVP board", () => {
  test("loading, then the empty state with both ways in", async () => {
    let release;
    routeFetch({ "GET /mvp": () => new Promise((resolve) => { release = () => resolve(ok(EMPTY)); }) });
    renderWith();
    expect(screen.getByRole("status", { name: "Loading mvp board" })).toBeTruthy();
    await waitFor(() => expect(release).toBeTypeOf("function")); // the read starts after the window's launch claim
    await act(async () => release());
    expect(await screen.findByRole("button", { name: "Scan this project's code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan a new project" })).toBeTruthy();
  });

  test("error state retries", async () => {
    let calls = 0;
    routeFetch({ "GET /mvp": () => (++calls === 1 ? refuse(500, "ERROR", "The ledger could not be read.") : ok(EMPTY)) });
    renderWith();
    expect(await screen.findByText("The ledger could not be read.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByRole("button", { name: "Scan this project's code" })).toBeTruthy();
  });

  test("plans a new project from a goal and one feature per line", async () => {
    let staged = false;
    const fetch = routeFetch({
      "GET /mvp": () => ok(staged ? board({ mode: "new" }) : EMPTY),
      "POST /mvp/stage": () => { staged = true; return ok(board({ mode: "new" })); },
    });
    renderWith();
    fireEvent.change(await screen.findByLabelText("What is the project for? (one line)"), { target: { value: "Write notes" } });
    fireEvent.change(screen.getByLabelText("Features, one per line"), { target: { value: "Note editor\nShare dialog" } });
    fireEvent.click(screen.getByRole("button", { name: "Plan a new project" }));
    expect(await screen.findByText(/came from the offline advisor/)).toBeTruthy();
    expect(bodyOf(fetch, "POST", "/mvp/stage")).toEqual({ mode: "new", goal: "Write notes", features: "Note editor\nShare dialog" });
  });

  test("shows a scan refusal readably", async () => {
    routeFetch({
      "GET /mvp": () => ok(EMPTY),
      "POST /mvp/stage": () => refuse(422, "NOT_A_FOLDER", "/nope is not a folder on this computer, so nothing was scanned."),
    });
    renderWith();
    fireEvent.change(await screen.findByLabelText(/Folder to scan/), { target: { value: "/nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Scan this project's code" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not a folder on this computer/);
  });

  test("board: stages, line, pills, evidence count; move later asks for a reason", async () => {
    const fetch = routeFetch({ "GET /mvp": () => ok(board()), "POST /mvp/move": () => ok(board()) });
    renderWith();
    expect(await screen.findByRole("separator", { name: "Proposed MVP line — confirm or move features across" })).toBeTruthy();
    const mvp = screen.getByRole("region", { name: /^MVP \d/ });
    expect(within(mvp).getByText("Done")).toBeTruthy();
    expect(within(mvp).getByText("2 pieces of evidence")).toBeTruthy();
    const beta = screen.getByRole("region", { name: /^Beta/ });
    expect(within(beta).getByText("Partial")).toBeTruthy();
    expect(within(beta).getByText(/Why later: Half built/)).toBeTruthy();
    expect(within(beta).getByText(/Needs:/).textContent).toMatch(/Note editor \(MVP\)/);
    expect(screen.queryByText("note-editor")).toBeNull();

    fireEvent.click(within(mvp).getByRole("button", { name: "Move Note editor later" }));
    const form = screen.getByRole("form", { name: "Move Note editor later" });
    const submit = within(form).getByRole("button", { name: "Move" });
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Why can it wait? (one line)"), { target: { value: "Writing can wait" } });
    fireEvent.change(within(form).getByLabelText("Move to"), { target: { value: "v1" } });
    fireEvent.click(submit);
    await waitFor(() => expect(bodyOf(fetch, "POST", "/mvp/move")).toEqual({ feature: "note-editor", to: "v1", reason: "Writing can wait" }));

    fireEvent.click(within(beta).getByRole("button", { name: "Move Share dialog to MVP" }));
    await waitFor(() => expect(fetch.mock.calls.filter(([u, i]) => i?.method === "POST").length).toBe(2));
    expect(JSON.parse(fetch.mock.calls.filter(([u, i]) => i?.method === "POST")[1][1].body)).toEqual({ feature: "share-dialog", to: "mvp", reason: "" });
  });

  test("drag and drop into a later stage opens the reason prompt", async () => {
    routeFetch({ "GET /mvp": () => ok(board()) });
    renderWith();
    const card = (await screen.findByText("Note editor", { selector: "strong" })).closest("li");
    const store = {};
    const dataTransfer = { setData: (k, v) => { store[k] = v; }, getData: (k) => store[k] };
    fireEvent.dragStart(card, { dataTransfer });
    const scale = screen.getByRole("region", { name: /^Scale/ });
    fireEvent.dragOver(scale, { dataTransfer });
    fireEvent.drop(scale, { dataTransfer });
    const form = await screen.findByRole("form", { name: "Move Note editor later" });
    expect(within(form).getByLabelText("Move to").value).toBe("scale");
  });

  test("confirm, then shows who and when; refusal is readable", async () => {
    let confirmed = false;
    let attempt = 0;
    const fn = routeFetch({
      "GET /mvp": () => ok(confirmed
        ? board({ confirmed: true, confirmation: { by: "owner", name: "You", at: "2026-10-09T11:00:00Z", entry: "L-000009", subject: "D-5" } })
        : board()),
      "POST /mvp/confirm": () => {
        if (++attempt === 1) return refuse(422, "MISSING_DEPENDENCIES", "The MVP line cannot be confirmed yet: Plan editor needs Store.");
        confirmed = true;
        return ok(null);
      },
    });
    renderWith();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm MVP line" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be confirmed yet/);
    fireEvent.click(screen.getByRole("button", { name: "Confirm MVP line" }));
    const done = await screen.findByText(/Confirmed/, { selector: ".mvp-confirmed" });
    expect(done.textContent).toMatch(/by You on/);
    expect(screen.queryByRole("button", { name: "Confirm MVP line" })).toBeNull();
    expect(screen.getByText("When is the MVP done?")).toBeTruthy();
    expect(bodyOf(fn, "POST", "/mvp/confirm")).toEqual({ fingerprint: "fp-board-1" });
  });

  test("a stale confirm reloads the board and shows the server's message", async () => {
    let reads = 0;
    const message = "The MVP board changed since you looked at it. Review the new version, then approve again.";
    const fn = routeFetch({
      "GET /mvp": () => { reads++; return ok(board({ fingerprint: reads > 1 ? "fp-board-2" : "fp-board-1" })); },
      "POST /mvp/confirm": () => refuse(409, "STALE", message),
    });
    renderWith();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm MVP line" }));
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: "Confirm MVP line" }));
    await waitFor(() => expect(fn.mock.calls.filter(([u, i]) => i?.method === "POST").map(([, i]) => JSON.parse(i.body).fingerprint)).toEqual(["fp-board-1", "fp-board-2"]));
  });

  test("Simple vs Advanced: ids, ledger numbers and evidence list", async () => {
    routeFetch({ "GET /mvp": () => ok(board()) });
    renderWith("simple");
    await screen.findByText("Note editor", { selector: "strong" });
    expect(screen.queryByText(/L-000003/)).toBeNull();
    expect(screen.getByText("Confirm the MVP line.")).toBeTruthy();
    expect(screen.queryByText("npm run test:e2e")).toBeNull();
    expect(screen.getByText("2 pieces of evidence").closest("details").open).toBe(false);
    cleanup();

    renderWith("advanced");
    await screen.findByText("Note editor", { selector: "strong" });
    expect(screen.getAllByText(/L-000003/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^note-editor/)).toBeTruthy();
    expect(screen.getByText("Ledger entries for this board")).toBeTruthy();
    expect(screen.getByText("MVP line not confirmed")).toBeTruthy();
    expect(screen.getByText("npm run test:e2e")).toBeTruthy();
    expect(screen.getByText("2 pieces of evidence").closest("details").open).toBe(true);
  });
});
