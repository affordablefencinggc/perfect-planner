import { describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore, type Actor, type EntryDraft, type LedgerEntry } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import {
  addMember,
  buildPeopleView,
  changeMember,
  claimOwnership,
  clearPhoto,
  docId,
  installPeopleRules,
  MemoryPhotoStore,
  parsePeopleEvent,
  peopleEvent,
  PeopleError,
  photoSources,
  removeDoc,
  removeMember,
  setPhoto,
  shareDoc,
  stageOf,
  type PhotoStore,
} from "./index";

const owner: Actor = { kind: "person", id: "looplet-spare" };
const mia: Actor = { kind: "person", id: "mia" };
const sam: Actor = { kind: "person", id: "sam" };
const stranger: Actor = { kind: "person", id: "stranger" };
const miasAgent: Actor = { kind: "agent", id: "mia-worker", model: "claude-x" };
const ownersAgent: Actor = { kind: "agent", id: "claude-code", model: "claude-x" };

function clock(start = "2026-10-09T02:00:00Z", stepMs = 60_000): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += stepMs) - stepMs);
}

function open(): Ledger {
  const ledger = Ledger.openSync(new MemoryStore(), { now: clock() });
  installNumberingRules(ledger);
  installPeopleRules(ledger);
  return ledger;
}

/** A project with an owner, Mia as a helper (with an agent) and Sam as a viewer. */
function team(): Ledger {
  const ledger = open();
  claimOwnership(ledger, owner, "Looplet Spare");
  addMember(ledger, owner, { person: "mia", name: "Mia", role: "helper", agents: ["mia-worker"] });
  addMember(ledger, owner, { person: "sam", name: "Sam", role: "viewer" });
  return ledger;
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerError && error.code === "RULE") return error.message;
    throw error;
  }
  throw new Error("expected the ledger to refuse");
}

function createTask(ledger: Ledger, actor: Actor = owner): LedgerEntry {
  return appendNumbered(ledger, { actor, type: "task.created", summary: "Build the login screen", evidence: [], refs: [] });
}

function write(ledger: Ledger, draft: Partial<EntryDraft> & Pick<EntryDraft, "actor" | "type" | "subject">): LedgerEntry {
  return ledger.append({ summary: "Something happened", ...draft });
}

const png = (size = 64, fill = 1) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

describe("people events", () => {
  it("ride on decision.made, numbered D-n, with a reason", () => {
    const ledger = open();
    const entry = claimOwnership(ledger, owner, "Looplet Spare");
    expect(entry.type).toBe("decision.made");
    expect(entry.subject).toBe("D-1");
    expect(entry.reason).toBeTruthy();
    expect(peopleEvent(entry)).toEqual({ op: "member.added", person: "looplet-spare", name: "Looplet Spare", role: "owner" });
    expect(addMember(ledger, owner, { person: "mia", name: "Mia", role: "helper" }).subject).toBe("D-2");
  });

  it("are covered by the fingerprint chain like any other entry", () => {
    const ledger = team();
    const entries = ledger.entries();
    expect(entries.every((e, i) => i === 0 || e.prev === entries[i - 1]!.hash)).toBe(true);
  });

  it("parse only well-formed payloads", () => {
    expect(parsePeopleEvent({ op: "member.added", person: "mia", name: "Mia", role: "helper" })).toBeTruthy();
    expect(parsePeopleEvent({ op: "member.added", person: "Mia", name: "Mia", role: "helper" })).toBeUndefined();
    expect(parsePeopleEvent({ op: "member.added", person: "mia", name: " ", role: "helper" })).toBeUndefined();
    expect(parsePeopleEvent({ op: "member.added", person: "mia", name: "Mia", role: "boss" })).toBeUndefined();
    expect(parsePeopleEvent({ op: "member.added", person: "mia", name: "Mia", role: "helper", approves: ["deploy"] })).toBeUndefined();
    expect(parsePeopleEvent({ op: "member.changed", person: "mia" })).toBeUndefined();
    expect(parsePeopleEvent({ op: "photo.set", person: "mia", file: "x", sha256: "nothex", bytes: 10, mime: "image/png" })).toBeUndefined();
    expect(parsePeopleEvent({ op: "photo.set", person: "mia", file: "x", sha256: "a".repeat(64), bytes: 10, mime: "image/svg+xml" })).toBeUndefined();
    expect(parsePeopleEvent({ op: "doc.shared", doc: "spec", title: "Spec", path: "" })).toBeUndefined();
    expect(parsePeopleEvent({ op: "launch" })).toBeUndefined();
    expect(parsePeopleEvent(null)).toBeUndefined();
    expect(parsePeopleEvent([])).toBeUndefined();
  });

  it("ignores decision.made entries that are ordinary decisions", () => {
    const ledger = team();
    const decision = appendNumbered(ledger, { actor: owner, type: "decision.made", summary: "Use SQLite", reason: "Simple", evidence: [], refs: [] });
    expect(peopleEvent(decision)).toBeUndefined();
    expect(stageOf(decision)).toBe("relay");
    expect(buildPeopleView(ledger.entries()).members).toHaveLength(3);
  });
});

