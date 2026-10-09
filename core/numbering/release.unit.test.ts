import { describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "./rules";
import {
  bumpVersion,
  currentStamp,
  cutRelease,
  findRelease,
  formatStamp,
  releaseRange,
  releaseStamp,
  releases,
  rollbackRelease,
} from "./release";

const owner = { kind: "person" as const, id: "owner" };
const gate = { kind: "system" as const, id: "gate" };

function open(): Ledger {
  const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T00:00:00Z") });
  installNumberingRules(ledger);
  return ledger;
}

/** Plan, task, proof and commit for one task, ending with task.done. */
function finishTask(ledger: Ledger, change: "breaking" | "feature" | "fix", sha: string): string {
  const task = appendNumbered(ledger, {
    actor: gate,
    type: "task.created",
    summary: `work for ${sha}`,
    evidence: [],
    refs: [],
    data: { change },
  });
  const t = task.subject;
  ledger.append({ actor: owner, type: "test.defined", subject: t, summary: "test defined", evidence: [], refs: [], data: { test: "npm test" } });
  ledger.append({ actor: owner, type: "test.approved", subject: t, summary: "test approved", evidence: [], refs: [], data: { test: "npm test" } });
  ledger.append({ actor: gate, type: "commit.observed", subject: t, summary: "commit observed", evidence: [`commit:${sha}`], refs: [], data: { sha } });
  ledger.append({ actor: gate, type: "test.passed", subject: t, summary: "test passed", evidence: [], refs: [], data: { test: "npm test" } });
  ledger.append({ actor: gate, type: "task.done", subject: t, summary: "done", evidence: [], refs: [] });
  return t;
}

describe("bumpVersion", () => {
  it("starts at v1.0.0 when there is no previous version", () => {
    expect(bumpVersion(undefined, "fix")).toBe("v1.0.0");
    expect(bumpVersion(undefined, "feature")).toBe("v1.0.0");
    expect(bumpVersion(undefined, "breaking")).toBe("v1.0.0");
  });

  it("bumps major for breaking, minor for feature, patch for fix", () => {
    expect(bumpVersion("v1.2.3", "breaking")).toBe("v2.0.0");
    expect(bumpVersion("v1.2.3", "feature")).toBe("v1.3.0");
    expect(bumpVersion("v1.2.3", "fix")).toBe("v1.2.4");
  });
});

describe("cutRelease", () => {
  it("cuts R-1 at v1.0.0 covering the ledger up to the cut, with the latest plan", () => {
    const ledger = open();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan approved", evidence: [], refs: [] }); // L-000001, P-1
    appendNumbered(ledger, { actor: gate, type: "task.created", summary: "first", evidence: [], refs: [] }); // L-000002, T-1
    const before = ledger.last()!.n;
    const cut = cutRelease(ledger, owner, { commit: "abc1234" });

    expect(cut.type).toBe("release.cut");
    expect(cut.subject).toBe("R-1");
    expect(cut.data).toMatchObject({ release: "R-1", version: "v1.0.0", plan: "P-1", commit: "abc1234", from: "L-000001", to: before });
    expect(cut.evidence).toEqual(["commit:abc1234"]);
    expect(cut.n).toBe("L-000003");
  });

  it("cuts R-2 at v1.1.0 after a feature task is done, and records the plan at that point", () => {
    const ledger = open();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan one", evidence: [], refs: [] });
    cutRelease(ledger, owner, { commit: "aaa1111" });

    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan two", evidence: [], refs: [] });
    finishTask(ledger, "feature", "bbb2222");
    const second = cutRelease(ledger, owner, { commit: "bbb2222" });

    expect(second.subject).toBe("R-2");
    expect(second.data).toMatchObject({ version: "v1.1.0", plan: "P-2", change: "feature" });
  });

  it("uses the strongest change among the tasks done in the range", () => {
    const ledger = open();
    finishTask(ledger, "fix", "c1");
    finishTask(ledger, "breaking", "c2");
    expect(cutRelease(ledger, owner, { commit: "c2" }).data).toMatchObject({ version: "v1.0.0", change: "breaking" });
  });

  it("throws when nothing has happened since the last release", () => {
    const ledger = open();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan", evidence: [], refs: [] });
    cutRelease(ledger, owner, { commit: "abc1234" });
    expect(() => cutRelease(ledger, owner, { commit: "abc1234" })).toThrow(RangeError);
    expect(ledger.entries()).toHaveLength(2);
  });

  it("throws on an empty ledger", () => {
    expect(() => cutRelease(open(), owner, { commit: "abc1234" })).toThrow(RangeError);
  });

  it("requires a commit", () => {
    const ledger = open();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan", evidence: [], refs: [] });
    expect(() => cutRelease(ledger, owner, { commit: "" })).toThrow(/needs the commit/);
  });
});

describe("releaseRange / releaseStamp / currentStamp", () => {
  it("releaseRange returns the entries from..to of a release", () => {
    const ledger = open();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan", evidence: [], refs: [] });
    appendNumbered(ledger, { actor: gate, type: "task.created", summary: "task", evidence: [], refs: [] });
    cutRelease(ledger, owner, { commit: "abc1234" });
    const range = releaseRange(ledger.entries(), "R-1");
    expect(range.map((e) => e.n)).toEqual(["L-000001", "L-000002"]);
    expect(releaseRange(ledger.entries(), "R-7")).toEqual([]);
  });

  it("formats the release stamp as R · version · plan · entry · commit", () => {
    const ledger = open();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan", evidence: [], refs: [] });
    appendNumbered(ledger, { actor: gate, type: "task.created", summary: "task", evidence: [], refs: [] });
    const cut = cutRelease(ledger, owner, { commit: "abc1234" });
    expect(releaseStamp(ledger.entries())).toBe(`R-1 · v1.0.0 · P-1 · ${cut.n} · abc1234`);
    expect(releaseStamp(ledger.entries(), "R-1")).toBe(`R-1 · v1.0.0 · P-1 · ${cut.n} · abc1234`);
    expect(releaseStamp(ledger.entries(), "R-2")).toBeUndefined();
    expect(cut.n).toBe("L-000003");
  });

  it("omits empty parts from a stamp", () => {
    expect(formatStamp({ release: "R-1", version: "v1.0.0", commit: "abc1234" })).toBe("R-1 · v1.0.0 · abc1234");
    expect(formatStamp({})).toBe("unreleased");
  });

  it("currentStamp starts with 'unreleased' when nothing has been released", () => {
    const ledger = open();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan", evidence: [], refs: [] });
    appendNumbered(ledger, { actor: gate, type: "task.created", summary: "task", evidence: [], refs: [] });
    const stamp = currentStamp(ledger.entries(), "abc1234");
    expect(stamp.startsWith("unreleased")).toBe(true);
    expect(stamp).toBe("unreleased · P-1 · L-000002 · abc1234");
  });

  it("currentStamp shows the latest release followed by the ledger head", () => {
    const ledger = open();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan", evidence: [], refs: [] });
    cutRelease(ledger, owner, { commit: "abc1234" });
    const head = ledger.last()!.n;
    expect(currentStamp(ledger.entries(), "abc1234")).toBe(`R-1 · v1.0.0 · P-1 · ${head} · abc1234`);
  });
});

describe("rollbackRelease", () => {
  it("makes R-3 with a patch bump above the latest version, restoring R-1 with its commit and plan", () => {
    const ledger = open();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan one", evidence: [], refs: [] }); // P-1
    finishTask(ledger, "fix", "aaa1111");
    cutRelease(ledger, owner, { commit: "aaa1111" }); // R-1 v1.0.0

    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "plan two", evidence: [], refs: [] }); // P-2
    finishTask(ledger, "feature", "bbb2222");
    cutRelease(ledger, owner, { commit: "bbb2222" }); // R-2 v1.1.0

    const rollback = rollbackRelease(ledger, owner, { to: "R-1", reason: "R-2 broke checkout" });
    expect(rollback.type).toBe("release.rollback");
    expect(rollback.subject).toBe("R-3");
    expect(rollback.reason).toBe("R-2 broke checkout");
    expect(rollback.data).toMatchObject({
      release: "R-3",
      version: "v1.1.1",
      plan: "P-1",
      commit: "aaa1111",
      restores: "R-1",
    });

    const record = findRelease(ledger.entries(), "R-3");
    expect(record).toMatchObject({ version: "v1.1.1", plan: "P-1", commit: "aaa1111", restores: "R-1" });
    expect(releases(ledger.entries()).map((r) => r.release)).toEqual(["R-1", "R-2", "R-3"]);
  });

  it("uses the commit given instead of the restored release's commit when one is supplied", () => {
    const ledger = open();
    finishTask(ledger, "fix", "aaa1111");
    cutRelease(ledger, owner, { commit: "aaa1111" });
    finishTask(ledger, "fix", "bbb2222");
    cutRelease(ledger, owner, { commit: "bbb2222" });
    const rollback = rollbackRelease(ledger, owner, { to: "R-1", reason: "redeploy", commit: "ccc3333" });
    expect(rollback.data).toMatchObject({ commit: "ccc3333", restores: "R-1" });
  });

  it("throws when rolling back to the latest release", () => {
    const ledger = open();
    finishTask(ledger, "fix", "aaa1111");
    cutRelease(ledger, owner, { commit: "aaa1111" });
    expect(() => rollbackRelease(ledger, owner, { to: "R-1", reason: "no-op" })).toThrow(/already the latest release/);
    expect(ledger.entries()).toHaveLength(7);
  });

  it("throws when the target is not a release", () => {
    const ledger = open();
    finishTask(ledger, "fix", "aaa1111");
    cutRelease(ledger, owner, { commit: "aaa1111" });
    expect(() => rollbackRelease(ledger, owner, { to: "R-9", reason: "nope" })).toThrow(RangeError);
  });

  it("requires a reason", () => {
    const ledger = open();
    finishTask(ledger, "fix", "aaa1111");
    cutRelease(ledger, owner, { commit: "aaa1111" });
    finishTask(ledger, "fix", "bbb2222");
    cutRelease(ledger, owner, { commit: "bbb2222" });
    const codeOf = (reason: unknown) => {
      try {
        rollbackRelease(ledger, owner, { to: "R-1", reason: reason as string });
      } catch (error) {
        return (error as LedgerError).code;
      }
      return "no error";
    };
    // A missing reason is REASON_REQUIRED; a blank one is refused as an empty field.
    expect(codeOf(undefined)).toBe("REASON_REQUIRED");
    expect(codeOf("")).toBe("EMPTY_FIELD");
    expect(codeOf("   ")).toBe("EMPTY_FIELD");
    expect(releases(ledger.entries())).toHaveLength(2);
  });
});
