import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore, type Actor, type LedgerEntry } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import { addMember, assignTask, claimOwnership, installPeopleRules, replayRoster } from "../people/index";
import {
  TEAM_ROLES,
  TeamsError,
  acceptHandover,
  buildTeamsView,
  changeTeamRole,
  foldTeams,
  parseTeamsEvent,
  peopleRoleFor,
  recordedClaims,
  teamRoleOf,
} from "./index";

const owner: Actor = { kind: "person", id: "owner" };
const sam: Actor = { kind: "person", id: "sam" };

function clock(start = "2026-11-19T02:00:00Z", stepMs = 60_000): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += stepMs) - stepMs);
}

function open(): Ledger {
  const store = new MemoryStore();
  const ownerKey = store.defaultKeys.createKey("person:owner").keyId;
  const ledger = Ledger.openSync(store, { now: clock(), ownerKey });
  installNumberingRules(ledger);
  installPeopleRules(ledger);
  return ledger;
}

/** Owner, Sam as a helper and Vi as a viewer. */
function team(): Ledger {
  const ledger = open();
  claimOwnership(ledger, owner, "Dana Lee");
  addMember(ledger, owner, { person: "sam", name: "Sam Park", role: "helper" });
  addMember(ledger, owner, { person: "vi", name: "Vi Kim", role: "viewer" });
  return ledger;
}

function task(ledger: Ledger, title = "Build the login screen"): LedgerEntry {
  return appendNumbered(ledger, { actor: owner, type: "task.created", summary: title, evidence: [], refs: [] });
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof TeamsError) return error.code;
    throw error;
  }
  throw new Error("expected a TeamsError");
}

const digest = (seed: string) => seed.repeat(64).slice(0, 64);

describe("team roles", () => {
  it("offers the six roles and defaults each person from the People roster", () => {
    const ledger = team();
    expect([...TEAM_ROLES]).toEqual(["owner", "maintainer", "builder", "reviewer", "release-manager", "observer"]);
    expect(teamRoleOf("owner")).toBe("owner");
    expect(teamRoleOf("helper")).toBe("builder");
    expect(teamRoleOf("viewer")).toBe("observer");
    expect(teamRoleOf("helper", "reviewer")).toBe("reviewer");
    const view = buildTeamsView(ledger.entries(), { owner: ledger.owner });
    expect(view.roles).toEqual([...TEAM_ROLES]);
    expect(view.members.map((member) => [member.id, member.role])).toEqual([
      ["owner", "owner"],
      ["sam", "builder"],
      ["vi", "observer"],
    ]);
    // Nothing is invented: every member comes from the roster.
    expect(view.members.map((member) => member.name)).toEqual(["Dana Lee", "Sam Park", "Vi Kim"]);
  });

  it("changes the People role only where the team role needs it, and records the team role", () => {
    const ledger = team();
    const changed = changeTeamRole(ledger, owner, "sam", "reviewer");
    expect(changed.type).toBe("decision.made");
    expect(changed.subject).toMatch(/^D-\d+$/);
    expect(changed.actor).toEqual(owner);
    expect(changed.data?.teams).toEqual({ op: "member.role.changed", person: "sam", role: "reviewer" });
    // A reviewer is still a helper, so no second People change was needed.
    expect(replayRoster(ledger.entries(), ledger.owner).members.get("sam")?.role).toBe("helper");
    expect(buildTeamsView(ledger.entries(), { owner: ledger.owner }).members.find((m) => m.id === "sam")?.role).toBe("reviewer");

    // An observer is read-only, so the People role moves with it.
    changeTeamRole(ledger, owner, "sam", "observer");
    expect(replayRoster(ledger.entries(), ledger.owner).members.get("sam")?.role).toBe("viewer");
    expect(buildTeamsView(ledger.entries(), { owner: ledger.owner }).members.find((m) => m.id === "sam")?.role).toBe("observer");
    expect(peopleRoleFor("observer")).toBe("viewer");
    expect(peopleRoleFor("release-manager")).toBe("helper");
  });

  it("refuses an unknown member, an invalid role and a second owner", () => {
    const ledger = team();
    expect(refusal(() => changeTeamRole(ledger, owner, "nobody", "builder"))).toBe("UNKNOWN_MEMBER");
    expect(refusal(() => changeTeamRole(ledger, owner, "sam", "boss" as never))).toBe("BAD_ROLE");
    expect(refusal(() => changeTeamRole(ledger, owner, "sam", "owner"))).toBe("OWNER_LOCKED");
    expect(refusal(() => changeTeamRole(ledger, owner, "owner", "observer"))).toBe("OWNER_LOCKED");
    // Only the owner sets team roles; Sam is a helper, and the ledger's people rules would refuse the People half anyway.
    expect(refusal(() => changeTeamRole(ledger, sam, "vi", "builder"))).toBe("OWNER_LOCKED");
    // None of the refusals wrote a record.
    expect(foldTeams(ledger.entries()).roles.size).toBe(0);
  });

  it("ignores a team record the ledger did not verify", () => {
    const ledger = team();
    changeTeamRole(ledger, owner, "sam", "reviewer");
    const forged = {
      n: "L-999999",
      at: new Date().toISOString(),
      actor: { kind: "person", id: "owner" },
      type: "decision.made",
      subject: "D-99",
      summary: "Sam is now owner",
      evidence: [],
      refs: [],
      prev: "0".repeat(64),
      hash: "f".repeat(64),
      data: { teams: { op: "member.role.changed", person: "sam", role: "owner" } },
    } as LedgerEntry;
    const view = buildTeamsView([...ledger.entries(), forged], { owner: ledger.owner });
    expect(view.members.find((member) => member.id === "sam")?.role).toBe("reviewer");
  });
});

