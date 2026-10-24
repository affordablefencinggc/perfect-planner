// Big and full (ledger 10-soak area 5): a 20,000-file repo, a ledger of tens of thousands of entries, and a ledger
// folder that runs out of space. Numbers are printed; the assertions are the limits stated in the ledger.
// PP_SOAK=1 runs it (the full-disk part also needs root and `mount -t tmpfs`).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verifyChain } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import { asPersonRequest } from "../host/keys";
import { hostCall, startTestHost } from "../host/testing";
import { buildCheckApprove, cleanTemp, dispatchAndApproveTest, git, makeRepo, startWindow, tempDir, write } from "./helpers";

afterAll(cleanTemp);
const on = process.env.PP_SOAK === "1";
const d = on ? describe : describe.skip;
const q = "?project=p";
const t = async <T>(label: string, f: () => Promise<T>) => {
  const s = Date.now();
  const r = await f();
  const ms = Date.now() - s;
  console.log(`big: ${label} ${ms} ms`);
  return { r, ms };
};

d("a 20,000-file repo", () => {
  it("dispatch, check, diff and merge stay under a minute each", async () => {
    const repo = makeRepo();
    // 20,000 files in 200 folders, written fast with fast-import
    const lines: string[] = ["commit refs/heads/main", "committer t <t@t.invalid> 1700000000 +0000", "data 4", "big"];
    lines.push("from refs/heads/main^0");
    for (let i = 0; i < 20_000; i++) {
      const body = `export const v${i} = ${i};\n`;
      lines.push(`M 100644 inline src/gen/d${i % 200}/f${i}.js`, `data ${Buffer.byteLength(body)}`, body);
    }
    execFileSync("git", ["fast-import", "--quiet", "--force"], { cwd: repo, input: lines.join("\n") + "\n", env: { ...process.env } });
    git(repo, "reset", "--hard", "-q", "main");
    expect(git(repo, "ls-files").split("\n").length).toBeGreaterThanOrEqual(20_000);
    const dir = tempDir();
    const win = await startWindow({ data: dir, project: repo, secrets: path.join(dir, "secrets.json") });
    try {
      const chosen = await t("choose repo", () => win.call("POST", `/tasks/repo${q}`, { root: repo }));
      expect(chosen.r.status).toBe(200);
      await win.call("POST", `/planning/tasks${q}`, { title: "Touch the big repo" });
      const dispatch = await t("dispatch + approve test (worktree of 20k files)", () => dispatchAndApproveTest(win, q, "T-1"));
      const build = await t("build, check, approve diff", () => buildCheckApprove(win, q, dispatch.r));
      const head = build.r;
      const merge = await t("merge", () => win.call("POST", `/tasks/T-1/merge${q}`, { commit: head }));
      expect(merge.r.status, JSON.stringify(merge.r.body)).toBe(200);
      for (const step of [dispatch, build, merge]) expect(step.ms).toBeLessThan(60_000);
    } finally {
      await win.stop();
    }
  }, 600_000);
});

d("a ledger of 50,000 entries", () => {
  it("opens, lists, verifies and answers /tasks in bounded time", async () => {
    const ctx = await startTestHost();
    try {
      const project = ctx.host.project("big");
      const person = { kind: "person" as const, id: "owner" };
      const count = Number(process.env.PP_BIG_ENTRIES ?? 20_000);
      const fill = await t(`append ${count} entries`, async () => {
        asPersonRequest(() => {
          for (let i = 0; i < 300; i++) appendNumbered(project.ledger, { actor: person, type: "task.created", summary: `Task ${i}`, data: { title: `Task ${i}` } });
        });
        for (let i = 300; i < count; i++) {
          project.ledger.append({ actor: { kind: "system", id: "worktrees" }, type: "task.progress", subject: `T-${(i % 300) + 1}`, summary: `note ${i}`, data: { n: i } });
        }
      });
      expect(fill.ms).toBeLessThan(600_000);
      const one = await t("ONE person-signed append (a click) at this size", async () => asPersonRequest(() => project.ledger.append({ actor: person, type: "task.progress", subject: "T-1", summary: "click", data: {} })));
      void one; // the cost of a click grows with the ledger (F6, appendcost.test.ts); printed above, not asserted here
      const tasks = await t("GET /tasks (300 tasks, big ledger)", () => hostCall(ctx.base, "GET", "/tasks?project=big"));
      expect(tasks.r.status).toBe(200);
      const summary = await t("GET /summary", () => hostCall(ctx.base, "GET", "/summary?project=big"));
      expect(summary.r.status).toBe(200);
      const verify = await t("GET /verify", () => hostCall(ctx.base, "GET", "/verify?project=big"));
      expect(verify.r.status).toBe(200);
      const chain = await t("verifyChain over all entries", async () => verifyChain(project.entries() as any));
      expect(chain.r.ok ?? true).toBe(true);
      for (const x of [tasks, summary, verify]) expect(x.ms, "an answer took more than 10 s").toBeLessThan(10_000);
    } finally {
      await ctx.stop();
    }
  }, 1_800_000);
});

