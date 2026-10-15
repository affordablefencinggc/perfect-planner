import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenshotViewingPanel } from "../src/components/ScreenshotViewingPanel.jsx";

afterEach(cleanup);
describe("ScreenshotViewingPanel", () => {
  it("emits only a named explicit decision and never renders the challenge token", async () => {
    const onAttest = vi.fn(); const challenge = { challengeId: "CH-1", token: "secret-" + "challenge-token", requestedViewer: "danie" };
    const { container } = render(<ScreenshotViewingPanel record={{ viewingStatus: "UNVIEWED" }} challenge={challenge} onAttest={onAttest} />);
    expect(container.textContent).not.toContain(challenge.token); const submit = screen.getByRole("button", { name: /record viewing/i }); expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Viewer name"), { target: { value: "danie" } }); fireEvent.change(screen.getByLabelText("Concrete observation"), { target: { value: "The release gate is visibly disabled." } }); fireEvent.click(screen.getByLabelText("I viewed this exact screenshot")); expect(submit.disabled).toBe(false); fireEvent.click(submit);
    expect(onAttest).toHaveBeenCalledWith({ challengeId: "CH-1", token: challenge.token, actor: "danie", explicitGesture: true, observation: "The release gate is visibly disabled." });
  });
  const fill = (name = "danie") => {
    fireEvent.change(screen.getByLabelText("Viewer name"), { target: { value: name } });
    fireEvent.change(screen.getByLabelText("Concrete observation"), { target: { value: "The release gate is visibly disabled." } });
    fireEvent.click(screen.getByLabelText("I viewed this exact screenshot"));
  };
  const challenge = { challengeId: "CH-1", token: "secret-challenge-token", requestedViewer: "danie" };
  it("a refused attestation is shown as an alert, keeps the form, and allows a retry", async () => {
    const onAttest = vi.fn().mockRejectedValueOnce(new Error("CHALLENGE_EXPIRED")).mockResolvedValueOnce(undefined);
    render(<ScreenshotViewingPanel record={{ viewingStatus: "UNVIEWED" }} challenge={challenge} onAttest={onAttest} />);
    fill(); fireEvent.click(screen.getByRole("button", { name: /record viewing/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not recorded.*still UNVIEWED/);
    expect(screen.getByRole("alert").textContent).not.toContain(challenge.token);
    fireEvent.click(screen.getByRole("button", { name: /record viewing/i }));
    expect(await screen.findByText("Viewing decision submitted")).toBeTruthy();
    expect(onAttest).toHaveBeenCalledTimes(2);
  });
  it("locks after a successful submission and ignores a double submit", async () => {
    let resolve; const onAttest = vi.fn(() => new Promise((done) => { resolve = done; }));
    const { container } = render(<ScreenshotViewingPanel record={{ viewingStatus: "UNVIEWED" }} challenge={challenge} onAttest={onAttest} />);
    fill(); const form = container.querySelector("form");
    fireEvent.submit(form); fireEvent.submit(form);
    expect(onAttest).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(screen.queryByRole("button", { name: /record viewing/i })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/counts as viewed only once the evidence record shows VIEWED/);
  });
  it("explains a name that does not match the requested viewer", () => {
    render(<ScreenshotViewingPanel record={{ viewingStatus: "UNVIEWED" }} challenge={challenge} onAttest={vi.fn()} />);
    fill("Danie");
    expect(screen.getByText(/Enter that name exactly/)).toBeTruthy();
    expect(screen.getByLabelText("Viewer name").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("button", { name: /record viewing/i }).disabled).toBe(true);
  });
  it("an already viewed record says so without the no-challenge warning", () => {
    render(<ScreenshotViewingPanel record={{ viewingStatus: "VIEWED" }} challenge={null} />);
    expect(screen.getByText("Viewing attested")).toBeTruthy();
    expect(screen.queryByText(/without a current durable challenge/)).toBeNull();
  });
  it("cannot invent an attestation without a current durable challenge", () => { const onAttest = vi.fn(); render(<ScreenshotViewingPanel record={{ viewingStatus: "UNVIEWED" }} challenge={null} onAttest={onAttest} />); expect(screen.queryByRole("button")).toBeNull(); expect(onAttest).not.toHaveBeenCalled(); });
});
