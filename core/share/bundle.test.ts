import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, Ledger } from "../ledger/index";
import { git } from "../worktrees/git";
import { commitAll, makeRepo, writeFiles } from "../worktrees/testing";
import { BundleError, checkMerge, exportBundle, importBundle, readBundle } from "./bundle";

const SLOW = 60_000;
const person = { kind: "person", id: "owner" } as const;

describe("share bundles", () => {
  let a: { root: string; cleanup: () => void };
  let b: { root: string; cleanup: () => void };
  let file: string;
  let entries: Awaited<ReturnType<typeof makeEntries>>;

  async function makeEntries() {
    const ledger = await Ledger.open(new MemoryStore());
    ledger.append({ actor: person, type: "task.created", subject: "T-1", summary: "First task", data: {} });
    return [...ledger.entries()];
  }

  beforeEach(async () => {
    a = await makeRepo();
    b = await makeRepo();
    // Both start from the same commit: b fetches a's history.
    const seedFile = path.join(os.tmpdir(), `pp-seed-${Date.now()}-${Math.random().toString(16).slice(2)}.bundle`);
    await git(a.root, ["bundle", "create", seedFile, "HEAD"]);
    await git(b.root, ["bundle", "unbundle", seedFile]);
    await git(b.root, ["reset", "-q", "--hard", await git(a.root, ["rev-parse", "HEAD"])]);
    file = path.join(os.tmpdir(), `pp-test-${Date.now()}-${Math.random().toString(16).slice(2)}.ppb`);
    entries = await makeEntries();
  }, SLOW);

  afterEach(() => {
    a.cleanup();
    b.cleanup();
  });

  async function sendBranch(files: Record<string, string>) {
    await git(a.root, ["checkout", "-q", "-b", "pp/T-1"]);
    writeFiles(a.root, files);
    await commitAll(a.root, "work");
    await exportBundle({ repoRoot: a.root, project: "demo", sender: "ana", branches: ["pp/T-1"], entries, outFile: file });
  }

  it("round-trips a branch into the inbox without touching the receiver's own branches", async () => {
    await sendBranch({ "new.txt": "hi\n" });
    const mainBefore = await git(b.root, ["rev-parse", "HEAD"]);
    const res = await importBundle(b.root, file);
    expect(res.refs["pp/T-1"]).toBe("refs/pp-inbox/ana/pp/T-1");
    expect(res.entries).toBe(entries.length);
    expect(await git(b.root, ["rev-parse", "HEAD"])).toBe(mainBefore);
    expect(await git(b.root, ["branch", "--list", "pp/*"])).toBe("");
    expect(await git(b.root, ["show", "refs/pp-inbox/ana/pp/T-1:new.txt"])).toBe("hi");
  }, SLOW);

  it("refuses a bundle changed after it was made", async () => {
    await sendBranch({ "new.txt": "hi\n" });
    const raw = readFileSync(file);
    raw[raw.length - 5] ^= 0xff;
    writeFileSync(file, raw);
    expect(() => readBundle(file)).toThrow(/changed or damaged/);
  }, SLOW);

  it("refuses edited ledger entries and non-bundles", async () => {
    await sendBranch({ "new.txt": "hi\n" });
    const raw = readFileSync(file).toString("latin1").replace("First task", "Other task");
    writeFileSync(file, Buffer.from(raw, "latin1"));
    expect(() => readBundle(file)).toThrow(BundleError);
    writeFileSync(file, "nonsense");
    expect(() => readBundle(file)).toThrow(/not a Perfect Planner bundle/);
  }, SLOW);

  it("reports a clean merge, and the conflicting files when both sides changed the same lines", async () => {
    await sendBranch({ "README.md": "from ana\n" });
    await importBundle(b.root, file);
    expect(await checkMerge(b.root, "HEAD", "refs/pp-inbox/ana/pp/T-1")).toEqual({ clean: true, alreadyIn: false });
    writeFiles(b.root, { "README.md": "from ben\n" });
    await commitAll(b.root, "ben edit");
    expect(await checkMerge(b.root, "HEAD", "refs/pp-inbox/ana/pp/T-1")).toEqual({ clean: false, conflicts: ["README.md"] });
  }, SLOW);
});
