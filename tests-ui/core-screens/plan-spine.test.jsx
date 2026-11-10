import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import CorePlanSpine, { groupByPhase } from "../../src/core-screens/CorePlanSpine.jsx";

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const fresh = () => new Date().toISOString();
const task = (id, over = {}) => { const value = { id, label: id, title: `Task ${id}`, status: "open", stage: "needs-test", clauses: [], proofs: [], lastProgress: null, merged: null, dispatch: null, worktree: null, diffApproval: null, ...over }; if (value.stage === "building" && value.lastProgress === null) value.lastProgress = { text: "worker-reported edit", at: fresh() }; return value; };

function routeFetch({ tasks, agents = [], roadmap = { phases: [] }, people = { view: { members: [] }, photos: {} } }) {
  const fn = vi.fn(async (url, init) => {
    if (init?.method === "POST" && String(url).includes("/people/assign")) { const b = JSON.parse(init.body); for (const t of tasks) if (t.id === b.task) t.assignee = b.person; return ok({ entry: "L-9" }); }
    const path = String(url).split("?")[0].replace("/api/core", "");
    if (path === "/session") return ok({ person: true });
    if (path === "/tasks") return ok({ repo: { ok: true, root: "/r" }, tasks });
    if (path === "/agents") return ok({ agents, connections: [] });
    if (path === "/planning/roadmap") return ok(roadmap);
    if (path === "/people") return ok(people);
    throw new Error(`unexpected ${path}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("groupByPhase", () => {
  test("puts each task in its roadmap phase and the rest in a last group; a roadmap task with no ledger task is not drawn", () => {
    const tasks = [task("T-1"), task("T-2"), task("T-3")];
    const roadmap = { phases: [{ id: "P1", title: "Plan", tasks: [{ task: "T-2", owner: "sam" }, { key: "x" }] }, { id: "P2", title: "Empty", tasks: [] }] };
    const groups = groupByPhase(tasks, roadmap);
    expect(groups.map((g) => [g.id, g.rows.map((r) => r.task.id)])).toEqual([["P1", ["T-2"]], ["More", ["T-1", "T-3"]]]);
    expect(groups[0].rows[0].owner).toBe("sam");
  });
  test("with no roadmap everything is one group", () => {
    expect(groupByPhase([task("T-1")], null).map((g) => g.id)).toEqual(["All"]);
  });
  test("an unassigned roadmap owner is no owner", () => {
    const roadmap = { phases: [{ id: "P1", title: "Plan", tasks: [{ task: "T-1", owner: "unassigned" }] }] };
    expect(groupByPhase([task("T-1")], roadmap)[0].rows[0].owner).toBeNull();
  });
});

describe("a person's own spine", () => {
  const two = () => routeFetch({
    tasks: [
      task("T-1", { status: "claimed", owner: "a1", workerActivity: { worker: "a1", activity: "working", at: fresh() }, stage: "building", dispatch: { model: "claude-sonnet-5-5" } }),
      task("T-2", { status: "claimed", owner: "a2", workerActivity: { worker: "a2", activity: "working", at: fresh() }, stage: "building", dispatch: { model: "gemini-3-pro" }, waitingFor: { tasks: ["T-1"], message: "Waits for T-1" } }),
      task("T-3", { stage: "done", dispatch: { model: "gpt-5-codex" } }),
    ],
    agents: [
      { id: "a1", role: "worker", task: "T-1", model: "claude-sonnet-5-5", person: "sam", lastSeen: fresh() },
      { id: "a2", role: "worker", task: "T-2", model: "gemini-3-pro", person: "jo", lastSeen: fresh() },
    ],
    roadmap: { phases: [{ id: "build", title: "Build", tasks: [{ task: "T-1", owner: "sam", dependsOnTasks: [] }, { task: "T-2", owner: "jo", dependsOnTasks: ["T-1"] }, { task: "T-3", owner: "sam", dependsOnTasks: ["T-1"] }] }] },
    people: { view: { owner: { person: "sam" }, members: [{ person: "sam", name: "Sam Lee", role: "owner" }, { person: "jo", name: "Jo Park", role: "helper" }, { person: "al", name: "Al Ng", role: "helper" }] }, photos: { sam: "data:image/png;base64,AAAA" } },
  });

  test("the main spine lists every person with what they are doing; a person with no work says so", async () => {
    two();
    render(<CorePlanSpine />);
    const strip = await screen.findByRole("list", { name: "People on this project" });
    const cards = within(strip).getAllByRole("button");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Open Sam Lee's spine", "Open Jo Park's spine", "Open Al Ng's spine"]);
    expect(cards[0].textContent).toContain("2 tasks · 1 working");
    expect(cards[2].textContent).toContain("No tasks yet");
  });

  test("opening a person shows their head, only their tasks and a runner per model building; back returns", async () => {
    two();
    const { container } = render(<CorePlanSpine />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Open Sam Lee's spine" }))[0]);
    const head = await screen.findByRole("heading", { name: "Sam Lee" });
    expect(head.closest("header").querySelector("img.core-owner-photo").getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(screen.getByRole("status").textContent).toContain("owner · 2 tasks · 1 merged · 1 model working in parallel");
    expect([...container.querySelectorAll(".core-vertebra")].map((c) => c.getAttribute("aria-label"))).toEqual(["T-1 Task T-1", "T-3 Task T-3"]);
    // One runner, for Sam's one model that is building; Jo's building task is not on this spine.
    expect(container.querySelectorAll(".spine-runner img")).toHaveLength(1);
    expect(container.querySelector(".spine-runner img").getAttribute("src")).toContain("running-right/anthropic-claude.svg");
    expect(container.querySelector(".core-veins")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Main spine/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Jo Park's spine" }));
    await screen.findByRole("heading", { name: "Jo Park" });
    expect(container.querySelector(".spine-runner img").getAttribute("src")).toContain("running-right/google-gemini.svg");
    fireEvent.click(screen.getByRole("button", { name: /Main spine/ }));
    await screen.findByRole("list", { name: "People on this project" });
  });

  test("the owner can give a task to someone, and it moves onto their spine; others and a lone owner get no selector", async () => {
    const fn = two();
    // two() has no `me`, so no selector yet.
    const first = render(<CorePlanSpine />);
    await screen.findByRole("list", { name: "People on this project" });
    expect(screen.queryByLabelText("Give T-1 to")).toBeNull();
    first.unmount();
    cleanup();
    const tasks = [task("T-1", { stage: "needs-test" }), task("T-2", { stage: "done" })];
    routeFetch({
      tasks,
      roadmap: { phases: [{ id: "build", title: "Build", tasks: [{ task: "T-1", owner: "sam" }, { task: "T-2", owner: "sam" }] }] },
      people: { me: "sam", view: { owner: { person: "sam" }, members: [{ person: "sam", name: "Sam Lee", role: "owner" }, { person: "jo", name: "Jo Park", role: "helper" }, { person: "vi", name: "Vi", role: "viewer" }] }, photos: {} },
    });
    render(<CorePlanSpine />);
    const select = await screen.findByLabelText("Give T-1 to");
    // A merged task is not handed out; a viewer cannot be chosen.
    expect(screen.queryByLabelText("Give T-2 to")).toBeNull();
    expect([...select.options].map((o) => o.textContent)).toEqual(["Sam Lee", "Jo Park"]);
    fireEvent.change(select, { target: { value: "jo" } });
    await waitFor(() => expect(globalThis.fetch.mock.calls.some(([u, i]) => String(u).includes("/people/assign") && JSON.parse(i.body).person === "jo")).toBe(true));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "People on this project" })).getByRole("button", { name: "Open Jo Park's spine" }).textContent).toContain("1 task"));
    void fn;
  });

  test("a person with no tasks has a head and an honest empty line, no spine", async () => {
    two();
    const { container } = render(<CorePlanSpine />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Al Ng's spine" }));
    await screen.findByText("Al Ng has no tasks on this project yet.");
    expect(container.querySelector(".plan-canvas")).toBeNull();
  });
});

describe("CorePlanSpine", () => {
  test("draws vertebra cards from the ledger: phase, owner picture, running robot only while its worker is live", async () => {
    routeFetch({
      tasks: [
        task("T-1", { status: "claimed", owner: "w1", workerActivity: { worker: "w1", activity: "working", at: fresh() }, stage: "building", dispatch: { model: "claude-sonnet-5-5" }, clauses: ["It saves", "It loads"], worktree: { branch: "pp/T-1" } }),
        task("T-2", { stage: "done", dispatch: { model: "gemini-2.5-pro" }, diffApproval: { commit: "abc" }, proofs: [{ kind: "commit", link: "x" }] }),
        task("T-3", { stage: "review-diff", dispatch: { model: "my-own-model" } }),
      ],
      agents: [{ id: "w1", role: "worker", task: "T-1", model: "claude-sonnet-5-5", name: "Claude A", lastSeen: fresh() }],
      roadmap: { phases: [{ id: "P1", title: "Build", tasks: [{ task: "T-1", owner: "sam" }, { task: "T-2", owner: "sam" }] }] },
      people: { view: { owner: { person: "sam" }, members: [{ person: "sam", name: "Sam Lee" }] }, photos: { sam: "data:image/png;base64,AAAA" } },
    });
    const { container } = render(<CorePlanSpine />);
    await screen.findByRole("group", { name: /Phase 1 Build/ });
    const cards = [...container.querySelectorAll(".core-vertebra")];
    expect(cards.map((c) => c.dataset.stage)).toEqual(["building", "done", "review-diff"]);
    expect(cards.map((c) => c.dataset.side)).toEqual(["left", "right", "left"]);
    // T-1: live Claude worker runs; the picture is Sam's own, from /people.
    expect(cards[0].querySelector(".perimeter-worker.running img").getAttribute("src")).toContain("running-right/anthropic-claude.svg");
    expect(cards[0].querySelector("img.core-owner-photo").getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(within(cards[0]).getByText("It saves")).toBeTruthy();
    // The card being built right now stands out and says so.
    expect(cards[0].className).toContain("core-working");
    expect(cards[0].querySelector(".core-working-text").textContent).toBe("Building now");
    expect(cards[1].className).not.toContain("core-working");
    // T-2: merged, robot parked with the green outline, diff and proof counted.
    expect(cards[1].querySelector(".perimeter-worker.running")).toBeNull();
    expect(cards[1].querySelector(".perimeter-success-trail.complete")).not.toBeNull();
    expect(cards[1].textContent).toContain("1/11/1");
        // T-3: a model we cannot place gets no robot, and it is marked as waiting on the person.
    expect(cards[2].querySelector(".perimeter-worker")).toBeNull();
    expect(cards[2].className).toContain("core-needs-you");
    expect(screen.getByRole("status").textContent).toContain("1 of 3 merged · 1 working now");
  });

  test("a worker that has gone quiet does not run; a task without a roadmap owner shows who approves", async () => {
    routeFetch({
      tasks: [task("T-1", { stage: "building", dispatch: { model: "gpt-5-codex" } })],
      agents: [{ id: "w1", role: "worker", task: "T-1", model: "gpt-5-codex", quiet: true }],
      people: { view: { owner: { person: "sam" }, members: [{ person: "sam", name: "Sam Lee" }] }, photos: {} },
    });
    const { container } = render(<CorePlanSpine />);
    await waitFor(() => expect(container.querySelector(".core-vertebra")).not.toBeNull());
    expect(container.querySelector(".perimeter-worker.running")).toBeNull();
    expect(container.querySelector(".perimeter-worker img").getAttribute("src")).toContain("dead-still/openai-gpt.svg");
    expect(screen.getAllByRole("button", { name: "Approves: Sam Lee: open their spine" })[0]).toBeTruthy();
    expect(container.querySelector("img.core-owner-photo")).toBeNull();
  });

  test("keeps durable Codex identity and actionable ledger stages when no agent survives restart", async () => {
    routeFetch({
      tasks: [
        task("T-1", { stage: "test-proposed", owner: "codex-d23a34ad", dispatch: { model: "claude-sonnet-4-5" } }),
        task("T-2", { stage: "ready-to-claim", owner: "codex-d23a34ad", dispatch: { model: "claude-sonnet-4-5" } }),
        task("T-3", { stage: "ready-to-merge", check: { passed: true, commit: "abc123" }, proofs: [{ kind: "test", link: "test-output" }], diffApproval: { commit: "abc123", by: { kind: "person", id: "sam" } }, owner: "codex-d23a34ad", dispatch: { model: "claude-sonnet-4-5" } }),
      ],
      people: { view: { owner: { person: "sam" }, members: [{ person: "sam", name: "Sam Lee" }] }, photos: {} },
    });
    const { container } = render(<CorePlanSpine />);
    await waitFor(() => expect(container.querySelectorAll(".core-vertebra")).toHaveLength(3));
    expect(container.querySelectorAll(".perimeter-worker.running")).toHaveLength(0);
    expect([...container.querySelectorAll(".perimeter-worker img")].every((img) => img.getAttribute("src").includes("openai-gpt.svg"))).toBe(true);
    expect(screen.getByText("Test waiting for your approval")).toBeTruthy();
    expect(screen.getByText("Ready for a worker to claim")).toBeTruthy();
    expect(screen.getByText("Approved, waiting for you to merge")).toBeTruthy();
  });

  test("draws nothing with no tasks, and says so plainly when the ledger cannot be read", async () => {
    routeFetch({ tasks: [] });
    const { container, rerender } = render(<CorePlanSpine />);
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector(".core-plan-spine")).toBeNull();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("/tasks") ? { ok: false, status: 500, json: async () => ({ ok: false, code: "ERROR", message: "disk unreadable" }) } : ok({})));
    render(<CorePlanSpine />);
    expect((await screen.findByRole("alert")).textContent).toContain("disk unreadable");
  });
});

describe("a plan not yet approved", () => {
  test("is drawn as short topic cards on the spine, and a card opens Deep planning", async () => {
    routeFetch({ tasks: [], roadmap: { phases: [{ id: "p1", title: "Foundations", tasks: [{ key: "k1", title: "Sign people in with a one-time email link: tokens expire after ten minutes and are single use", doneWhen: "a test signs in twice" }] }] } });
    const onWorkspace = vi.fn();
    render(<CorePlanSpine onWorkspace={onWorkspace} />);
    const card = await screen.findByRole("article", { name: /Sign people in with a one-time email link/ });
    expect(card.textContent).not.toMatch(/tokens expire/);
    expect(card.textContent).toMatch(/Planned, not started/);
    fireEvent.click(card);
    expect(onWorkspace).toHaveBeenCalledWith("planning");
  });
});
test("restores requested Codex identity without a live roster or dispatch and never animates it", async () => {
  routeFetch({ tasks: [task("T-1", { status: "claimed", owner: "worker-opaque", stage: "building", workerDispatch: { requestedModel: "gpt-5.6", requestedAt: "2026-11-04T03:00:00Z" } }), task("T-2", { stage: "building" })] });
  const { container } = render(<CorePlanSpine />);
  await waitFor(() => expect(container.querySelectorAll(".core-vertebra")).toHaveLength(2));
  expect(container.querySelectorAll(".perimeter-worker.running")).toHaveLength(0);
  const icons = [...container.querySelectorAll(".perimeter-worker img")];
  expect(icons).toHaveLength(1);
  expect(icons[0].getAttribute("src")).toContain("openai-gpt.svg");
  expect(icons[0].closest(".perimeter-worker").getAttribute("aria-label")).toMatch(/Requested provider: Codex/);
});

test.each(["working", "finished", undefined])("rework activity %s renders the reported icon and preserves last-check state", async (activity) => {
  const at = fresh();
  routeFetch({ tasks: [task("T-1", { status: "claimed", owner: "codex-worker", stage: "review-diff", check: { passed: true, commit: "previous" }, proofs: [{ kind: "commit", link: "previous" }], workerDispatch: { requestedModel: "gpt-requested" }, workerReport: { worker: "codex-worker", reportedModel: "gpt-reported" }, workerActivity: activity ? { worker: "codex-worker", activity, at, afterCheck: true } : null, lastProgress: { text: "Navigation repair update", at } })], agents: [{ id: "codex-worker", role: "worker", task: "T-1", requestedModel: "gpt-requested", reportedModel: "gpt-reported", model: "gpt-requested", lastSeen: at }] });
  const { container } = render(<CorePlanSpine />);
  await waitFor(() => expect(container.querySelector(".core-vertebra")).not.toBeNull());
  const icon = container.querySelector(".perimeter-worker");
  expect(icon.getAttribute("aria-label")).toContain("Worker-reported provider: Codex");
  expect(icon.getAttribute("aria-label")).toContain("requested gpt-requested, reported gpt-reported (conflict)");
  expect(icon.classList.contains("running")).toBe(activity === "working");
  expect(container.querySelector(".core-vertebra").dataset.stage).toBe("review-diff");
});
