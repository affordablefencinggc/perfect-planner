// FOUND by the soak (ledger 10-soak, F3): a port lease is taken in freePort() but the worktree is only registered several
// awaits later. Any read of the registry in between (GET /tasks does one) runs syncLeases(), which drops "a lease with no
// worktree behind it", and another repo or project then takes the same port. Fixed by PENDING_PORTS in manager.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ledger } from "../ledger/index";
import { WorktreeManager } from "./manager";
import { makeRepo, memoryLedger } from "./testing";

const person = { kind: "person", id: "looplet-spare" } as const;

describe("port leases", () => {
  let a: { root: string; cleanup: () => void };
  let b: { root: string; cleanup: () => void };
  let ledger: Ledger;
  beforeEach(async () => {
    a = await makeRepo({ "README.md": "a\n" });
    b = await makeRepo({ "README.md": "b\n" });
    ledger = await memoryLedger();
  });
  afterEach(() => {
    a.cleanup();
    b.cleanup();
  });

  it("a registry read while a worktree is being made does not free its port for another repo (found by the soak, F3; fixed in manager.ts)", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let gate = false;
    const first = new WorktreeManager({ repoRoot: a.root, ledger, ports: [43301, 43302], install: async () => { if (!gate) return; entered(); await held; } });
    await first.create({ taskId: "T-9", actor: person }); // the registry file exists, as in any running project
    await first.remove("T-9", { kind: "person", id: "looplet-spare" }); // frees 43301 but leaves the registry file in place
    gate = true;
    const second = new WorktreeManager({ repoRoot: b.root, ledger, ports: [43301, 43302], install: false });
    const making = first.create({ taskId: "T-1", actor: person });
    await inside; // the port is leased, the worktree is not registered yet
    await first.list(); // what GET /tasks does on every poll
    const other = await second.create({ taskId: "T-1", actor: person });
    release();
    const mine = await making;
    expect(other.port, "two live worktrees in two repos got the same dev-server port").not.toBe(mine.port);
  }, 60_000);
});