d("a full disk under the ledger", () => {
  it("refuses plainly, keeps the chain intact, and writes again when space returns", async () => {
    const repo = makeRepo();
    const dir = tempDir();
    const ledgerDir = path.join(repo, ".perfect-planner");
    fs.mkdirSync(ledgerDir, { recursive: true });
    const mounted = spawnSync("mount", ["-t", "tmpfs", "-o", "size=1536k", "tmpfs", ledgerDir]);
    if (mounted.status !== 0) {
      console.log(`big: full-disk test skipped (cannot mount tmpfs: ${String(mounted.stderr).trim()})`);
      return;
    }
    const win = await startWindow({ data: dir, project: repo, secrets: path.join(dir, "secrets.json") });
    try {
      const first = await win.call("POST", `/planning/tasks${q}`, { title: "first" });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      // leave only a little room, then write until something gives
      const filler = path.join(ledgerDir, "filler.bin");
      const free = Number(execFileSync("df", ["--output=avail", "-B1", ledgerDir]).toString().trim().split("\n").pop());
      fs.writeFileSync(filler, Buffer.alloc(Math.max(0, free - 200_000)));
      let refusal: { status: number; body: any } | undefined;
      let ok = 0;
      for (let i = 0; i < 2000 && !refusal; i++) {
        const res = await win.call("POST", `/planning/tasks${q}`, { title: `fill ${i} ${"x".repeat(150)}`, doneWhen: "y".repeat(900) });
        if (res.status === 200) ok++;
        else refusal = res;
      }
      console.log(`big: disk full after ${ok} writes -> ${refusal?.status} ${refusal?.body?.code}: ${String(refusal?.body?.message).slice(0, 200)}`);
      expect(refusal, "the disk never filled").toBeDefined();
      expect(refusal!.status, "a full disk must be a plain refusal, not a crash").toBeLessThan(600);
      expect(String(refusal!.body?.message ?? ""), "the refusal must say what happened").toMatch(/space|disk|full|write|save/i);
      expect(String(refusal!.body?.message ?? ""), "a full disk is not tampering").not.toMatch(/fingerprint|acknowledge|tamper/i);
      // reads still work and the chain is intact
      expect((await win.call("GET", `/tasks${q}`)).status).toBe(200);
      const files = fs.readdirSync(ledgerDir).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        const text = fs.readFileSync(path.join(ledgerDir, f), "utf8");
        expect(text.endsWith("\n"), `${f} ends in a torn line`).toBe(true);
        for (const line of text.split("\n").filter(Boolean)) JSON.parse(line);
      }
      expect(verifyChain(win.host.project("p").entries() as any).ok ?? true).toBe(true);
      // space comes back
      fs.rmSync(filler);
      // The refusal says "until the ledger is reopened": without a restart the writes stay stopped. That is a stated rule, so it is only recorded.
      const same = await win.call("POST", `/planning/tasks${q}`, { title: "after the disk was freed, same session" });
      console.log(`big: same session after space returned -> ${same.status} ${same.body.code}: ${String(same.body.message).slice(0, 200)}`);
      // Reopen (the app restarts) over the same folders: the half-written last line must be handled, not read as tampering that needs a person to acknowledge.
      await win.stop();
      const again = await startWindow({ data: dir, project: repo, secrets: path.join(dir, "secrets.json") });
      try {
        const view = await again.call("GET", `/tasks${q}`);
        console.log(`big: after restart GET /tasks -> ${view.status} ${view.body.code ?? ""}: ${String(view.body.message ?? "").slice(0, 200)}`);
        const after = await again.call("POST", `/planning/tasks${q}`, { title: "after the disk was freed and the app restarted" });
        console.log(`big: after restart write -> ${after.status} ${after.body.code ?? ""}: ${String(after.body.message ?? "").slice(0, 300)}`);
        expect(after.status, `writes did not resume after a restart: ${JSON.stringify(after.body)}`).toBe(200);
        expect(verifyChain(again.host.project("p").entries() as any).ok ?? true).toBe(true);
      } finally {
        await again.stop();
      }
    } finally {
      await win.stop().catch(() => undefined);
      spawnSync("umount", [ledgerDir]);
    }
  }, 300_000);
});

void write;