describe("solo first", () => {
  it("restricts nobody until the first member is added", () => {
    const ledger = open();
    createTask(ledger, stranger);
    write(ledger, { actor: stranger, type: "test.defined", subject: "T-1", data: { test: "npm test" } });
    write(ledger, { actor: stranger, type: "test.approved", subject: "T-1", data: { test: "npm test" } });
    expect(ledger.entries()).toHaveLength(3);
    expect(buildPeopleView(ledger.entries())).toEqual({ members: [], docs: [], head: "L-000003" });
  });

  it("lets a solo person share documents before setting up a roster", () => {
    const ledger = open();
    shareDoc(ledger, owner, { title: "Product brief", path: "docs/brief.md" });
    expect(buildPeopleView(ledger.entries()).docs.map((d) => d.title)).toEqual(["Product brief"]);
  });

  it("makes the first member the owner, and only of themselves", () => {
    const ledger = open();
    expect(refusal(() => addMember(ledger, owner, { person: "looplet-spare", name: "L", role: "helper" }))).toMatch(/first member .* owner/);
    expect(refusal(() => addMember(ledger, owner, { person: "mia", name: "Mia", role: "owner" }))).toMatch(/adds themselves first/);
    expect(refusal(() => claimOwnership(ledger, ownersAgent, "Agent"))).toMatch(/only a person/);
    claimOwnership(ledger, owner, "Looplet Spare");
    expect(buildPeopleView(ledger.entries()).owner?.person).toBe("looplet-spare");
  });
});

