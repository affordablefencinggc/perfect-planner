import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TaskTerminalPanel } from "../../src/core-screens/TaskTerminalPanel.jsx";

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("TaskTerminalPanel", () => {
  test("runs a preset and shows exit code, output and transcript hash", async () => {
    const fetchMock = routeFetch({
      "POST /tasks/T-1/terminal": () => ok({
        command: "git status",
        cwd: "/tmp/wt",
        exitCode: 0,
        stdout: "On branch pp/T-1",
        stderr: "",
        durationMs: 12,
        transcriptHash: "a".repeat(64),
        truncated: false,
      }),
    });
    render(<TaskTerminalPanel taskId="T-1" project="default" />);
    fireEvent.click(screen.getByRole("button", { name: "git status" }));
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    expect(await screen.findByText("On branch pp/T-1")).toBeTruthy();
    expect(screen.getByText(/exit/)).toBeTruthy();
    expect(screen.getByText(/transcript aaaaaaaaaaaaaaaa/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/tasks/T-1/terminal"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("shows the host refusal without pretending the command ran", async () => {
    routeFetch({
      "POST /tasks/T-1/terminal": () => ({ ok: false, status: 400, json: async () => ({ ok: false, code: "COMMAND_REFUSED", message: "That command is not on the read-only list." }) }),
    });
    render(<TaskTerminalPanel taskId="T-1" project="default" />);
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/read-only list/);
  });

  test("a task without a worktree says it is advisory only", () => {
    render(<TaskTerminalPanel taskId="T-1" project="default" hasWorktree={false} />);
    expect(screen.getByText(/advisory only/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Run/ })).toBeNull();
  });
});
