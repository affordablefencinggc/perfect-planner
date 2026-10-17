import { describe, expect, it } from "vitest";
import { MockJev, dependencyClosure, proposeWith, validateProposal } from "./advisor";
import type { Feature, MvpAdvisor, MvpProposal, ProposalInput, ScannedFeature } from "./types";

const f = (id: string, name: string, dependsOn: string[] = [], userFacing = true): Feature => ({
  id, name, dependsOn, userFacing,
});

const newFeatures: Feature[] = [
  f("auth", "Sign in", [], true),
  f("projects", "Create a project plan", ["auth"]),
  f("tasks", "Track tasks to done", ["projects"]),
  f("board", "Task board view", ["tasks"]),
  f("export", "Export to PDF", ["projects"]),
  f("themes", "Colour themes"),
  f("ci-gate", "CI merge gate", [], false),
  f("perf-budget", "Performance budget checks", [], false),
];
const goal = "Plan a project and track tasks to done";
const newInput: ProposalInput = { mode: "new", goal, features: newFeatures };

const scanned = (x: Feature, status: ScannedFeature["status"]): ScannedFeature => ({
  ...x, status, evidence: [], findings: [],
});

const stageMap = (p: MvpProposal) => Object.fromEntries(p.placements.map((pl) => [pl.feature, pl.stage]));

describe("MockJev, new project", () => {
  it("picks the goal-matching features and their dependencies", async () => {
    const p = await new MockJev().proposeMvp(newInput);
    expect(p.by).toEqual({ kind: "jev", id: "jev-mock", model: "mock-1" });
    const s = stageMap(p);
    expect(s.auth).toBe("mvp");
    expect(s.projects).toBe("mvp");
    expect(s.tasks).toBe("mvp");
    expect(s.themes).toBe("beta");
    expect(s["ci-gate"]).toBe("v1");
    expect(s["perf-budget"]).toBe("scale");
    expect(p.journey.name).toBe(`Core journey: ${goal}`);
    expect(p.journey.test).toBe("npm run test:e2e");
    expect(p.journey.steps[0]).toMatch(/^Use /);
    expect(p.summary).toMatch(/^\d+ of 8 features in the MVP$/);
    expect(validateProposal(p, newFeatures)).toEqual([]);
  });

  it("is deterministic", async () => {
    const a = await new MockJev().proposeMvp(newInput);
    const b = await new MockJev().proposeMvp(structuredClone(newInput));
    expect(b).toEqual(a);
  });

  it("accepts an override actor", () => {
    const actor = { kind: "jev" as const, id: "x", model: "m" };
    expect(new MockJev(actor).actor).toBe(actor);
  });
});

describe("MockJev, existing project", () => {
  const features: ScannedFeature[] = [
    scanned(f("auth", "Sign in"), "done"),
    scanned(f("e2e", "Journey: plan to done", ["auth", "tasks"]), "partial"),
    scanned(f("tasks", "Tasks", ["auth"]), "done"),
    scanned(f("reports", "Reports"), "missing"),
    scanned(f("calendar", "Calendar"), "partial"),
    scanned(f("themes", "Themes"), "done"),
    scanned(f("mutation-gate", "Mutation testing gate", [], false), "done"),
  ];
  const input: ProposalInput = { mode: "existing", goal, features };

  it("uses the end-to-end feature closure and the status rules", async () => {
    const p = await new MockJev().proposeMvp(input);
    const s = stageMap(p);
    expect(p.journey.features.sort()).toEqual(["auth", "e2e", "tasks"]);
    expect(s).toMatchObject({
      auth: "mvp", e2e: "mvp", tasks: "mvp",
      reports: "v1", calendar: "beta", themes: "beta", "mutation-gate": "scale",
    });
    expect(p.summary).toBe("3 of 7 features in the MVP, 2 already done");
    expect(validateProposal(p, features)).toEqual([]);
  });

  it("ignores a journey-named feature that touches nothing and follows the goal", async () => {
    // Found on Looplet: a notification "journey" folder became a one-feature MVP.
    const loose: ScannedFeature[] = [
      scanned(f("journey", "Journey"), "partial"),
      scanned(f("quote-editor", "Quote editor"), "done"),
      scanned(f("invoice-list", "Invoice list"), "partial"),
      scanned(f("themes", "Themes"), "done"),
    ];
    const p = await new MockJev().proposeMvp({ mode: "existing", goal: "Send a quote, then an invoice", features: loose });
    expect(p.journey.features.sort()).toEqual(["invoice-list", "quote-editor"]);
    expect(stageMap(p)).toMatchObject({ "quote-editor": "mvp", "invoice-list": "mvp", journey: "beta" });
  });
});

