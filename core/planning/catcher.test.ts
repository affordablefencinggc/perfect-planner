import { describe, expect, it } from "vitest";
import { catchDeferral, findDeferrals, MAX_SPIKE_DAYS, spikeProblem } from "./catcher";

const NOW = new Date("2026-10-09T05:00:00Z");

describe("catchDeferral", () => {
  it.each([
    "TBD",
    "tbd",
    "T.B.D.",
    "TBC",
    "to be decided",
    "We'll figure it out later",
    "later",
    "not sure yet",
    "don't know",
    "eventually",
    "we'll see",
    "maybe Postgres",
    "it depends",
    "defer this",
    "TODO",
    "whatever works",
    "???",
    "?",
    "",
    "   ",
  ])("catches %j", (text) => {
    expect(catchDeferral(text).deferred).toBe(true);
  });

  it.each([
    "Postgres on Supabase",
    "SQLite on device, synced to Postgres",
    "Stripe Checkout, no refunds in v1",
    "Email magic link, owner and helper roles",
    "Tauri desktop app on Windows, macOS and Linux",
    "Not in v1: no payments at all",
    "Latest stable Node",
  ])("accepts a real decision: %j", (text) => {
    expect(catchDeferral(text)).toEqual({ deferred: false, matches: [] });
  });

  it("names what it matched", () => {
    expect(catchDeferral("TBD, we'll figure it out later").matches).toEqual(["TBD", "later", "figure it out"]);
    expect(catchDeferral(undefined).matches).toEqual(["empty"]);
  });
});

describe("findDeferrals", () => {
  it("finds each deferring line with its line number", () => {
    const text = "# Plan\nStack: Tauri + React\nAuth: TBD\n\nPayments: later\nData: SQLite";
    expect(findDeferrals(text)).toEqual([
      { line: 3, text: "Auth: TBD", matches: ["TBD"] },
      { line: 5, text: "Payments: later", matches: ["later"] },
    ]);
  });

  it("handles Windows line endings and empty input", () => {
    expect(findDeferrals("a\r\nb: tbd\r\n").map((h) => h.line)).toEqual([2]);
    expect(findDeferrals("")).toEqual([]);
  });
});

describe("spikeProblem", () => {
  const risk = "Picking the wrong store means migrating every user later on.";
  it("accepts a dated spike with a written risk", () => {
    expect(spikeProblem({ due: "2026-10-16", risk: "Picking the wrong store forces a data migration." }, NOW)).toBeNull();
    expect(spikeProblem({ due: "2026-10-09", risk: "Picking the wrong store forces a data migration." }, NOW)).toBeNull();
  });

  it("refuses a missing, malformed, past or far-off due date", () => {
    expect(spikeProblem(undefined, NOW)).toMatch(/due date and a risk/);
    expect(spikeProblem({ due: "next week", risk: "x".repeat(20) }, NOW)).toMatch(/due date like/);
    expect(spikeProblem({ due: "2026-13-45", risk: "x".repeat(20) }, NOW)).toMatch(/due date like/);
    expect(spikeProblem({ due: "2026-10-01", risk: "Something real breaks here." }, NOW)).toMatch(/already past/);
    expect(spikeProblem({ due: "2027-01-01", risk: "Something real breaks here." }, NOW)).toMatch(`${MAX_SPIKE_DAYS} days`);
  });

  it("refuses an empty or vague risk", () => {
    expect(spikeProblem({ due: "2026-10-16", risk: "" }, NOW)).toMatch(/risk written down/);
    expect(spikeProblem({ due: "2026-10-16", risk }, NOW)).toMatch(/itself vague/);
  });
});
