import fs from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import CoreSpine, { modelFamily } from "../../src/core-screens/CoreSpine.jsx";

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const task = (id, over = {}) => ({ id, label: id, title: `Task ${id}`, status: "open", stage: "needs-test", proofs: [], lastProgress: null, merged: null, dispatch: null, ...over });
const fresh = () => new Date().toISOString();
const agent = (over) => ({ id: "w", name: "Worker", role: "worker", person: "owner", lastSeen: fresh(), ...over });

function routeFetch({ tasks, agents = [], failTasks = false }) {
  const fn = vi.fn(async (url) => {
    const path = String(url).split("?")[0].replace("/api/core", "");
    if (path === "/session") return ok({ person: true });
    if (path === "/tasks") {
      if (failTasks) return { ok: false, status: 500, json: async () => ({ ok: false, code: "ERROR", message: "disk unreadable" }) };
      return ok({ repo: { ok: true, root: "/r" }, tasks: typeof tasks === "function" ? tasks() : tasks });
    }
    if (path === "/agents") return ok({ agents, connections: [] });
    throw new Error(`unexpected ${path}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("modelFamily", () => {
  test("names the family from the model, and never guesses for an unknown one", () => {
    expect(modelFamily("claude-sonnet-5-5").id).toBe("claude");
    expect(modelFamily("unverified:Claude Opus").id).toBe("claude");
    expect(modelFamily("gemini-2.5-pro").id).toBe("gemini");
    expect(modelFamily("gpt-5-codex").id).toBe("codex");
    expect(modelFamily("my-own-model")).toMatchObject({ id: "unknown", glyph: "?" });
    expect(modelFamily(undefined).id).toBe("unknown");
  });
});

describe("CoreSpine", () => {
  test("draws one node per real task in ledger order, with where each stands", async () => {
    routeFetch({ tasks: [task("T-10"), task("T-2", { stage: "test-proposed" }), task("T-1", { stage: "done", merged: { mergeCommit: "abcdef1234567890" }, proofs: [{ kind: "commit", link: "x" }] })] });
    render(<CoreSpine />);
    const list = await screen.findByRole("list", { name: "Tasks from the ledger" });
    const nodes = within(list).getAllByRole("article");
    expect(nodes.map((n) => n.getAttribute("aria-label"))).toEqual(["T-1 Task T-1", "T-2 Task T-2", "T-10 Task T-10"]);
    expect(screen.getByText("Merged and done")).toBeTruthy();
    expect(screen.getByText(/Test waiting for your approval/)).toBeTruthy();
    expect(screen.getByText(/your turn/)).toBeTruthy();
    expect(screen.getByText(/merged at abcdef123456/)).toBeTruthy();
    expect(screen.getByText("1 of 3 merged · every row is read from this project's ledger")).toBeTruthy();
  });

  test("marks the stations a task has passed and the one waiting", async () => {
    routeFetch({ tasks: [task("T-1", { stage: "review-diff" })] });
    render(<CoreSpine />);
    const stations = await screen.findByRole("list", { name: "T-1 progress" });
    const states = within(stations).getAllByRole("listitem").map((li) => `${li.textContent}:${li.getAttribute("data-state")}`);
    expect(states).toEqual(["Test written:done", "Test approved:done", "Built:done", "Checked:next", "Diff approved:todo", "Merged:todo"]);
  });

  test("shows the model working on a task and only animates while it is building", async () => {
    routeFetch({
      tasks: [task("T-1", { status: "claimed", owner: "a1", workerActivity: { worker: "a1", activity: "working", at: fresh() }, stage: "building", label: "T-1", lastProgress: { text: "editing", at: fresh() } }), task("T-2", { stage: "ready-to-claim", label: "T-2", dispatch: { model: "gemini-2.5-pro" } }), task("T-3", { stage: "done", label: "T-3" })],
      agents: [agent({ id: "a1", name: "Worker T-1", task: "T-1", model: "claude-sonnet-5-5" })],
    });
    const { container } = render(<CoreSpine />);
    const claude = (await screen.findAllByRole("img", { name: /Claude \(claude-sonnet-5-5\), working now/ })).at(-1);
    expect(claude.querySelector(".spine-model-orbit")).toBeTruthy();
    const gemini = screen.getByRole("img", { name: /Gemini/ });
    expect(gemini.getAttribute("aria-label")).not.toMatch(/working now/);
    expect(gemini.querySelector(".spine-model-orbit")).toBeNull();
    // A finished task shows no worker at all.
    expect((await screen.findByRole("list", { name: "Tasks from the ledger" })).querySelectorAll(".spine-model")).toHaveLength(2);
    expect(container.querySelectorAll('[data-working="true"]')).toHaveLength(1);
  });

  test("a building task whose worker went quiet is not animated and says so", async () => {
    routeFetch({ tasks: [task("T-1", { stage: "building", lastProgress: { text: "editing", at: fresh() } })], agents: [agent({ task: "T-1", model: "claude-opus", quiet: true })] });
    const { container } = render(<CoreSpine />);
    await screen.findByText(/No fresh observed worker activity/);
    expect(container.querySelector(".spine-model-orbit")).toBeNull();
  });

  test("a revoked worker is not shown on the task", async () => {
    routeFetch({ tasks: [task("T-1", { stage: "building" })], agents: [agent({ task: "T-1", model: "claude-opus", revoked: true })] });
    const { container } = render(<CoreSpine />);
    await screen.findByRole("list", { name: "Tasks from the ledger" });
    expect(container.querySelector(".spine-model")).toBeNull();
  });

  test("keeps durable Codex attribution after restart even when an old configured model says Claude", async () => {
    routeFetch({ tasks: [task("T-1", { stage: "ready-to-claim", owner: "codex-d23a34ad", dispatch: { model: "claude-sonnet-4-5" } })] });
    render(<CoreSpine />);
    const icon = await screen.findByRole("img", { name: /Codex \(configured claude-sonnet-4-5; provider identity is Codex\)/ });
    expect(icon.querySelector(".spine-model-orbit")).toBeNull();
    expect(screen.getByText("Ready for a worker to claim")).toBeTruthy();
  });

  test("a hostile title and progress note are shown as text, never as markup", async () => {
    routeFetch({ tasks: [task("T-1", { title: "<img src=x onerror=alert(1)>", lastProgress: { text: "<script>bad()</script>" } })] });
    const { container } = render(<CoreSpine />);
    await screen.findByRole("list", { name: "Tasks from the ledger" });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });

  test("an empty ledger says so and offers Deep planning", async () => {
    routeFetch({ tasks: [] });
    const onWorkspace = vi.fn();
    render(<CoreSpine onWorkspace={onWorkspace} />);
    expect(await screen.findByText(/No tasks on this project's ledger yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Deep planning" }));
    expect(onWorkspace).toHaveBeenCalledWith("planning");
  });

  test("a failed read shows the error and no tasks, then Try again brings them back", async () => {
    let fail = true;
    const fn = routeFetch({ tasks: [task("T-1")] });
    const inner = fn.getMockImplementation();
    fn.mockImplementation(async (url, init) => (fail && String(url).includes("/tasks") ? { ok: false, status: 500, json: async () => ({ ok: false, code: "ERROR", message: "disk unreadable" }) } : inner(url, init)));
    render(<CoreSpine />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("article", { name: "T-1 Task T-1" })).toBeTruthy();
  });

  test("handles 200 tasks", async () => {
    routeFetch({ tasks: Array.from({ length: 200 }, (_, i) => task(`T-${i + 1}`, { stage: i % 3 ? "done" : "building" })) });
    render(<CoreSpine />);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(200));
  });

  test("shows nothing when this window has no session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ ok: false, code: "NO_SESSION", message: "no" }) })));
    const { container } = render(<CoreSpine />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".core-spine")?.getAttribute("data-state") ?? "gone").not.toBe("ready");
  });
  test("with many tasks it counts who is waiting on whom, and a button shows just those", async () => {
    const many = [
      ...Array.from({ length: 4 }, (_, i) => task(`T-${i + 1}`)),
      task("T-5", { stage: "test-proposed" }),
      task("T-6", { status: "claimed", owner: "gemini-worker", workerActivity: { worker: "gemini-worker", activity: "working", at: fresh() }, stage: "building", dispatch: { model: "gemini-3-pro" }, lastProgress: { text: "editing", at: fresh() } }),
      task("T-7", { stage: "building", dispatch: { model: "gpt-5-codex" } }),
      task("T-8", { stage: "done", merged: { mergeCommit: "abc" } }),
    ];
    routeFetch({ tasks: many, agents: [agent({ id: "gemini-worker", task: "T-6", model: "gemini-3-pro" })] });
    render(<CoreSpine />);
    const group = await screen.findByRole("group", { name: "Show tasks" });
    expect(within(group).getByRole("button", { name: /^All 8/ })).toBeTruthy();
    expect(within(group).getByRole("button", { name: /^Need you 1/ })).toBeTruthy();
    expect(within(group).getByRole("button", { name: /^Working 1/ })).toBeTruthy();
    expect(within(group).getByRole("button", { name: /^Not started 4/ })).toBeTruthy();
    expect(within(group).getByRole("button", { name: /^Merged 1/ })).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: /^Working/ }));
    const list = screen.getByRole("list", { name: "Tasks from the ledger" });
    expect(within(list).getAllByRole("article").map((n) => n.getAttribute("aria-label"))).toEqual(["T-6 Task T-6"]);
    fireEvent.click(within(group).getByRole("button", { name: /^All/ }));
    expect(within(list).getAllByRole("article")).toHaveLength(8);
  });

  test("uses the actual animated provider badge for each fresh lane and preserves review when activity predates its check", async () => {
    let now = fresh();
    const active = () => [
      task("T-1", { title: "Continue the Finish-Lines route", status: "claimed", owner: "codex-active", stage: "review-diff", dispatch: { model: "claude-sonnet-5-5" }, workerReport: { worker: "codex-active", reportedModel: "gpt-5.6-terra" }, check: { passed: true, commit: "aabbccdd" }, proofs: [{ kind: "test-run", link: "prior check" }], workerActivity: { worker: "codex-active", activity: "working", afterCheck: true, at: now }, lastProgress: { text: "continuing implementation", at: now } }),
      task("T-2", { title: "Keep the Build worker visible", status: "claimed", owner: "gemini-build", stage: "building", workerActivity: { worker: "gemini-build", activity: "working", at: now }, lastProgress: { text: "updating the live lane", at: now } }),
      task("T-3", { title: "Fresh pre-check finish stays still", status: "claimed", owner: "claude-review", stage: "review-diff", check: { passed: true }, proofs: [{ kind: "commit", link: "receipt" }], workerActivity: { worker: "claude-review", activity: "finished", at: now }, lastProgress: { text: "finished the requested change", at: now } }),
      task("T-4", { title: "Fresh pre-check work stays in review", status: "claimed", owner: "precheck-worker", stage: "review-diff", check: { passed: true }, proofs: [{ kind: "commit", link: "receipt" }], workerActivity: { worker: "precheck-worker", activity: "working", afterCheck: false, at: now }, lastProgress: { text: "old work report", at: now } }),
      task("T-5", { title: "Waiting after a check stays in review", status: "claimed", owner: "waiting-worker", stage: "review-diff", check: { passed: true }, proofs: [{ kind: "commit", link: "receipt" }], workerActivity: { worker: "waiting-worker", activity: "waiting", afterCheck: false, at: now }, lastProgress: { text: "waiting for review", at: now } }),
      task("T-6", { title: "Stale work stays still", status: "claimed", owner: "old-worker", stage: "building", workerActivity: { worker: "old-worker", activity: "working", at: "2020-01-01T00:00:00.000Z" }, lastProgress: { text: "old action", at: "2020-01-01T00:00:00.000Z" } }),
      task("T-7", { title: "Still staged", stage: "test-proposed" }),
    ];
    const agents = [
      agent({ id: "codex-active", task: "T-1", model: "gpt-5.6-terra" }),
      agent({ id: "gemini-build", task: "T-2", model: "gemini-3-pro" }),
      agent({ id: "claude-review", task: "T-3", model: "claude-sonnet-5-5" }),
      agent({ id: "precheck-worker", task: "T-4", model: "gpt-5.6-terra" }),
      agent({ id: "waiting-worker", task: "T-5", model: "gpt-5.6-terra" }),
      agent({ id: "old-worker", task: "T-6", model: "gpt-5.6-terra", lastSeen: "2020-01-01T00:00:00.000Z" }),
    ];
    routeFetch({ tasks: active, agents });
    render(<CoreSpine actions />);
    const live = await screen.findByRole("region", { name: "Live work" });
    const lanes = within(live).getAllByRole("article");
    expect(within(live).getAllByRole("article")).toHaveLength(3);
    expect(within(live).getByText("Continue the Finish-Lines route")).toBeTruthy();
    expect(lanes?.[0]?.textContent).toMatch(/Working after the last check/);
    expect(within(live).queryByText(/recheck/i)).toBeNull();
    expect(within(live).getByText(/Requested claude-sonnet-5-5; worker reported gpt-5.6-terra/)).toBeTruthy();
    expect(lanes[0].querySelector(".spine-model-orbit")).toBeTruthy();
    expect(lanes[1].querySelector(".spine-model-orbit")).toBeTruthy();
    expect(lanes[2].querySelector(".spine-model-orbit")).toBeNull();
    expect(lanes[2].textContent).toMatch(/Worker reported finished.*Awaiting review/);
    expect(within(live).queryByText("Fresh pre-check work stays in review")).toBeNull();
    expect(within(live).queryByText("Waiting after a check stays in review")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Need you/ }));
    expect(within(live).getAllByRole("article")).toHaveLength(3);

    now = fresh();
    agents[0] = { ...agents[0], lastSeen: "2020-01-01T00:00:00.000Z" };
    await new Promise((resolve) => setTimeout(resolve, 4200));
    expect(within(await screen.findByRole("region", { name: "Live work" })).getAllByRole("article")).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Live work" })).getByText("Keep the Build worker visible")).toBeTruthy();
  }, 20000);

  test("a task nobody has touched is a one-line row; one with a worker or waiting on you is a full card", async () => {
    routeFetch({ tasks: [task("T-1"), task("T-2", { stage: "test-proposed" }), task("T-3", { stage: "building", dispatch: { model: "claude-opus-5-5" } }), task("T-4"), task("T-5")] });
    render(<CoreSpine />);
    await screen.findByRole("list", { name: "Tasks from the ledger" });
    expect(screen.queryByRole("list", { name: "T-1 progress" })).toBeNull();
    expect(screen.getByRole("list", { name: "T-2 progress" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "T-3 progress" })).toBeTruthy();
    expect(screen.getAllByText("No proof attached")).toHaveLength(2);
  });

  test("reports how many tasks the ledger has, so the older proof panel can step aside", async () => {
    routeFetch({ tasks: [task("T-1"), task("T-2")] });
    const onCount = vi.fn();
    render(<CoreSpine onCount={onCount} />);
    await screen.findByRole("list", { name: "Tasks from the ledger" });
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(2));
  });
  test("on the Build page it opens on what waits for you and each row says what to do next", async () => {
    routeFetch({ tasks: [task("T-1"), task("T-2", { stage: "test-proposed" }), task("T-3", { stage: "ready-to-merge" }), task("T-4"), task("T-5"), task("T-6")] });
    const onWorkspace = vi.fn();
    render(<CoreSpine actions onWorkspace={onWorkspace} />);
    const list = await screen.findByRole("list", { name: "Tasks from the ledger" });
    expect(within(list).getAllByRole("article").map((n) => n.getAttribute("aria-label"))).toEqual(["T-2 Task T-2", "T-3 Task T-3"]);
    fireEvent.click(screen.getByRole("button", { name: "Review the test" }));
    expect(onWorkspace).toHaveBeenCalledWith("tasks");
    expect(screen.getByRole("button", { name: "Merge" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(within(list).getAllByRole("article")).toHaveLength(6);
  });

  test("without actions there are no next-step buttons", async () => {
    routeFetch({ tasks: [task("T-1", { stage: "test-proposed" })] });
    render(<CoreSpine onWorkspace={() => {}} />);
    await screen.findByRole("list", { name: "Tasks from the ledger" });
    expect(screen.queryByRole("button", { name: "Review the test" })).toBeNull();
  });

  test("reduced motion directly stops the actual Plan spine runner", () => {
    const css = fs.readFileSync(path.resolve("src/core-screens/CoreSpine.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.core-plan-spine \.spine-runner \{ animation: none/);
  });
});
