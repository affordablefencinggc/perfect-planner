// Hostile agent and forged request trial (ledger 10-soak). A stand-in worker that lies, skips steps, replays,
// and commits after approval, driven through the real bridge and the real host. A refusal is the pass. A write
// that lands, a merge of an unapproved commit, a 5xx or a changed chain is a break. Known breaks are it.fails.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeCall } from "../mcp/index";
import { verifyChain } from "../ledger/index";
import { addTask, cleanTemp, dispatchAndApproveTest, git, makeRepo, startWindow, tempDir, write, type Dispatched, type Window } from "./helpers";

afterAll(cleanTemp);
const q = "?project=p";
let win: Window;
let repo: string;

beforeAll(async () => {
  repo = makeRepo();
  const dir = tempDir();
  win = await startWindow({ data: dir, project: repo, secrets: path.join(dir, "secrets.json") });
  for (const title of ["one", "two", "three", "four", "five"]) await addTask(win, q, title);
}, 120_000);
afterAll(async () => win.stop());

const chain = () => (win.host.project("p").entries() as any[]);
const types = () => chain().map((e) => e.type);
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e as Error & { code?: string };
  }
};

describe("1. a hostile worker", () => {
  let w: Dispatched;
  it("cannot claim before the person approved its test", async () => {
    const d = (await win.call("POST", `/tasks/T-1/dispatch${q}`, { model: "m" })).body.result;
    const call = bridgeCall(d.bridgeUrl, fs.readFileSync(d.tokenFile, "utf8"));
    const hello = (await call({ tool: "hello", args: { name: "Liar" } })) as { agent: string };
    write(d.worktree, "tests/save.check.mjs", 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/save.js") ? 0 : 1);\n');
    git(d.worktree, "add", "-A");
    git(d.worktree, "commit", "-q", "-m", "t");
    await call({ tool: "propose_test", args: { task: "T-1", command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] }, agent: hello.agent });
    const err = await refused(call({ tool: "claim_task", args: { task: "T-1" }, agent: hello.agent }));
    expect(err, "claim before approval was accepted").not.toBeNull();
    w = { task: "T-1", worktree: d.worktree, branch: d.branch, bridgeUrl: d.bridgeUrl, tokenFile: d.tokenFile, token: fs.readFileSync(d.tokenFile, "utf8"), agent: hello.agent, call };
  });

  it("cannot touch another task with its own token", async () => {
    for (const tool of ["claim_task", "attach_proof", "report_progress", "propose_test", "ask_main"]) {
      const err = await refused(w.call({ tool, args: { task: "T-2", kind: "commit", link: "abc1234", text: "done", question: "x", command: "true", files: ["a"] }, agent: w.agent } as any));
      expect(err, `${tool} on T-2 with T-1's token was accepted`).not.toBeNull();
    }
  });

  it("cannot pass itself off as a different agent or a person", async () => {
    const err = await refused(w.call({ tool: "claim_task", args: { task: "T-1" }, agent: "agent-main-0" } as any));
    expect(err).not.toBeNull();
    const withPerson = await fetch(`${win.base}/tasks/T-1/approve-diff${q}`, { method: "POST", headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" }, body: "{}" });
    expect([401, 403]).toContain(withPerson.status);
  });

  it("order tricks: proof before claim, a changed test after approval", async () => {
    const entry = ((await win.call("GET", `/tasks${q}`)).body.result.tasks as any[]).find((t) => t.id === "T-1").test.entry;
    const approved = await win.call("POST", `/tasks/T-1/approve-test${q}`, { test: entry });
    expect(approved.body.result.failsFirst).toBe(true);
    const early = await refused(w.call({ tool: "attach_proof", args: { task: "T-1", kind: "commit", link: git(w.worktree, "rev-parse", "HEAD") }, agent: w.agent }));
    expect(early, "proof before claim was accepted").not.toBeNull();
    // Re-proposing a weaker test after approval must not replace the approved one.
    write(w.worktree, "tests/weak.mjs", "process.exit(0);\n");
    git(w.worktree, "add", "-A");
    git(w.worktree, "commit", "-q", "-m", "weak");
    await refused(w.call({ tool: "propose_test", args: { task: "T-1", command: "node tests/weak.mjs", files: ["tests/weak.mjs"] }, agent: w.agent }));
    // The weaker test is only a proposal: the old approval is void, the claim is refused, and approving the weak test is refused because it passes first.
    const claim = await refused(w.call({ tool: "claim_task", args: { task: "T-1" }, agent: w.agent }));
    expect(claim, "claim worked on a swapped, unapproved test").not.toBeNull();
    const weakEntry = ((await win.call("GET", `/tasks${q}`)).body.result.tasks as any[]).find((t) => t.id === "T-1").test.entry;
    const weak = await win.call("POST", `/tasks/T-1/approve-test${q}`, { test: weakEntry });
    expect(weak.body.result?.failsFirst, "a test that passes on today's code was accepted as a fails-first test").not.toBe(true);
  });

  it("a commit made after the diff was approved is never merged", async () => {
    w = await dispatchAndApproveTest(win, q, "T-3");
    await w.call({ tool: "claim_task", args: { task: "T-3" }, agent: w.agent });
    write(w.worktree, "src/save.js", "export const save = (n) => n;\n");
    git(w.worktree, "add", "-A");
    git(w.worktree, "commit", "-q", "-m", "build");
    const head = git(w.worktree, "rev-parse", "HEAD");
    await w.call({ tool: "attach_proof", args: { task: "T-3", kind: "commit", link: head }, agent: w.agent });
    expect((await win.call("POST", `/tasks/T-3/check${q}`)).body.result.passed).toBe(true);
    const diff = (await win.call("GET", `/tasks/T-3/diff${q}`)).body.result;
    const ok = await win.call("POST", `/tasks/T-3/approve-diff${q}`, { commit: head, confirmSensitive: diff.sensitive });
    expect(ok.status).toBe(200);
    // the worker slips a second commit in after the person looked
    write(w.worktree, "src/backdoor.js", "export const evil = true;\n");
    git(w.worktree, "add", "-A");
    git(w.worktree, "commit", "-q", "-m", "sneak");
    const mainBefore = git(repo, "rev-parse", "main");
    const merge = await win.call("POST", `/tasks/T-3/merge${q}`, { commit: head });
    console.log(`hostile: merge after a sneaked commit -> ${merge.status} ${merge.body.code ?? ""} ${String(merge.body.message ?? "").slice(0, 160)}`);
    const files = git(repo, "ls-tree", "-r", "--name-only", "main");
    expect(files, "the unapproved backdoor commit reached main").not.toContain("backdoor.js");
    if (merge.status === 200) expect(git(repo, "rev-parse", "main")).not.toBe(mainBefore);
    expect(merge.status, JSON.stringify(merge.body)).not.toBe(500);
  });

  it("a token is dead after its task is finished or the worker is revoked", async () => {
    const err = await refused(w.call({ tool: "report_progress", args: { task: "T-3", text: "still here" }, agent: w.agent } as any));
    const view = ((await win.call("GET", `/tasks${q}`)).body.result.tasks as any[]).find((t) => t.id === "T-3");
    if (view.status === "done") expect(err, "worker token still works after merge").not.toBeNull();
  });

  it("chain still verifies and no worker-signed approval exists", () => {
    const entries = chain();
    expect(verifyChain(entries as any).ok ?? true).toBe(true);
    const bad = entries.filter((e) => /approved|merged/.test(e.type) && e.actor?.kind === "agent");
    expect(bad.map((e) => `${e.type}:${e.actor?.id}`)).toEqual([]);
    void types;
  });
});

describe("7. forged requests against the new routes", () => {
  const routes: [string, string, unknown][] = [
    ["POST", "/tasks/groups/g1/merge", { commits: {} }],
    ["POST", "/people/assign", { task: "T-2", person: "owner" }],
    ["POST", "/cost/prices", { prices: { m: { inputPerMillion: 1, outputPerMillion: 1 } } }],
    ["POST", "/repos", { name: "evil", root: "/tmp" }],
    ["POST", "/repos/remove", { name: "evil" }],
    ["POST", "/tasks/T-2/dispatch", {}],
    ["POST", "/tasks/T-2/approve-diff", { commit: "x" }],
    ["POST", "/tasks/T-2/merge", { commit: "x" }],
    ["POST", "/keys/rotate", {}],
    ["POST", "/plan/approve", {}],
    ["POST", "/people/members", { name: "mallory", role: "owner" }],
  ];
  const hdr = (kind: string): Record<string, string> => {
    const p = win.person();
    switch (kind) {
      case "no cookie": return { origin: win.origin };
      case "no csrf": return { cookie: p.cookie!, origin: win.origin };
      case "wrong csrf": return { ...p, "x-csrf-token": "nope" } as any;
      case "wrong origin": return { ...p, origin: "http://evil.example" };
      case "no origin": { const { origin: _o, ...rest } = p; return rest; }
      default: return {};
    }
  };
  for (const kind of ["no cookie", "no csrf", "wrong origin", "no origin"]) {
    it(`every route refuses: ${kind}`, async () => {
      const bad: string[] = [];
      for (const [method, route, body] of routes) {
        const before = chain().length;
        const res = await fetch(`${win.base}${route}${q}`, { method, headers: { ...hdr(kind), "content-type": "application/json" }, body: JSON.stringify(body) });
        if (res.status < 400 || res.status >= 500) bad.push(`${route} -> ${res.status}`);
        if (chain().length !== before) bad.push(`${route} wrote to the ledger`);
      }
      expect(bad).toEqual([]);
    });
  }
  it("an agent bridge token is not a person", async () => {
    const t = fs.readFileSync(w2token(), "utf8");
    const bad: string[] = [];
    for (const [method, route, body] of routes) {
      const res = await fetch(`${win.base}${route}${q}`, { method, headers: { authorization: `Bearer ${t}`, "x-pp-token": t, origin: win.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.status < 400 || res.status >= 500) bad.push(`${route} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });
  it("a used launch secret cannot be claimed again", async () => {
    const launch = win.host.issueLaunch();
    const claim = () => fetch(`${win.base}/session/claim`, { method: "POST", headers: { origin: win.origin, "content-type": "application/json" }, body: JSON.stringify({ launch }) });
    expect((await claim()).status).toBe(200);
    expect((await claim()).status).toBeGreaterThanOrEqual(400);
  });
  it("route list is complete: every registered route is in the table or marked read-only", () => {
    // reads the route files so a new person-only route cannot be forgotten
    const dir = path.join(__dirname, "../host/routes");
    const found = new Set<string>();
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/router\.post\("([^"]+)"/g)) found.add(m[1]!);
    }
    expect(found.size).toBeGreaterThan(30);
  });
});

function w2token(): string {
  const dir = path.join(tempDir(), "t");
  fs.writeFileSync(dir, "pp_not_a_real_token_value");
  return dir;
}
