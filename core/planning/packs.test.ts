import { describe, it, expect } from "vitest";
import { AREAS } from "./types";
import type { IdeaProfile } from "./types";
import { PACKS, packFor, questionsFor, findQuestion } from "./packs";
import { profileIdea, SIGNALS } from "./profile";

const blank: IdeaProfile = { idea: "", signals: [], known: {}, team: "solo" };
const withSignals = (...signals: string[]): IdeaProfile => ({ ...blank, signals });

const profiles: IdeaProfile[] = [
  blank,
  ...Object.keys(SIGNALS).map((s) => withSignals(s)),
  { ...withSignals("offline", "team", "ai", "payments", "desktop", "web", "mobile", "personal-data"), team: "team" },
];

describe("packs", () => {
  it("has ten packs, one per area, in order", () => {
    expect(PACKS.map((p) => p.area)).toEqual([...AREAS]);
    for (const area of AREAS) expect(packFor(area).area).toBe(area);
  });

  it("builds well formed questions for every profile", () => {
    for (const profile of profiles) {
      const ids = new Set<string>();
      for (const pack of PACKS) {
        const qs = pack.questions(profile);
        expect(qs.length).toBeGreaterThanOrEqual(3);
        expect(qs.length).toBeLessThanOrEqual(4);
        expect(qs.some((q) => q.blocking)).toBe(true);
        for (const q of qs) {
          expect(ids.has(q.id)).toBe(false);
          ids.add(q.id);
          expect(q.area).toBe(pack.area);
          expect(q.id.startsWith(`${pack.area}.`)).toBe(true);
          expect(q.options.length).toBeGreaterThanOrEqual(2);
          expect(q.options.length).toBeLessThanOrEqual(4);
          const optIds = q.options.map((o) => o.id);
          expect(new Set(optIds).size).toBe(optIds.length);
          for (const id of optIds) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
          expect(optIds).toContain(q.recommendation.option);
          expect(q.recommendation.confidence).toBeGreaterThanOrEqual(0);
          expect(q.recommendation.confidence).toBeLessThanOrEqual(1);
          expect(q.recommendation.reason.length).toBeGreaterThan(0);
          expect(q.why.length).toBeGreaterThan(0);
          expect(JSON.stringify(q)).not.toContain("—");
        }
      }
    }
  });
});

describe("signals change recommendations", () => {
  const rec = (p: IdeaProfile, id: string) => findQuestion(p, id)!;

  it("offline picks local-first SQLite and makes conflicts blocking", () => {
    expect(rec(blank, "data.store").recommendation.option).toBe("postgres");
    expect(rec(blank, "offline.conflicts").blocking).toBe(false);
    const p = withSignals("offline");
    expect(rec(p, "data.store").recommendation.option).toBe("sqlite-sync");
    expect(rec(p, "offline.required").recommendation.option).toBe("full-offline");
    expect(rec(p, "offline.conflicts").blocking).toBe(true);
  });

  it("payments picks Stripe Checkout and makes money blocking", () => {
    expect(rec(blank, "money.payments").recommendation.option).toBe("not-v1");
    expect(rec(blank, "money.pricing").blocking).toBe(false);
    const p = withSignals("payments");
    const q = rec(p, "money.payments");
    expect(q.recommendation.option).toBe("stripe-checkout");
    expect(q.recommendation.confidence).toBeGreaterThan(rec(blank, "money.payments").recommendation.confidence);
    expect(rec(p, "money.pricing").blocking).toBe(true);
    expect(rec(p, "money.tax-refunds").blocking).toBe(true);
  });

  it("ai makes model, fallback and cost cap blocking", () => {
    expect(rec(blank, "ai.use").recommendation.option).toBe("no");
    for (const id of ["ai.model", "ai.fallback", "ai.cost-cap"]) expect(rec(blank, id).blocking).toBe(false);
    const p = withSignals("ai");
    expect(rec(p, "ai.use").recommendation.option).toBe("core");
    for (const id of ["ai.model", "ai.fallback", "ai.cost-cap"]) expect(rec(p, id).blocking).toBe(true);
  });

  it("desktop picks Tauri, mobile picks Expo", () => {
    expect(rec(withSignals("desktop"), "platforms.desktop-shell").recommendation.option).toBe("tauri");
    expect(rec(withSignals("desktop"), "platforms.first").recommendation.option).toBe("desktop");
    expect(rec(withSignals("mobile"), "platforms.mobile-stack").recommendation.option).toBe("expo");
    expect(rec(blank, "platforms.desktop-shell").recommendation.option).toBe("none");
  });

  it("personal data makes encryption and minimisation blocking", () => {
    const p = withSignals("personal-data");
    expect(rec(p, "security.encryption").blocking).toBe(true);
    expect(rec(p, "security.encryption").recommendation.option).toBe("field-level");
    expect(rec(p, "security.personal-data").recommendation.option).toBe("store-minimum");
    expect(rec(blank, "security.encryption").blocking).toBe(false);
  });
});

describe("questionsFor", () => {
  it("returns every question in area order", () => {
    const qs = questionsFor(blank);
    const order = qs.map((q) => AREAS.indexOf(q.area));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(qs.map((q) => q.area)).size).toBe(10);
  });

  it("skips questions the scan already answered", () => {
    const all = questionsFor(blank);
    const known = { "stack.language": "typescript", "data.store": "postgres" };
    const qs = questionsFor({ ...blank, known });
    expect(qs.length).toBe(all.length - 2);
    expect(qs.map((q) => q.id)).not.toContain("stack.language");
    expect(qs.map((q) => q.id)).not.toContain("data.store");
    expect(findQuestion({ ...blank, known }, "data.store")).toBeDefined();
    expect(findQuestion(blank, "nope.thing")).toBeUndefined();
  });
});

describe("profileIdea", () => {
  it("detects signals by keyword", () => {
    const p = profileIdea("An offline-first Windows app with Stripe billing and a Claude agent for customer emails");
    for (const s of ["offline", "payments", "ai", "desktop", "personal-data"]) expect(p.signals).toContain(s);
    expect(p.signals).not.toContain("mobile");
    expect(p.team).toBe("solo");
  });

  it("matches whole words only", () => {
    expect(profileIdea("maintain a paid list").signals).not.toContain("ai");
    expect(profileIdea("a webhook relay").signals).not.toContain("web");
    expect(profileIdea("planner with AI agents").signals).toContain("ai");
  });

  it("sets team from the signal or the option", () => {
    expect(profileIdea("solo dev who can add helpers").team).toBe("team");
    expect(profileIdea("a todo list").team).toBe("solo");
    expect(profileIdea("a todo list", { team: "team" }).team).toBe("team");
    expect(profileIdea("x", { known: { "data.store": "postgres" } }).known).toEqual({ "data.store": "postgres" });
  });

  it("an empty idea still gets all ten areas with low confidence", () => {
    const p = profileIdea("");
    expect(p.signals).toEqual([]);
    const qs = questionsFor(p);
    expect(new Set(qs.map((q) => q.area)).size).toBe(10);
    for (const area of AREAS) {
      const blocker = qs.find((q) => q.area === area && q.blocking)!;
      expect(blocker.recommendation.confidence).toBeLessThanOrEqual(0.6);
    }
  });
});
