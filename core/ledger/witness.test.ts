import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileHeadWitness, FileStore, Ledger, MemoryKeyProvider, type HeadWitness } from "./index";

// Reviewer condition 1 (owner recovery): the ledger can be cut short from its
// end together with its HEAD file, since both sit in the project folder. A copy
// of the head kept in the app's data folder still shows the cut.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const agent = { kind: "agent" as const, id: "claude-code", model: "x" };

function project(witness: HeadWitness) {
  const root = temp("pp-witness-");
  const ledger = Ledger.openSync(new FileStore(root), { keys: new MemoryKeyProvider(), witness });
  for (const summary of ["One", "Two", "Three"]) ledger.append({ actor: agent, type: "task.progress", subject: "T-1", summary });
  ledger.close();
  return root;
}

function ledgerFile(root: string): string {
  const dir = path.join(root, ".perfect-planner", "ledger");
  return path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith(".jsonl"))!);
}

describe("the head copy kept outside the project", () => {
  it("records the head on every write", () => {
    const witness = new FileHeadWitness(temp("pp-appdata-"));
    const root = project(witness);
    const lines = fs.readFileSync(ledgerFile(root), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(witness.read(lines[0].hash)).toEqual({ n: "L-000003", hash: lines[2].hash, entries: 3 });
  });

  it("shows a ledger cut short with its HEAD file as truncated", () => {
    const witness = new FileHeadWitness(temp("pp-appdata-"));
    const root = project(witness);
    const file = ledgerFile(root);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    fs.writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);
    fs.rmSync(path.join(root, ".perfect-planner", "ledger", "HEAD"));
    // Without the outside copy the cut is invisible.
    const blind = Ledger.openSync(new FileStore(root), { keys: new MemoryKeyProvider(), readOnly: true });
    expect(blind.status.ok).toBe(true);
    const seen = Ledger.openSync(new FileStore(root), { keys: new MemoryKeyProvider(), witness, readOnly: true });
    expect(seen.status).toMatchObject({ ok: false, problem: "truncated", brokenAt: "L-000003" });
    expect(seen.status.detail).toMatch(/outside the project/);
  });

  it("shows a rewritten last entry when HEAD was rewritten to match", () => {
    const witness = new FileHeadWitness(temp("pp-appdata-"));
    const root = project(witness);
    const blind = Ledger.openSync(new FileStore(root), { keys: new MemoryKeyProvider() });
    blind.close();
    const file = ledgerFile(root);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    fs.writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);
    fs.rmSync(path.join(root, ".perfect-planner", "ledger", "HEAD"));
    // A different third entry, written by a process that did not use the witness.
    const forger = Ledger.openSync(new FileStore(root), { keys: new MemoryKeyProvider() });
    forger.append({ actor: agent, type: "task.progress", subject: "T-1", summary: "Something else" });
    forger.close();
    const seen = Ledger.openSync(new FileStore(root), { keys: new MemoryKeyProvider(), witness, readOnly: true });
    expect(seen.status).toMatchObject({ ok: false, problem: "hash", brokenAt: "L-000003" });
  });

  it("keeps a stored entry and reports it when the copy cannot be written", () => {
    const broken: HeadWitness = {
      description: "a read-only folder",
      read: () => undefined,
      write: () => {
        throw new Error("permission denied");
      },
    };
    const root = temp("pp-witness-");
    const ledger = Ledger.openSync(new FileStore(root), { keys: new MemoryKeyProvider(), witness: broken });
    const entry = ledger.append({ actor: agent, type: "task.progress", subject: "T-1", summary: "Stored anyway" });
    expect(ledger.get(entry.n)).toBeDefined();
    expect(ledger.status.witnessProblem).toMatch(/permission denied/);
  });
});
