// Attack 6: damage one line in the middle of the ledger. The app must refuse to continue: it must not drop the bad
// line and carry on with the lines after it, and it must not write a single byte more while the ledger is damaged.
// "Nothing more written" is checked on the bytes of every file in the ledger folder, and by the absence of the
// worktree and branch a dispatch would have made.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bridgeCall } from "../mcp/index";
import { addTask, cleanTemp, git, makeRepo, startWindow, tempDir, type Window } from "./helpers";

afterAll(cleanTemp);
const q = "?project=p";

interface Ctx {
  data: string;
  repo: string;
  secrets: string;
  ledger: string;
  /** The month file the entries are in (the only one, or the later one after a split). */
  file: string;
  lines: string[];
}

/** A project with a real history made through the app (tasks added by the person), then the app closed. */
async function prepare({ tasks = 8, split = false } = {}): Promise<Ctx> {
  const data = tempDir();
  const repo = makeRepo();
  const secrets = path.join(data, "secrets.json");
  const first = await startWindow({ data, project: repo, secrets });
  for (let i = 1; i <= tasks; i += 1) await addTask(first, q, `Task number ${i}`);
  await first.stop();
  const ledger = path.join(repo, ".perfect-planner", "ledger");
  const months = fs.readdirSync(ledger).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f));
  expect(months.length).toBe(1);
  let file = path.join(ledger, months[0]!);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
  expect(lines.length).toBeGreaterThanOrEqual(tasks);
  if (split) {
    // The first half moves to an earlier month's file: the chain is the files read in order.
    const half = Math.floor(lines.length / 2);
    fs.writeFileSync(path.join(ledger, "2020-01.jsonl"), `${lines.slice(0, half).join("\n")}\n`);
    fs.writeFileSync(file, `${lines.slice(half).join("\n")}\n`);
  }
  return { data, repo, secrets, ledger, file, lines };
}

/** Every byte in the ledger folder (not the lock, which is a pid), for "nothing was written" checks. */
function ledgerBytes(ledger: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(ledger).sort()) {
    if (name === ".writer.lock") continue;
    out[name] = createHash("sha256").update(fs.readFileSync(path.join(ledger, name))).digest("hex");
  }
  return out;
}

const reopen = (ctx: Ctx) => startWindow({ data: ctx.data, project: ctx.repo, secrets: ctx.secrets });

/** The app opens on a damaged ledger and refuses every write, changes nothing on disk, and says so on /status. */
async function expectRefusesToContinue(win: Window, ctx: Ctx, { tasksAfter = [], codes = ["CHAIN_BROKEN"] }: { tasksAfter?: string[]; codes?: string[] } = {}) {
  const status = (await win.call("GET", `/status${q}`)).body.result;
  expect(status.integrity, JSON.stringify(status.integrity)).toMatchObject({ writesStopped: true });
  expect(["damaged", "rolled-back"]).toContain(status.integrity.state);
  expect(typeof status.integrity.reason).toBe("string");
  const before = ledgerBytes(ctx.ledger);
  const attempts: [string, string, unknown][] = [
    ["POST", `/planning/tasks${q}`, { title: "Written after the damage" }],
    ["POST", `/tasks/T-1/dispatch${q}`, { model: "builder-model" }],
    ["POST", `/people/members${q}`, { person: "helper", name: "Helper" }],
    ["POST", `/planning/start${q}`, { idea: "A second idea after the damage" }],
  ];
  for (const [method, route, body] of attempts) {
    const res = await win.call(method as "POST", route, body);
    expect(res.status, `${route}: ${JSON.stringify(res.body)}`).not.toBe(200);
    expect(res.body.ok, route).toBe(false);
  }
  // The attempts that reach the ledger say why: it is damaged, not "try again".
  const refused = await win.call("POST", `/planning/tasks${q}`, { title: "Written after the damage" });
  expect(codes, JSON.stringify(refused.body)).toContain(refused.body.code);
  expect(ledgerBytes(ctx.ledger), "the app wrote to a damaged ledger").toEqual(before);
  expect(fs.readdirSync(ctx.ledger).filter((f) => f.startsWith("torn-")), "a mid-file line is not a torn tail").toEqual([]);
  // The dispatch did not get as far as making the worker's folder or branch.
  expect(git(ctx.repo, "branch", "--list").split("\n").map((b) => b.trim().replace("* ", ""))).toEqual(["main"]);
  expect(git(ctx.repo, "worktree", "list").split("\n").length).toBe(1);
  // A line that cannot be read ends the reading there: what comes after it is not quietly used.
  const board = JSON.stringify((await win.call("GET", `/tasks${q}`)).body);
  for (const title of tasksAfter) expect(board, `"${title}" is after the damage but the app shows it`).not.toContain(title);
}

