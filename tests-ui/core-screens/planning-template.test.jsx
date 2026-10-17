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

const CARDS = [
  { id: "web-app", title: "New web app", description: "A web app from nothing: screens, a place to keep data, and a first release.", depth: "standard", tasks: 8, askFirst: ["stack"], usuallySkip: ["offline"] },
  { id: "cli-tool", title: "New command-line tool", description: "A tool you run in a terminal: commands, options, help text and a first release.", depth: "quick", tasks: 5, askFirst: ["stack"], usuallySkip: ["money"] },
  { id: "fix-bug", title: "Fix a bug", description: "Reproduce the bug with a test, fix it, and make sure it stays fixed.", depth: "quick", tasks: 4, askFirst: ["testing"], usuallySkip: ["money"] },
];
const LIST = { templates: CARDS, blank: { id: "blank", title: "Start blank", description: "No starter. Begin from your idea alone." }, current: null, note: "A starter only suggests where to begin. It answers no question and approves nothing: you still decide, and you approve the plan." };

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
  recommendation: { option: "typescript", reason: "UI work is easiest in one language.", confidence: 0.6, sources: [] },
  status: "open",
  entries: { asked: "L-000003" },
  ...o,
});

const TEMPLATE = { id: "web-app", title: "New web app", description: CARDS[0].description, depth: "standard", decision: "D-1", askFirst: [{ area: "stack", title: "Stack" }], usuallySkip: [{ area: "offline", title: "Offline and sync" }], skippable: 1, note: "A starter only suggests. It has answered nothing and approved nothing." };

const overview = (o = {}) => ({
  started: true,
  idea: "A habit tracker where people sign in",
  signals: [],
  person: "owner",
  research: { live: false, note: "Live web research is off: it needs a research key." },
  progress: { answered: 0, total: 2, open: 2, blockingOpen: 1 },
  blockers: [{ q: "Q-1", id: "stack.language", area: "stack", areaTitle: "Stack", text: "Which language runs the app?", recommendation: question().recommendation }],
  areas: [
    {
      area: "stack",
      title: "Stack",
      hint: "ask-first",
      questions: [question({ suggestion: { label: "TypeScript everywhere", option: "typescript", why: "One language keeps a small web app simple.", from: "New web app" } })],
    },
    {
      area: "offline",
      title: "Offline and sync",
      hint: "usually-skip",
      questions: [question({ q: "Q-2", id: "offline.required", area: "offline", text: "Does it need to work offline?", blocking: false, recommendation: { option: null, reason: "", confidence: 0, sources: [] }, options: [], suggestion: { label: "Not needed for a new web app.", text: "Not needed for a new web app.", why: "Most new web apps start online only.", from: "New web app" } })],
    },
  ],
  template: TEMPLATE,
  approval: { canApprove: false, message: "The plan cannot be approved yet: 1 blocking question is still open (Q-1).", approved: [] },
  ...o,
});

const draftRoadmap = {
  written: false,
  answered: 0,
  template: { id: "web-app", title: "New web app", depth: "standard", decision: "D-1", tasks: 2, leftOut: [{ step: "payments", title: "Take payments", because: "Your idea has no payments." }] },
  phases: [
    {
      id: "foundation",
      title: "Foundation",
      tasks: [
        { key: "K-tpl-web-app-scaffold", title: "Set up the project so it installs and starts", phase: "foundation", owner: "owner", doneWhen: "a clean checkout installs and starts.", change: "feature", dependsOn: [], dependsOnTasks: [], template: { id: "web-app", step: "scaffold", size: "small", tier: 1, files: ["package.json", "src/main.*"] }, suggested: true },
        { key: "K-first-release", title: "Cut the first release", phase: "release", owner: "owner", doneWhen: "it ships.", change: "feature", dependsOn: [], dependsOnTasks: [] },
      ],
    },
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
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const path = String(url).split("?")[0].replace("/api/core", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const handler = handlers[`${method} ${path}`];
    return handler ? handler(body) : refused(404, "NOT_FOUND", `Nothing at ${path}.`);
  }));
  return calls;
}

function renderScreen(mode = "simple") {
  window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  return render(<ViewModeProvider><DeepPlanningScreen /></ViewModeProvider>);
}

const notStarted = () => overview({ started: false, idea: null, areas: [], blockers: [], template: null });

