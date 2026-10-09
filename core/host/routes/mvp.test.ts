import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCall, startTestHost } from "../testing";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

let t: Awaited<ReturnType<typeof startTestHost>>;
beforeEach(async () => { t = await startTestHost(); });
afterEach(async () => { await t.stop(); });

const NEW = {
  mode: "new",
  goal: "Plan a project and track tasks to done",
  features: "Plan editor (needs: Local project store)\nTask board to track tasks (needs: Local project store)\nLocal project store\nShare with a team\nPerformance budget gate",
};

describe("MVP board routes", () => {
  it("starts empty", async () => {
    const r = await hostCall(t.base, "GET", "/mvp?project=a");
    expect(r.status).toBe(200);
    expect(r.body.result.staged).toBe(false);
    expect(r.body.result.stages.map((s: any) => s.name)).toEqual(["MVP", "Beta", "v1", "Scale"]);
  });

  it("plans a new project with the offline advisor, moves with a reason and confirms", async () => {
    const staged = await hostCall(t.base, "POST", "/mvp/stage?project=a", NEW);
    expect(staged.status).toBe(200);
    const board = staged.body.result;
    expect(board.staged).toBe(true);
    expect(board.proposal.offline).toBe(true);
    expect(board.features).toHaveLength(5);
    const store = board.features.find((f: any) => f.id === "local-project-store");
    expect(store.stage).toBe("mvp");
    expect(store.status).toBe("missing");
    const editor = board.features.find((f: any) => f.id === "plan-editor");
    expect(editor.dependsOn[0]).toMatchObject({ id: "local-project-store", name: "Local project store" });
    for (const f of board.features.filter((x: any) => x.stage !== "mvp")) expect(f.reason.length).toBeGreaterThan(0);

    // Out of the MVP needs a reason.
    const mvpFeature = board.features.find((f: any) => f.stage === "mvp" && f.id !== "local-project-store");
    const refused = await hostCall(t.base, "POST", "/mvp/move?project=a", { feature: mvpFeature.id, to: "beta", reason: "TBD" });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("REASON_REQUIRED");
    expect(refused.body.message).toMatch(/one-line reason/);

    // Moving the store out breaks a dependency: confirm is refused with a readable message.
    const out = await hostCall(t.base, "POST", "/mvp/move?project=a", { feature: "local-project-store", to: "v1", reason: "Try it later" });
    expect(out.status).toBe(200);
    expect(out.body.result.moved).toMatchObject({ from: "mvp", to: "v1" });
    expect(out.body.result.warnings.length).toBeGreaterThan(0);
    const blocked = await hostCall(t.base, "POST", "/mvp/confirm?project=a", {});
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe("MISSING_DEPENDENCIES");
    expect(blocked.body.message).toMatch(/needs Local project store/);

    const back = await hostCall(t.base, "POST", "/mvp/move?project=a", { feature: "local-project-store", to: "mvp" });
    expect(back.body.result.warnings).toEqual([]);

    const renamed = await hostCall(t.base, "POST", "/mvp/rename?project=a", { stage: "mvp", name: "Pilot" });
    expect(renamed.body.result.stages[0].name).toBe("Pilot");
    const badName = await hostCall(t.base, "POST", "/mvp/rename?project=a", { stage: "beta", name: "pilot" });
    expect(badName.status).toBe(422);

    const confirmed = await hostCall(t.base, "POST", "/mvp/confirm?project=a", {});
    expect(confirmed.status).toBe(200);
    const c = confirmed.body.result;
    expect(c.confirmed).toBe(true);
    expect(c.confirmation).toMatchObject({ by: "owner", name: "You" });
    expect(c.confirmation.entry).toMatch(/^L-\d+$/);
    expect(c.doneWhen.done).toBe(false);
    expect(c.doneWhen.blocking.join(" ")).toMatch(/Journey test has not passed/);
    expect(c.history.map((h: any) => h.kind)).toEqual(["staging", "proposal", "move", "move", "rename", "confirm"]);

    // Survives a fresh read; a later move un-confirms.
    const again = await hostCall(t.base, "POST", "/mvp/move?project=a", { feature: "performance-budget-gate", to: "mvp" });
    expect(again.body.result.confirmed).toBe(false);
  });

  it("refuses bad input readably", async () => {
    const noGoal = await hostCall(t.base, "POST", "/mvp/stage?project=b", { mode: "new", goal: "", features: "A" });
    expect(noGoal.body.code).toBe("GOAL_REQUIRED");
    const noFeatures = await hostCall(t.base, "POST", "/mvp/stage?project=b", { mode: "new", goal: "Ship", features: "\n  \n" });
    expect(noFeatures.body.code).toBe("NO_FEATURES");
    const badDep = await hostCall(t.base, "POST", "/mvp/stage?project=b", { mode: "new", goal: "Ship", features: "A (needs: Z)" });
    expect(badDep.body.code).toBe("UNKNOWN_DEPENDENCY");
    const badMode = await hostCall(t.base, "POST", "/mvp/stage?project=b", { mode: "both" });
    expect(badMode.body.code).toBe("BAD_MODE");
    const noBoard = await hostCall(t.base, "POST", "/mvp/confirm?project=b", {});
    expect(noBoard.status).toBe(422);
    expect(noBoard.body.message).toMatch(/no proposed MVP line yet/);
    const notFolder = await hostCall(t.base, "POST", "/mvp/stage?project=b", { mode: "existing", path: path.join(t.dir, "nope") });
    expect(notFolder.body.code).toBe("NOT_A_FOLDER");
    const file = path.join(t.dir, "file.txt");
    fs.writeFileSync(file, "x");
    expect((await hostCall(t.base, "POST", "/mvp/stage?project=b", { mode: "existing", path: file })).body.code).toBe("NOT_A_FOLDER");
    // The project's own (empty) folder has nothing to scan.
    const empty = await hostCall(t.base, "POST", "/mvp/stage?project=b", { mode: "existing" });
    expect(empty.body.code).toBe("NO_FEATURES");
    expect((await hostCall(t.base, "GET", "/mvp?project=b")).body.result.staged).toBe(false);
  });

  it("scans an existing folder with evidence and rescans it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-mvp-scan-"));
    try {
      fs.mkdirSync(path.join(dir, "src/components"), { recursive: true });
      fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src/components/NoteEditor.jsx"), "export default function NoteEditor() { return null; }\n");
      fs.writeFileSync(path.join(dir, "tests/NoteEditor.test.jsx"), "it('works', () => {});\n");
      fs.writeFileSync(path.join(dir, "src/components/ShareDialog.jsx"), "// TODO: wire up sharing\nexport default function ShareDialog() { return null; }\n");
      const r = await hostCall(t.base, "POST", "/mvp/stage?project=c", { mode: "existing", path: dir, goal: "Write notes" });
      expect(r.status).toBe(200);
      const b = r.body.result;
      expect(b.mode).toBe("existing");
      expect(b.source.root).toBe(path.resolve(dir));
      const editor = b.features.find((f: any) => f.id === "note-editor");
      expect(editor.status).toBe("done");
      expect(editor.evidence.map((e: any) => e.file)).toContain("tests/NoteEditor.test.jsx");
      expect(b.features.find((f: any) => f.id === "share-dialog").status).toBe("partial");

      fs.writeFileSync(path.join(dir, "tests/ShareDialog.test.jsx"), "it('works', () => {});\n");
      fs.writeFileSync(path.join(dir, "src/components/ShareDialog.jsx"), "export default function ShareDialog() { return null; }\n");
      const re = await hostCall(t.base, "POST", "/mvp/rescan?project=c", {});
      expect(re.body.result.features.find((f: any) => f.id === "share-dialog").status).toBe("done");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans this repository through its feature registry", async () => {
    const r = await hostCall(t.base, "POST", "/mvp/stage?project=d", { mode: "existing", path: repoRoot });
    expect(r.status).toBe(200);
    expect(r.body.result.source.kind).toMatch(/^registry:/);
    expect(r.body.result.features.some((f: any) => f.id === "C057" && f.stage === "mvp")).toBe(true);
  });
});
