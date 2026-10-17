import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DeepPlanningScreen from "../../src/core-screens/DeepPlanningScreen.jsx";
import { ViewModeProvider, VIEW_MODE_STORAGE_KEY } from "../../src/project/viewMode.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  try { window.localStorage.clear(); } catch { /* jsdom */ }
});

const question = (o = {}) => ({
  q: "Q-1",
  id: "stack.language",
  area: "stack",
  text: "Which language runs the app?",
  why: "Every later choice follows the language.",
  blocking: true,
  options: [
    { id: "typescript", label: "TypeScript everywhere", fit: "One language for UI and server." },
    { id: "python", label: "Python backend", fit: "Heavy data work." },
  ],
  recommendation: { option: "typescript", reason: "UI work is easiest in one language.", confidence: 0.8, sources: [] },
  status: "open",
  entries: { asked: "L-000003" },
  ...o,
});

const overview = (o = {}) => ({
  started: true,
  idea: "Desktop invoice app that works offline",
  signals: ["offline", "desktop"],
  person: "owner",
  research: { live: false, note: "Live web research is off: it needs a research key." },
  progress: { answered: 1, total: 2, open: 1, blockingOpen: 1 },
  blockers: [{ q: "Q-1", id: "stack.language", area: "stack", areaTitle: "Stack", text: "Which language runs the app?", recommendation: question().recommendation }],
  areas: [
    {
      area: "stack",
      title: "Stack",
      questions: [
        question(),
        question({ q: "Q-2", id: "stack.framework", text: "Which UI framework?", blocking: false, status: "decided", answer: "Vite + React", choice: "vite-react", decision: "D-1", entries: { asked: "L-000004", decided: "L-000005", answered: "L-000006" } }),
      ],
    },
  ],
  approval: { canApprove: false, message: "The plan cannot be approved yet: 1 blocking question is still open (Q-1). Answer it, or set a dated spike for it.", approved: [] },
  ...o,
});

const mindmap = {
  idea: "Desktop invoice app",
  answered: 1,
  map: {
    root: "root",
    nodes: {
      root: { id: "root", kind: "component", label: "Desktop invoice app", from: [], children: ["component.app-shell"] },
      "component.app-shell": { id: "component.app-shell", kind: "component", label: "App shell", from: ["stack.framework"], children: ["screen.main"] },
      "screen.main": { id: "screen.main", kind: "screen", label: "Main layout", from: ["stack.framework"], children: [] },
    },
    links: [],
  },
  mermaid: "graph TD",
  depth: [{ kind: "shallow", message: "App shell has no parts yet.", nodes: ["component.app-shell"], questions: ["stack.framework"] }],
};

const roadmap = {
  written: true,
  answered: 1,
  phases: [
    { id: "foundation", title: "Foundation", tasks: [{ key: "K-component.app-shell", title: "Build App shell", phase: "foundation", owner: "owner", doneWhen: "a test proves it starts.", node: "component.app-shell", change: "feature", dependsOn: [], dependsOnTasks: [], task: "T-1", entry: "L-000010" }] },
    { id: "core", title: "Core", tasks: [] },
  ],
};

function ok(result) {
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
}
function refused(status, code, message) {
  return { ok: false, status, json: async () => ({ ok: false, code, message }) };
}

