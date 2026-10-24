import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeoplePanel } from "../../src/people/PeoplePanel.jsx";

afterEach(cleanup);
const NOW = new Date("2026-10-09T12:00:00Z");
const now = () => NOW;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const presence = (o) => ({ entry: "L-1", type: "task.started", stage: "task", subject: "T-14", summary: "Started", via: "dana", at: ago(3 * 60_000), ...o });
const mk = (o) => ({ approves: [], agents: [], since: "L-1", ...o });
const dana = mk({ person: "dana", name: "Dana Lee", role: "owner", presence: presence({}) });
const eli = mk({ person: "eli", name: "Eli Kim", role: "helper", approves: ["plan", "test"], presence: presence({ stage: "plan", subject: "P-2 §3", via: "eli-agent", summary: "Edited clause", at: ago(2 * 3600_000) }) });
const vic = mk({ person: "vic", name: "Vic Roy", role: "viewer", presence: presence({ stage: "git", subject: "D-3", via: "vic", at: ago(3 * 86400_000), summary: "Old" }) });
const noone = mk({ person: "zed", name: "Zed", role: "viewer" });
const doc1 = { doc: "P-2", title: "Main plan", path: "plan.md", version: "P-2", clauses: Array.from({ length: 12 }, (_, i) => `§${i}`), kind: "plan", sharedBy: "dana", at: "2026-10-01T10:00:00Z", entry: "L-9" };
const doc2 = { doc: "D-1", title: "Notes", path: "notes.md", version: "v3", clauses: [], kind: "document", sharedBy: "ghost", at: "2026-10-02T10:00:00Z", entry: "L-10" };
const view = (members = [dana, eli, vic], docs = [doc1, doc2]) => ({ members, owner: members.find((m) => m.role === "owner"), docs });
const full = (extra = {}) => ({ view: view(), me: "dana", now, onAddMember: vi.fn(), onChangeRole: vi.fn(), onRemoveMember: vi.fn(), onSetPhoto: vi.fn(), onShareDoc: vi.fn(), onOpenDoc: vi.fn(), ...extra });

describe("members and presence", () => {
  it("renders rows, roles, You tag, approvals", () => {
    render(<PeoplePanel {...full()} />);
    const sec = screen.getByRole("region", { name: "People on this project" });
    expect(within(sec).getByText("Owner")).toBeTruthy();
    expect(within(sec).getByText("Helper")).toBeTruthy();
    expect(within(sec).getByText("Viewer")).toBeTruthy();
    expect(within(sec).getAllByText("You")).toHaveLength(1);
    expect(within(sec).getByText("Can approve: plan, test")).toBeTruthy();
  });
  it("presence lines incl via agent, idle and none", () => {
    const { container } = render(<PeoplePanel {...full({ view: view([dana, eli, vic, noone]) })} />);
    expect(screen.getByText("On T-14 · Task stage · 3 min ago — Started")).toBeTruthy();
    expect(screen.getByText(/On P-2 §3 · Plan stage · 2 h ago · via eli-agent — Edited clause/)).toBeTruthy();
    expect(screen.getByText("No activity yet")).toBeTruthy();
    const idle = container.querySelectorAll(".people-presence.is-idle");
    expect(idle).toHaveLength(1);
    expect(idle[0].textContent).toContain("3 d ago");
  });
  it("avatars: img with alt when photo, initials otherwise", () => {
    render(<PeoplePanel {...full({ photos: { dana: "data:image/png;base64,AAAA" } })} />);
    const img = screen.getAllByRole("img", { name: "Dana Lee" }).find((e) => e.tagName === "IMG");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    const ini = screen.getAllByRole("img", { name: "Eli Kim" })[0];
    expect(ini.tagName).toBe("SPAN");
    expect(ini.textContent).toBe("EK");
    expect(ini.firstChild.getAttribute("aria-hidden")).toBe("true");
  });
  it("stage strip groups by stage in STAGES order", () => {
    render(<PeoplePanel {...full({ view: view([dana, eli, vic, noone, mk({ person: "al", name: "Al B", role: "helper", presence: presence({}) })]) })} />);
    const strip = screen.getByLabelText("Where everyone is");
    const items = within(strip).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"));
    expect(items).toEqual(["Plan stage: Eli Kim", "Task stage: Dana Lee, Al B", "Git stage: Vic Roy"]);
  });
  it("no strip when nobody has presence", () => {
    render(<PeoplePanel {...full({ view: view([{ ...dana, presence: undefined }]) })} />);
    expect(screen.queryByLabelText("Where everyone is")).toBeNull();
  });
});

