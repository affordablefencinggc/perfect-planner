import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PeoplePanel } from "../../src/people/PeoplePanel.jsx";

afterEach(cleanup);

// Regression: the first-run form starts on "owner"; once an owner exists, the next add must not still send "owner".
it("adds the second person as a helper, not a second owner", async () => {
  const onAddMember = vi.fn(async () => {});
  const empty = { view: { members: [], owner: null, docs: [] }, me: "owner", now: () => new Date(), onAddMember };
  const { rerender } = render(<PeoplePanel {...empty} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Riley Owner" } });
  fireEvent.click(screen.getByRole("button", { name: "Add person" }));
  await vi.waitFor(() => expect(onAddMember).toHaveBeenCalledTimes(1));
  expect(onAddMember.mock.calls[0][0].role).toBe("owner");

  const riley = { person: "riley-owner", name: "Riley Owner", role: "owner", approves: [], agents: [], since: "L-1" };
  rerender(<PeoplePanel {...empty} view={{ members: [riley], owner: riley, docs: [] }} me="riley-owner" />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sam Helper" } });
  expect(screen.getByLabelText("Role").value).toBe("helper");
  fireEvent.click(screen.getByRole("button", { name: "Add person" }));
  await vi.waitFor(() => expect(onAddMember).toHaveBeenCalledTimes(2));
  expect(onAddMember.mock.calls[1][0]).toMatchObject({ person: "sam-helper", role: "helper" });
});

// The host only accepts the project's pinned owner as the first person (OWNER_IS_PINNED otherwise),
// so the first add uses that id, whatever name is typed.
it("adds the first person under the project's pinned owner id", async () => {
  const onAddMember = vi.fn(async () => {});
  render(<PeoplePanel view={{ members: [], owner: null, docs: [] }} me="owner" starter="owner" now={() => new Date()} onAddMember={onAddMember} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dana Lee" } });
  expect(screen.getByLabelText("Person id").value).toBe("owner");
  expect(screen.getByLabelText("Person id").readOnly).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Add person" }));
  await vi.waitFor(() => expect(onAddMember).toHaveBeenCalledTimes(1));
  expect(onAddMember.mock.calls[0][0]).toMatchObject({ person: "owner", name: "Dana Lee", role: "owner" });
});
