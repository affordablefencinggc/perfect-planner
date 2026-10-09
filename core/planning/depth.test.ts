import { describe, it, expect } from "vitest";
import { CONTRADICTION_RULES, depthCheck } from "./depth";
import { addNode, buildMindMap } from "./mindmap";
import type { Area, PlanningAnswer } from "./types";

const ans = (area: Area, slug: string, text: string, extra: Partial<PlanningAnswer> = {}): PlanningAnswer => ({
  questionId: `${area}.${slug}`,
  area,
  q: `Question about ${area}`,
  choice: "custom",
  text,
  ...extra,
});

const CLEAN: PlanningAnswer[] = [
  ans("stack", "shell", "Tauri 2 with React, mobile builds later"),
  ans("data", "store", "SQLite on the device, synced to Postgres"),
  ans("auth", "method", "Email magic link with owner and helper roles"),
  ans("money", "payments", "Stripe"),
  ans("money", "pricing", "Subscription, $8 per month"),
  ans("ai", "provider", "Jev"),
  ans("offline", "mode", "Offline-first"),
  ans("security", "secrets", "Keys in the OS keychain"),
  ans("scale", "users", "Hundreds of users"),
  ans("testing", "suite", "Vitest"),
  ans("platforms", "targets", "Desktop first, then web and mobile"),
];

const check = (answers: PlanningAnswer[]) => depthCheck(buildMindMap("idea", answers), answers);
const contradictions = (answers: PlanningAnswer[]) => check(answers).filter((f) => f.kind === "contradiction");

describe("depthCheck", () => {
  it("finds nothing in a clean, consistent plan", () => {
    expect(check(CLEAN)).toEqual([]);
  });

  it("flags component nodes with no children as shallow", () => {
    const map = addNode(buildMindMap("idea", CLEAN), { id: "component-reports", kind: "component", label: "Reports", from: ["x.y"], children: [] });
    const findings = depthCheck(map, CLEAN);
    expect(findings).toEqual([
      { kind: "shallow", message: expect.stringContaining("Reports"), nodes: ["component-reports"], questions: ["x.y"] },
    ]);
  });

  it("does not flag the root or non-component leaves", () => {
    const findings = depthCheck(buildMindMap("idea", []), []);
    expect(findings).toEqual([]);
  });

  it("offline-first with a server-only store", () => {
    const answers = [ans("offline", "mode", "Offline-first"), ans("data", "store", "Postgres, server-only")];
    const found = contradictions(answers);
    expect(found).toHaveLength(1);
    expect(found[0]!.questions).toEqual(["data.store", "offline.mode"]);
    expect(found[0]!.nodes).toContain("component-sync-engine");
    expect(found[0]!.nodes).toContain("data-data-store");
  });

  it("no sign-in with roles", () => {
    const found = contradictions([ans("auth", "method", "No sign-in"), ans("security", "access", "Admins and editors have different permissions")]);
    expect(found.map((f) => f.questions)).toEqual([["auth.method", "security.access"]]);
  });

  it("no sign-in with payments", () => {
    const found = contradictions([ans("auth", "method", "Anonymous, no accounts"), ans("money", "payments", "Stripe checkout")]);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toMatch(/sign-in/);
  });

  it("payments not in v1 while pricing chosen", () => {
    const found = contradictions([ans("money", "payments", "Not in v1"), ans("money", "pricing", "Subscription, $8 per month")]);
    expect(found.map((f) => f.questions)).toEqual([["money.payments", "money.pricing"]]);
  });

  it("AI not used while a provider is chosen", () => {
    const found = contradictions([ans("ai", "use", "No AI", { choice: "none" }), ans("ai", "provider", "Anthropic Claude")]);
    expect(found.map((f) => f.questions)).toEqual([["ai.provider", "ai.use"]]);
  });

  it("mobile first with a desktop-only shell", () => {
    const found = contradictions([ans("platforms", "targets", "Mobile first, web later"), ans("stack", "shell", "Electron")]);
    expect(found.map((f) => f.questions)).toEqual([["platforms.targets", "stack.shell"]]);
    expect(contradictions([ans("platforms", "targets", "Mobile first"), ans("stack", "shell", "Tauri 2 with iOS and Android builds")])).toEqual([]);
    expect(contradictions([ans("platforms", "targets", "Desktop, then mobile"), ans("stack", "shell", "Electron")])).toEqual([]);
  });

  it("each rule fires on its own fixture and the table is exported", () => {
    expect(CONTRADICTION_RULES.map((r) => r.id)).toEqual([
      "offline-vs-server-only",
      "no-sign-in-vs-roles-or-payments",
      "no-payments-vs-pricing",
      "no-ai-vs-ai-provider",
      "mobile-first-vs-desktop-shell",
    ]);
    for (const rule of CONTRADICTION_RULES) expect(rule.check(CLEAN)).toBeNull();
  });
});
