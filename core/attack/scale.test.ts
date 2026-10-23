// Scale break test (CI runs 2 projects x 5 workers; the full 4 x 10 is PP_SCALE_PROJECTS=4 PP_SCALE_WORKERS=10, about 2.5 minutes): four projects (four repos), ten parallel workers in each, all driven through the
// same host the app uses: dispatch, worker over the bridge, test approval, check, diff approval, merge.
// It reports every refusal it sees, then asserts the end state: every task done, every file on main once,
// every ledger chain intact, no task claimed twice.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeCall } from "../mcp/index";
import { verifyChain } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import { asPersonRequest } from "../host/keys";
import { hostCall, startTestHost } from "../host/testing";

// These suites test the host's own logic (concurrency, routes, bridge), which does not change with the OS, and
// Linux CI runs them in full. Windows core CI is already close to its 15-minute limit, so there they are skipped
// unless PP_ATTACK_ALL=1 (set it to run them on a Windows machine).
const runHere = process.platform !== "win32" || process.env.PP_ATTACK_ALL === "1";
const PROJECTS = Number(process.env.PP_SCALE_PROJECTS ?? 2);
const WORKERS = Number(process.env.PP_SCALE_WORKERS ?? 5);
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

let ctx: Awaited<ReturnType<typeof startTestHost>>;
const repos: string[] = [];
const keys = Array.from({ length: PROJECTS }, (_, i) => `scale${i + 1}`);
const refusals: string[] = [];
const ports: number[] = [];

beforeAll(async () => {
  if (!runHere) return;
  ctx = await startTestHost();
  for (const key of keys) {
    const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `pp-${key}-`)));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "commit.gpgsign", "false");
    // The app records merges under the repo's own identity, and a CI machine has none.
    git(repo, "config", "user.name", "Scale Test");
    git(repo, "config", "user.email", "scale@test.invalid");
    write(repo, "README.md", `# ${key}\n`);
    write(repo, ".gitignore", ".perfect-planner/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Initial");
    repos.push(repo);
    const project = ctx.host.project(key);
    for (let n = 1; n <= WORKERS; n++) {
      asPersonRequest(() => appendNumbered(project.ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: `Add part ${n}`, data: { title: `Add part ${n}` } }));
    }
    const chosen = await hostCall(ctx.base, "POST", `/tasks/repo?project=${key}`, { root: repo });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
  }
}, 120_000);

afterAll(async () => {
  if (!runHere) return;
  if (refusals.length) console.log(`scale: ${refusals.length} refusals seen\n${refusals.slice(0, 40).join("\n")}`);
  await ctx.stop();
  for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true });
}, 120_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function person(key: string, route: string, body: unknown = {}, tries = 1) {
  let last: Awaited<ReturnType<typeof hostCall>> | undefined;
  for (let i = 0; i < tries; i++) {
    last = await hostCall(ctx.base, "POST", `${route}?project=${key}`, body);
    if (last.status === 200) return last;
    refusals.push(`${key} ${route} -> ${last.status} ${last.body?.code}: ${String(last.body?.message ?? "").slice(0, 160)}`);
    await sleep(200 * (i + 1));
  }
  return last!;
}

