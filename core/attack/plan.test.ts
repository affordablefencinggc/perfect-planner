// Attack 10: the planning screen under rough use. An empty idea, a huge one, an odd one; answering a question twice
// (one after the other and at the same moment); approving twice; editing after approval; two windows open on the same
// project. The safe outcome is always the same: a plain refusal, exactly one entry in the ledger for the thing that was
// done, and an approval that can only ever be given to the plan the person was looking at.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanTemp, connectWindow, makeRepo, startWindow, tempDir, type Window } from "./helpers";

afterAll(cleanTemp);
const q = "?project=p";
const IDEA = "A web notes app with no accounts that uses SQLite and runs in the browser";

interface Question {
  q: string;
  status: string;
  source?: string;
  blocking: boolean;
  options?: { id: string }[];
}
interface Overview {
  fingerprint: string;
  started: boolean;
  approval: { canApprove: boolean; current: boolean; changedSinceApproval: boolean; approved: { plan: string }[] };
  areas: { questions: Question[] }[];
}

async function overview(win: Window): Promise<Overview> {
  return (await win.call("GET", `/planning${q}`)).body.result as Overview;
}
const questionsOf = (ov: Overview): Question[] => ov.areas.flatMap((a) => a.questions);
const entriesOf = (win: Window, type: string) => win.host.project("p").entries().filter((e) => e.type === type);

async function open(): Promise<{ win: Window; data: string; repo: string }> {
  const data = tempDir();
  const repo = makeRepo();
  const win = await startWindow({ data, project: repo, secrets: path.join(data, "secrets.json") });
  return { win, data, repo };
}

/** Starts the plan and answers questions through the app until it can be approved (optionally leaving one optional question open). */
async function settle(win: Window, { idea = IDEA, leaveOptionalOpen = false }: { idea?: string; leaveOptionalOpen?: boolean } = {}): Promise<Overview> {
  expect((await win.call("POST", `/planning/start${q}`, { idea })).status).toBe(200);
  await win.call("POST", `/planning/accept${q}`, { minConfidence: 0.5 });
  let left = leaveOptionalOpen;
  for (const question of questionsOf(await overview(win)).filter((x) => x.status === "open")) {
    if (left && !question.blocking) {
      left = false;
      continue;
    }
    const body = question.options?.length ? { q: question.q, choice: question.options[0]!.id } : { q: question.q, text: "Decided: use the simplest option available." };
    const res = await win.call("POST", `/planning/answer${q}`, body);
    expect(res.status, `${question.q}: ${JSON.stringify(res.body)}`).toBe(200);
  }
  const ov = await overview(win);
  expect(ov.approval.canApprove).toBe(true);
  return ov;
}

