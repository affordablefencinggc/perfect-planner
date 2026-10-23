// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PersonProfile } from "../../src/people/PersonProfile.jsx";
import { nextFreeSlot, statsFromTasks } from "../../src/people/profileStats.js";

describe("profile stats", () => {
  it("counts finished, open and failed work for a person and their agents", () => {
    const tasks = [
      { id: "T-1", owner: "mira", status: "done" },
      { id: "T-2", owner: "claude-code", status: "claimed", check: { passed: false } },
      { id: "T-3", owner: "jon", status: "claimed" },
    ];
    const s = statsFromTasks({ person: "mira", agents: ["claude-code"] }, tasks);
    expect(s).toMatchObject({ finished: 1, open: 1, errors: 1, total: 2 });
  });
  it("skips weekends and booked days for the next free slot", () => {
    expect(nextFreeSlot(["2026-10-23"], "2026-10-23")).toBe("2026-10-26");
    expect(nextFreeSlot(["2026-10-26"], "2026-10-26")).toBe("2026-10-27");
  });
});

const profile = (over = {}) => ({ person: "mira", name: "Mira", role: "Backend lead", today: "2026-10-23", stats: { finished: 2, open: 0, errors: 0, total: 2, openTasks: [] }, ...over });

import { afterEach } from "vitest";
afterEach(cleanup);
describe("PersonProfile", () => {
  it("labels sample data and allocates to the next free slot", () => {
    render(<PersonProfile profile={profile({ sample: true })} onClose={() => {}} />);
    expect(screen.getByRole("note").textContent).toMatch(/Sample data/);
    fireEvent.change(screen.getByLabelText("Work"), { target: { value: "Export API" } });
    fireEvent.click(screen.getByLabelText(/Next free slot/));
    fireEvent.click(screen.getByRole("button", { name: "Allocate to Mira" }));
    expect(screen.getByText("2026-10-23")).toBeTruthy();
  });
  it("does not offer allocation when it is not connected", () => {
    render(<PersonProfile profile={profile()} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /Allocate to/ })).toBeNull();
  });
  it("rejects non-https links and non-markdown files", async () => {
    render(<PersonProfile profile={profile()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Reference link"), { target: { value: "http://x.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/https/);
  });
  it("assigns an existing unowned task through onAssign", async () => {
    const onAssign = vi.fn().mockResolvedValue({});
    render(<PersonProfile profile={profile({ assignable: [{ id: "T-4", label: "Export CSV" }] })} onAssign={onAssign} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "T-4" } });
    fireEvent.click(screen.getByRole("button", { name: "Allocate to Mira" }));
    await Promise.resolve();
    expect(onAssign).toHaveBeenCalledWith({ person: "mira", task: "T-4" });
  });
  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<PersonProfile profile={profile()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