describe.skipIf(!runHere)(`${PROJECTS} projects x ${WORKERS} parallel workers`, () => {
  it("finishes every task, loses nothing, claims nothing twice", async () => {
    const started = Date.now();
    await Promise.all(keys.map(async (key, ki) => {
      const repo = repos[ki]!;
      const ids = Array.from({ length: WORKERS }, (_, i) => `T-${i + 1}`);
      // Dispatch all workers at once, then each worker proposes its test.
      const workers = await Promise.all(ids.map(async (id) => {
        const res = await person(key, `/tasks/${id}/dispatch`, { model: "claude-sonnet-5-5" }, 5);
        expect(res.status, `${key} ${id} dispatch ${JSON.stringify(res.body)}`).toBe(200);
        const d = res.body.result;
        ports.push(d.port ?? d.worktreeInfo?.port);
        const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
        const hello = (await call({ tool: "hello", args: { name: `Worker ${key} ${id}` } })) as { agent: string };
        const file = `part-${id}`;
        write(d.worktree, `tests/${file}.check.mjs`, `import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/${file}.js") ? 0 : 1);\n`);
        git(d.worktree, "add", "-A");
        git(d.worktree, "commit", "-q", "-m", `Test ${id}`);
        await call({ tool: "propose_test", args: { task: id, command: `node tests/${file}.check.mjs`, files: [`tests/${file}.check.mjs`] }, agent: hello.agent });
        return { id, d, call, agent: hello.agent, file };
      }));
      // The person approves every test (each is run and must fail first).
      const listed = (await hostCall(ctx.base, "GET", `/tasks?project=${key}`)).body.result.tasks as any[];
      await Promise.all(workers.map(async (w) => {
        const entry = listed.find((t) => t.id === w.id).test.entry;
        const res = await person(key, `/tasks/${w.id}/approve-test`, { test: entry }, 5);
        expect(res.body.result, `${key} ${w.id} approve-test`).toMatchObject({ failsFirst: true });
      }));
      // Workers claim, build, commit and attach proof, all at once.
      await Promise.all(workers.map(async (w) => {
        await w.call({ tool: "claim_task", args: { task: w.id }, agent: w.agent });
        write(w.d.worktree, `src/${w.file}.js`, `export const ${w.file.replace(/\W/g, "_")} = 1;\n`);
        git(w.d.worktree, "add", "-A");
        git(w.d.worktree, "commit", "-q", "-m", `Build ${w.id}`);
        await w.call({ tool: "attach_proof", args: { task: w.id, kind: "commit", link: git(w.d.worktree, "rev-parse", "HEAD") }, agent: w.agent });
      }));
      // Check and approve every diff, then merge them all at once; a merge refused because main moved is retried after bringing the task up to date.
      await Promise.all(workers.map(async (w) => {
        expect((await person(key, `/tasks/${w.id}/check`, {}, 3)).body.result, `${key} ${w.id} check`).toMatchObject({ passed: true });
        const diff = (await hostCall(ctx.base, "GET", `/tasks/${w.id}/diff?project=${key}`)).body.result;
        const ok = await person(key, `/tasks/${w.id}/approve-diff`, { commit: diff.commit, confirmSensitive: diff.sensitive }, 3);
        expect(ok.status, `${key} ${w.id} approve-diff ${JSON.stringify(ok.body)}`).toBe(200);
      }));
      await Promise.all(workers.map(async (w) => {
        for (let attempt = 0; attempt < 12; attempt++) {
          const view = (await hostCall(ctx.base, "GET", `/tasks?project=${key}`)).body.result.tasks.find((t: any) => t.id === w.id);
          if (view.status === "done") return;
          const commit = view.diffApproval?.commit;
          const res = await person(key, `/tasks/${w.id}/merge`, { commit }, 1);
          if (res.status === 200) return;
          if (/moved|behind|stale|out of date|update/i.test(String(res.body?.message))) {
            await person(key, `/tasks/${w.id}/update-from-main`, {}, 1);
            // Updating changes the tip: the person checks and approves the new one.
            await person(key, `/tasks/${w.id}/check`, {}, 2);
            const diff = (await hostCall(ctx.base, "GET", `/tasks/${w.id}/diff?project=${key}`)).body.result;
            await person(key, `/tasks/${w.id}/approve-diff`, { commit: diff.commit, confirmSensitive: diff.sensitive }, 2);
          }
          await sleep(150 * (attempt + 1) + Math.random() * 200);
        }
      }));
      void repo;
    }));
    console.log(`scale: ${PROJECTS} projects x ${WORKERS} workers took ${Math.round((Date.now() - started) / 1000)}s`);

    expect(ports.every((p) => Number.isInteger(p)), `dispatch result carries a port: ${JSON.stringify(ports.slice(0, 3))}`).toBe(true);
    expect(new Set(ports).size, "no two workers across all projects got the same dev-server port").toBe(ports.length);

    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki]!;
      const view = (await hostCall(ctx.base, "GET", `/tasks?project=${key}`)).body.result.tasks as any[];
      const notDone = view.filter((t) => t.status !== "done").map((t) => `${t.id}:${t.stage}`);
      if (notDone.length) console.log(`scale: ${key} not done; main checkout status:\n${git(repos[ki]!, "status", "--porcelain", "--untracked-files=no")}\nhead ${git(repos[ki]!, "rev-parse", "HEAD")} branch ${git(repos[ki]!, "rev-parse", "--abbrev-ref", "HEAD")}`);
      expect(notDone, `${key} tasks not done`).toEqual([]);
      const files = git(repos[ki]!, "ls-tree", "-r", "--name-only", "main").split("\n").filter((f) => f.startsWith("src/part-"));
      expect(files.sort(), `${key} files on main`).toHaveLength(WORKERS);
      const entries = ctx.host.project(key).entries();
      expect(verifyChain(entries as any).ok ?? true, `${key} ledger chain`).toBe(true);
      const claims = entries.filter((e: any) => e.type === "task.claimed").map((e: any) => e.subject);
      expect(new Set(claims).size, `${key} a task was claimed twice`).toBe(claims.length);
    }
  }, 900_000);
});