function mockApi(handlers) {
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const path = String(url).split("?")[0].replace("/api/core", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const handler = handlers[`${method} ${path}`];
    if (!handler) return refused(404, "NOT_FOUND", `Nothing at ${path}.`);
    return handler(body);
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

function renderScreen(mode = "simple") {
  window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  return render(<ViewModeProvider><DeepPlanningScreen /></ViewModeProvider>);
}

describe("Deep planning screen", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows loading first", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderScreen();
    expect(screen.getByRole("status", { name: "Loading deep planning" })).toBeTruthy();
  });

  it("shows the idea start when nothing has started, and starts planning", async () => {
    let started = false;
    const calls = mockApi({
      "GET /planning": () => ok(started ? overview() : overview({ started: false, idea: null, areas: [], blockers: [] })),
      "POST /planning/start": () => { started = true; return ok({ asked: ["Q-1"], overview: overview() }); },
    });
    renderScreen();
    expect(await screen.findByText("Start with your idea")).toBeTruthy();
    expect(screen.getByText(/Live web research is off/)).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start planning" });
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your idea"), { target: { value: "Desktop invoice app that works offline" } });
    fireEvent.click(start);
    expect(await screen.findByRole("region", { name: "Open blocking questions" })).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/planning/start", body: { idea: "Desktop invoice app that works offline" } });
  });

  it("shows an error with a working retry", async () => {
    let fail = true;
    mockApi({ "GET /planning": () => (fail ? refused(500, "ERROR", "The ledger could not be read.") : ok(overview())) });
    renderScreen();
    expect(await screen.findByText("The ledger could not be read.")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("Which language runs the app?", { selector: "h4" })).toBeTruthy();
  });

  it("renders progress, blockers, cards with the recommendation, and the approval gate", async () => {
    mockApi({ "GET /planning": () => ok(overview()) });
    renderScreen();
    await screen.findByText("Which language runs the app?", { selector: "h4" });
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getByText("blocking question open")).toBeTruthy();
    const rail = screen.getByRole("region", { name: "Open blocking questions" });
    expect(within(rail).getByRole("button", { name: "Go to question: Which language runs the app?" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Stack" })).toBeTruthy();
    const card = screen.getByRole("article", { name: "Which language runs the app?" });
    expect(within(card).getByText("TypeScript everywhere")).toBeTruthy();
    expect(within(card).getByRole("meter", { name: "How sure the recommendation is" }).getAttribute("aria-valuenow")).toBe("80");
    expect(within(card).getByRole("button", { name: "Use recommendation" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Choose Python backend" })).toBeTruthy();
    expect(screen.getByText(/1 blocking question is still open/)).toBeTruthy();
    expect(screen.getByText("Vite + React")).toBeTruthy();
  });

  it("one tap on the recommendation posts the answer", async () => {
    const calls = mockApi({
      "GET /planning": () => ok(overview()),
      "POST /planning/answer": () => ok({ q: "Q-1", status: "decided", decision: "D-2", answer: "TypeScript everywhere" }),
    });
    renderScreen();
    const card = await screen.findByRole("article", { name: "Which language runs the app?" });
    fireEvent.click(within(card).getByRole("button", { name: "Use recommendation" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/planning/answer")).toBe(true));
    expect(calls.find((c) => c.path === "/planning/answer").body).toEqual({ q: "Q-1", choice: "typescript" });
  });

  it("shows the catcher's message for TBD and offers a dated spike", async () => {
    const message = '"TBD" puts Q-1 off (TBD). Make a decision, or pass a spike with a due date and the risk.';
    const calls = mockApi({
      "GET /planning": () => ok(overview()),
      "POST /planning/answer": (body) => (body.spike ? ok({ q: "Q-1", status: "spiked", task: "T-1", due: body.spike.due, answer: "Spike" }) : refused(422, "DEFERRED", message)),
    });
    renderScreen();
    const card = await screen.findByRole("article", { name: "Which language runs the app?" });
    fireEvent.change(within(card).getByLabelText("Your own answer"), { target: { value: "TBD" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save answer" }));
    expect((await within(card).findByRole("alert")).textContent).toBe(message);
    fireEvent.change(within(card).getByLabelText("Risk if it stays open"), { target: { value: "Wrong choice means a rewrite of the UI." } });
    fireEvent.click(within(card).getByRole("button", { name: "Set spike" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/planning/answer")).toHaveLength(2));
    expect(calls.filter((c) => c.path === "/planning/answer")[1].body.spike.risk).toBe("Wrong choice means a rewrite of the UI.");
  });

  it("shows why approval was refused", async () => {
    mockApi({
      "GET /planning": () => ok(overview()),
      "POST /planning/approve": () => refused(409, "BLOCKERS_OPEN", "The plan cannot be approved yet: 1 blocking question is still open (Q-1)."),
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /Approve plan/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("1 blocking question is still open (Q-1)");
  });

  it("switches to the mind map and the roadmap", async () => {
    mockApi({ "GET /planning": () => ok(overview()), "GET /planning/mindmap": () => ok(mindmap), "GET /planning/roadmap": () => ok(roadmap) });
    renderScreen();
    await screen.findByRole("tab", { name: /Questions/ });
    fireEvent.click(screen.getByRole("tab", { name: /Mind map/ }));
    expect(await screen.findByText("Main layout")).toBeTruthy();
    expect(screen.getByText("App shell has no parts yet.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Mind map/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: /Mind map/ }), { key: "ArrowRight" });
    expect(await screen.findByText("Build App shell")).toBeTruthy();
    expect(screen.queryByText(/T-1/)).toBeNull();
  });

  it("Advanced shows Q-, D-, T- and ledger numbers; Simple does not", async () => {
    mockApi({ "GET /planning": () => ok(overview()), "GET /planning/roadmap": () => ok(roadmap) });
    const { unmount } = renderScreen("simple");
    await screen.findByText("Which language runs the app?", { selector: "h4" });
    expect(screen.queryByText(/L-000003/)).toBeNull();
    expect(screen.queryByText(/D-1/)).toBeNull();
    unmount();

    renderScreen("advanced");
    await screen.findByText("Which language runs the app?", { selector: "h4" });
    expect(screen.getByText(/Q-1 · stack.language · asked L-000003/)).toBeTruthy();
    expect(screen.getByText(/D-1 · L-000005/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Roadmap/ }));
    expect(await screen.findByText(/T-1 · L-000010/)).toBeTruthy();
  });
});