/** A mutation of one line in the middle of the file (line index 5, the 6th entry). */
type Mutation = (lines: string[], index: number) => string[];
const AT = 5;
const replaceLine = (make: (line: string) => string): Mutation => (lines, index) => lines.map((l, i) => (i === index ? make(l) : l));

// unreadable: the line is not an entry at all, so reading stops there and the lines after it are not loaded.
// codes: what a refused write may say. A damaged line the reader accepts (half-made entry) currently surfaces as a
// generic ERROR from a TypeError, see RESULT.md (minor: refused, but with the wrong message).
const variants: { name: string; mutate: Mutation; unreadable?: boolean; codes?: string[] }[] = [
  { name: "garbage bytes in the middle of the line", mutate: replaceLine((l) => `${l.slice(0, 40)}\u0000\u0007###${l.slice(40)}`), unreadable: true },
  { name: "the line cut in half, newline kept", mutate: replaceLine((l) => l.slice(0, Math.floor(l.length / 2))), unreadable: true },
  { name: "the line replaced by something that is not an entry (null)", mutate: replaceLine(() => "null"), unreadable: true },
  { name: "the line replaced by a number", mutate: replaceLine(() => "42"), unreadable: true },
  { name: "the line replaced by an empty object", mutate: replaceLine(() => "{}"), unreadable: true },
  { name: "the line replaced by a half-made entry (a number and nothing else)", mutate: replaceLine((l) => JSON.stringify({ n: (JSON.parse(l) as { n: string }).n })), codes: ["CHAIN_BROKEN", "ERROR"] },
  { name: "one word of the summary changed (valid JSON, wrong fingerprint)", mutate: replaceLine((l) => l.replace(/Task number/, "Task NUMBER")) },
  { name: "the line deleted", mutate: (lines, index) => lines.filter((_, i) => i !== index) },
  { name: "the line blanked out with spaces", mutate: replaceLine((l) => " ".repeat(l.length)) },
  { name: "the line repeated", mutate: (lines, index) => [...lines.slice(0, index + 1), lines[index]!, ...lines.slice(index + 1)] },
  { name: "two lines swapped", mutate: (lines, index) => lines.map((l, i) => (i === index ? lines[index + 1]! : i === index + 1 ? lines[index]! : l)) },
  { name: "a line from the middle copied over the next one", mutate: (lines, index) => lines.map((l, i) => (i === index + 1 ? lines[index]! : l)) },
];

