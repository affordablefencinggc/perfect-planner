import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore, Ledger, MemoryKeyProvider, MemoryStore, type Actor } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import {
  boardFromLedger,
  confirmMvp,
  installMvpRules,
  featuresIn,
  missingDependencies,
  moveFeature,
  mvpDoneWhen,
  recordProposal,
  renameStage,
  setJourney,
  stageOf,
} from "./board";
import { MvpError, type Journey, type MvpProposal, type ScannedFeature } from "./types";

const person: Actor = { kind: "person", id: "owner" };
const jev: Actor = { kind: "jev", id: "jev", model: "mock" };
const agent: Actor = { kind: "agent", id: "claude-code", model: "x" };
const gate: Actor = { kind: "system", id: "gate" };

const journey: Journey = { name: "Import and sign off", steps: ["Import", "Sign off"], test: "npm run test:e2e", features: ["a"] };
const proposal: MvpProposal = {
  by: jev,
  journey,
  summary: "1 of 3 in the MVP",
  placements: [
    { feature: "a", stage: "mvp", reason: "" },
    { feature: "b", stage: "beta", reason: "Nice to have" },
    { feature: "c", stage: "v1", reason: "Needs b" },
  ],
};

function open(): Ledger {
  return Ledger.openSync(new MemoryStore());
}
function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof MvpError) return e.code;
    throw e;
  }
  return "none";
}
function feat(id: string, status: ScannedFeature["status"], dependsOn: string[] = []): ScannedFeature {
  return { id, name: `Feature ${id}`, dependsOn, userFacing: true, status, evidence: [], findings: [] };
}

describe("board replay", () => {
  it("defaults before any entry", () => {
    const b = boardFromLedger([]);
    expect(b.stages.map((s) => [s.id, s.name, s.order])).toEqual([["mvp", "MVP", 0], ["beta", "Beta", 1], ["v1", "v1", 2], ["scale", "Scale", 3]]);
    expect(b.confirmed).toBe(false);
  });

  it("round-trips a proposal and ignores unrelated decisions", () => {
    const l = open();
    l.append({ actor: person, type: "decision.made", subject: "D-1", summary: "Other", reason: "because", data: { x: 1 } });
    const e = recordProposal(l, proposal);
    expect(e.subject).toBe("D-2");
    const b = boardFromLedger(l.entries());
    expect(b.placements).toEqual(proposal.placements);
    expect(b.journey).toEqual(journey);
    expect(b.proposalEntry).toBe(e.n);
    expect(stageOf(b, "b")).toBe("beta");
    expect(featuresIn(b, "mvp")).toEqual(["a"]);
  });

  it("rejects non-mvp placements without a one-line reason", () => {
    const l = open();
    for (const reason of ["", "  ", "TBD", "tbd", "-", "two\nlines", "x".repeat(201)]) {
      const p = { ...proposal, placements: [{ feature: "b", stage: "beta" as const, reason }] };
      expect(code(() => recordProposal(l, p))).toBe("REASON_REQUIRED");
    }
    expect(l.entries()).toHaveLength(0);
  });

  it("a later proposal replaces the board and clears confirmation", () => {
    const l = open();
    recordProposal(l, proposal);
    confirmMvp(l, person);
    recordProposal(l, { ...proposal, placements: [{ feature: "z", stage: "mvp", reason: "" }] });
    const b = boardFromLedger(l.entries());
    expect(b.confirmed).toBe(false);
    expect(b.placements.map((p) => p.feature)).toEqual(["z"]);
  });
});

