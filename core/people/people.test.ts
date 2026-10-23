import { describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore, type Actor, type EntryDraft, type LedgerEntry } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import {
  addMember,
  assignTask,
  auditPeople,
  openPeopleLedger,
  buildPeopleView,
  peopleView,
  changeMember,
  claimOwnership,
  clearPhoto,
  docId,
  installPeopleRules,
  LISTED_AGENTS_MAX,
  listAgent,
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

/** A store whose test keys hold the owner's key, and that key's id, which the app pins outside the ledger. */
function pinned(store = new MemoryStore()): { store: MemoryStore; ownerKey: string } {
  return { store, ownerKey: store.defaultKeys.createKey("person:looplet-spare").keyId };
}

function open(): Ledger {
  const { store, ownerKey } = pinned();
  const ledger = Ledger.openSync(store, { now: clock(), ownerKey });
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
    expect(peopleView(ledger).members).toHaveLength(3);
  });
});

describe("solo first", () => {
  it("restricts nobody until the first member is added", () => {
    const ledger = open();
    createTask(ledger, owner);
    write(ledger, { actor: owner, type: "test.defined", subject: "T-1", data: { test: "npm test" } });
    write(ledger, { actor: owner, type: "test.approved", subject: "T-1", data: { test: "npm test" } });
    write(ledger, { actor: stranger, type: "task.progress", subject: "T-1" });
    expect(ledger.entries()).toHaveLength(4);
    expect(peopleView(ledger)).toEqual({ members: [], docs: [], assignments: {}, head: "L-000004" });
  });

  it("lets a solo person share documents before setting up a roster", () => {
    const ledger = open();
    shareDoc(ledger, owner, { title: "Product brief", path: "docs/brief.md" });
    expect(peopleView(ledger).docs.map((d) => d.title)).toEqual(["Product brief"]);
  });

  it("makes the first member the owner, and only of themselves", () => {
    const ledger = open();
    expect(refusal(() => addMember(ledger, owner, { person: "looplet-spare", name: "L", role: "helper" }))).toMatch(/first member .* owner/);
    expect(refusal(() => addMember(ledger, owner, { person: "mia", name: "Mia", role: "owner" }))).toMatch(/adds themselves first/);
    expect(() => claimOwnership(ledger, ownersAgent, "Agent")).toThrow(expect.objectContaining({ code: "NOT_PERMITTED" }));
    claimOwnership(ledger, owner, "Looplet Spare");
    expect(peopleView(ledger).owner?.person).toBe("looplet-spare");
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
    expect(peopleView(ledger).members.find((m) => m.person === "mia")?.approves).toEqual(["test", "review"]);
    changeMember(ledger, owner, "mia", { role: "viewer" });
    expect(peopleView(ledger).members.find((m) => m.person === "mia")?.approves).toEqual([]);
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

  it("leaves the owner, their listed agents, Jev and the watcher alone", () => {
    const ledger = team();
    changeMember(ledger, owner, "looplet-spare", { agents: ["claude-code"] });
    createTask(ledger, owner);
    write(ledger, { actor: ownersAgent, type: "task.progress", subject: "T-1" });
    write(ledger, { actor: { kind: "jev", id: "jev", model: "jev-1" }, type: "review.verdict", subject: "T-1" });
    write(ledger, { actor: { kind: "system", id: "watcher" }, type: "commit.observed", subject: "T-1", data: { sha: "abc1234" } });
    expect(ledger.entries()).toHaveLength(8);
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
    const view = peopleView(ledger);
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
    const store: PhotoStore = { save: (file) => void saved.push(file), load: () => undefined, remove: () => {} };
    refusal(() => setPhoto(ledger, store, mia, "sam", png()));
    expect(saved).toEqual([]);
  });

  it("clears the photo again when the file cannot be saved", () => {
    const ledger = team();
    const store: PhotoStore = { save: () => { throw new Error("disk full"); }, load: () => undefined, remove: () => {} };
    expect(() => setPhoto(ledger, store, mia, "mia", png())).toThrow("disk full");
    expect(peopleEvent(ledger.last()!)).toEqual({ op: "photo.cleared", person: "mia" });
    expect(peopleView(ledger).members.find((m) => m.person === "mia")?.photo).toBeUndefined();
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
    expect(photoSources(peopleView(ledger), store)).toEqual({});
    clearPhoto(ledger, mia, "mia");
    expect(peopleView(ledger).members.find((m) => m.person === "mia")?.photo).toBeUndefined();
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
    const view = peopleView(ledger);
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
    let mias = peopleView(ledger).members.find((m) => m.person === "mia")!;
    expect(mias.presence).toMatchObject({ stage: "task", type: "task.done" });
    expect(mias.presence?.task).toBeUndefined();
    write(ledger, { actor: owner, type: "task.reopened", subject: "T-1", reason: "Broke on Mac" });
    mias = peopleView(ledger).members.find((m) => m.person === "mia")!;
    expect(mias.presence?.task).toBe("T-1");
  });

  it("prefers work over profile changes, but shows profile changes for newcomers", () => {
    const ledger = team();
    const store = new MemoryPhotoStore();
    createTask(ledger);
    write(ledger, { actor: mia, type: "task.progress", subject: "T-1", summary: "Halfway" });
    setPhoto(ledger, store, mia, "mia", png());
    setPhoto(ledger, store, sam, "sam", png());
    const by = Object.fromEntries(peopleView(ledger).members.map((m) => [m.person, m.presence]));
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
    const [plan] = peopleView(ledger).docs;
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
    let docs = peopleView(ledger).docs;
    expect(docs.map((d) => [d.doc, d.version, d.clauses.length])).toEqual([["core-specs", "v2", 3], ["mockups", "v1", 0]]);
    expect(ledger.last()!.evidence).toEqual(["https://example.com/mockups"]);
    removeDoc(ledger, owner, "mockups", "Out of date");
    docs = peopleView(ledger).docs;
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
    const view = peopleView(ledger);
    expect(view.members.map((m) => [m.person, m.role])).toEqual([["looplet-spare", "owner"], ["mia", "helper"], ["sam", "viewer"]]);
    expect(view.owner?.person).toBe("looplet-spare");
    expect(view.head).toBe("L-000003");
    expect(peopleView(ledger)).toEqual(view);
  });

  it("matches on a second device that only reads the synced ledger", async () => {
    const { store, ownerKey } = pinned();
    const writer = Ledger.openSync(store, { now: clock(), ownerKey });
    installNumberingRules(writer);
    installPeopleRules(writer);
    claimOwnership(writer, owner, "Looplet Spare");
    addMember(writer, owner, { person: "mia", name: "Mia", role: "helper" });
    const view = peopleView(writer);
    writer.close();
    const reader = await Ledger.open(store, { readOnly: true, ownerKey });
    expect(peopleView(reader)).toEqual(view);
  });

  it("renames a member without losing their history", () => {
    const ledger = team();
    const entry = changeMember(ledger, owner, "mia", { name: "Mia Chen" });
    expect(entry.summary).toBe("Mia is now called Mia Chen");
    const mias = peopleView(ledger).members.find((m) => m.person === "mia")!;
    expect(mias).toMatchObject({ name: "Mia Chen", since: "L-000002" });
  });
});

describe("review fixes: authority comes from the ledger, not the payload", () => {
  /** A ledger with no people rules installed yet. */
  function bare(): Ledger {
    const { store, ownerKey } = pinned();
    return Ledger.openSync(store, { now: clock(), ownerKey });
  }
  const people = (event: Record<string, unknown>) => ({ people: event });

  /** Entries as a reader sees them: replay is pure over the list, so forged entries can be fed straight in. */
  function entry(n: number, actor: Actor, event: Record<string, unknown>): LedgerEntry {
    const num = `L-${String(n).padStart(6, "0")}`;
    return { n: num, at: "2026-10-09T02:00:00Z", actor, type: "decision.made", subject: `D-${n}`, summary: "x", reason: "x", evidence: [], refs: [], data: people(event), prev: "0".repeat(64), hash: "0".repeat(64) };
  }

  it("refuses an agent that tries to write itself in as owner", () => {
    const ledger = open();
    expect(() =>
      appendNumbered(ledger, { actor: ownersAgent, type: "decision.made", summary: "I own this", reason: "x", evidence: [], refs: [], data: people({ op: "member.added", person: "claude-code", name: "Claude", role: "owner" }) }),
    ).toThrow(expect.objectContaining({ code: "NOT_PERMITTED" }));
  });

  it("ignores roster changes in entries not written by a person, whatever their payload says", () => {
    const forged = [
      entry(1, ownersAgent, { op: "member.added", person: "claude-code", name: "Claude", role: "owner" }),
      entry(2, { kind: "system", id: "watcher" }, { op: "member.added", person: "watcher", name: "Watcher", role: "owner" }),
      entry(3, { kind: "jev", id: "jev", model: "j" }, { op: "member.added", person: "jev", name: "Jev", role: "owner" }),
    ];
    expect(buildPeopleView(forged, { owner: "person:looplet-spare" }).members).toEqual([]);
  });

  it("ignores people changes that the rules would have refused", () => {
    // The owner's claim is a real, signed entry; the rest are hand-built and unsigned.
    const real = open();
    claimOwnership(real, owner, "Looplet Spare");
    const entries = [
      ...real.entries(),
      entry(2, mia, { op: "member.added", person: "mia", name: "Mia", role: "helper" }),
      entry(3, ownersAgent, { op: "member.changed", person: "looplet-spare", role: "viewer" }),
      entry(4, stranger, { op: "member.removed", person: "looplet-spare" }),
    ];
    expect(buildPeopleView(entries, { owner: "person:looplet-spare" }).members.map((m) => [m.person, m.role])).toEqual([["looplet-spare", "owner"]]);
  });

  it("installs the people rules on the first people write", () => {
    const ledger = bare();
    createTask(ledger, owner);
    claimOwnership(ledger, owner, "Looplet Spare");
    expect(refusal(() => createTask(ledger, stranger))).toMatch(/not a member/);
  });

  it("only lets the pinned owner claim the project", () => {
    const ledger = open();
    createTask(ledger, owner);
    expect(refusal(() => claimOwnership(ledger, stranger, "Stranger"))).toMatch(/looplet-spare owns this project/);
    claimOwnership(ledger, owner, "Looplet Spare");
    expect(peopleView(ledger).owner?.person).toBe("looplet-spare");
  });

  it("refuses agents nobody on the project has listed", () => {
    const ledger = team();
    createTask(ledger);
    expect(refusal(() => write(ledger, { actor: ownersAgent, type: "task.progress", subject: "T-1" }))).toMatch(/claude-code is not listed/);
    changeMember(ledger, owner, "looplet-spare", { agents: ["claude-code"] });
    write(ledger, { actor: ownersAgent, type: "task.progress", subject: "T-1" });
  });

  it("shares only project-relative paths or https links", () => {
    const ledger = team();
    for (const path of ["/etc/passwd", "C:\\\\secrets.txt", "C:/x.md", "../outside.md", "docs/../../x.md", "javascript:alert(1)", "http://example.com", "file:///etc/passwd"]) {
      expect(() => shareDoc(ledger, owner, { title: "Bad", path }), path).toThrow(PeopleError);
    }
    shareDoc(ledger, owner, { title: "Fine", path: "docs/specs/plan.md" });
    shareDoc(ledger, owner, { title: "Link", path: "https://example.com/doc" });
    expect(peopleView(ledger).docs).toHaveLength(2);
  });

  it("deletes the photo file when the photo is cleared", () => {
    const ledger = team();
    const store = new MemoryPhotoStore();
    const entry = setPhoto(ledger, store, mia, "mia", png());
    const file = entry.evidence[0]!.slice("file:".length);
    clearPhoto(ledger, mia, "mia", store);
    expect(store.load(file)).toBeUndefined();
  });
});

describe("opening a ledger with people rules", () => {
  /** Writes a project to a store with the rules off, as a process that skipped them would. */
  let ownerKey = "";
  function unchecked(write: (ledger: Ledger) => void): MemoryStore {
    const project = pinned();
    ownerKey = project.ownerKey;
    const ledger = Ledger.openSync(project.store, { now: clock(), ownerKey });
    write(ledger);
    ledger.close();
    return project.store;
  }
  const people = (event: Record<string, unknown>) => ({ people: event });
  const raw = (ledger: Ledger, actor: Actor, event: Record<string, unknown>) =>
    appendNumbered(ledger, { actor, type: "decision.made", summary: "x", reason: "x", evidence: [], refs: [], data: people(event) });

  it("opens a clean project with the rules installed", async () => {
    const store = unchecked((l) => {
      raw(l, owner, { op: "member.added", person: "looplet-spare", name: "Looplet Spare", role: "owner" });
      raw(l, owner, { op: "member.added", person: "sam", name: "Sam", role: "viewer" });
    });
    const ledger = await openPeopleLedger(store, { now: clock(), ownerKey });
    expect(refusal(() => createTask(ledger, sam))).toMatch(/viewer/);
    ledger.close();
  });

  it("refuses to open when a stored entry breaks the people rules", async () => {
    const store = unchecked((l) => {
      raw(l, owner, { op: "member.added", person: "looplet-spare", name: "Looplet Spare", role: "owner" });
      raw(l, owner, { op: "member.added", person: "sam", name: "Sam", role: "viewer" });
      appendNumbered(l, { actor: sam, type: "task.created", summary: "Sneaky task", evidence: [], refs: [] });
    });
    await expect(openPeopleLedger(store, { ownerKey })).rejects.toMatchObject({ code: "STORED_VIOLATION", message: expect.stringMatching(/L-000003.*viewer/) });
  });

  it("can open read-only to show the violations instead", async () => {
    const store = unchecked((l) => {
      raw(l, owner, { op: "member.added", person: "looplet-spare", name: "Looplet Spare", role: "owner" });
      raw(l, mia, { op: "member.added", person: "mia", name: "Mia", role: "owner" });
      appendNumbered(l, { actor: stranger, type: "task.created", summary: "Who am I", evidence: [], refs: [] });
    });
    const ledger = await openPeopleLedger(store, { readOnly: true, ownerKey });
    expect(auditPeople(ledger.entries(), ledger.owner).map((v) => v.n)).toEqual(["L-000002", "L-000003"]);
    expect(peopleView(ledger).members.map((m) => m.person)).toEqual(["looplet-spare"]);
  });

  it("treats a solo project's history as clean", () => {
    const ledger = open();
    createTask(ledger, owner);
    write(ledger, { actor: ownersAgent, type: "task.progress", subject: "T-1" });
    claimOwnership(ledger, owner, "Looplet Spare");
    expect(auditPeople(ledger.entries(), ledger.owner)).toEqual([]);
  });
});

describe("the pinned owner key", () => {
  it("lets the owner claim a fresh pinned ledger through the helpers alone", () => {
    const { store, ownerKey } = pinned();
    const ledger = Ledger.openSync(store, { now: clock(), ownerKey });
    claimOwnership(ledger, owner, "Looplet Spare");
    expect(peopleView(ledger).owner?.person).toBe("looplet-spare");
  });

  it("allows no helper enrolment and no roles without an ownerKey", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { now: clock() });
    expect(ledger.owner).toBeUndefined();
    expect(refusal(() => claimOwnership(ledger, owner, "Looplet Spare"))).toMatch(/no pinned owner/);
    expect(refusal(() => addMember(ledger, owner, { person: "mia", name: "Mia", role: "helper" }))).toMatch(/no pinned owner/);
    expect(refusal(() => shareDoc(ledger, owner, { title: "Spec", path: "docs/spec.md" }))).toMatch(/no pinned owner/);
    expect(() => peopleView(ledger)).toThrow(expect.objectContaining({ code: "NO_OWNER_KEY" }));
  });

  it("refuses loudly when a project is reopened without its ownerKey", async () => {
    const { store, ownerKey } = pinned();
    const writer = await openPeopleLedger(store, { now: clock(), ownerKey });
    claimOwnership(writer, owner, "Looplet Spare");
    addMember(writer, owner, { person: "mia", name: "Mia", role: "helper" });
    writer.close();
    const unpinned = await Ledger.open(store, { readOnly: true });
    expect(() => peopleView(unpinned)).toThrow(expect.objectContaining({ code: "NO_OWNER_KEY" }));
    expect(buildPeopleView(unpinned.entries(), {}).members).toEqual([]);
    await expect(openPeopleLedger(store, { readOnly: true })).rejects.toMatchObject({ code: "NO_OWNER_KEY" });
    const repinned = await Ledger.open(store, { readOnly: true, ownerKey });
    expect(peopleView(repinned).members.map((m) => m.person)).toEqual(["looplet-spare", "mia"]);
  });
});

