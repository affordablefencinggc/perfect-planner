import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("cannot invent an attestation without a current durable challenge", () => { const onAttest = vi.fn(); render(<ScreenshotViewingPanel record={{ viewingStatus: "UNVIEWED" }} challenge={null} onAttest={onAttest} />); expect(screen.queryByRole("button")).toBeNull(); expect(onAttest).not.toHaveBeenCalled(); });
});
