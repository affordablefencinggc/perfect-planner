import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore } from "../ledger/index";
import { MAX_NOTICES, Relay } from "./relay";

async function relay() {
  return new Relay({ ledger: await Ledger.open(new MemoryStore()) });
}

describe("relay notices", () => {
  it("shows each notice once to each person's main chat, in order, and also as a line", async () => {
    const r = await relay();
    r.addNotice({ kind: "collision", tasks: ["T-3", "T-5"], text: "T-3 and T-5 both changed src/a.ts." });
    r.addNotice({ kind: "stalled", tasks: ["T-4"], text: "T-4 has not changed anything for 15 minutes." });
    const first = r.digest("owner");
    expect(first.notices.map((n) => [n.id, n.kind, n.tasks, n.text])).toEqual([
      ["N-1", "collision", ["T-3", "T-5"], "T-3 and T-5 both changed src/a.ts."],
      ["N-2", "stalled", ["T-4"], "T-4 has not changed anything for 15 minutes."],
    ]);
    expect(first.lines).toEqual(["T-3 and T-5 both changed src/a.ts.", "T-4 has not changed anything for 15 minutes."]);
    expect(first.open).toBe(0);
    const again = r.digest("owner");
    expect([again.notices, again.lines]).toEqual([[], []]);
    // Another person's main chat has its own pointer.
    expect(r.digest("helper").notices).toHaveLength(2);
    r.addNotice({ kind: "commits", tasks: ["T-4"], text: "T-4 committed \"x\" (abc1234)." });
    expect(r.digest("owner").notices.map((n) => n.id)).toEqual(["N-3"]);
    expect(r.digest("helper").notices.map((n) => n.id)).toEqual(["N-3"]);
  });

  it("keeps questions first and puts notices after them", async () => {
    const r = await relay();
    await r.ask({ kind: "agent", id: "w1", model: "m" }, "owner", { task: "T-1", question: "Which date format?" });
    r.addNotice({ kind: "collision", tasks: ["T-1", "T-2"], text: "T-1 and T-2 both changed a.ts." });
    const digest = r.digest("owner");
    expect(digest.lines).toEqual(["Q-1 (T-1) Which date format?", "T-1 and T-2 both changed a.ts."]);
    expect(digest.open).toBe(1);
  });

  it("redacts secrets, flattens whitespace and clips; refuses an empty notice", async () => {
    const r = await relay();
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    r.addNotice({ kind: "commits", tasks: ["T-1"], text: `T-1 committed\n"fix ${key}"   ${"x".repeat(600)}` });
    const [notice] = r.digest("owner").notices;
    expect(notice!.text).not.toContain(key);
    expect(notice!.text).not.toContain("\n");
    expect(notice!.text.length).toBeLessThanOrEqual(400);
    expect(() => r.addNotice({ kind: "commits", tasks: [], text: "  \n " })).toThrow(/some words/);
  });

  it("counts the notices that fell off the end unread instead of losing them silently", async () => {
    const r = await relay();
    r.addNotice({ kind: "commits", tasks: ["T-1"], text: "seen" });
    r.digest("owner");
    for (let i = 0; i < MAX_NOTICES + 10; i += 1) r.addNotice({ kind: "commits", tasks: ["T-1"], text: `commit ${i}` });
    const digest = r.digest("owner");
    expect(digest.notices).toHaveLength(MAX_NOTICES + 1);
    expect(digest.notices[0]).toMatchObject({ kind: "problem", text: expect.stringContaining("10 older notices") });
    expect(digest.notices[1]!.text).toBe("commit 10");
    // A person who never looked is told how many of the very first ones are gone too.
    expect(r.digest("helper").notices[0]!.text).toContain("11 older notices");
  });

  it("returns copies: changing what you were handed changes nothing stored", async () => {
    const r = await relay();
    const made = r.addNotice({ kind: "collision", tasks: ["T-1", "T-2"], text: "T-1 and T-2 both changed a.ts." });
    made.tasks.push("T-9");
    expect(r.digest("owner").notices[0]!.tasks).toEqual(["T-1", "T-2"]);
  });
});
