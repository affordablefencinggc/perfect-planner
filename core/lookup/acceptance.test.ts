import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore, Ledger, verifyChain, type Actor } from "../ledger/index";
import { appendNumbered, cutRelease, installNumberingRules, releaseRange, rollbackRelease, taskLabel } from "../numbering/index";
import { addClause, addPlanText, changeClause, installClauseRules, lookup, renderPlan, renderReleaseNotes, search, withdrawClause } from "./index";

const owner: Actor = { kind: "person", id: "looplet-spare" };
const worker: Actor = { kind: "agent", id: "claude-code", model: "worker-model" };
const watcher: Actor = { kind: "system", id: "watcher" };

const PLAN = `# Invoice sending

## 1. Scope

Finish invoice sending in Looplet.

## 2. Behaviour

- A new invoice keeps its identity after a reload.
- An accepted email is recovered without resending.
`;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-accept-"));
  dirs.push(dir);
  return dir;
}

function open(root: string, now: () => Date): Ledger {
  const ledger = Ledger.openSync(new FileStore(root), { now });
  installNumberingRules(ledger);
  installClauseRules(ledger);
  return ledger;
}

function finishTask(ledger: Ledger, task: string, sha: string, test: string) {
  ledger.append({ actor: worker, type: "task.claimed", subject: task, summary: `Claimed ${task}` });
  ledger.append({ actor: watcher, type: "commit.observed", subject: task, summary: `Commit ${sha}`, evidence: [`commit:${sha}`], data: { sha } });
  ledger.append({ actor: watcher, type: "test.passed", subject: task, summary: `${test} passed`, evidence: ["test-run:1"], data: { test, afterMerge: true } });
  return ledger.append({ actor: owner, type: "task.done", subject: task, summary: `${task} done`, evidence: [`commit:${sha}`] });
}