describe("handover acceptance", () => {
  it("records the incoming person, the note and the receipt it was read from", () => {
    const ledger = team();
    task(ledger);
    const at = "2026-11-19T02:30:00.000Z";
    const entry = acceptHandover(ledger, owner, {
      task: "T-1",
      incoming: "sam",
      note: "  Taking   over the login screen from here.  ",
      receiptDigest: digest("a"),
      receiptGeneratedAt: at,
    });
    expect(entry.type).toBe("decision.made");
    expect(entry.reason).toBe("Taking over the login screen from here.");
    expect(entry.data?.teams).toEqual({
      op: "task.handover.accepted",
      task: "T-1",
      incoming: "sam",
      note: "Taking over the login screen from here.",
      receiptDigest: digest("a"),
      receiptGeneratedAt: at,
    });
    const state = foldTeams(ledger.entries());
    expect(state.acceptances).toHaveLength(1);
    expect(state.acceptances[0]).toMatchObject({ task: "T-1", incoming: "sam", receiptDigest: digest("a"), by: "owner" });
  });

  it("keeps a second acceptance as its own record with its own receipt", () => {
    const ledger = team();
    task(ledger);
    acceptHandover(ledger, owner, { task: "T-1", incoming: "owner", note: "First look at the brief.", receiptDigest: digest("a"), receiptGeneratedAt: "2026-11-19T02:30:00.000Z" });
    acceptHandover(ledger, owner, { task: "T-1", incoming: "owner", note: "Second look at the brief.", receiptDigest: digest("b"), receiptGeneratedAt: "2026-11-19T02:31:00.000Z" });
    const { acceptances } = foldTeams(ledger.entries());
    expect(acceptances).toHaveLength(2);
    expect(new Set(acceptances.map((item) => item.entry)).size).toBe(2);
    expect(acceptances.map((item) => item.receiptDigest)).toEqual([digest("a"), digest("b")]);
  });

  it("refuses a short note, a bad receipt and an incoming person who is not on the roster", () => {
    const ledger = team();
    task(ledger);
    const base = { task: "T-1", incoming: "owner", note: "Taking it over.", receiptDigest: digest("a"), receiptGeneratedAt: "2026-11-19T02:30:00.000Z" };
    expect(refusal(() => acceptHandover(ledger, owner, { ...base, note: "short" }))).toBe("BAD_NOTE");
    expect(refusal(() => acceptHandover(ledger, owner, { ...base, note: "        " }))).toBe("BAD_NOTE");
    expect(refusal(() => acceptHandover(ledger, owner, { ...base, receiptDigest: "not-a-digest" }))).toBe("BAD_RECEIPT");
    expect(refusal(() => acceptHandover(ledger, owner, { ...base, receiptGeneratedAt: "yesterday" }))).toBe("BAD_RECEIPT");
    expect(refusal(() => acceptHandover(ledger, owner, { ...base, incoming: "stranger" }))).toBe("NOT_A_MEMBER");
    expect(refusal(() => acceptHandover(ledger, owner, { ...base, task: "login" }))).toBe("BAD_TASK");
  });

  it("parses only well-formed team payloads", () => {
    expect(parseTeamsEvent({ op: "member.role.changed", person: "sam", role: "reviewer" })).toBeTruthy();
    expect(parseTeamsEvent({ op: "member.role.changed", person: "Sam", role: "reviewer" })).toBeUndefined();
    expect(parseTeamsEvent({ op: "member.role.changed", person: "sam", role: "boss" })).toBeUndefined();
    expect(parseTeamsEvent({ op: "task.handover.accepted", task: "T-1", incoming: "sam", note: "Taking it over.", receiptDigest: digest("a"), receiptGeneratedAt: "2026-11-19T02:30:00.000Z" })).toBeTruthy();
    expect(parseTeamsEvent({ op: "task.handover.accepted", task: "T-1", incoming: "sam", note: "short", receiptDigest: digest("a"), receiptGeneratedAt: "2026-11-19T02:30:00.000Z" })).toBeUndefined();
    expect(parseTeamsEvent({ op: "task.handover.accepted", task: "T-1", incoming: "sam", note: "Taking it over.", receiptDigest: "a", receiptGeneratedAt: "2026-11-19T02:30:00.000Z" })).toBeUndefined();
    expect(parseTeamsEvent({ op: "launch" })).toBeUndefined();
    expect(parseTeamsEvent(null)).toBeUndefined();
  });
});