describe("attack 6: one damaged line in the middle of a month file", () => {
  it.each(variants)("$name: the app refuses to continue and writes nothing", async ({ mutate, unreadable, codes }) => {
    const ctx = await prepare();
    const lines = mutate(ctx.lines, AT);
    fs.writeFileSync(ctx.file, `${lines.join("\n")}\n`);
    const win = await reopen(ctx);
    try {
      await expectRefusesToContinue(win, ctx, { ...(unreadable ? { tasksAfter: ["Task number 7", "Task number 8"] } : {}), ...(codes ? { codes } : {}) });
      // And a restart does not make it go away: the damage is still there and still stops writes.
      await win.stop();
      const again = await reopen(ctx);
      try {
        const status = (await again.call("GET", `/status${q}`)).body.result;
        expect(status.integrity.writesStopped).toBe(true);
      } finally {
        await again.stop();
      }
    } catch (error) {
      await win.stop().catch(() => undefined);
      throw error;
    }
  }, 60_000);

  it("a damaged line in the EARLIER month file, with a good later month file after it, stops the app the same way", async () => {
    const ctx = await prepare({ split: true });
    const earlier = path.join(ctx.ledger, "2020-01.jsonl");
    const lines = fs.readFileSync(earlier, "utf8").split("\n").filter((l) => l !== "");
    lines[Math.floor(lines.length / 2)] = "{\"n\":\"L-0000";
    fs.writeFileSync(earlier, `${lines.join("\n")}\n`);
    const win = await reopen(ctx);
    try {
      await expectRefusesToContinue(win, ctx, { tasksAfter: ["Task number 8"] });
      expect(win.host.project("p").ledger.status).toMatchObject({ ok: false, problem: "parse" });
    } finally {
      await win.stop();
    }
  }, 60_000);

  it("a parse break names the damaged line, keeps every byte, and a person cannot just acknowledge it away", async () => {
    const ctx = await prepare();
    const damaged = ctx.lines.map((l, i) => (i === AT ? `${l.slice(0, 30)}\u0000${l.slice(31)}` : l));
    fs.writeFileSync(ctx.file, `${damaged.join("\n")}\n`);
    const before = ledgerBytes(ctx.ledger);
    const win = await reopen(ctx);
    try {
      const ledger = win.host.project("p").ledger;
      expect(ledger.status).toMatchObject({ ok: false, problem: "parse", brokenAt: "L-000006" });
      // Only the lines before the damage are read; the ones after are not smuggled in.
      expect(win.host.project("p").entries().length).toBe(AT);
      // The person's "I have seen it" is not accepted for something that cannot be read at all.
      expect(() => ledger.acknowledgeBreak({ kind: "person", id: "owner" }, "I looked, carry on")).toThrow(/cannot be read|restore/i);
      expect(ledgerBytes(ctx.ledger)).toEqual(before);
    } finally {
      await win.stop();
    }
    // Restoring the file from a good copy (git or a backup) is the way out: the same app then continues.
    fs.writeFileSync(ctx.file, `${ctx.lines.join("\n")}\n`);
    const healed = await reopen(ctx);
    try {
      expect((await healed.call("GET", `/status${q}`)).body.result.integrity).toEqual({ state: "ok", writesStopped: false });
      expect(await addTask(healed, q, "Written after the repair")).toMatch(/^T-\d+$/);
    } finally {
      await healed.stop();
    }
  }, 60_000);

  it("an agent that connects to a damaged ledger cannot write through the bridge either", async () => {
    const ctx = await prepare();
    fs.writeFileSync(ctx.file, `${ctx.lines.map((l, i) => (i === AT ? "{\"n\":" : l)).join("\n")}\n`);
    const win = await reopen(ctx);
    try {
      const before = ledgerBytes(ctx.ledger);
      // The window may hand out a connect line (that writes no ledger entry), but whatever the agent then does must stop.
      const connected = await win.call("POST", `/agents/connect${q}`, {});
      const c = connected.body.result as { bridgeUrl: string; tokenFile: string };
      const call = bridgeCall(c.bridgeUrl, fs.readFileSync(c.tokenFile, "utf8"));
      const outcomes: string[] = [];
      for (const [tool, args] of [["hello", { name: "Main chat" }], ["claim_task", { task: "T-1" }], ["report_progress", { task: "T-1", text: "going on" }], ["ask_main", { task: "T-1", question: "Shall I carry on?" }], ["release_task", { task: "T-1", reason: "x" }]] as const) {
        outcomes.push(await call({ tool, args, agent: "main-0000" }).then(() => `${tool}: accepted`, (error: { code?: string }) => `${tool}: ${error.code}`));
      }
      expect(ledgerBytes(ctx.ledger), outcomes.join(", ")).toEqual(before);
      expect(outcomes.filter((o) => /accepted/.test(o)).filter((o) => !/^hello/.test(o)), outcomes.join(", ")).toEqual([]);
    } finally {
      await win.stop();
    }
  }, 60_000);

  it("control: a ledger whose lines only use Windows line endings is not damaged", async () => {
    const ctx = await prepare();
    fs.writeFileSync(ctx.file, `${ctx.lines.join("\r\n")}\r\n`);
    const win = await reopen(ctx);
    try {
      expect((await win.call("GET", `/status${q}`)).body.result.integrity).toEqual({ state: "ok", writesStopped: false });
    } finally {
      await win.stop();
    }
  }, 60_000);

  it("the same damage in the LAST line with a newline after it is also refused (only a line missing its newline is a torn tail)", async () => {
    const ctx = await prepare();
    const last = ctx.lines.length - 1;
    const lines = ctx.lines.map((l, i) => (i === last ? l.slice(0, Math.floor(l.length / 2)) : l));
    fs.writeFileSync(ctx.file, `${lines.join("\n")}\n`);
    const win = await reopen(ctx);
    try {
      const status = (await win.call("GET", `/status${q}`)).body.result;
      expect(status.integrity.writesStopped).toBe(true);
      expect(fs.readdirSync(ctx.ledger).filter((f) => f.startsWith("torn-"))).toEqual([]);
    } finally {
      await win.stop();
    }
  }, 60_000);
});
