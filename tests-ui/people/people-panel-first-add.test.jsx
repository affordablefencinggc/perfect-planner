import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PeoplePanel } from "../../src/people/PeoplePanel.jsx";
import { Ledger, MemoryStore } from "../../core/ledger/index";
import { addMember, claimOwnership, peopleView } from "../../core/people/index";

afterEach(cleanup);

/** A project whose owner key the app pinned for "looplet-spare", who has already written to it. */
function pinnedProject() {
  const store = new MemoryStore();
  const ownerKey = store.defaultKeys.createKey("person:looplet-spare").keyId;
  const ledger = Ledger.openSync(store, { ownerKey });
  ledger.append({ actor: { kind: "person", id: "looplet-spare" }, type: "question.asked", subject: "Q-1", summary: "First note" });
  return ledger;
}

/** Wires the panel's add to the people module the way the host does: the first add claims, later adds enrol. */
function hostAdd(ledger) {
  return async ({ person, name, role }) => {
    if (peopleView(ledger).members.length === 0) claimOwnership(ledger, { kind: "person", id: person }, name);
    else addMember(ledger, { kind: "person", id: peopleView(ledger).owner.person }, { person, name, role });
  };
}

it("the first add through the panel claims the project as its pinned owner, whatever name is typed", async () => {
  const ledger = pinnedProject();
  const onAddMember = hostAdd(ledger);
  const { rerender } = render(<PeoplePanel view={peopleView(ledger)} me="looplet-spare" starter="looplet-spare" onAddMember={onAddMember} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Daniel Somebody" } });
  expect(screen.getByLabelText("Person id").value).toBe("looplet-spare");
  fireEvent.click(screen.getByRole("button", { name: "Add person" }));
  await screen.findByLabelText("Name");
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByRole("alert")).toBeNull();
  const view = peopleView(ledger);
  expect(view.owner?.person).toBe("looplet-spare");
  expect(view.owner?.name).toBe("Daniel Somebody");

  rerender(<PeoplePanel view={view} me="looplet-spare" starter="looplet-spare" onAddMember={onAddMember} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mia Helper" } });
  fireEvent.click(screen.getByRole("button", { name: "Add person" }));
  await new Promise((r) => setTimeout(r, 0));
  expect(peopleView(ledger).members.map((m) => [m.person, m.role])).toEqual([["looplet-spare", "owner"], ["mia-helper", "helper"]]);
});

it("without the starter id, the slug of a typed name is refused by the pinned owner rule and the panel says so", async () => {
  const ledger = pinnedProject();
  render(<PeoplePanel view={peopleView(ledger)} me="looplet-spare" onAddMember={hostAdd(ledger)} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Daniel Somebody" } });
  fireEvent.click(screen.getByRole("button", { name: "Add person" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/looplet-spare owns this project/);
  expect(peopleView(ledger).members).toEqual([]);
});