describe("membership rules", () => {
  it("lets only the owner add, change and remove people", () => {
    const ledger = team();
    expect(refusal(() => addMember(ledger, mia, { person: "kai", name: "Kai", role: "helper" }))).toMatch(/only the owner adds/);
    expect(refusal(() => changeMember(ledger, mia, "sam", { role: "helper" }))).toMatch(/only the owner changes/);
    expect(refusal(() => removeMember(ledger, mia, "sam"))).toMatch(/only the owner removes/);
    expect(refusal(() => addMember(ledger, stranger, { person: "kai", name: "Kai", role: "helper" }))).toMatch(/only the owner/);
  });

  it("keeps exactly one owner", () => {
    const ledger = team();
    expect(refusal(() => addMember(ledger, owner, { person: "kai", name: "Kai", role: "owner" }))).toMatch(/one owner/);
    expect(refusal(() => changeMember(ledger, owner, "mia", { role: "owner" }))).toMatch(/one owner/);
    expect(refusal(() => changeMember(ledger, owner, "looplet-spare", { role: "helper" }))).toMatch(/owner's role/);
    expect(refusal(() => removeMember(ledger, owner, "looplet-spare"))).toMatch(/owner cannot be removed/);
  });

  it("refuses duplicates and unknown people", () => {
    const ledger = team();
    expect(refusal(() => addMember(ledger, owner, { person: "mia", name: "Mia again", role: "helper" }))).toMatch(/already on the project/);
    expect(refusal(() => changeMember(ledger, owner, "kai", { role: "helper" }))).toMatch(/not on the project/);
    expect(refusal(() => removeMember(ledger, owner, "kai"))).toMatch(/not on the project/);
  });

  it("gives approvals to helpers only", () => {
    const ledger = team();
    expect(refusal(() => addMember(ledger, owner, { person: "kai", name: "Kai", role: "viewer", approves: ["test"] }))).toMatch(/viewer cannot approve/);
    expect(refusal(() => changeMember(ledger, owner, "sam", { approves: ["test"] }))).toMatch(/viewer has no approvals/);
    changeMember(ledger, owner, "mia", { approves: ["test", "review"] });
    expect(buildPeopleView(ledger.entries()).members.find((m) => m.person === "mia")?.approves).toEqual(["test", "review"]);
    changeMember(ledger, owner, "mia", { role: "viewer" });
    expect(buildPeopleView(ledger.entries()).members.find((m) => m.person === "mia")?.approves).toEqual([]);
  });

  it("refuses malformed people payloads written by hand", () => {
    const ledger = team();
    const bad = { actor: owner, type: "decision.made" as const, subject: "D-4", summary: "x", reason: "x", data: { people: { op: "member.added", person: "../etc" } } };
    expect(refusal(() => ledger.append(bad))).toMatch(/not a valid people event/);
  });

  it("validates ids before writing anything", () => {
    const ledger = team();
    expect(() => addMember(ledger, owner, { person: "Bad Id", name: "Bad", role: "helper" })).toThrow(PeopleError);
    expect(() => shareDoc(ledger, owner, { doc: "../x", title: "X", path: "x.md" })).toThrow(PeopleError);
    expect(ledger.entries()).toHaveLength(3);
  });
});

describe("what each role may write", () => {
  it("stops people who are not on the project", () => {
    const ledger = team();
    expect(refusal(() => createTask(ledger, stranger))).toMatch(/stranger is not a member/);
  });

  it("makes viewers read-only, including their agents", () => {
    const ledger = team();
    changeMember(ledger, owner, "sam", { agents: ["sam-bot"] });
    createTask(ledger);
    expect(refusal(() => createTask(ledger, sam))).toMatch(/viewer/);
    expect(refusal(() => write(ledger, { actor: { kind: "agent", id: "sam-bot", model: "m" }, type: "task.progress", subject: "T-1" }))).toMatch(/working for sam/);
  });

  it("lets helpers claim and progress tasks but approve only what the owner granted", () => {
    const ledger = team();
    createTask(ledger);
    write(ledger, { actor: mia, type: "task.claimed", subject: "T-1" });
    write(ledger, { actor: mia, type: "test.defined", subject: "T-1", data: { test: "npm test" } });
    expect(refusal(() => write(ledger, { actor: mia, type: "test.approved", subject: "T-1", data: { test: "npm test" } }))).toMatch(/without test approval/);
    write(ledger, { actor: miasAgent, type: "task.progress", subject: "T-1" });
    changeMember(ledger, owner, "mia", { approves: ["test"] });
    // The ledger never lets an agent approve, whatever its person may do.
    expect(() => write(ledger, { actor: miasAgent, type: "test.approved", subject: "T-1", data: { test: "npm test" } })).toThrow(
      expect.objectContaining({ code: "NOT_PERMITTED" }),
    );
    write(ledger, { actor: mia, type: "test.approved", subject: "T-1", data: { test: "npm test" } });
    expect(refusal(() => appendNumbered(ledger, { actor: mia, type: "plan.approved", summary: "Plan", evidence: [], refs: [] }))).toMatch(/plan approval/);
  });

  it("leaves the owner, unlisted agents, Jev and the watcher alone", () => {
    const ledger = team();
    createTask(ledger, owner);
    write(ledger, { actor: ownersAgent, type: "task.progress", subject: "T-1" });
    write(ledger, { actor: { kind: "jev", id: "jev", model: "jev-1" }, type: "review.verdict", subject: "T-1" });
    write(ledger, { actor: { kind: "system", id: "watcher" }, type: "commit.observed", subject: "T-1", data: { sha: "abc1234" } });
    expect(ledger.entries()).toHaveLength(7);
  });

  it("closes the door on removed members", () => {
    const ledger = team();
    createTask(ledger);
    removeMember(ledger, owner, "mia", "Finished her part");
    expect(refusal(() => createTask(ledger, mia))).toMatch(/not a member/);
    expect(refusal(() => write(ledger, { actor: miasAgent, type: "task.progress", subject: "T-1" }))).toMatch(/has left the project/);
  });
});

describe("profile photos", () => {
  it("stores a local photo and records its fingerprint", () => {
    const ledger = team();
    const store = new MemoryPhotoStore();
    const entry = setPhoto(ledger, store, mia, "mia", png());
    const event = peopleEvent(entry);
    expect(event).toMatchObject({ op: "photo.set", person: "mia", mime: "image/png", bytes: 64 });
    expect(entry.evidence[0]).toMatch(/^file:\.perfect-planner\/people\/photos\/mia-[0-9a-f]{12}\.png$/);
    const view = buildPeopleView(ledger.entries());
    const member = view.members.find((m) => m.person === "mia")!;
    expect(member.photo?.entry).toBe(entry.n);
    expect(photoSources(view, store).mia).toMatch(/^data:image\/png;base64,/);
  });

  it("lets people set their own photo, and the owner set anyone's", () => {
    const ledger = team();
    const store = new MemoryPhotoStore();
    expect(refusal(() => setPhoto(ledger, store, mia, "sam", png()))).toMatch(/their own photo/);
    setPhoto(ledger, store, owner, "sam", png());
    setPhoto(ledger, store, sam, "sam", png(64, 2));
    expect(refusal(() => setPhoto(ledger, store, stranger, "stranger", png()))).toMatch(/not on the project/);
  });

  it("writes no file when the ledger refuses", () => {
    const ledger = team();
    const saved: string[] = [];
    const store: PhotoStore = { save: (file) => void saved.push(file), load: () => undefined };
    refusal(() => setPhoto(ledger, store, mia, "sam", png()));
    expect(saved).toEqual([]);
  });

  it("clears the photo again when the file cannot be saved", () => {
    const ledger = team();
    const store: PhotoStore = { save: () => { throw new Error("disk full"); }, load: () => undefined };
    expect(() => setPhoto(ledger, store, mia, "mia", png())).toThrow("disk full");
    expect(peopleEvent(ledger.last()!)).toEqual({ op: "photo.cleared", person: "mia" });
    expect(buildPeopleView(ledger.entries()).members.find((m) => m.person === "mia")?.photo).toBeUndefined();
  });

  it("refuses oversized and non-image files before anything is written", () => {
    const ledger = team();
    const store = new MemoryPhotoStore();
    expect(() => setPhoto(ledger, store, mia, "mia", png(512 * 1024 + 1))).toThrow(PeopleError);
    expect(() => setPhoto(ledger, store, mia, "mia", new TextEncoder().encode("<svg onload=alert(1)>"))).toThrow(PeopleError);
    expect(ledger.entries()).toHaveLength(3);
  });

  it("refuses a hand-written photo entry that points outside the photo folder", () => {
    const ledger = team();
    const sha = "a".repeat(64);
    const people = { op: "photo.set", person: "mia", file: "../../secrets.png", sha256: sha, bytes: 10, mime: "image/png" };
    expect(refusal(() => ledger.append({ actor: mia, type: "decision.made", subject: "D-4", summary: "x", reason: "x", data: { people } }))).toMatch(/a photo lives at/);
    const other = { ...people, file: `.perfect-planner/people/photos/sam-${sha.slice(0, 12)}.png` };
    expect(refusal(() => ledger.append({ actor: mia, type: "decision.made", subject: "D-4", summary: "x", reason: "x", data: { people: other } }))).toMatch(/a photo lives at/);
    const mismatch = { ...people, file: ".perfect-planner/people/photos/mia-bbbbbbbbbbbb.png" };
    expect(refusal(() => ledger.append({ actor: mia, type: "decision.made", subject: "D-4", summary: "x", reason: "x", data: { people: mismatch } }))).toMatch(/fingerprint/);
  });

  it("hides a photo that was altered on disk, and forgets a cleared one", () => {
    const ledger = team();
    const store = new MemoryPhotoStore();
    const entry = setPhoto(ledger, store, mia, "mia", png());
    store.save(entry.evidence[0]!.slice("file:".length), png(64, 9));
    expect(photoSources(buildPeopleView(ledger.entries()), store)).toEqual({});
    clearPhoto(ledger, mia, "mia");
    expect(buildPeopleView(ledger.entries()).members.find((m) => m.person === "mia")?.photo).toBeUndefined();
  });
});

describe("where everyone is", () => {
  it("reads each member's presence from their latest entry, or their agents'", () => {
    const ledger = team();
    createTask(ledger);
    createTask(ledger);
    write(ledger, { actor: mia, type: "task.claimed", subject: "T-1", summary: "Mia took the login screen" });
    write(ledger, { actor: miasAgent, type: "task.blocked", subject: "T-1", summary: "Waiting on the login API" });
    write(ledger, { actor: owner, type: "question.asked", subject: "Q-1", summary: "Which font?", data: { task: "T-2" } });
    const view = buildPeopleView(ledger.entries());
    const by = Object.fromEntries(view.members.map((m) => [m.person, m.presence]));
    expect(by.mia).toMatchObject({ stage: "task", subject: "T-1", task: "T-1", via: "mia-worker", summary: "Waiting on the login API" });
    expect(by["looplet-spare"]).toMatchObject({ stage: "relay", subject: "Q-1", via: "looplet-spare", task: "T-2" });
    expect(by.sam).toBeUndefined();
  });

  it("drops the task once it is done, and brings it back when reopened", () => {
    const ledger = team();
    changeMember(ledger, owner, "mia", { approves: ["test"] });
    createTask(ledger);
    write(ledger, { actor: mia, type: "task.claimed", subject: "T-1" });
    write(ledger, { actor: mia, type: "test.defined", subject: "T-1", data: { test: "npm test" } });
    write(ledger, { actor: mia, type: "test.approved", subject: "T-1", data: { test: "npm test" } });
    write(ledger, { actor: mia, type: "test.passed", subject: "T-1", data: { test: "npm test" } });
    write(ledger, { actor: mia, type: "task.done", subject: "T-1" });
    let mias = buildPeopleView(ledger.entries()).members.find((m) => m.person === "mia")!;
    expect(mias.presence).toMatchObject({ stage: "task", type: "task.done" });
    expect(mias.presence?.task).toBeUndefined();
    write(ledger, { actor: owner, type: "task.reopened", subject: "T-1", reason: "Broke on Mac" });
    mias = buildPeopleView(ledger.entries()).members.find((m) => m.person === "mia")!;
    expect(mias.presence?.task).toBe("T-1");
  });

  it("prefers work over profile changes, but shows profile changes for newcomers", () => {
    const ledger = team();
    const store = new MemoryPhotoStore();
    createTask(ledger);
    write(ledger, { actor: mia, type: "task.progress", subject: "T-1", summary: "Halfway" });
    setPhoto(ledger, store, mia, "mia", png());
    setPhoto(ledger, store, sam, "sam", png());
    const by = Object.fromEntries(buildPeopleView(ledger.entries()).members.map((m) => [m.person, m.presence]));
    expect(by.mia).toMatchObject({ stage: "task", summary: "Halfway" });
    expect(by.sam).toMatchObject({ stage: "people" });
  });

  it("maps every entry type to a core-loop stage", () => {
    const cases: [EntryDraft["type"], string][] = [
      ["plan.approved", "plan"], ["clause.changed", "plan"], ["task.blocked", "task"], ["question.answered", "relay"],
      ["worktree.created", "git"], ["collision.detected", "git"], ["merge.done", "git"], ["test.failed", "proof"],
      ["review.verdict", "proof"], ["release.cut", "release"], ["budget.warning", "housekeeping"], ["correction", "housekeeping"],
    ];
    for (const [type, stage] of cases) expect(stageOf({ type })).toBe(stage);
  });
});

describe("shared original documents", () => {
  it("shows the latest plan with its clauses to everyone", () => {
    const ledger = team();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "First plan", evidence: [], refs: [] });
    write(ledger, { actor: owner, type: "clause.added", subject: "P-1 §1" });
    write(ledger, { actor: owner, type: "clause.added", subject: "P-1 §2" });
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Second plan", evidence: [], refs: [], data: { title: "Perfect Planner plan", path: "docs/plan.md" } });
    write(ledger, { actor: owner, type: "clause.added", subject: "P-2 §3" });
    write(ledger, { actor: owner, type: "clause.withdrawn", subject: "P-2 §1", reason: "Dropped" });
    const [plan] = buildPeopleView(ledger.entries()).docs;
    expect(plan).toMatchObject({ doc: "plan", kind: "plan", version: "P-2", title: "Perfect Planner plan", path: "docs/plan.md", sharedBy: "looplet-spare" });
    expect(plan!.clauses).toEqual(["§2", "§3"]);
  });

  it("lists owner-shared documents with versions, and removes them", () => {
    const ledger = team();
    const first = shareDoc(ledger, owner, { title: "Core specs", path: "specs/CORE-SPECS.md", clauses: ["§1", "§2"] });
    expect(first.summary).toBe("Core specs shared with the project");
    expect(first.evidence).toEqual(["file:specs/CORE-SPECS.md"]);
    shareDoc(ledger, owner, { title: "Core specs", path: "specs/CORE-SPECS.md", clauses: ["§1", "§2", "§9"] });
    shareDoc(ledger, owner, { doc: "mockups", title: "Mockups", path: "https://example.com/mockups" });
    let docs = buildPeopleView(ledger.entries()).docs;
    expect(docs.map((d) => [d.doc, d.version, d.clauses.length])).toEqual([["core-specs", "v2", 3], ["mockups", "v1", 0]]);
    expect(ledger.last()!.evidence).toEqual(["https://example.com/mockups"]);
    removeDoc(ledger, owner, "mockups", "Out of date");
    docs = buildPeopleView(ledger.entries()).docs;
    expect(docs.map((d) => d.doc)).toEqual(["core-specs"]);
  });

  it("lets only the owner share once there is a roster", () => {
    const ledger = team();
    expect(refusal(() => shareDoc(ledger, mia, { title: "My notes", path: "notes.md" }))).toMatch(/only the owner shares/);
    expect(refusal(() => removeDoc(ledger, owner, "nothing"))).toMatch(/not shared/);
  });

  it("derives document ids from titles", () => {
    expect(docId("Core Specs (v2)!")).toBe("core-specs-v2");
    expect(docId("???")).toBe("doc");
    expect(docId("a".repeat(60))).toHaveLength(40);
  });
});

