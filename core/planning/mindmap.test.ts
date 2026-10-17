import { describe, it, expect } from "vitest";
import { addNode, buildMindMap, isDeclined, linkNodes, nodeId, removeNode, renameNode, toMermaid } from "./mindmap";
import type { Area, MindMap, PlanningAnswer } from "./types";

const ans = (area: Area, slug: string, text: string, extra: Partial<PlanningAnswer> = {}): PlanningAnswer => ({
  questionId: `${area}.${slug}`,
  area,
  q: `Question about ${area}`,
  choice: "custom",
  text,
  ...extra,
});

const FULL: PlanningAnswer[] = [
  ans("stack", "shell", "Tauri + React"),
  ans("data", "store", "SQLite on the device"),
  ans("auth", "method", "Email magic link with owner and helper roles"),
  ans("money", "payments", "Stripe subscriptions"),
  ans("ai", "provider", "Jev via its API"),
  ans("offline", "mode", "Offline-first with sync"),
  ans("security", "secrets", "Keys in the OS keychain"),
  ans("scale", "users", "Hundreds of users"),
  ans("testing", "suite", "Vitest and Playwright"),
  ans("platforms", "targets", "Desktop, web and mobile"),
];

const ids = (map: MindMap) => Object.keys(map.nodes).sort();