describe("attack 10: an empty, odd or huge idea", () => {
  it("is refused in plain words and writes nothing", async () => {
    const { win, repo } = await open();
    try {
      const before = win.host.project("p").entries().length;
      const bad: [unknown, string][] = [
        ["", "EMPTY"],
        ["   \n\t ", "EMPTY"],
        ["ab", "EMPTY"],
        [undefined, "EMPTY"],
        [null, "EMPTY"],
        [5, "INVALID"],
        [["a notes app"], "INVALID"],
        [{ idea: "x" }, "INVALID"],
        [true, "INVALID"],
        ["a".repeat(4001), "INVALID"],
      ];
      for (const [idea, code] of bad) {
        const res = await win.call("POST", `/planning/start${q}`, idea === undefined ? {} : { idea });
        expect([res.status, res.body.code], `idea ${JSON.stringify(idea)?.slice(0, 30)}`).toEqual([400, code]);
        expect(typeof res.body.message).toBe("string");
      }
      // A body that is not JSON at all, and no body.
      const raw = await fetch(`${win.base}/planning/start${q}`, { method: "POST", headers: { ...win.person(), "content-type": "application/json" }, body: "{not json" });
      expect(raw.status).toBeGreaterThanOrEqual(400);
      expect(raw.status).toBeLessThan(500);
      expect(win.host.project("p").entries().length).toBe(before);
      expect(fs.existsSync(path.join(repo, ".perfect-planner", "planning-idea.json"))).toBe(false);
      expect((await overview(win)).started).toBe(false);
    } finally {
      await win.stop();
    }
  }, 60_000);

  it("a 3 MB idea is cut off at the door (413 or a dropped connection), and the app keeps answering", async () => {
    const { win } = await open();
    try {
      const before = win.host.project("p").entries().length;
      const outcome = await fetch(`${win.base}/planning/start${q}`, { method: "POST", headers: { ...win.person(), "content-type": "application/json" }, body: JSON.stringify({ idea: "x".repeat(3 * 1024 * 1024) }) }).then((r) => r.status, () => "dropped");
      expect([413, "dropped", 400]).toContain(outcome);
      expect(win.host.project("p").entries().length).toBe(before);
      expect((await win.call("GET", `/status${q}`)).status).toBe(200);
    } finally {
      await win.stop();
    }
  }, 60_000);

  it("an idea of exactly 4,000 characters, and one with control characters, lone surrogates, a bidi override and a fake ledger line, are kept as text: the ledger and the idea file stay valid after a restart", async () => {
    const { win, data, repo } = await open();
    const nasty = `A notes app\u0000 \ud800 ‮evil‬\n{"n":"L-000001","hash":"x"}\r\n</script><img src=x onerror=1> ${"é".repeat(40)}`;
    try {
      expect((await win.call("POST", `/planning/start${q}`, { idea: "a".repeat(4000) })).status).toBe(200);
      expect((await win.call("POST", `/planning/start${q}`, { idea: nasty })).status).toBe(200);
      expect(win.host.project("p").ledger.status.ok).toBe(true);
    } finally {
      await win.stop();
    }
    const again = await startWindow({ data, project: repo, secrets: path.join(data, "secrets.json") });
    try {
      expect(again.host.project("p").ledger.status.ok).toBe(true);
      expect((await again.call("GET", `/status${q}`)).body.result.integrity).toEqual({ state: "ok", writesStopped: false });
      expect((await again.call("GET", `/planning${q}`)).status).toBe(200);
      const file = JSON.parse(fs.readFileSync(path.join(repo, ".perfect-planner", "planning-idea.json"), "utf8")) as { idea: string };
      expect(typeof file.idea).toBe("string");
      // Every ledger line is still exactly one entry: the pasted "ledger line" did not become one.
      const ledgerDir = path.join(repo, ".perfect-planner", "ledger");
      const lines = fs.readdirSync(ledgerDir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => fs.readFileSync(path.join(ledgerDir, f), "utf8").split("\n").filter(Boolean));
      expect(lines.length).toBe(again.host.project("p").entries().length);
    } finally {
      await again.stop();
    }
  }, 60_000);
});

describe("attack 10: answering a question twice", () => {
  it("the second answer is refused and the first stands; at the same moment, exactly one of several answers is taken", async () => {
    const { win } = await open();
    try {
      expect((await win.call("POST", `/planning/start${q}`, { idea: IDEA })).status).toBe(200);
      const open1 = questionsOf(await overview(win)).filter((x) => x.status === "open" && (x.options?.length ?? 0) >= 3);
      const [a, b] = open1;
      expect(a && b).toBeTruthy();

      // One after the other.
      const first = await win.call("POST", `/planning/answer${q}`, { q: a!.q, choice: a!.options![0]!.id });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const second = await win.call("POST", `/planning/answer${q}`, { q: a!.q, choice: a!.options![1]!.id });
      expect([second.status, second.body.code]).toEqual([409, "ALREADY_ANSWERED"]);
      expect(entriesOf(win, "question.answered").filter((e) => e.subject === a!.q).length).toBe(1);
      expect(questionsOf(await overview(win)).find((x) => x.q === a!.q)!.status).not.toBe("open");

      // At the same moment, with different answers from different windows.
      const tabB = await connectWindow(win.base, win.host.issueLaunch());
      const race = await Promise.all([
        win.call("POST", `/planning/answer${q}`, { q: b!.q, choice: b!.options![0]!.id }),
        tabB.call("POST", `/planning/answer${q}`, { q: b!.q, choice: b!.options![1]!.id }),
        win.call("POST", `/planning/answer${q}`, { q: b!.q, choice: b!.options![2]!.id }),
        tabB.call("POST", `/planning/answer${q}`, { q: b!.q, choice: b!.options![0]!.id }),
      ]);
      expect(race.filter((r) => r.status === 200).length, JSON.stringify(race.map((r) => [r.status, r.body.code]))).toBe(1);
      expect(race.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.body.code === "ALREADY_ANSWERED")).toBe(true);
      expect(entriesOf(win, "question.answered").filter((e) => e.subject === b!.q).length).toBe(1);
      expect(entriesOf(win, "decision.made").filter((e) => e.data?.question === b!.q).length).toBeLessThanOrEqual(1);
      expect(win.host.project("p").ledger.status.ok).toBe(true);
    } finally {
      await win.stop();
    }
  }, 60_000);
});