describe("core loop ledger, numbering and lookup together", () => {
  it("runs plan to release to rollback, survives a restart, and resolves references", () => {
    const root = tempRoot();
    let clock = Date.parse("2026-10-30T10:00:00Z");
    const now = () => new Date((clock += 60_000));
    let ledger = open(root, now);

    // Plan P-1 with clause numbers on every item.
    addPlanText(ledger, owner, PLAN);
    const p1 = appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Invoice sending plan approved" });
    expect(p1.subject).toBe("P-1");
    expect(lookup(ledger.entries(), "P-1 §2.1").text).toBe("A new invoice keeps its identity after a reload.");

    // Two tasks citing clauses, with approved tests.
    const t1 = appendNumbered(ledger, { actor: owner, type: "task.created", summary: "Invoice identity survives reload", refs: ["P-1 §2.1"], data: { change: "feature" } });
    const t2 = appendNumbered(ledger, { actor: owner, type: "task.created", summary: "Recover accepted email", refs: ["P-1 §2.2"] });
    expect([t1.subject, t2.subject]).toEqual(["T-1", "T-2"]);
    for (const [task, test] of [["T-1", "npm test -- identity"], ["T-2", "npm test -- recovery"]]) {
      ledger.append({ actor: owner, type: "test.defined", subject: task, summary: `Test for ${task}`, data: { test } });
      ledger.append({ actor: owner, type: "test.approved", subject: task, summary: `Test for ${task} approved`, data: { test } });
    }

    // A question through the relay, answered by a decision.
    const q = appendNumbered(ledger, { actor: worker, type: "question.asked", summary: "Keep the draft id or mint a new one?", data: { task: "T-1" } });
    const d = appendNumbered(ledger, { actor: owner, type: "decision.made", summary: "Keep the draft id", reason: "Spec P-1 §2.1 requires identity to survive", refs: ["P-1 §2.1"], data: { question: q.subject } });
    expect(d.subject).toBe("D-1");

    finishTask(ledger, "T-1", "9f3c2e1", "npm test -- identity");

    // T-2 is rejected once and comes back as attempt 2.
    ledger.append({ actor: { kind: "jev", id: "jev", model: "jev-latest" }, type: "review.verdict", subject: "T-2", summary: "Diff rejected: weakens a test", data: { verdict: "reject" } });
    ledger.append({ actor: owner, type: "task.reopened", subject: "T-2", summary: "Back to the worker", reason: "Jev rejected the diff" });
    expect(taskLabel(ledger.entries(), "T-2")).toBe("T-2.a2");
    finishTask(ledger, "T-2.a2", "a1b2c3d", "npm test -- recovery");

    // Release R-1 as a feature release, with its ledger range.
    const r1 = cutRelease(ledger, owner, { commit: "a1b2c3d" });
    expect(r1.subject).toBe("R-1");
    expect(r1.data).toMatchObject({ version: "v1.0.0", plan: "P-1", from: "L-000001" });
    expect(releaseRange(ledger.entries(), "R-1").at(-1)?.n).toBe(ledger.entries()[ledger.entries().length - 2].n);

    // The plan changes, a clause is inserted and one withdrawn, P-2 approved.
    changeClause(ledger, owner, "§1.1", "Finish invoice sending in Looplet, end to end.", "Scope covers delivery too");
    expect(addClause(ledger, owner, { after: "2.1", text: "Reload works offline too." }).subject).toBe("§2.1.1");
    withdrawClause(ledger, owner, "§2.2", "Moved to a later plan");
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Plan revised" });
    const r2 = cutRelease(ledger, owner, { commit: "b2c3d4e" });
    expect(r2.data).toMatchObject({ version: "v1.0.1", plan: "P-2" });

    // Roll back to R-1: a new release, numbers and versions still go up.
    const r3 = rollbackRelease(ledger, owner, { to: "R-1", reason: "R-2 broke sending" });
    expect(r3.subject).toBe("R-3");
    expect(r3.data).toMatchObject({ version: "v1.0.2", restores: "R-1", commit: "a1b2c3d", plan: "P-1" });

    // Restart: everything comes back from disk and the chain checks clean.
    ledger.close();
    ledger = open(root, now);
    expect(ledger.status.ok).toBe(true);
    expect(verifyChain(ledger.entries())).toEqual({ ok: true });
    const files = fs.readdirSync(path.join(root, ".perfect-planner", "ledger")).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    // lookup("P-1 §2.1") returns the clause, its tasks and their commits (spec §7.1).
    const clause = lookup(ledger.entries(), "P-1 §2.1");
    expect(clause.found).toBe(true);
    expect(clause.tasks).toEqual(["T-1"]);
    expect(clause.commits).toEqual(["9f3c2e1"]);
    expect(clause.citedBy.map((e) => e.subject)).toEqual(expect.arrayContaining(["T-1", "D-1"]));

    // Versions of a clause: P-1 has the old text, P-2 the new.
    expect(lookup(ledger.entries(), "P-1 §1.1").text).toBe("Finish invoice sending in Looplet.");
    expect(lookup(ledger.entries(), "P-2 §1.1").text).toBe("Finish invoice sending in Looplet, end to end.");
    expect(lookup(ledger.entries(), "P-1 §2.1.1").problem).toMatch(/added after P-1/);
    expect(lookup(ledger.entries(), "§2.2").status).toBe("withdrawn");

    // Every other kind of reference resolves.
    expect(lookup(ledger.entries(), "T-2").ref).toBe("T-2.a2");
    expect(lookup(ledger.entries(), "Q-1").status).toBe("answered");
    expect(lookup(ledger.entries(), "D-1").text).toBe("Keep the draft id");
    expect(lookup(ledger.entries(), "R-3").status).toBe("rollback to R-1");
    expect(lookup(ledger.entries(), "R-1").text).toMatch(/^R-1 · v1\.0\.0 · P-1 · L-\d{6} · a1b2c3d$/);
    expect(lookup(ledger.entries(), "L-000001").found).toBe(true);
    expect(search(ledger.entries(), "reload")[0].ref).toMatch(/^§2\.1/);

    // Docs are views: the P-2 plan lists the withdrawn clause, notes list done tasks.
    const plan = renderPlan(ledger.entries(), "P-2");
    expect(plan).toContain("§2.1.1 Reload works offline too.");
    expect(plan).toMatch(/## Withdrawn[\s\S]*§2\.2 withdrawn/);
    expect(renderReleaseNotes(ledger.entries(), "R-1")).toContain("T-1: Invoice identity survives reload");
    ledger.close();
  });

  it("detects a hand-edited ledger file on the next start and stops writes", () => {
    const root = tempRoot();
    const now = () => new Date("2026-10-09T08:00:00Z");
    const ledger = open(root, now);
    addPlanText(ledger, owner, PLAN);
    ledger.close();

    const dir = path.join(root, ".perfect-planner", "ledger");
    const file = path.join(dir, "2026-10.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const tampered = JSON.parse(lines[1]);
    tampered.data.text = "Something nobody approved.";
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);

    const reopened = open(root, now);
    expect(reopened.status).toMatchObject({ ok: false, brokenAt: "L-000002", problem: "hash" });
    expect(() => addClause(reopened, owner, { text: "More" })).toThrow(/writes are stopped/);
    reopened.acknowledgeBreak(owner, "Saw the edit, restoring from git next");
    expect(reopened.status.ok).toBe(true);
    reopened.close();
    expect(open(root, now).status).toMatchObject({ ok: true, acknowledged: ["L-000002"] });
  });
});
