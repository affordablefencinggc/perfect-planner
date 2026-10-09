import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// An in-memory native journal with real compare-and-swap, so double sends and refusals behave like the real one.
const { journal } = vi.hoisted(() => ({ journal: { state: null, calls: [], gate: null, failNext: null } }));
vi.mock("../src/native/collisionAuthority.js", async () => {
  const { appendLedgerEntry } = await import("../src/engine/collisionEngine.js");
  const snapshot = (planId, censusDigest) => {
    const state = journal.state ??= { planId, censusDigest, ledger: [], approvedIds: [] };
    return { schemaVersion: 1, planId, censusDigest, authority: "native-journal", authoritative: true, revision: state.ledger.length, headHash: state.ledger.at(-1)?.hash ?? "GENESIS", approvedIds: [...state.approvedIds], ledger: [...state.ledger] };
  };
  const write = async (method, request, type, payload) => {
    journal.calls.push(method);
    if (journal.gate) await journal.gate;
    if (journal.failNext) { const reason = journal.failNext; journal.failNext = null; throw new Error(reason); }
    const state = journal.state ??= { planId: request.planId, censusDigest: request.censusDigest, ledger: [], approvedIds: [] };
    if (request.expectedRevision !== state.ledger.length) throw new Error("compare-and-swap failed");
    state.ledger = await appendLedgerEntry(state.ledger, type, payload, { actor: "native-authority", timestamp: `2026-10-09T00:00:${String(state.ledger.length).padStart(2, "0")}.000Z` });
    return snapshot(request.planId, request.censusDigest);
  };
  return { createNativeCollisionAuthorityAdapter: () => ({
    inspect: async (request) => { journal.calls.push("inspect"); return snapshot(request.planId, request.censusDigest); },
    approve: async (request) => {
      const result = await write("approve", request, "collision.order-approved", { collisionId: request.collision.id, censusDigest: request.censusDigest });
      journal.state.approvedIds.push(request.collision.id);
      return { ...result, approvedIds: [...journal.state.approvedIds] };
    },
    commit: (request) => write("commit", request, "collision.assessment-committed", { censusDigest: request.censusDigest, ...request.assessment }),
  }) };
});

import { CollisionWorkspace } from "../src/components/CollisionWorkspace.jsx";

beforeEach(() => { journal.state = null; journal.calls = []; journal.gate = null; journal.failNext = null; });
afterEach(cleanup);

const cards = () => screen.getAllByRole("button", { name: /Request approval|Recorded by authority|Requesting…/ });

test("a double click sends one approval, and the card shows the recorded order", async () => {
  const onToast = vi.fn();
  render(<CollisionWorkspace onGateChange={vi.fn()} onToast={onToast} />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Request approval" }).length).toBeGreaterThan(0));
  let release; journal.gate = new Promise((resolve) => { release = resolve; });
  const first = cards()[0];
  act(() => { first.click(); first.click(); });
  await waitFor(() => expect(first.textContent).toContain("Requesting…"));
  expect(screen.getAllByRole("button", { name: "Request approval" }).every((button) => button.disabled)).toBe(true);
  journal.gate = null; await act(async () => release());
  await waitFor(() => expect(first.textContent).toContain("Recorded by authority"));
  expect(journal.calls.filter((call) => call === "approve")).toHaveLength(1);
  expect(screen.queryByText(/Authority rejected/)).toBeNull();
});

test("a refused write keeps what the authority already recorded, says why and re-reads", async () => {
  const onToast = vi.fn(), onGateChange = vi.fn();
  const user = userEvent.setup();
  render(<CollisionWorkspace onGateChange={onGateChange} onToast={onToast} />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Request approval" }).length).toBeGreaterThan(1));
  await user.click(cards()[0]);
  await waitFor(() => expect(cards()[0].textContent).toContain("Recorded by authority"));
  const inspects = journal.calls.filter((call) => call === "inspect").length;
  journal.failNext = "compare-and-swap failed";
  await user.click(screen.getAllByRole("button", { name: "Request approval" })[0]);
  await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/^Not recorded: Authority rejected: compare-and-swap failed/)));
  await waitFor(() => expect(journal.calls.filter((call) => call === "inspect").length).toBe(inspects + 1));
  expect(cards()[0].textContent).toContain("Recorded by authority");
  expect(screen.queryByText("authority unavailable")).toBeNull();
  expect(onGateChange.mock.calls.at(-1)[0]).toMatchObject({ authorityAvailable: true });
});

test("commit runs once and then reads as committed instead of staying clickable", async () => {
  const onToast = vi.fn();
  const user = userEvent.setup();
  render(<CollisionWorkspace onGateChange={vi.fn()} onToast={onToast} />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Request approval" }).length).toBeGreaterThan(0));
  while (screen.queryAllByRole("button", { name: "Request approval" }).length) {
    const before = journal.calls.length;
    await user.click(screen.getAllByRole("button", { name: "Request approval" })[0]);
    await waitFor(() => expect(journal.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Requesting…" })).toHaveLength(0));
  }
  const commit = await screen.findByRole("button", { name: /Commit assessment/ });
  await waitFor(() => expect(commit.disabled).toBe(false));
  await user.click(commit);
  const done = await screen.findByRole("button", { name: /Assessment committed/ });
  expect(done.disabled).toBe(true);
  expect(journal.calls.filter((call) => call === "commit")).toHaveLength(1);
  expect(onToast).toHaveBeenCalledWith("Collision assessment committed by native authority.");
  expect(within(screen.getByRole("note")).getByText(/Demo journal:/)).toBeTruthy();
});