describe("the view", () => {
  it("is rebuilt from the ledger alone and lists the owner first", () => {
    const ledger = team();
    const view = buildPeopleView(ledger.entries());
    expect(view.members.map((m) => [m.person, m.role])).toEqual([["looplet-spare", "owner"], ["mia", "helper"], ["sam", "viewer"]]);
    expect(view.owner?.person).toBe("looplet-spare");
    expect(view.head).toBe("L-000003");
    expect(buildPeopleView(ledger.entries())).toEqual(view);
  });

  it("matches on a second device that only reads the synced ledger", async () => {
    const store = new MemoryStore();
    const writer = Ledger.openSync(store, { now: clock() });
    installNumberingRules(writer);
    installPeopleRules(writer);
    claimOwnership(writer, owner, "Looplet Spare");
    addMember(writer, owner, { person: "mia", name: "Mia", role: "helper" });
    const view = buildPeopleView(writer.entries());
    writer.close();
    const reader = await Ledger.open(store, { readOnly: true });
    expect(buildPeopleView(reader.entries())).toEqual(view);
  });

  it("renames a member without losing their history", () => {
    const ledger = team();
    const entry = changeMember(ledger, owner, "mia", { name: "Mia Chen" });
    expect(entry.summary).toBe("Mia is now called Mia Chen");
    const mias = buildPeopleView(ledger.entries()).members.find((m) => m.person === "mia")!;
    expect(mias).toMatchObject({ name: "Mia Chen", since: "L-000002" });
  });
});
