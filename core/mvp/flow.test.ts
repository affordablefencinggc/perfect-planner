// The whole MVP-first flow, run against this very repository.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore, type Actor } from "../ledger/index";
import {
  MockJev, boardFromLedger, boardReport, confirmMvp, featuresIn, moveFeature, mvpDoneWhen,
  renameStage, scanReport, MVP_STAGER, stageExistingProject, stageNewProject, stageOf, MvpError,
} from "./index";

const root = fileURLToPath(new URL("../..", import.meta.url));
const person: Actor = { kind: "person", id: "looplet-spare" };
const agent: Actor = { kind: "agent", id: "claude-code", model: "claude-test" };

describe("MVP-first stages on this repository", () => {
  it("scans, proposes, moves with a reason, confirms and tracks done-when", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    const { scan, proposal } = await stageExistingProject(ledger, new MockJev(), {
      root,
      goal: "Import an existing project, plan it and sign it off",
    });

    expect(scan.source).toMatch(/^registry:/);
    expect(scan.features.length).toBeGreaterThanOrEqual(40);
    // The repo's own end-to-end journey (C057) anchors the MVP.
    expect(proposal.journey.features).toContain("C057");
    // Jev may not write decisions, so the stager records its proposal and names it.
    const recorded = ledger.entries()[0];
    expect(recorded.actor).toEqual(MVP_STAGER);
    expect((recorded.data?.mvp as { proposedBy: unknown }).proposedBy).toEqual(new MockJev().actor);
    let board = boardFromLedger(ledger.entries());
    expect(stageOf(board, "C057")).toBe("mvp");
    expect(board.placements).toHaveLength(scan.features.length);

    // Moving a feature out of the MVP needs a one-line reason.
    const outsider = featuresIn(board, "mvp").find((id) => !proposal.journey.features.includes(id) && id !== "C057");
    const mvpFeature = outsider ?? featuresIn(board, "mvp")[0];
    expect(() => moveFeature(ledger, person, mvpFeature, "beta", "")).toThrow(MvpError);
    expect(() => moveFeature(ledger, person, mvpFeature, "beta", "TBD")).toThrow(MvpError);
    moveFeature(ledger, person, mvpFeature, "beta", "Can wait until after the first user journey");
    // ...and back in, no reason needed.
    moveFeature(ledger, person, mvpFeature, "mvp", "");

    renameStage(ledger, person, "mvp", "Pilot");
    expect(() => confirmMvp(ledger, agent)).toThrow(MvpError);
    confirmMvp(ledger, person, "Looks right");

    board = boardFromLedger(ledger.entries());
    expect(board.confirmed).toBe(true);
    expect(board.stages.find((s) => s.id === "mvp")?.name).toBe("Pilot");

    // Not done until the one journey test passes.
    let done = mvpDoneWhen(board, ledger.entries(), scan.features);
    expect(done.journeyPassed).toBe(false);
    expect(done.done).toBe(false);
    expect(done.blocking.join("\n")).toContain(proposal.journey.test);

    ledger.append({ actor: { kind: "system", id: "gate" }, type: "test.passed", subject: "MVP", summary: "Journey passed", evidence: [], refs: [], data: { test: proposal.journey.test } });
    done = mvpDoneWhen(boardFromLedger(ledger.entries()), ledger.entries(), scan.features);
    expect(done.journeyPassed).toBe(true);
    const notDone = scan.features.filter((f) => featuresIn(board, "mvp").includes(f.id) && f.status !== "done");
    expect(done.done).toBe(notDone.length === 0);

    expect(scanReport(scan)).toContain("| C057 |");
    expect(boardReport(board, scan.features)).toContain("## Pilot");
  });

  it("proposes an MVP for a brand-new project with reasons for everything left out", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    const { proposal } = await stageNewProject(ledger, new MockJev(), {
      goal: "Plan a project and track tasks to done",
      features: [
        { id: "plan", name: "Plan editor", dependsOn: ["store"], userFacing: true },
        { id: "tasks", name: "Task board to track tasks", dependsOn: ["store"], userFacing: true },
        { id: "store", name: "Local project store", dependsOn: [], userFacing: false },
        { id: "share", name: "Share with a team", dependsOn: ["plan"], userFacing: true },
        { id: "perf", name: "Performance budget gate", dependsOn: [], userFacing: false },
      ],
    });
    const board = boardFromLedger(ledger.entries());
    expect(stageOf(board, "store")).toBe("mvp");
    for (const p of proposal.placements.filter((x) => x.stage !== "mvp")) expect(p.reason.trim().length).toBeGreaterThan(0);
  });
});
