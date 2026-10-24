import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoreTerminal } from "../../src/core-screens/CoreTerminal.jsx";
import { resetPersonSession } from "../../src/core-screens/coreApi.js";

const SCRIPTS = [
  { id: "connect-claude", group: "Agents", label: "Connect Claude Code", about: "Sets up Claude Code.", shown: "node connect.mjs --agent claude", asks: false },
  { id: "aws-configure", group: "Cloud", label: "Amazon: enter your keys", about: "Asks for your keys.", shown: "aws configure", asks: true },
];
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

beforeEach(() => resetPersonSession());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("CoreTerminal", () => {
  test("shows the exact command first and starts nothing until Run is pressed", async () => {
    const fn = routeFetch({
      "GET /terminal/scripts": () => ok({ scripts: SCRIPTS }),
      "GET /terminal/run": () => ok({ state: "idle", output: "" }),
    });
    render(<CoreTerminal />);
    fireEvent.click(await screen.findByRole("button", { name: "Amazon: enter your keys" }));
    expect(screen.getByLabelText("The command that will run").textContent).toBe("aws configure");
    expect(fn.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  test("sends what is typed as hidden input and then shows the finish", async () => {
    let state = "idle";
    const bodies = [];
    routeFetch({
      "GET /terminal/scripts": () => ok({ scripts: SCRIPTS }),
      "GET /terminal/run": () => ok({ state, output: state === "idle" ? "" : "$ aws configure\nAccess key: " }),
      "POST /terminal/run": () => { state = "running"; return ok({ state, output: "$ aws configure\nAccess key: " }); },
      "POST /terminal/input": (init) => { bodies.push(JSON.parse(init.body)); state = "done"; return ok({ state, output: "done" }); },
    });
    render(<CoreTerminal />);
    fireEvent.click(await screen.findByRole("button", { name: "Amazon: enter your keys" }));
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    const box = await screen.findByLabelText("Type a reply to the script");
    expect(box.type).toBe("password");
    fireEvent.change(box, { target: { value: "AKIAEXAMPLE" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bodies).toEqual([{ text: "AKIAEXAMPLE", secret: true }]));
    await screen.findByText("Finished.");
  });
});