describe("buildMindMap", () => {
  it("is deterministic and ignores answer order", () => {
    const a = buildMindMap("A planner", FULL);
    const b = buildMindMap("A planner", FULL);
    const c = buildMindMap("A planner", [...FULL].reverse());
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("makes a root from the idea, trimmed to 60 characters", () => {
    const map = buildMindMap("  " + "x".repeat(100) + "  ", []);
    expect(map.root).toBe("root");
    expect(map.nodes.root!.kind).toBe("component");
    expect(map.nodes.root!.label.length).toBeLessThanOrEqual(60);
    expect(map.links).toEqual([]);
  });

  it("maps each area to its nodes", () => {
    const map = buildMindMap("A planner", FULL);
    const expected = [
      "component-app-shell",
      "screen-main-layout",
      "integration-framework-tauri-react",
      "data-data-store",
      "data-schema",
      "data-backups",
      "component-sign-in",
      "screen-sign-in-screen",
      "data-users-and-roles",
      "integration-payments",
      "integration-ai-provider",
      "risk-ai-api-outage",
      "component-sync-engine",
      "risk-edit-conflicts",
      "data-local-copy",
      "risk-data-exposure",
      "data-secrets-store",
      "risk-cost-at-scale",
      "component-test-suite",
      "component-release-pipeline",
      "component-web-screens",
      "component-desktop-screens",
      "component-mobile-screens",
      "screen-mobile-home-screen",
    ];
    for (const id of expected) expect(map.nodes[id], id).toBeDefined();
    expect(map.nodes["component-sign-in"]!.from).toEqual(["auth.method"]);
    expect(map.nodes["component-sign-in"]!.children).toEqual(["screen-sign-in-screen", "data-users-and-roles"]);
    expect(map.nodes["risk-ai-api-outage"]!.kind).toBe("risk");
  });

  it("links the root to top-level nodes and parents to children", () => {
    const map = buildMindMap("A planner", FULL);
    expect(map.links).toContainEqual({ from: "root", to: "component-app-shell" });
    expect(map.links).toContainEqual({ from: "component-sign-in", to: "screen-sign-in-screen" });
    for (const node of Object.values(map.nodes)) {
      for (const child of node.children) expect(map.links).toContainEqual({ from: node.id, to: child });
    }
  });

  it("skips declined money, AI, auth and offline", () => {
    const map = buildMindMap("x", [
      ans("money", "payments", "Not in v1"),
      ans("ai", "use", "No AI"),
      ans("auth", "method", "No sign-in"),
      ans("offline", "mode", "Online-only", { choice: "online-only" }),
    ]);
    expect(ids(map)).toEqual(["root"]);
  });

  it("only adds platform screens for platforms mentioned", () => {
    const map = buildMindMap("x", [ans("platforms", "targets", "Web only for now")]);
    expect(map.nodes["component-web-screens"]).toBeDefined();
    expect(map.nodes["component-desktop-screens"]).toBeUndefined();
    expect(map.nodes["component-mobile-screens"]).toBeUndefined();
  });

  it("turns spikes into dated risk nodes", () => {
    const map = buildMindMap("x", [
      ans("data", "store", "Undecided", { spike: { task: "T-3", due: "2026-10-20", risk: "migration later" } }),
    ]);
    const node = map.nodes[nodeId("risk", "Open: data.store")]!;
    expect(node.kind).toBe("risk");
    expect(node.label).toBe("Open: data.store");
    // The spike is not a decision, so the area's components are not built from it.
    expect(map.nodes[nodeId("data", "Data store")]).toBeUndefined();
    expect(Object.values(map.nodes).some((n) => n.label.includes("Spike"))).toBe(false);
    expect(node.note).toContain("2026-10-20");
    expect(node.from).toEqual(["data.store"]);
    expect(map.nodes.root!.children).toContain(node.id);
  });

  it("merges the same node from two answers into one with both question ids", () => {
    const map = buildMindMap("x", [ans("testing", "unit", "Vitest"), ans("testing", "e2e", "Playwright")]);
    expect(map.nodes["component-test-suite"]!.from).toEqual(["testing.e2e", "testing.unit"]);
    expect(map.nodes.root!.children.filter((c) => c === "component-test-suite")).toHaveLength(1);
  });

  it("reads declines", () => {
    expect(isDeclined(ans("money", "p", "Not in v1"))).toBe(true);
    expect(isDeclined(ans("money", "p", "Stripe"))).toBe(false);
    expect(isDeclined(ans("money", "p", "whatever", { choice: "none" }))).toBe(true);
  });
});

describe("editing helpers", () => {
  const base = buildMindMap("A planner", FULL);
  const frozen = JSON.stringify(base);

  it("addNode adds under a parent without mutating", () => {
    const next = addNode(base, { id: "screen-settings", kind: "screen", label: "Settings", from: [], children: [] }, "component-app-shell");
    expect(next.nodes["screen-settings"]).toBeDefined();
    expect(next.nodes["component-app-shell"]!.children).toContain("screen-settings");
    expect(next.links).toContainEqual({ from: "component-app-shell", to: "screen-settings" });
    expect(JSON.stringify(base)).toBe(frozen);
    const top = addNode(base, { id: "data-logs", kind: "data", label: "Logs", from: [], children: [] });
    expect(top.nodes.root!.children).toContain("data-logs");
  });

  it("addNode throws on duplicate id or unknown parent", () => {
    expect(() => addNode(base, { ...base.nodes["component-app-shell"]! })).toThrow(/duplicate/);
    expect(() => addNode(base, { id: "x", kind: "data", label: "X", from: [], children: [] }, "nope")).toThrow(/unknown/);
  });

  it("removeNode drops the node, its own children, links and references", () => {
    const next = removeNode(base, "component-sign-in");
    expect(next.nodes["component-sign-in"]).toBeUndefined();
    expect(next.nodes["screen-sign-in-screen"]).toBeUndefined();
    expect(next.nodes.root!.children).not.toContain("component-sign-in");
    expect(next.links.some((l) => l.from === "component-sign-in" || l.to === "component-sign-in")).toBe(false);
    expect(JSON.stringify(base)).toBe(frozen);
    expect(() => removeNode(base, "nope")).toThrow(/unknown/);
    expect(() => removeNode(base, "root")).toThrow();
  });

  it("renameNode keeps the id", () => {
    const next = renameNode(base, "component-sign-in", "Login");
    expect(next.nodes["component-sign-in"]!.label).toBe("Login");
    expect(base.nodes["component-sign-in"]!.label).toBe("Sign-in");
    expect(() => renameNode(base, "nope", "x")).toThrow(/unknown/);
  });

  it("linkNodes adds a labelled link", () => {
    const next = linkNodes(base, "integration-payments", "component-sign-in", "needs a user");
    expect(next.links).toContainEqual({ from: "integration-payments", to: "component-sign-in", label: "needs a user" });
    expect(next.links.length).toBe(base.links.length + 1);
    expect(JSON.stringify(base)).toBe(frozen);
    expect(() => linkNodes(base, "integration-payments", "nope")).toThrow(/unknown/);
  });
});

describe("toMermaid", () => {
  it("renders a graph with every label and link", () => {
    const map = linkNodes(buildMindMap('A "quoted" planner', FULL), "integration-payments", "component-sign-in", "needs a user");
    const text = toMermaid(map);
    expect(text.startsWith("graph TD")).toBe(true);
    for (const node of Object.values(map.nodes)) expect(text).toContain(node.label.replace(/"/g, "#quot;"));
    expect(text).toContain("needs a user");
    expect(text).not.toMatch(/"A "quoted/);
  });
});
