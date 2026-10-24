// Long soak (ledger 10-soak areas 5 and 6). PP_SOAK=1 runs it; PP_SOAK_PROJECTS / PP_SOAK_REPOS / PP_SOAK_TASKS scale it
// (default for the trial: 3 projects x 4 repos x 10 tasks per repo, 10 stand-in agents per project). Every agent is a
// stand-in: no model, no key. Some are hostile: they call tools on tasks that are not theirs, and a few commit a
// backdoor after the person approved the diff. The person polls /tasks, /cost and /summary the whole time.
// End state asserted: every honest task done once, every file on main once, no backdoor on main, ledger chains verify,
// no task claimed twice, dev-server ports unique, cost totals equal what the agents reported, no 5xx.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeCall } from "../mcp/index";
import { verifyChain } from "../ledger/index";
import { hostCall, startTestHost } from "../host/testing";

const P = Number(process.env.PP_SOAK_PROJECTS ?? 3);
const R = Number(process.env.PP_SOAK_REPOS ?? 4);
const T = Number(process.env.PP_SOAK_TASKS ?? 10);
const AGENTS = Number(process.env.PP_SOAK_AGENTS ?? 10);
const on = process.env.PP_SOAK === "1";
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ctx: Awaited<ReturnType<typeof startTestHost>>;
const keys = Array.from({ length: P }, (_, i) => `soak${i + 1}`);
const repoDirs = new Map<string, Map<string, string>>(); // project -> repo name -> folder
const refusals = new Map<string, number>();
const fivexx: string[] = [];
const forgedAccepted: string[] = [];
const reportedTokens = new Map<string, number>();
const sneaked = new Map<string, string>(); // project:task -> backdoor file
const latency: number[] = [];
const ports: { port: number; start: number; end: number; who: string }[] = [];
let polling = true;

const d = on ? describe : describe.skip;

async function call(key: string, method: "GET" | "POST", route: string, body?: unknown) {
  const res = await hostCall(ctx.base, method, `${route}?project=${key}`, body);
  if (res.status >= 500) fivexx.push(`${key} ${method} ${route} -> ${res.status} ${res.body?.code}: ${String(res.body?.message).slice(0, 120)}`);
  if (res.status >= 400) {
    const k = `${route.replace(/T-\d+/, "T-n").replace(/groups\/[^/]+/, "groups/g")} ${res.status} ${res.body?.code}`;
    refusals.set(k, (refusals.get(k) ?? 0) + 1);
  }
  return res;
}

beforeAll(async () => {
  if (!on) return;
  ctx = await startTestHost();
  for (const key of keys) {
    const dirs = new Map<string, string>();
    repoDirs.set(key, dirs);
    for (let r = 0; r < R; r++) {
      const name = r === 0 ? "main" : `repo${r}`;
      const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `pp-${key}-${name}-`)));
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "commit.gpgsign", "false");
      git(repo, "config", "user.name", "Soak");
      git(repo, "config", "user.email", "soak@test.invalid");
      write(repo, "README.md", `# ${key} ${name}\n`);
      write(repo, ".gitignore", ".perfect-planner/\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "Initial");
      dirs.set(name, repo);
    }
    const first = await call(key, "POST", "/tasks/repo", { root: dirs.get("main") });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    for (const [name, root] of dirs) {
      if (name === "main") continue;
      const added = await call(key, "POST", "/repos", { name, root });
      expect(added.status, `${key} add ${name}: ${JSON.stringify(added.body)}`).toBe(200);
    }
    for (const name of dirs.keys()) {
      for (let n = 1; n <= T; n++) {
        const made = await call(key, "POST", "/planning/tasks", { title: `${name} part ${n}`, repos: [name] });
        expect(made.status, JSON.stringify(made.body)).toBe(200);
      }
    }
    // three tasks that span two repos each (one task per repo, merged together)
    for (let g = 1; g <= 3 && R >= 2; g++) {
      const made = await call(key, "POST", "/planning/tasks", { title: `shared change ${g}`, repos: ["main", "repo1"] });
      expect(made.status, JSON.stringify(made.body)).toBe(200);
    }
  }
}, 600_000);