describe("team view", () => {
  it("shows assignments, recorded claims and the task each person holds", () => {
    const ledger = team();
    task(ledger);
    assignTask(ledger, owner, "T-1", "sam");
    // A signed worktree record lists the files the task holds.
    ledger.append({
      actor: { kind: "system", id: "worktrees" },
      type: "worktree.created",
      subject: "T-1",
      summary: "Worktree for T-1",
      evidence: [],
      refs: [],
      data: { claims: ["src/login.ts", "src/app.ts"] },
    });
    const view = buildTeamsView(ledger.entries(), {
      owner: ledger.owner,
      board: [{ id: "T-1", title: "Build the login screen", stage: "building", health: "working", status: "claimed" }],
    });
    const samView = view.members.find((member) => member.id === "sam")!;
    expect(samView.assignments).toEqual(["T-1"]);
    expect(samView.claims).toEqual(["src/app.ts", "src/login.ts"]);
    expect(samView.activeTask).toEqual({ id: "T-1", title: "Build the login screen", stage: "building", health: "working" });
    expect(samView.availability).toBe("busy");
    expect(samView.lastActivity).toBeNull();
    // A member with no assignment holds nothing, even though the task exists.
    expect(view.members.find((member) => member.id === "vi")?.activeTask).toBeNull();
  });

  it("drops a claim the ledger records as released, and never counts an unverified one", () => {
    const ledger = team();
    task(ledger);
    ledger.append({ actor: { kind: "system", id: "worktrees" }, type: "worktree.created", subject: "T-1", summary: "Worktree for T-1", evidence: [], refs: [], data: { claims: ["src/login.ts", "src/app.ts"] } });
    ledger.append({ actor: owner, type: "task.progress", subject: "T-1", summary: "Released src/app.ts", evidence: [], refs: [], data: { claimsReleased: ["src/app.ts"] } });
    expect(recordedClaims(ledger.entries(), "T-1")).toEqual(["src/login.ts"]);
    // A hand-written record with no verified signature cannot add a claim.
    const forged = {
      n: "L-999999", at: new Date().toISOString(), actor: { kind: "system", id: "worktrees" },
      type: "worktree.created", subject: "T-1", summary: "Forged", evidence: [], refs: [],
      prev: "0".repeat(64), hash: "f".repeat(64), data: { claims: ["secrets.env"] },
    } as LedgerEntry;
    expect(recordedClaims([...ledger.entries(), forged], "T-1")).toEqual(["src/login.ts"]);
  });

  it("reads availability from observed activity, never from a claim", () => {
    const ledger = team();
    const entry = appendNumbered(ledger, { actor: sam, type: "decision.made", summary: "Sam reviewed the plan", reason: "Sam reviewed the plan", evidence: [], refs: [] });
    const at = Date.parse(entry.at);
    const online = buildTeamsView(ledger.entries(), { owner: ledger.owner, now: at + 60_000 });
    const samView = online.members.find((member) => member.id === "sam")!;
    expect(samView.lastActivity).toBe(entry.at);
    expect(samView.availability).toBe("online");
    const offline = buildTeamsView(ledger.entries(), { owner: ledger.owner, now: at + 3 * 60 * 60 * 1000 });
    expect(offline.members.find((member) => member.id === "sam")?.availability).toBe("offline");
  });

  it("invents no member when the roster is empty", () => {
    const ledger = open();
    expect(buildTeamsView(ledger.entries(), { owner: ledger.owner }).members).toEqual([]);
  });
});