describe("owner controls", () => {
  it("owner sees controls", () => {
    render(<PeoplePanel {...full()} />);
    expect(screen.getByRole("form", { name: "Add helper" })).toBeTruthy();
    expect(screen.getByLabelText("Role for Eli Kim")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Vic Roy" })).toBeTruthy();
    expect(screen.queryByLabelText("Role for Dana Lee")).toBeNull();
    expect(screen.getByRole("form", { name: "Share a document" })).toBeTruthy();
  });
  it.each(["eli", "vic"])("%s does not see owner controls", (me) => {
    render(<PeoplePanel {...full({ me })} />);
    expect(screen.queryByRole("form", { name: "Add helper" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByLabelText(/Role for/)).toBeNull();
    expect(screen.queryByRole("form", { name: "Share a document" })).toBeNull();
  });
  it("controls hidden without callbacks", () => {
    render(<PeoplePanel view={view()} me="dana" now={now} />);
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryAllByRole("button").filter((b) => b.textContent !== "Profile")).toHaveLength(0);
  });
  it("add flow with slug suggestion", () => {
    const p = full(); render(<PeoplePanel {...p} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Maya Chen" } });
    expect(screen.getByLabelText("Person id").value).toBe("maya-chen");
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(p.onAddMember).toHaveBeenCalledWith({ person: "maya-chen", name: "Maya Chen", role: "viewer" });
  });
  it("manual id overrides suggestion", () => {
    const p = full(); render(<PeoplePanel {...p} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Maya" } });
    fireEvent.change(screen.getByLabelText("Person id"), { target: { value: "m2" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Maya C" } });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(p.onAddMember).toHaveBeenCalledWith({ person: "m2", name: "Maya C", role: "helper" });
  });
  it("refuses duplicate and invalid ids", () => {
    const p = full(); render(<PeoplePanel {...p} />);
    const btn = screen.getByRole("button", { name: "Add person" });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Eli" } });
    expect(screen.getByLabelText("Person id").value).toBe("eli");
    expect(btn.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/already/);
    fireEvent.change(screen.getByLabelText("Person id"), { target: { value: "Bad Id!" } });
    expect(btn.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/lowercase/);
    fireEvent.change(screen.getByLabelText("Person id"), { target: { value: "-x" } });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(p.onAddMember).not.toHaveBeenCalled();
  });
  it("change role", () => {
    const p = full(); render(<PeoplePanel {...p} />);
    fireEvent.change(screen.getByLabelText("Role for Eli Kim"), { target: { value: "viewer" } });
    expect(p.onChangeRole).toHaveBeenCalledWith("eli", "viewer");
  });
  it("two-step remove", () => {
    const p = full(); render(<PeoplePanel {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Eli Kim" }));
    expect(p.onRemoveMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    expect(p.onRemoveMember).toHaveBeenCalledWith("eli");
    expect(screen.queryByRole("button", { name: "Confirm remove" })).toBeNull();
  });
  it("cancel remove", () => {
    const p = full(); render(<PeoplePanel {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Eli Kim" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm remove" })).toBeNull();
    expect(p.onRemoveMember).not.toHaveBeenCalled();
  });
});

describe("photo", () => {
  const file = (size, type = "image/png") => { const f = new File(["x"], "a.png", { type }); Object.defineProperty(f, "size", { value: size }); return f; };
  it("only for me, with accept list", () => {
    render(<PeoplePanel {...full({ me: "eli" })} />);
    const inputs = screen.getAllByLabelText("Change photo");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].getAttribute("accept")).toBe("image/png,image/jpeg,image/webp,image/gif");
  });
  it("hidden without onSetPhoto", () => {
    render(<PeoplePanel {...full({ onSetPhoto: undefined })} />);
    expect(screen.queryByLabelText("Change photo")).toBeNull();
  });
  it("rejects too-large file", async () => {
    const p = full(); render(<PeoplePanel {...p} />);
    fireEvent.change(screen.getByLabelText("Change photo"), { target: { files: [file(512 * 1024 + 1)] } });
    expect((await screen.findByRole("alert")).textContent).toBe("Photos must be 512 KB or smaller");
    expect(p.onSetPhoto).not.toHaveBeenCalled();
  });
  it("passes ok file", async () => {
    const p = full(); render(<PeoplePanel {...p} />);
    const f = file(1000);
    fireEvent.change(screen.getByLabelText("Change photo"), { target: { files: [f] } });
    await waitFor(() => expect(p.onSetPhoto).toHaveBeenCalledWith(f));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("shows rejection message", async () => {
    const p = full({ onSetPhoto: vi.fn().mockRejectedValue(new Error("Disk full")) }); render(<PeoplePanel {...p} />);
    fireEvent.change(screen.getByLabelText("Change photo"), { target: { files: [file(10)] } });
    expect((await screen.findByRole("alert")).textContent).toBe("Disk full");
  });
});

describe("documents", () => {
  it("lists with versions, clauses, sharer and open callback", () => {
    const p = full(); render(<PeoplePanel {...p} />);
    const sec = screen.getByRole("region", { name: "Shared documents" });
    expect(within(sec).getByText("P-2")).toBeTruthy();
    expect(within(sec).getByText("v3")).toBeTruthy();
    expect(within(sec).getByText("Plan")).toBeTruthy();
    expect(within(sec).getByText("Document")).toBeTruthy();
    expect(within(sec).getByText("12 clauses")).toBeTruthy();
    expect(within(sec).getByText("Shared by Dana Lee on 2026-10-01")).toBeTruthy();
    expect(within(sec).getByText("Shared by ghost on 2026-10-02")).toBeTruthy();
    fireEvent.click(within(sec).getByRole("button", { name: "Main plan" }));
    expect(p.onOpenDoc).toHaveBeenCalledWith(doc1);
  });
  it("plain title without onOpenDoc", () => {
    render(<PeoplePanel {...full({ onOpenDoc: undefined })} />);
    expect(screen.queryByRole("button", { name: "Main plan" })).toBeNull();
    expect(screen.getByText("Main plan")).toBeTruthy();
  });
  it("visible to non-owners", () => {
    render(<PeoplePanel {...full({ me: "vic" })} />);
    expect(screen.getByText("Notes")).toBeTruthy();
  });
  it("share form", () => {
    const p = full(); render(<PeoplePanel {...p} />);
    const btn = screen.getByRole("button", { name: "Share document" });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Spec" } });
    fireEvent.change(screen.getByLabelText("Document path"), { target: { value: "docs/spec.md" } });
    fireEvent.click(btn);
    expect(p.onShareDoc).toHaveBeenCalledWith({ title: "Spec", path: "docs/spec.md" });
  });
  it("empty state", () => {
    render(<PeoplePanel {...full({ view: view([dana, eli], []) })} />);
    expect(screen.getByText("No documents shared yet")).toBeTruthy();
  });
});

describe("solo state", () => {
  it("shows message and add form defaulting to owner", () => {
    const p = full({ view: { members: [], docs: [] }, me: "dana" }); render(<PeoplePanel {...p} />);
    expect(screen.getByText("Just you for now. Add a helper to share this project.")).toBeTruthy();
    expect(screen.getByLabelText("Role").value).toBe("owner");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dana" } });
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(p.onAddMember).toHaveBeenCalledWith({ person: "dana", name: "Dana", role: "owner" });
  });
  it("no form without callback", () => {
    render(<PeoplePanel view={{ members: [], docs: [] }} me="dana" now={now} />);
    expect(screen.getByText(/Just you for now/)).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
  });
});