afterAll(async () => {
  polling = false;
  if (!on) return;
  const top = [...refusals].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${n}x ${k}`);
  console.log(`soak: refusals seen (honest agents retry; expected ones are merge-moved and stale)\n${top.join("\n")}`);
  await ctx.stop();
  for (const dirs of repoDirs.values()) for (const dir of dirs.values()) fs.rmSync(dir, { recursive: true, force: true });
}, 120_000);

type TaskView = { id: string; repo: string | null; group: string | null; status: string; stage: string };
const tasksOf = async (key: string) => (await call(key, "GET", "/tasks")).body.result.tasks as TaskView[];

async function lifecycle(key: string, task: TaskView, index: number): Promise<"done" | "ready" | "sneaked"> {
  const repoName = task.repo ?? "main";
  const id = task.id;
  const res = await retry(key, `/tasks/${id}/dispatch`, { model: "stand-in" }, 8);
  if (res.status !== 200) throw new Error(`${key} ${id} dispatch ${JSON.stringify(res.body)}`);
  const dsp = res.body.result;
  const lease = { port: dsp.port ?? dsp.worktreeInfo?.port, start: Date.now(), end: Infinity, who: `${key}:${id}` };
  ports.push(lease);
  const workerCall = bridgeCall(dsp.bridgeUrl, fs.readFileSync(dsp.tokenFile, "utf8"));
  const hello = (await workerCall({ tool: "hello", args: { name: `Stand-in ${key}-${id}` } })) as { agent: string };
  const file = `part-${key}-${id}`;
  write(dsp.worktree, `tests/${file}.check.mjs`, `import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/${file}.js") ? 0 : 1);\n`);
  git(dsp.worktree, "add", "-A");
  git(dsp.worktree, "commit", "-q", "-m", `Test ${id}`);
  await workerCall({ tool: "propose_test", args: { task: id, command: `node tests/${file}.check.mjs`, files: [`tests/${file}.check.mjs`] }, agent: hello.agent });
  // Hostile habit 1: every 4th agent tries to use its own token on a task that is not its own.
  if (index % 4 === 0) {
    for (const tool of ["claim_task", "attach_proof", "report_progress"]) {
      const other = `T-${Number(id.slice(2)) % 20 + 1}`;
      if (other === id) continue;
      try {
        await workerCall({ tool, args: { task: other, kind: "commit", link: "0".repeat(40), text: "forged" }, agent: hello.agent } as any);
        forgedAccepted.push(`${key} ${id} ${tool} on ${other}`);
      } catch {
        /* refused is the pass */
      }
    }
  }
  const entry = (await tasksOf(key)).find((t) => t.id === id) as any;
  const approved = await retry(key, `/tasks/${id}/approve-test`, { test: entry.test.entry }, 5);
  if (!approved.body.result?.failsFirst) throw new Error(`${key} ${id} approve-test ${JSON.stringify(approved.body)}`);
  await workerCall({ tool: "claim_task", args: { task: id }, agent: hello.agent });
  write(dsp.worktree, `src/${file}.js`, `export const x = ${index};\n`);
  git(dsp.worktree, "add", "-A");
  git(dsp.worktree, "commit", "-q", "-m", `Build ${id}`);
  const head = git(dsp.worktree, "rev-parse", "HEAD");
  await workerCall({ tool: "attach_proof", args: { task: id, kind: "commit", link: head }, agent: hello.agent });
  const input = 1000 + index;
  await workerCall({ tool: "report_progress", args: { task: id, text: "built", usage: { inputTokens: input, outputTokens: 50 } }, agent: hello.agent });
  reportedTokens.set(key, (reportedTokens.get(key) ?? 0) + input);
  // Hostile habit 2: an agent that returns a bad usage figure keeps its progress line and loses only the figure.
  if (index % 7 === 0) await workerCall({ tool: "report_progress", args: { task: id, text: "lying", usage: { inputTokens: -5, outputTokens: 1e12 } }, agent: hello.agent }).catch(() => undefined);
  const checked = await retry(key, `/tasks/${id}/check`, {}, 3);
  if (!checked.body.result?.passed) throw new Error(`${key} ${id} check ${JSON.stringify(checked.body)}`);
  const diff = (await call(key, "GET", `/tasks/${id}/diff`)).body.result;
  const ok = await retry(key, `/tasks/${id}/approve-diff`, { commit: head, confirmSensitive: diff.sensitive }, 3);
  if (ok.status !== 200) throw new Error(`${key} ${id} approve-diff ${JSON.stringify(ok.body)}`);
  if (task.group) return "ready";
  // Hostile habit 3: a backdoor commit after the person approved.
  if (index % 11 === 5) {
    write(dsp.worktree, `src/backdoor-${key}-${id}.js`, "export const evil = 1;\n");
    git(dsp.worktree, "add", "-A");
    git(dsp.worktree, "commit", "-q", "-m", "sneak");
    sneaked.set(`${key}:${id}`, `backdoor-${key}-${id}.js`);
    await call(key, "POST", `/tasks/${id}/merge`, { commit: head });
    return "sneaked";
  }
  lease.end = Date.now();
  await mergeWithRetry(key, id, head, repoName);
  return "done";
}

async function retry(key: string, route: string, body: unknown, tries: number) {
  let last = await call(key, "POST", route, body);
  for (let i = 1; i < tries && last.status !== 200; i++) {
    await sleep(150 * i + Math.random() * 200);
    last = await call(key, "POST", route, body);
  }
  return last;
}

async function mergeWithRetry(key: string, id: string, head: string, _repo: string) {
  let commit = head;
  for (let attempt = 0; attempt < 15; attempt++) {
    const view = (await tasksOf(key)).find((t) => t.id === id) as any;
    if (view.status === "done") return;
    commit = view.diffApproval?.commit ?? commit;
    const res = await call(key, "POST", `/tasks/${id}/merge`, { commit });
    if (res.status === 200) return;
    if (/moved|behind|stale|out of date|update/i.test(String(res.body?.message))) {
      await call(key, "POST", `/tasks/${id}/update-from-main`, {});
      await call(key, "POST", `/tasks/${id}/check`, {});
      const diff = (await call(key, "GET", `/tasks/${id}/diff`)).body.result;
      await call(key, "POST", `/tasks/${id}/approve-diff`, { commit: diff.commit, confirmSensitive: diff.sensitive });
    }
    await sleep(120 * (attempt + 1) + Math.random() * 250);
  }
}

async function poll() {
  while (polling) {
    for (const key of keys) {
      const t0 = Date.now();
      await hostCall(ctx.base, "GET", `/tasks?project=${key}`);
      latency.push(Date.now() - t0);
      await hostCall(ctx.base, "GET", `/cost?project=${key}`);
      await hostCall(ctx.base, "GET", `/summary?project=${key}`);
    }
    await sleep(700);
  }
}

d(`${P} ledgers x ${R} repos x ${T} tasks each, ${AGENTS} agents per ledger`, () => {
  it("finishes, loses nothing, claims nothing twice, lets no backdoor in", async () => {
    const started = Date.now();
    const poller = poll();
    const outcomes = new Map<string, string>();
    await Promise.all(keys.map(async (key) => {
      const queue = (await tasksOf(key)).map((t, i) => ({ t, i }));
      await Promise.all(Array.from({ length: AGENTS }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          try {
            outcomes.set(`${key}:${next.t.id}`, await lifecycle(key, next.t, next.i));
          } catch (error) {
            outcomes.set(`${key}:${next.t.id}`, `ERROR ${(error as Error).message.slice(0, 200)}`);
          }
        }
      }));
      // Merge each group together; press twice at once, the second must find nothing to do or be told it is busy.
      const groups = new Map<string, TaskView[]>();
      for (const t of await tasksOf(key)) if (t.group) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
      for (const [group, members] of groups) {
        const commits: Record<string, string> = {};
        for (const m of members) commits[m.id] = ((await call(key, "GET", `/tasks/${m.id}/diff`)).body.result as any).commit;
        const [a, b] = await Promise.all([call(key, "POST", `/tasks/groups/${group}/merge`, { commits }), call(key, "POST", `/tasks/groups/${group}/merge`, { commits })]);
        outcomes.set(`${key}:group:${group}`, `${a.status}/${b.status}`);
      }
    }));
    polling = false;
    await poller;
    const secs = Math.round((Date.now() - started) / 1000);
    const sorted = [...latency].sort((x, y) => x - y);
    console.log(`soak: ${P * (R * T + 3)} tasks in ${secs}s; GET /tasks latency p50 ${sorted[Math.floor(sorted.length * 0.5)]} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)]} ms, max ${sorted.at(-1)} ms over ${sorted.length} polls; rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
    const errors = [...outcomes].filter(([, v]) => v.startsWith("ERROR"));
    console.log(`soak: outcomes ${JSON.stringify(Object.fromEntries([...outcomes.values()].map((v) => [v.slice(0, 5), 0])))} errors ${errors.length}`);
    for (const [k, v] of errors.slice(0, 15)) console.log(`  ${k}: ${v}`);
    for (const [k, v] of [...outcomes].filter(([k]) => k.includes(":group:"))) console.log(`  ${k}: ${v}`);

    expect(fivexx, "server errors (5xx)").toEqual([]);
    expect(forgedAccepted, "a worker's forged call on another task was accepted").toEqual([]);
    expect(errors.map(([k, v]) => `${k} ${v}`), "honest agents that could not finish").toEqual([]);
    expect(ports.every((p) => Number.isInteger(p.port))).toBe(true);
    const clashes: string[] = [];
    for (let i = 0; i < ports.length; i++) for (let j = i + 1; j < ports.length; j++) {
      const a = ports[i]!, b = ports[j]!;
      if (a.port === b.port && a.start < b.end && b.start < a.end) clashes.push(`${a.who} and ${b.who} both held port ${a.port}`);
    }
    expect(clashes.slice(0, 10), "two live workers held the same dev-server port").toEqual([]);

    for (const key of keys) {
      const dirs = repoDirs.get(key)!;
      const entries = ctx.host.project(key).entries() as any[];
      expect(verifyChain(entries as any).ok ?? true, `${key} ledger chain`).toBe(true);
      const claims = entries.filter((e) => e.type === "task.claimed").map((e) => e.subject);
      expect(new Set(claims).size, `${key} a task was claimed twice`).toBe(claims.length);
      const agentSigned = entries.filter((e) => /diff\.approved|merge\.approved|test\.approved|merged/.test(e.type) && e.actor?.kind === "agent");
      expect(agentSigned.map((e) => e.type), `${key} approval signed by an agent`).toEqual([]);
      for (const [name, dir] of dirs) {
        const onMain = git(dir, "ls-tree", "-r", "--name-only", "main").split("\n");
        const mine = onMain.filter((f) => f.startsWith(`src/part-${key}-`));
        const dup = mine.length - new Set(mine).size;
        expect(dup).toBe(0);
        for (const [k, file] of sneaked) if (k.startsWith(`${key}:`)) expect(onMain, `${key}/${name} backdoor ${file} reached main`).not.toContain(`src/${file}`);
      }
      // every task the honest path finished has its file on main of its repo
      const view = await tasksOf(key);
      for (const t of view) {
        const out = outcomes.get(`${key}:${t.id}`);
        if (out === "done") expect(t.status, `${key} ${t.id}`).toBe("done");
        if (out === "done") {
          const dir = dirs.get(t.repo ?? "main")!;
          expect(git(dir, "ls-tree", "-r", "--name-only", "main"), `${key} ${t.id} file missing on main`).toContain(`src/part-${key}-${t.id}.js`);
        }
      }
      const unfinished = view.filter((t) => t.status !== "done" && outcomes.get(`${key}:${t.id}`) !== "sneaked" && outcomes.get(`${key}:${t.id}`) !== "ready").map((t) => `${t.id}:${t.stage}`);
      expect(unfinished, `${key} tasks not done`).toEqual([]);
      const groupTasks = view.filter((t) => t.group);
      expect(groupTasks.filter((t) => t.status !== "done").map((t) => `${t.id}:${t.stage}`), `${key} group tasks not merged`).toEqual([]);
      // cost: the figures the agents reported add up, and the lying ones were left out
      const cost = (await call(key, "GET", "/cost")).body.result;
      expect(cost.project.inputTokens, `${key} cost input tokens vs reported`).toBe(reportedTokens.get(key));
    }
    // bound on the person's view
    expect(sorted[Math.floor(sorted.length * 0.95)] ?? 0, "p95 of GET /tasks above 10 s").toBeLessThan(10_000);
  }, 3_600_000);
});
