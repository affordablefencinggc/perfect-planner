import { describe, expect, it } from "vitest";
import { initials, presenceLine, relativeTime, slugify, stageLabel } from "../../src/people/presenceText.js";

const NOW = new Date("2026-10-09T12:00:00Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

describe("relativeTime", () => {
  it("buckets", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("just now");
    expect(relativeTime(ago(3 * 60_000), NOW)).toBe("3 min ago");
    expect(relativeTime(ago(5 * 3600_000), NOW)).toBe("5 h ago");
    expect(relativeTime(ago(49 * 3600_000), NOW)).toBe("2 d ago");
  });
  it("handles future and invalid", () => {
    expect(relativeTime(ago(-5000), NOW)).toBe("just now");
    expect(relativeTime("nope", NOW)).toBe("");
  });
});
describe("initials", () => {
  it("takes first and last word", () => {
    expect(initials("dana lee")).toBe("DL");
    expect(initials("Ann Marie Smith")).toBe("AS");
    expect(initials("eli")).toBe("E");
    expect(initials("  ")).toBe("?");
  });
});
describe("stageLabel", () => { it("capitalises", () => { expect(stageLabel("task")).toBe("Task"); expect(stageLabel("")).toBe(""); }); });
describe("slugify", () => {
  it("makes ids", () => {
    expect(slugify("Dana Lee")).toBe("dana-lee");
    expect(slugify("  José  Ñ!! ")).toBe("jose-n");
    expect(slugify("---")).toBe("");
    expect(slugify("a".repeat(60)).length).toBe(40);
  });
});
describe("presenceLine", () => {
  const m = { person: "dana", presence: { at: ago(3 * 60_000), stage: "task", subject: "T-14", summary: "Wrote tests", via: "dana" } };
  it("formats", () => expect(presenceLine(m, NOW)).toBe("On T-14 · Task stage · 3 min ago — Wrote tests"));
  it("shows via agent", () => expect(presenceLine({ ...m, presence: { ...m.presence, via: "agent-1" } }, NOW)).toBe("On T-14 · Task stage · 3 min ago · via agent-1 — Wrote tests"));
  it("no presence", () => expect(presenceLine({ person: "x" }, NOW)).toBe("No activity yet"));
});