describe("giving tasks to people", () => {
  it("lets only the owner assign, only to members who can work, and the latest assignment wins", () => {
    const ledger = team();
    assignTask(ledger, owner, "T-1", "mia");
    expect(refusal(() => assignTask(ledger, mia, "T-2", "mia"))).toMatch(/only the owner gives tasks/);
    expect(refusal(() => assignTask(ledger, owner, "T-2", "sam"))).toMatch(/viewer and cannot be given work/);
    expect(refusal(() => assignTask(ledger, owner, "T-2", "stranger"))).toMatch(/not on the project/);
    expect(buildPeopleView(ledger.entries(), { owner: ledger.owner }).assignments).toEqual({ "T-1": "mia" });
    assignTask(ledger, owner, "T-1", "looplet-spare");
    expect(buildPeopleView(ledger.entries(), { owner: ledger.owner }).assignments).toEqual({ "T-1": "looplet-spare" });
  });

  it("drops a removed person's tasks, and reads only well-formed assignments", () => {
    const ledger = team();
    assignTask(ledger, owner, "T-3", "mia");
    removeMember(ledger, owner, "mia");
    expect(buildPeopleView(ledger.entries(), { owner: ledger.owner }).assignments).toEqual({});
    expect(parsePeopleEvent({ op: "task.assigned", task: "T-3", person: "mia" })).toBeDefined();
    expect(parsePeopleEvent({ op: "task.assigned", task: "3", person: "mia" })).toBeUndefined();
    expect(parsePeopleEvent({ op: "task.assigned", task: "T-3", person: "Not A Slug" })).toBeUndefined();
  });
});