describe("the starter picker at the start of Deep planning", () => {
  beforeEach(() => window.localStorage.clear());

  it("lists Start blank first and then the starters from the route, with Start blank chosen", async () => {
    mockApi({ "GET /planning": () => ok(notStarted()), "GET /planning/templates": () => ok(LIST) });
    renderScreen();
    const group = await screen.findByRole("group", { name: /What kind of work is this/ });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.value)).toEqual(["blank", "web-app", "cli-tool", "fix-bug"]);
    expect(radios[0].checked).toBe(true);
    expect(within(group).getByText("Start blank")).toBeTruthy();
    expect(within(group).getByText("New web app")).toBeTruthy();
    expect(within(group).getByText(/answers no question and approves nothing/)).toBeTruthy();
  });

  it("sends no template when the person starts blank", async () => {
    let started = false;
    const calls = mockApi({
      "GET /planning": () => ok(started ? overview({ template: null }) : notStarted()),
      "GET /planning/templates": () => ok(LIST),
      "POST /planning/start": () => { started = true; return ok({ asked: ["Q-1"], overview: overview({ template: null }) }); },
    });
    renderScreen();
    await screen.findByRole("group", { name: /What kind of work/ });
    fireEvent.change(screen.getByLabelText("Your idea"), { target: { value: "A habit tracker where people sign in" } });
    fireEvent.click(screen.getByRole("button", { name: "Start planning" }));
    await screen.findByRole("region", { name: "Open blocking questions" });
    expect(calls.find((c) => c.path === "/planning/start").body).toEqual({ idea: "A habit tracker where people sign in" });
  });

  it("sends the chosen starter with the idea", async () => {
    let started = false;
    const calls = mockApi({
      "GET /planning": () => ok(started ? overview() : notStarted()),
      "GET /planning/templates": () => ok(LIST),
      "POST /planning/start": () => { started = true; return ok({ asked: ["Q-1"], template: { changed: true, id: "web-app" }, overview: overview() }); },
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("radio", { name: /New web app/ }));
    fireEvent.change(screen.getByLabelText("Your idea"), { target: { value: "A habit tracker where people sign in" } });
    fireEvent.click(screen.getByRole("button", { name: "Start planning" }));
    await screen.findByRole("region", { name: "Open blocking questions" });
    expect(calls.find((c) => c.path === "/planning/start").body).toEqual({ idea: "A habit tracker where people sign in", template: "web-app" });
  });

  it("is simply not shown when the list cannot be read, and planning still starts", async () => {
    const calls = mockApi({
      "GET /planning": () => ok(notStarted()),
      "GET /planning/templates": () => refused(500, "ERROR", "No list today."),
      "POST /planning/start": () => ok({ asked: [], overview: overview({ template: null }) }),
    });
    renderScreen();
    await screen.findByText("Start with your idea");
    await waitFor(() => expect(calls.some((c) => c.path === "/planning/templates")).toBe(true));
    expect(screen.queryByRole("group", { name: /What kind of work/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Your idea"), { target: { value: "A habit tracker where people sign in" } });
    fireEvent.click(screen.getByRole("button", { name: "Start planning" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/planning/start").body).toEqual({ idea: "A habit tracker where people sign in" }));
  });
});

describe("a plan with a starter", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows the starter, hints on the areas and a suggestion that answers nothing until it is used", async () => {
    const calls = mockApi({
      "GET /planning": () => ok(overview()),
      "GET /planning/templates": () => ok({ ...LIST, current: "web-app" }),
      "POST /planning/answer": () => ok({ q: "Q-1", status: "decided", decision: "D-2", answer: "TypeScript everywhere" }),
    });
    renderScreen();
    const bar = await screen.findByRole("region", { name: "Starter template" });
    expect(within(bar).getByLabelText("Starter").value).toBe("web-app");
    expect(within(bar).getByText(/Your answers are kept if you change it/)).toBeTruthy();
    expect(screen.getByText("Start here")).toBeTruthy();
    expect(screen.getByText("Usually not needed for this starter")).toBeTruthy();

    const card = screen.getByRole("article", { name: "Which language runs the app?" });
    expect(within(card).getByText(/Suggestion from the New web app starter/)).toBeTruthy();
    expect(within(card).getByText(/Nothing is decided until you use it/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/planning/answer")).toBe(false);
    fireEvent.click(within(card).getByRole("button", { name: "Use suggestion" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/planning/answer")).toBe(true));
    expect(calls.find((c) => c.path === "/planning/answer").body).toEqual({ q: "Q-1", choice: "typescript" });
  });

  it("a written-words suggestion is sent as the person's own text, only when they use it", async () => {
    const calls = mockApi({
      "GET /planning": () => ok(overview()),
      "GET /planning/templates": () => ok(LIST),
      "POST /planning/answer": () => ok({ q: "Q-2", status: "decided", decision: "D-3", answer: "Not needed for a new web app." }),
    });
    renderScreen();
    const card = await screen.findByRole("article", { name: "Does it need to work offline?" });
    fireEvent.click(within(card).getByRole("button", { name: "Use suggestion" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/planning/answer")).toBeTruthy());
    expect(calls.find((c) => c.path === "/planning/answer").body).toEqual({ q: "Q-2", text: "Not needed for a new web app." });
  });

  it("changing the starter and marking the usual areas not needed are the person's taps", async () => {
    const calls = mockApi({
      "GET /planning": () => ok(overview()),
      "GET /planning/templates": () => ok(LIST),
      "POST /planning/template": () => ok({ changed: true, template: "cli-tool", decision: "D-4", overview: overview() }),
      "POST /planning/template/skip": () => ok({ skipped: [{ q: "Q-2" }], overview: overview() }),
    });
    renderScreen();
    const bar = await screen.findByRole("region", { name: "Starter template" });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    fireEvent.change(within(bar).getByLabelText("Starter"), { target: { value: "cli-tool" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/planning/template")).toBe(true));
    expect(calls.find((c) => c.path === "/planning/template").body).toEqual({ template: "cli-tool" });
    fireEvent.click(within(bar).getByRole("button", { name: /Mark 1 question as not needed \(Offline and sync\)/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/planning/template/skip")).toBe(true));
    expect(calls.some((c) => c.path === "/planning/approve")).toBe(false);
  });

  it("shows why the starter cannot be changed any more", async () => {
    mockApi({
      "GET /planning": () => ok(overview()),
      "GET /planning/templates": () => ok(LIST),
      "POST /planning/template": () => refused(409, "ROADMAP_WRITTEN", "The roadmap is already on the board, so the starter can no longer change."),
    });
    renderScreen();
    const bar = await screen.findByRole("region", { name: "Starter template" });
    fireEvent.change(within(bar).getByLabelText("Starter"), { target: { value: "fix-bug" } });
    expect((await within(bar).findByRole("alert")).textContent).toMatch(/already on the board/);
  });

  it("fixes the starter once the plan is approved: no change, no skip button", async () => {
    const approved = [{ plan: "P-1", entry: "L-000020", at: "2026-10-09T10:00:00Z", by: "owner", summary: "Plan approved", fingerprint: "f1" }];
    mockApi({ "GET /planning": () => ok(overview({ approval: { canApprove: false, current: true, message: "This plan is approved as it stands.", approved } })), "GET /planning/templates": () => ok(LIST) });
    renderScreen();
    const bar = await screen.findByRole("region", { name: "Starter template" });
    expect(within(bar).getByLabelText("Starter").disabled).toBe(true);
    expect(within(bar).queryByRole("button")).toBeNull();
    expect(within(bar).getByText(/The plan is approved, so the starter is fixed/)).toBeTruthy();
  });

  it("has no starter bar problem with a plan that has no starter: it offers Start blank selected", async () => {
    mockApi({ "GET /planning": () => ok(overview({ template: null })), "GET /planning/templates": () => ok(LIST) });
    renderScreen();
    const bar = await screen.findByRole("region", { name: "Starter template" });
    expect(within(bar).getByLabelText("Starter").value).toBe("blank");
    expect(within(bar).queryByRole("button")).toBeNull();
  });

  it("marks starter tasks Suggested on the roadmap, says they are added only on approval, and shows size and files only in the advanced view", async () => {
    const handlers = { "GET /planning": () => ok(overview()), "GET /planning/templates": () => ok(LIST), "GET /planning/roadmap": () => ok(draftRoadmap) };
    mockApi(handlers);
    renderScreen("simple");
    await screen.findByRole("region", { name: "Starter template" });
    fireEvent.click(screen.getByRole("tab", { name: /Roadmap/ }));
    const task = (await screen.findByText("Set up the project so it installs and starts")).closest("li");
    expect(within(task).getByText("Suggested")).toBeTruthy();
    expect(screen.getAllByText("Suggested")).toHaveLength(1);
    expect(screen.getByText(/Tasks marked Suggested come from the New web app starter/)).toBeTruthy();
    expect(screen.getByText(/Not suggested because of your idea: Take payments/)).toBeTruthy();
    expect(screen.queryByText("No answers yet")).toBeNull();
    expect(screen.queryByText(/package\.json, src\/main/)).toBeNull();
    cleanup();

    mockApi(handlers);
    renderScreen("advanced");
    await screen.findByRole("region", { name: "Starter template" });
    fireEvent.click(screen.getByRole("tab", { name: /Roadmap/ }));
    expect(await screen.findByText(/small · package\.json, src\/main/)).toBeTruthy();
  });

  it("does not call a written task Suggested", async () => {
    const written = { ...draftRoadmap, written: true, template: draftRoadmap.template, phases: [{ ...draftRoadmap.phases[0], tasks: [{ ...draftRoadmap.phases[0].tasks[0], suggested: false, task: "T-1", entry: "L-000010" }] }] };
    mockApi({ "GET /planning": () => ok(overview()), "GET /planning/templates": () => ok(LIST), "GET /planning/roadmap": () => ok(written) });
    renderScreen();
    await screen.findByRole("region", { name: "Starter template" });
    fireEvent.click(screen.getByRole("tab", { name: /Roadmap/ }));
    await screen.findByText("Set up the project so it installs and starts");
    expect(screen.queryByText("Suggested")).toBeNull();
    expect(screen.queryByText(/Tasks marked Suggested/)).toBeNull();
  });
});
