import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commitAll, makeRepo, memoryLedger, writeFiles } from "../worktrees/testing";
import { TestGate, runTestCommand, type TestRunner } from "./index";
import type { CheckRequest } from "./execution";

async function setup() {
  const repo = await makeRepo({ "check.mjs": 'import {readFileSync} from "node:fs"; process.exit(readFileSync("feature.txt","utf8").includes("enabled") ? 0 : 7);', "feature.txt": "disabled" });
  const ledger = await memoryLedger();
  let afterRun: (() => Promise<void>) | undefined;
  let launches = 0;
  const runner: TestRunner = async (...args) => { launches++; const result = await runTestCommand(...args); await afterRun?.(); return result; };
  const gate = new TestGate({ ledger, run: runner });
  const person = { kind: "person" as const, id: "owner" };
  gate.define("T-1", "node check.mjs", { kind: "agent", id: "worker", model: "test-model" });
  expect(gate.approve("T-1", person, { cwd: repo.root }).ok).toBe(true);
  expect((await gate.confirmFailsFirst("T-1", repo.root)).ok).toBe(true);
  writeFiles(repo.root, { "feature.txt": "enabled" });
  const commit = await commitAll(repo.root, "Implement feature");
  const state = gate.state("T-1");
  const request: CheckRequest = { requestId: randomUUID(), attempt: "T-1", expected: { commit,
    definitionEntry: state.definition!.n, approvalEntry: state.approval!.n, pin: state.approval!.pin } };
  return { repo, ledger, gate, person, request, launches: () => launches, afterRun: (fn: () => Promise<void>) => { afterRun = fn; } };
}

describe("durable check real process validation", () => {
  it("publishes one attributable terminal and replays it after later HEAD movement without execution", async () => {
    const ctx = await setup();
    const result = await ctx.gate.proveRequest(ctx.request, "scope", async () => ctx.repo.root);
    expect(result).toMatchObject({ ok: true, commit: ctx.request.expected.commit, run: { exitCode: 0 } });
    expect(result.entry?.data?.execution).toMatchObject({ phase: "terminal", settlement: "process-exit-observed", descendantSettlement: "not-established" });
    writeFiles(ctx.repo.root, { "feature.txt": "enabled later" });
    await commitAll(ctx.repo.root, "Later unrelated change");
    const reopened = new TestGate({ ledger: ctx.ledger });
    expect(await reopened.proveRequest(ctx.request, "scope", async () => { throw new Error("Mutable preflight must not run on replay"); })).toEqual(result);
    expect(ctx.launches()).toBe(2); // real baseline + real checked execution
    ctx.ledger.close();
  }, 60_000);

  it.each(["HEAD", "dirty", "pins", "definition", "approval", "identity"])("retains runner success but refuses proof after %s changes", async change => {
    const ctx = await setup();
    let returned = false;
    ctx.afterRun(async () => {
      returned = true;
      if (change === "HEAD") { writeFiles(ctx.repo.root, { "feature.txt": "enabled later" }); await commitAll(ctx.repo.root, "Moved during check"); }
      if (change === "dirty") writeFiles(ctx.repo.root, { "unexpected.txt": "mutation" });
      if (change === "pins") writeFiles(ctx.repo.root, { "check.mjs": "process.exit(0);" });
      if (change === "definition") ctx.gate.define("T-1", "node check.mjs", { kind: "agent", id: "worker", model: "test-model" });
      if (change === "approval") {
        const previous = ctx.ledger.entries().find(e => e.n === ctx.request.expected.approvalEntry)!;
        ctx.ledger.append({ type: "test.approved", actor: ctx.person, subject: "T-1", summary: "Replacement approval receipt fixture", evidence: previous.evidence, refs: previous.refs, data: previous.data });
        expect(ctx.gate.state("T-1").approval?.n).not.toBe(ctx.request.expected.approvalEntry);
      }
    });
    const result = await ctx.gate.proveRequest(ctx.request, "scope", async () => change === "identity" && returned ? ctx.repo.root + "/.." : ctx.repo.root);
    expect(result).toMatchObject({ ok: false, run: { passed: true, exitCode: 0 }, entry: { type: "test.failed", data: { conclusive: false, execution: { phase: "terminal", validation: { valid: false } } } } });
    expect(ctx.gate.state("T-1").passedCommits).not.toContain(ctx.request.expected.commit);
    expect(result.reason).toContain("does not prove");
    ctx.ledger.close();
  }, 60_000);
});
