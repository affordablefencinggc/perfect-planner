import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore } from "../ledger/index";
import { cutRelease, installNumberingRules, releases } from "../numbering/index";
import { RollbackError, oneClickRollback, rollbackCandidates } from "./rollback";

const owner = { kind: "person" as const, id: "owner" };
const agent = { kind: "agent" as const, id: "claude-code", model: "m1" };
const system = { kind: "system" as const, id: "gate" };

function withReleases(count: number): Ledger {
  const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T00:00:00Z") });
  installNumberingRules(ledger);
  for (let i = 1; i <= count; i++) {
    ledger.append({ actor: system, type: "task.created", subject: `T-${i}`, summary: `work ${i}`, evidence: [], refs: [] });
    cutRelease(ledger, owner, { commit: `c0ffee${i}` });
  }
  return ledger;
}

describe("one-click rollback", () => {
  it("lists earlier releases newest first, defaulting to the one live before", () => {
    const ledger = withReleases(3);
    const candidates = rollbackCandidates(ledger.entries());
    expect(candidates.map((c) => c.release)).toEqual(["R-2", "R-1"]);
    expect(candidates[0].isDefault).toBe(true);
    expect(candidates[0].stamp).toMatch(/^R-2 · v1\.0\.1 · L-\d{6} · c0ffee2$/);
  });

  it("deploys first, then writes a new release with the next R number", async () => {
    const ledger = withReleases(2);
    const deployed: string[] = [];
    const result = await oneClickRollback(ledger, owner, { reason: "R-2 broke sending", deploy: async ({ commit }) => void deployed.push(commit) });
    expect(deployed).toEqual(["c0ffee1"]);
    expect(result.entry.type).toBe("release.rollback");
    expect(result.entry.subject).toBe("R-3");
    expect(result.entry.data).toMatchObject({ restores: "R-1", commit: "c0ffee1", version: "v1.0.2" });
    expect(result.stamp.startsWith("R-3 · v1.0.2")).toBe(true);
    expect(releases(ledger.entries()).map((r) => r.release)).toEqual(["R-1", "R-2", "R-3"]);
  });

  it("can restore an older named release", async () => {
    const ledger = withReleases(3);
    const result = await oneClickRollback(ledger, owner, { reason: "back to the first", to: "R-1" });
    expect(result.restored.release).toBe("R-1");
  });

  it("writes nothing when the deploy fails", async () => {
    const ledger = withReleases(2);
    const before = ledger.entries().length;
    await expect(
      oneClickRollback(ledger, owner, { reason: "bad", deploy: async () => { throw new Error("host down"); } }),
    ).rejects.toMatchObject({ code: "DEPLOY_FAILED" });
    expect(ledger.entries().length).toBe(before);
  });

  it("refuses agents, unknown releases, the current release and an empty history", async () => {
    await expect(oneClickRollback(withReleases(2), agent, { reason: "x" })).rejects.toBeInstanceOf(RollbackError);
    await expect(oneClickRollback(withReleases(2), owner, { reason: "x", to: "R-9" })).rejects.toMatchObject({ code: "UNKNOWN_RELEASE" });
    await expect(oneClickRollback(withReleases(2), owner, { reason: "x", to: "R-2" })).rejects.toMatchObject({ code: "UNKNOWN_RELEASE" });
    await expect(oneClickRollback(withReleases(1), owner, { reason: "x" })).rejects.toMatchObject({ code: "NOTHING_TO_ROLL_BACK" });
  });

  it("a second click undoes the first, still as a new release", async () => {
    const ledger = withReleases(2);
    await oneClickRollback(ledger, owner, { reason: "R-2 broke sending" });
    const again = await oneClickRollback(ledger, owner, { reason: "the fix was fine after all" });
    expect(again.entry.subject).toBe("R-4");
    expect(again.restored.release).toBe("R-2");
  });
});
