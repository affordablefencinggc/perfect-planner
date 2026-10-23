import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import CoreSpine, { modelFamily } from "../../src/core-screens/CoreSpine.jsx";

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const task = (id, over = {}) => ({ id, label: id, title: `Task ${id}`, status: "open", stage: "needs-test", proofs: [], lastProgress: null, merged: null, dispatch: null, ...over });
const agent = (over) => ({ id: "w", name: "Worker", role: "worker", person: "owner", ...over });

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
      tasks: [task("T-1", { stage: "building", label: "T-1" }), task("T-2", { stage: "ready-to-claim", label: "T-2", dispatch: { model: "gemini-2.5-pro" } }), task("T-3", { stage: "done", label: "T-3" })],
      agents: [agent({ id: "a1", name: "Worker T-1", task: "T-1", model: "claude-sonnet-5-5" })],
    });
    const { container } = render(<CoreSpine />);
    const claude = await screen.findByRole("img", { name: /Claude \(claude-sonnet-5-5\), working now/ });
    expect(claude.querySelector(".spine-model-orbit")).toBeTruthy();
    const gemini = screen.getByRole("img", { name: /Gemini/ });
    expect(gemini.getAttribute("aria-label")).not.toMatch(/working now/);
    expect(gemini.querySelector(".spine-model-orbit")).toBeNull();
    // A finished task shows no worker at all.
    expect(container.querySelectorAll(".spine-model")).toHaveLength(2);
    expect(container.querySelectorAll('[data-working="true"]')).toHaveLength(1);
  });

  test("a building task whose worker went quiet is not animated and says so", async () => {
    routeFetch({ tasks: [task("T-1", { stage: "building" })], agents: [agent({ task: "T-1", model: "claude-opus", quiet: true })] });
    const { container } = render(<CoreSpine />);
    await screen.findByText(/has not been heard from lately/);
    expect(container.querySelector(".spine-model-orbit")).toBeNull();
  });

  test("a revoked worker is not shown on the task", async () => {
    routeFetch({ tasks: [task("T-1", { stage: "building" })], agents: [agent({ task: "T-1", model: "claude-opus", revoked: true })] });
    const { container } = render(<CoreSpine />);
    await screen.findByRole("list", { name: "Tasks from the ledger" });
    expect(container.querySelector(".spine-model")).toBeNull();
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
});