describe("attack 10: approving, twice, after an edit, and from two windows", () => {
  it("one approval gives one plan and one set of tasks, whether the second click comes after or at the same moment; a missing or wrong fingerprint is refused", async () => {
    const { win } = await open();
    try {
      const ov = await settle(win);
      const noFingerprint = await win.call("POST", `/planning/approve${q}`, {});
      expect([noFingerprint.status, noFingerprint.body.code]).toEqual([400, "FINGERPRINT_REQUIRED"]);
      const wrong = await win.call("POST", `/planning/approve${q}`, { fingerprint: "0".repeat(64) });
      expect([wrong.status, wrong.body.code]).toEqual([409, "STALE"]);
      expect(entriesOf(win, "plan.approved")).toEqual([]);

      const tabB = await connectWindow(win.base, win.host.issueLaunch());
      const clicks = await Promise.all([win, tabB, win, tabB].map((w) => w.call("POST", `/planning/approve${q}`, { fingerprint: ov.fingerprint })));
      expect(clicks.filter((r) => r.status === 200).length, JSON.stringify(clicks.map((r) => [r.status, r.body.code]))).toBe(1);
      expect(clicks.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.body.code === "ALREADY_APPROVED")).toBe(true);
      expect(entriesOf(win, "plan.approved").length).toBe(1);

      const later = await win.call("POST", `/planning/approve${q}`, { fingerprint: ov.fingerprint });
      expect([later.status, later.body.code]).toEqual([409, "ALREADY_APPROVED"]);
      expect(entriesOf(win, "plan.approved").length).toBe(1);
      const titles = ((await win.call("GET", `/tasks${q}`)).body.result.tasks as { title: string }[]).map((t) => t.title);
      expect(titles.length).toBeGreaterThan(5);
      expect(new Set(titles).size, "the same task was written twice").toBe(titles.length);
      expect(entriesOf(win, "task.created").length).toBe(titles.length);
    } finally {
      await win.stop();
    }
  }, 60_000);

  it("editing after approval: a decided answer cannot be changed; reopening what the description settled makes the old approval stale; only a fresh look can approve, and the tasks are not written again", async () => {
    const { win } = await open();
    try {
      const ov = await settle(win);
      expect((await win.call("POST", `/planning/approve${q}`, { fingerprint: ov.fingerprint })).status).toBe(200);
      const tasksAfterApproval = entriesOf(win, "task.created").length;

      // A person's own answers are final.
      const decided = questionsOf(ov).find((x) => x.status !== "open" && x.source !== "description" && x.source !== "repo")!;
      const change = await win.call("POST", `/planning/answer${q}`, { q: decided.q, choice: "anything-else" });
      expect([change.status, change.body.code]).toEqual([409, "ALREADY_ANSWERED"]);
      const reopenOwn = await win.call("POST", `/planning/reopen${q}`, { q: decided.q });
      expect([reopenOwn.status, reopenOwn.body.code]).toEqual([409, "NOT_FROM_DESCRIPTION"]);
      // A task of the person's own is not a change to the plan.
      expect((await win.call("POST", `/planning/tasks${q}`, { title: "Added after approval" })).status).toBe(200);
      expect((await overview(win)).approval.current).toBe(true);

      // What the description settled can be reopened. That changes the plan.
      const settledByIdea = questionsOf(ov).find((x) => x.source === "description")!;
      const reopenRes = await win.call("POST", `/planning/reopen${q}`, { q: settledByIdea.q });
      expect(reopenRes.status, JSON.stringify(reopenRes.body)).toBe(200);
      // The question comes back under a new number; the one it replaces stays in the ledger.
      const newNumber = reopenRes.body.result.q as string;
      const edited = await overview(win);
      expect(edited.approval).toMatchObject({ current: false, canApprove: false, changedSinceApproval: true });
      // Neither the old nor the new fingerprint approves while a blocking question is open.
      for (const fingerprint of [ov.fingerprint, edited.fingerprint]) {
        const refused = await win.call("POST", `/planning/approve${q}`, { fingerprint });
        expect([refused.status, refused.body.code]).toEqual([409, "BLOCKERS_OPEN"]);
      }
      const reopened = questionsOf(edited).find((x) => x.q === newNumber)!;
      const answered = await win.call("POST", `/planning/answer${q}`, { q: reopened.q, choice: reopened.options![1]!.id });
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      const fresh = await overview(win);
      expect(fresh.approval.canApprove).toBe(true);
      // The fingerprint the person saw before the edit cannot approve the edited plan.
      const stale = await win.call("POST", `/planning/approve${q}`, { fingerprint: ov.fingerprint });
      expect([stale.status, stale.body.code]).toEqual([409, "STALE"]);
      expect(entriesOf(win, "plan.approved").length).toBe(1);
      const approved = await win.call("POST", `/planning/approve${q}`, { fingerprint: fresh.fingerprint });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body.result.tasks).toEqual({});
      expect(entriesOf(win, "plan.approved").length).toBe(2);
      expect(entriesOf(win, "task.created").length).toBe(tasksAfterApproval + 1);
    } finally {
      await win.stop();
    }
  }, 90_000);

  it("two windows: one looks, the other changes the plan, and the first window's approval is refused as stale", async () => {
    const { win } = await open();
    try {
      const tabA = win;
      const tabB = await connectWindow(win.base, win.host.issueLaunch());
      expect(tabB.cookie).not.toBe(tabA.cookie);
      const seenByA = await settle(win, { leaveOptionalOpen: true });
      const optional = questionsOf(seenByA).find((x) => x.status === "open")!;
      expect(optional).toBeTruthy();
      // B answers the one open question while A is still looking at the screen.
      const changed = await tabB.call("POST", `/planning/answer${q}`, { q: optional.q, ...(optional.options?.length ? { choice: optional.options[0]!.id } : { text: "Decided: not now." }) });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      const refused = await tabA.call("POST", `/planning/approve${q}`, { fingerprint: seenByA.fingerprint });
      expect([refused.status, refused.body.code]).toEqual([409, "STALE"]);
      expect(entriesOf(win, "plan.approved")).toEqual([]);
      expect(entriesOf(win, "task.created")).toEqual([]);
      // After a reload A approves what it now sees.
      const reloaded = await overview(tabA as Window);
      expect(reloaded.fingerprint).not.toBe(seenByA.fingerprint);
      expect((await tabA.call("POST", `/planning/approve${q}`, { fingerprint: reloaded.fingerprint })).status).toBe(200);
      expect(entriesOf(win, "plan.approved").length).toBe(1);
    } finally {
      await win.stop();
    }
  }, 90_000);

  it("two windows: a different idea started in the other window also keeps the first window's approval from going through", async () => {
    const { win } = await open();
    try {
      const seenByA = await settle(win);
      const tabB = await connectWindow(win.base, win.host.issueLaunch());
      expect((await tabB.call("POST", `/planning/start${q}`, { idea: "A completely different idea: a bicycle repair shop booking system" })).status).toBe(200);
      // The other idea brings its own questions into the same plan; either way A's old view cannot approve it.
      const refused = await win.call("POST", `/planning/approve${q}`, { fingerprint: seenByA.fingerprint });
      expect(refused.status).toBe(409);
      expect(["STALE", "BLOCKERS_OPEN"]).toContain(refused.body.code);
      expect(entriesOf(win, "plan.approved")).toEqual([]);
      expect(entriesOf(win, "task.created")).toEqual([]);
    } finally {
      await win.stop();
    }
  }, 90_000);
});