describe("explicit journey", () => {
  it("is respected", async () => {
    const p = await new MockJev().proposeMvp({
      ...newInput,
      journey: { name: "My journey", steps: ["Open", "Close"], test: "npm run my:e2e", features: ["themes"] },
    });
    expect(p.journey).toEqual({
      name: "My journey", steps: ["Open", "Close"], test: "npm run my:e2e", features: ["themes"],
    });
    expect(stageMap(p).themes).toBe("mvp");
    expect(stageMap(p).tasks).not.toBe("mvp");
  });
});

describe("validateProposal", () => {
  const good = async () => structuredClone(await new MockJev().proposeMvp(newInput));

  it("flags missing, duplicate and unknown placements", async () => {
    const p = await good();
    const dropped = p.placements.pop()!;
    p.placements.push({ ...p.placements[0] }, { feature: "ghost", stage: "mvp", reason: "" });
    const out = validateProposal(p, newFeatures).join("\n");
    expect(out).toContain(`${dropped.feature} is not placed`);
    expect(out).toContain(`${p.placements[0].feature} is placed 2 times`);
    expect(out).toContain("unknown feature ghost");
  });

  it("flags bad reasons", async () => {
    const p = await good();
    const later = p.placements.filter((x) => x.stage !== "mvp");
    later[0].reason = "   ";
    later[1].reason = "TBD";
    later[2].reason = "line one\nline two";
    later[3].reason = "x".repeat(201);
    const out = validateProposal(p, newFeatures);
    expect(out).toHaveLength(4);
  });

  it("flags journey problems", async () => {
    const p = await good();
    p.journey.features.push("themes");
    p.journey.test = " ";
    const out = validateProposal(p, newFeatures).join("\n");
    expect(out).toContain("journey feature themes is not in the MVP");
    expect(out).toContain("no test command");
  });

  it("flags dependencies that sit outside the MVP", async () => {
    const p = await good();
    p.placements.find((x) => x.feature === "auth")!.stage = "beta";
    p.placements.find((x) => x.feature === "auth")!.reason = "later";
    expect(validateProposal(p, newFeatures)).toContain("projects needs auth which sits in beta");
  });
});

describe("proposeWith", () => {
  it("returns a valid proposal", async () => {
    const p = await proposeWith(new MockJev(), newInput);
    expect(p.placements).toHaveLength(newFeatures.length);
  });

  it("rejects a broken advisor", async () => {
    const broken: MvpAdvisor = {
      actor: { kind: "jev", id: "bad", model: "m" },
      proposeMvp: async () => ({
        by: { kind: "jev", id: "bad", model: "m" },
        journey: { name: "j", steps: [], test: "", features: [] },
        placements: [{ feature: "auth", stage: "beta", reason: "TBD" }],
        summary: "",
      }),
    };
    await expect(proposeWith(broken, newInput)).rejects.toThrow(/invalid MVP[\s\S]*auth/);
  });
});

describe("dependency cycles", () => {
  it("do not hang", async () => {
    const cyc = [f("a", "Alpha plan", ["b"]), f("b", "Beta plan", ["a"]), f("c", "Other", ["c"], false)];
    expect(dependencyClosure(["a"], cyc).sort()).toEqual(["a", "b"]);
    expect(dependencyClosure(["c", "nope"], cyc)).toEqual(["c"]);
    const p = await proposeWith(new MockJev(), { mode: "new", goal: "alpha plan", features: cyc });
    expect(stageMap(p)).toMatchObject({ a: "mvp", b: "mvp" });
  });
});