describe("moveFeature", () => {
  it("needs a proposal, a known feature and stage", () => {
    const l = open();
    expect(code(() => moveFeature(l, person, "a", "beta", "later"))).toBe("NO_PROPOSAL");
    recordProposal(l, proposal);
    expect(code(() => moveFeature(l, person, "nope", "beta", "later"))).toBe("UNKNOWN_FEATURE");
    expect(code(() => moveFeature(l, person, "a", "bogus" as never, "later"))).toBe("UNKNOWN_STAGE");
  });

  it("requires a one-line reason to leave the MVP or go to a later stage", () => {
    const l = open();
    recordProposal(l, proposal);
    for (const reason of ["", "TBD", "-", "a\nb", "y".repeat(201)]) {
      expect(code(() => moveFeature(l, person, "a", "beta", reason))).toBe("REASON_REQUIRED");
      expect(code(() => moveFeature(l, person, "b", "v1", reason))).toBe("REASON_REQUIRED");
    }
    moveFeature(l, person, "a", "beta", "  Too big for now  ");
    const b = boardFromLedger(l.entries());
    expect(stageOf(b, "a")).toBe("beta");
    expect(b.placements.find((p) => p.feature === "a")!.reason).toBe("Too big for now");
  });

  it("allows moving into the MVP without a reason", () => {
    const l = open();
    recordProposal(l, proposal);
    const e = moveFeature(l, person, "b", "mvp", "");
    expect(e.reason).toBe("Moved into the MVP");
    expect(stageOf(boardFromLedger(l.entries()), "b")).toBe("mvp");
  });

  it("un-confirms the board", () => {
    const l = open();
    recordProposal(l, proposal);
    confirmMvp(l, person);
    expect(boardFromLedger(l.entries()).confirmed).toBe(true);
    moveFeature(l, person, "b", "mvp", "");
    expect(boardFromLedger(l.entries()).confirmed).toBe(false);
  });

  it("lists MVP features with dependencies outside the MVP", () => {
    const l = open();
    recordProposal(l, proposal);
    moveFeature(l, person, "c", "mvp", "");
    const b = boardFromLedger(l.entries());
    const fs = [feat("a", "done"), feat("b", "done"), feat("c", "done", ["b", "a"])];
    expect(missingDependencies(b, fs)).toEqual([{ feature: "c", missing: ["b"] }]);
  });
});

describe("renameStage", () => {
  it("renames, trims and enforces uniqueness and length", () => {
    const l = open();
    renameStage(l, person, "mvp", "  Pilot ");
    expect(boardFromLedger(l.entries()).stages[0]!.name).toBe("Pilot");
    expect(code(() => renameStage(l, person, "beta", "pilot"))).toBe("BAD_NAME");
    expect(code(() => renameStage(l, person, "beta", "  "))).toBe("BAD_NAME");
    expect(code(() => renameStage(l, person, "beta", "a\nb"))).toBe("BAD_NAME");
    expect(code(() => renameStage(l, person, "beta", "z".repeat(41)))).toBe("BAD_NAME");
    renameStage(l, person, "mvp", "PILOT");
    expect(code(() => renameStage(l, person, "bogus" as never, "Q"))).toBe("UNKNOWN_STAGE");
  });

  it("survives a later proposal", () => {
    const l = open();
    renameStage(l, person, "mvp", "Pilot");
    recordProposal(l, proposal);
    expect(boardFromLedger(l.entries()).stages[0]!.name).toBe("Pilot");
  });
});

describe("confirmMvp", () => {
  it("needs a person and a proposal", () => {
    const l = open();
    expect(code(() => confirmMvp(l, person))).toBe("NO_PROPOSAL");
    recordProposal(l, proposal);
    expect(code(() => confirmMvp(l, agent))).toBe("NOT_A_PERSON");
    expect(code(() => confirmMvp(l, jev))).toBe("NOT_A_PERSON");
    confirmMvp(l, person, "Looks right");
    const b = boardFromLedger(l.entries());
    expect(b.confirmed).toBe(true);
    expect(b.confirmedBy).toBe("owner");
  });

  it("ignores a confirm entry written straight to the ledger by the system, and the ledger refuses one from an agent", () => {
    const l = open();
    recordProposal(l, proposal);
    expect(() => appendNumbered(l, {
      actor: agent, type: "decision.made", summary: "Confirmed the MVP line",
      reason: "Forged", evidence: [], refs: [], data: { mvp: { kind: "confirm" } },
    })).toThrow();
    appendNumbered(l, {
      actor: gate, type: "decision.made", summary: "Confirmed the MVP line",
      reason: "Forged", evidence: [], refs: [], data: { mvp: { kind: "confirm", confirmedBy: "owner", note: "forged" } },
    });
    const b = boardFromLedger(l.entries());
    expect(b.confirmed).toBe(false);
    expect(b.confirmedBy).toBeUndefined();
  });

  it("names the confirming person from the entry's actor, never from the payload", () => {
    const l = open();
    recordProposal(l, proposal);
    appendNumbered(l, {
      actor: person, type: "decision.made", summary: "Confirmed the MVP line",
      reason: "Confirmed", evidence: [], refs: [], data: { mvp: { kind: "confirm", confirmedBy: "someone-else" } },
    });
    expect(boardFromLedger(l.entries()).confirmedBy).toBe("owner");
  });

  it("installMvpRules refuses a non-person confirm at write time", () => {
    const l = open();
    installMvpRules(l);
    recordProposal(l, proposal);
    const forge = () => appendNumbered(l, {
      actor: gate, type: "decision.made", summary: "Confirmed the MVP line",
      reason: "Forged", evidence: [], refs: [], data: { mvp: { kind: "confirm" } },
    });
    expect(forge).toThrow(/Only a person can confirm/);
    confirmMvp(l, person);
    expect(boardFromLedger(l.entries()).confirmed).toBe(true);
  });
});