describe("listing an agent under the person who connected it", () => {
  it("lists it once, in the owner's name, so the roster rule lets it write", () => {
    const ledger = team();
    const stray: Actor = { kind: "agent", id: "sam-bot-1", model: "claude-x" };
    createTask(ledger);
    const progress = () => write(ledger, { actor: stray, type: "task.progress", subject: "T-1" });
    expect(refusal(progress)).toMatch(/not listed as anyone's agent/);
    expect(listAgent(ledger, "mia", "sam-bot-1")).toBe(true);
    const before = ledger.entries().length;
    expect(listAgent(ledger, "mia", "sam-bot-1")).toBe(true);
    expect(ledger.entries().length).toBe(before);
    expect(progress).not.toThrow();
    expect(buildPeopleView(ledger.entries(), { owner: ledger.owner }).members.find((m) => m.person === "mia")!.agents).toEqual(["mia-worker", "sam-bot-1"]);
  });

  it("does nothing without a roster or for someone who is not on it, and keeps the newest agents when the list is full", () => {
    expect(listAgent(open(), "mia", "a-1")).toBe(false);
    const ledger = team();
    expect(listAgent(ledger, "stranger", "a-1")).toBe(false);
    for (let i = 0; i < LISTED_AGENTS_MAX + 5; i++) listAgent(ledger, "mia", `bot-${i}`);
    const agents = buildPeopleView(ledger.entries(), { owner: ledger.owner }).members.find((m) => m.person === "mia")!.agents;
    expect(agents).toHaveLength(LISTED_AGENTS_MAX);
    expect(agents.at(-1)).toBe(`bot-${LISTED_AGENTS_MAX + 4}`);
    expect(agents).not.toContain("bot-0");
  });
});