describe("setJourney", () => {
  it("replaces the journey and pulls its features into the MVP", () => {
    const l = open();
    recordProposal(l, proposal);
    const e = setJourney(l, person, { ...journey, name: "New", features: ["b", "c", "a"] });
    expect((e.data!.mvp as { moved: string[] }).moved).toEqual(["b", "c"]);
    const b = boardFromLedger(l.entries());
    expect(b.journey!.name).toBe("New");
    expect(featuresIn(b, "mvp").sort()).toEqual(["a", "b", "c"]);
    expect(code(() => setJourney(l, person, { ...journey, test: " " }))).toBe("REASON_REQUIRED");
  });
});

describe("mvpDoneWhen", () => {
  const fs = [feat("a", "done")];
  function ready(): Ledger {
    const l = open();
    recordProposal(l, proposal);
    confirmMvp(l, person);
    return l;
  }
  const run = (l: Ledger, fx = fs) => mvpDoneWhen(boardFromLedger(l.entries()), l.entries(), fx);

  it("blocks on every missing piece", () => {
    const l = open();
    expect(run(l).blocking).toContain("MVP line not confirmed");
    recordProposal(l, proposal);
    const r = run(l, [feat("a", "partial")]);
    expect(r.done).toBe(false);
    expect(r.blocking).toEqual([
      "MVP line not confirmed",
      "Journey test has not passed yet: npm run test:e2e",
      "a Feature a is partial",
    ]);
  });

  it("is done only when confirmed, journey passed and all MVP features done", () => {
    const l = ready();
    l.append({ actor: gate, type: "test.passed", subject: "T-1", summary: "ok", data: { test: "npm run test:e2e" } });
    const r = run(l);
    expect(r).toEqual({ done: true, journeyPassed: true, blocking: [] });
  });

  it("uses the latest run of the journey test", () => {
    const l = ready();
    l.append({ actor: gate, type: "test.passed", subject: "T-1", summary: "ok", data: { test: "npm run test:e2e" } });
    l.append({ actor: gate, type: "test.passed", subject: "T-1", summary: "other", data: { test: "npm test" } });
    expect(run(l).journeyPassed).toBe(true);
    l.append({ actor: gate, type: "test.failed", subject: "T-1", summary: "bad", data: { test: "npm run test:e2e" } });
    const r = run(l);
    expect(r.journeyPassed).toBe(false);
    expect(r.done).toBe(false);
  });

  it("is blocked by a move after confirmation, a missing feature, and no journey", () => {
    const l = ready();
    l.append({ actor: gate, type: "test.passed", subject: "T-1", summary: "ok", data: { test: "npm run test:e2e" } });
    expect(run(l, []).blocking).toEqual(["a was not found in the scan"]);
    moveFeature(l, person, "b", "mvp", "");
    expect(run(l, [feat("a", "done"), feat("b", "missing")]).blocking).toEqual(["MVP line not confirmed", "b Feature b is missing"]);
    expect(mvpDoneWhen(boardFromLedger([]), [], []).blocking).toContain("No journey has been set");
  });
});

describe("restart", () => {
  it("replays the same board from a re-opened FileStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-board-"));
    try {
      const keys = new MemoryKeyProvider();
      const first = Ledger.openSync(new FileStore(dir), { keys });
      recordProposal(first, proposal);
      renameStage(first, person, "mvp", "Pilot");
      moveFeature(first, person, "a", "beta", "Not needed yet");
      moveFeature(first, person, "a", "mvp", "");
      confirmMvp(first, person);
      const before = boardFromLedger(first.entries());
      first.close();
      const second = Ledger.openSync(new FileStore(dir), { readOnly: true, keys });
      expect(boardFromLedger(second.entries())).toEqual(before);
      expect(before.confirmed).toBe(true);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
