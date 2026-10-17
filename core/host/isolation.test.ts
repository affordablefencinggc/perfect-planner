// Project separation, attacked (lane L6A). With several projects in one host, what stops one project's
// work leaking into another? Logic: a ledger, an owner pin, a bridge, a token store and a worktree
// registry per project. Every test here is an attack with the safe outcome asserted. What the logic does
// NOT stop (no sandbox: a worker and a test command run as the user) is in isolation-exec.test.ts, as
// `it.fails` tests named "known gap". core/host/ISOLATION.md lists both.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bridgeCall, TOOL_NAMES, type ToolName } from "../mcp/index";
import { appendNumbered } from "../numbering/index";
import { folderIdentity, identityWithin } from "./folderIdentity";
import { createCoreHost } from "./index";
import { asPersonRequest } from "./keys";
import { ledgerIntegrity, projectKeyProblem } from "./project";
import { chosenRepoRoot } from "./protectedRoots";
import { isNetworkPath } from "./tokenFile";
import { cleanAfterEach, dispatch, git, newRepo, person, track, twoProjects, type Ctx, type Side } from "./isolation-testing";
import { hostCall, personHeaders, startTestHost } from "./testing";

cleanAfterEach();

/** Arguments that pass each tool's input check, so a refusal can only come from the token. */
const VALID_ARGS: Record<ToolName, Record<string, unknown>> = {
  hello: { name: "Worker" },
  list_tasks: {},
  claim_task: { task: "T-1" },
  report_progress: { task: "T-1", text: "working" },
  attach_proof: { task: "T-1", kind: "commit", link: "abc1234" },
  ask_main: { task: "T-1", question: "Which date format?" },
  check_inbox: {},
  answer: { question: "Q-1", text: "ISO dates" },
  lookup: { ref: "T-1" },
  release_task: { task: "T-1", reason: "stuck" },
  propose_test: { task: "T-1", command: "node tests/x.mjs", files: ["tests/x.mjs"] },
};

describe("worker tokens across projects (bridge)", () => {
  it("a worker token from A is refused by B's bridge on every tool, and B's by A's", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const a = await dispatch(ctx, alpha);
    const b = await dispatch(ctx, beta);
    expect(a.bridgeUrl).not.toBe(b.bridgeUrl);
    expect(a.token).not.toBe(b.token);
    const before = [alpha, beta].map((s) => ctx.host.project(s.key).entries().length);
    for (const [token, url, label] of [[a.token, b.bridgeUrl, "A's token on B"], [b.token, a.bridgeUrl, "B's token on A"]] as const) {
      const call = bridgeCall(url, token);
      for (const tool of TOOL_NAMES) {
        // Even with an agent id the other project handed out for a real token.
        await expect(call({ tool, args: VALID_ARGS[tool], agent: "worker-deadbeef" }), `${label}: ${tool}`).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      }
    }
    // Nothing was written to either ledger by the refused calls.
    expect([alpha, beta].map((s) => ctx.host.project(s.key).entries().length)).toEqual(before);
  }, 60_000);

  it("a connect token from A cannot become B's main chat", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const connected = await hostCall(ctx.base, "POST", `/agents/connect?project=${alpha.key}`, {});
    expect(connected.status, JSON.stringify(connected.body)).toBe(200);
    const token = fs.readFileSync(connected.body.result.tokenFile, "utf8");
    const other = await hostCall(ctx.base, "POST", `/agents/connect?project=${beta.key}`, {});
    await expect(bridgeCall(other.body.result.bridgeUrl, token)({ tool: "hello", args: { name: "Intruder" } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(((await hostCall(ctx.base, "GET", `/agents?project=${beta.key}`)).body.result.agents as unknown[]).length).toBe(0);
  }, 60_000);

  it("a worker sees only its own project's board, and its token cannot name another task", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const a = await dispatch(ctx, alpha);
    await dispatch(ctx, beta);
    const call = bridgeCall(a.bridgeUrl, a.token);
    const { agent } = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
    const board = (await call({ tool: "list_tasks", args: {}, agent })) as { tasks: { id: string; title: string }[] };
    expect(board.tasks.map((t) => t.title)).toEqual(["Save notes (alpha)"]);
    expect(JSON.stringify(await call({ tool: "lookup", args: { ref: "T-1" }, agent }))).not.toContain("beta");
    // Its token covers T-1 only: another task number is refused, even one that exists in no project.
    await expect(call({ tool: "claim_task", args: { task: "T-2" }, agent })).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});

describe("worker tokens and the app's own routes", () => {
  it("a worker token is not a login: as a bearer token, a cookie or a CSRF token it gets 401 on reads and writes of both projects", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const a = await dispatch(ctx, alpha);
    const origin = ctx.base.replace(/\/api\/core$/, "");
    const attempts: Record<string, string>[] = [
      { authorization: `Bearer ${a.token}` },
      { cookie: `pp_core_person=${a.token}` },
      { cookie: `pp_core_person=${a.token}`, "x-pp-csrf": a.token, origin },
      { "x-pp-csrf": a.token, origin },
    ];
    for (const key of [alpha.key, beta.key]) {
      for (const headers of attempts) {
        const read = await fetch(`${ctx.base}/tasks?project=${key}`, { headers });
        expect(read.status, `${key} read ${Object.keys(headers)}`).toBe(401);
        const write = await fetch(`${ctx.base}/tasks/T-1/release?project=${key}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
        expect(write.status, `${key} write ${Object.keys(headers)}`).toBe(401);
      }
    }
  }, 60_000);

  it("the person's window works on both projects, but no route hands back a token, a token file's content, or the other project's folder", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const a = await dispatch(ctx, alpha);
    const b = await dispatch(ctx, beta);
    const secrets = [a.token, b.token, a.tokenFile, b.tokenFile, ctx.host.project("alpha").root, ctx.host.project("beta").root];
    const reads = ["/status", "/agents", "/tasks", "/summary", "/plan", "/people", "/decisions", "/mvp", "/planning", "/planning/mindmap", "/planning/roadmap", "/search?q=notes", "/recent", "/verify", "/lookup?ref=T-1", "/tasks/T-1/diff"];
    for (const key of [alpha.key, beta.key]) {
      for (const route of reads) {
        const sep = route.includes("?") ? "&" : "?";
        const res = await fetch(`${ctx.base}${route}${sep}project=${key}`, { headers: personHeaders(ctx.base) });
        const text = await res.text();
        for (const secret of secrets) {
          // The only thing a route may say about a path is the worktree it made for the task being asked about.
          if (secret === a.tokenFile || secret === b.tokenFile) expect(text, `${key} ${route} token file path`).not.toContain(secret);
          else expect(text, `${key} ${route}`).not.toContain(secret);
        }
      }
    }
  }, 120_000);
});

describe("the same task id in two projects", () => {
  it("approving A's T-1 test moves nothing in B: B's T-1 stays unapproved and its worker cannot claim", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const a = await dispatch(ctx, alpha);
    const b = await dispatch(ctx, beta);
    expect(a.worktree).not.toBe(b.worktree);
    fs.mkdirSync(path.join(a.worktree, "tests"), { recursive: true });
    fs.writeFileSync(path.join(a.worktree, "tests", "save.check.mjs"), 'import { existsSync } from "node:fs";\nif (!existsSync("src/save.js")) process.exit(1);\n');
    git(a.worktree, "add", "-A");
    git(a.worktree, "commit", "-q", "-m", "Test first");
    const defined = await hostCall(ctx.base, "POST", `/tasks/T-1/test?project=alpha`, { command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] });
    expect(defined.status, JSON.stringify(defined.body)).toBe(200);
    const entry = defined.body.result.tasks[0].test.entry;
    const approved = await hostCall(ctx.base, "POST", `/tasks/T-1/approve-test?project=alpha`, { test: entry });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.result).toMatchObject({ approved: true, failsFirst: true });

    const view = async (key: string) => (await hostCall(ctx.base, "GET", `/tasks?project=${key}`)).body.result.tasks[0];
    expect(await view("alpha")).toMatchObject({ stage: "ready-to-claim" });
    expect(await view("beta")).toMatchObject({ stage: "needs-test", test: null, approval: null, baseline: null });
    const state = ctx.host.project("beta").service.gate.state("T-1");
    expect(state.definition).toBeUndefined();
    expect(state.approval).toBeUndefined();
    expect(ctx.host.project("beta").entries().filter((e) => e.type.startsWith("test."))).toEqual([]);

    // B's worker holds the same task number and cannot claim: its project has no approved test.
    const call = bridgeCall(b.bridgeUrl, b.token);
    const { agent } = (await call({ tool: "hello", args: { name: "Worker B" } })) as { agent: string };
    await expect(call({ tool: "claim_task", args: { task: "T-1" }, agent })).rejects.toThrow(/no done-when test/);
    // A's worker, in the project where the test was approved, can.
    const callA = bridgeCall(a.bridgeUrl, a.token);
    const helloA = (await callA({ tool: "hello", args: { name: "Worker A" } })) as { agent: string };
    expect(await callA({ tool: "claim_task", args: { task: "T-1" }, agent: helloA.agent })).toMatchObject({ status: "claimed" });
  }, 120_000);

  it("a request meant for A, replayed against B without the person's window, writes nothing", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    await dispatch(ctx, alpha);
    await dispatch(ctx, beta);
    const before = ctx.host.project("beta").entries().length;
    for (const route of ["approve-test", "approve-diff", "merge", "reject", "release"]) {
      const replay = await hostCall(ctx.base, "POST", `/tasks/T-1/${route}?project=beta`, { test: "L-000003", commit: "a".repeat(40), notes: "x" }, { asAgent: true });
      expect(replay.status, route).toBe(401);
    }
    expect(ctx.host.project("beta").entries().length).toBe(before);
  }, 60_000);

  // approve-test is bound to the number of the test definition the person read ({ test: "L-000003" }), and
  // two projects that did the same steps have the same numbers. The person's own credentials work on every
  // project, so a request made for A that is replayed with the person's cookie and project=beta approves B's
  // different test. L1 owns this route in wave 1: bind the request to the definition's hash or the project.
  it.fails("known gap: a person's approve-test request made for A, replayed with project=beta, still approves B's own (different) test", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const a = await dispatch(ctx, alpha);
    const b = await dispatch(ctx, beta);
    const propose = async (side: Side, worktree: string, name: string) => {
      fs.mkdirSync(path.join(worktree, "tests"), { recursive: true });
      fs.writeFileSync(path.join(worktree, "tests", `${name}.mjs`), "process.exit(1);\n");
      git(worktree, "add", "-A");
      git(worktree, "commit", "-q", "-m", name);
      const res = await hostCall(ctx.base, "POST", `/tasks/T-1/test?project=${side.key}`, { command: `node tests/${name}.mjs`, files: [`tests/${name}.mjs`] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.result.tasks[0].test.entry as string;
    };
    const entryA = await propose(alpha, a.worktree, "a-test");
    const entryB = await propose(beta, b.worktree, "b-test");
    expect(entryA).toBe(entryB);
    // The body the window sent for project A (the person read A's test) is sent again with project=beta.
    const replay = await hostCall(ctx.base, "POST", `/tasks/T-1/approve-test?project=beta`, { test: entryA });
    expect(replay.status, "the replay must be refused").toBeGreaterThanOrEqual(400);
    expect(ctx.host.project("beta").service.gate.state("T-1").approval).toBeUndefined();
  }, 120_000);
});

describe("project names", () => {
  const BAD = ["..", "../beta", "..%2Fbeta", "%2e%2e", "beta/../alpha", "a/b", "a\\b", ".", "beta.", "beta..", "con", "NUL", "aux.txt", "com1", "lpt9", "a b", "βeta", "x".repeat(65), "-beta", "_beta", "beta\u0000"];

  it("no odd project name reaches another project or a folder outside the app's data folder, and none silently becomes 'default'", async () => {
    const ctx = await startTestHost();
    track(() => ctx.stop());
    for (const key of ["alpha", "beta"]) await hostCall(ctx.base, "GET", `/status?project=${key}`);
    const rootBefore = fs.readdirSync(ctx.dir).sort();
    const projectsBefore = fs.readdirSync(path.join(ctx.dir, "projects")).sort();
    const parent = path.dirname(ctx.dir);
    for (const key of BAD) {
      for (const method of ["GET", "POST"] as const) {
        const route = method === "GET" ? "/status" : "/owner/start";
        const res = await hostCall(ctx.base, method, `${route}?project=${encodeURIComponent(key)}`, method === "POST" ? {} : undefined);
        expect(res.status, `${method} ${JSON.stringify(key)}`).toBe(400);
        expect(res.body.code, JSON.stringify(key)).toBe("INVALID_PROJECT");
        expect(projectKeyProblem(key), JSON.stringify(key)).toBeTruthy();
      }
    }
    expect(fs.readdirSync(ctx.dir).sort()).toEqual(rootBefore);
    expect(fs.readdirSync(path.join(ctx.dir, "projects")).sort()).toEqual(projectsBefore);
    // Where a path trick would have landed a project folder if the name had been joined into a path.
    for (const escaped of [path.join(parent, "beta"), path.join(parent, "alpha"), path.join(ctx.dir, "beta"), path.join(ctx.dir, "alpha"), path.join(ctx.dir, "etc")]) expect(fs.existsSync(escaped), escaped).toBe(false);
    // And the library function underneath refuses to build a path outside projects/ even if the host were bypassed.
    for (const key of ["..", "../x", "a/b", "", "con", "x."]) expect(() => ctx.host.project(key), JSON.stringify(key)).toThrow();
    expect(fs.existsSync(path.join(ctx.dir, "x"))).toBe(false);
  });

  it("no name, or an empty one, is the 'default' project: the only fallback left; spaces around a real name are trimmed, not a new project", async () => {
    const ctx = await startTestHost();
    track(() => ctx.stop());
    for (const route of ["/status", "/status?project=", "/status?project=%20%20"]) expect((await hostCall(ctx.base, "GET", route)).body.result.project, route).toBe("default");
    for (const route of ["/status?project=%20alpha", "/status?project=alpha%0A", "/status?project=alpha%20"]) expect((await hostCall(ctx.base, "GET", route)).body.result.project, route).toBe("alpha");
    expect(fs.readdirSync(path.join(ctx.dir, "projects")).sort()).toEqual(["alpha", "default"]);
  });

  it("names that differ only in case are two projects on Linux and refused as one folder where the OS ignores case (identity rules, checked for every OS)", async () => {
    // What each OS treats as the same folder name; the host refuses a second project with the same identity.
    const same = (platform: NodeJS.Platform, a: string, b: string) => folderIdentity(a, platform, (p) => p) === folderIdentity(b, platform, (p) => p);
    expect(same("win32", "C:\\Data\\projects\\Beta", "c:\\data\\PROJECTS\\beta")).toBe(true);
    expect(same("win32", "C:\\Data\\projects\\beta.", "C:\\Data\\projects\\beta")).toBe(true);
    expect(same("win32", "C:\\Data\\projects\\beta. ", "C:/Data/projects/beta")).toBe(true);
    expect(same("win32", "C:\\Data\\projects\\alpha", "C:\\Data\\projects\\beta")).toBe(false);
    // UNC and device spellings never equal a local drive path.
    for (const unc of ["\\\\host\\share\\projects\\beta", "//host/share/projects/beta", "\\\\?\\UNC\\host\\share\\projects\\beta"]) expect(same("win32", unc, "C:\\Data\\projects\\beta"), unc).toBe(false);
    expect(same("darwin", "/Users/me/projects/Beta", "/users/me/projects/beta")).toBe(true);
    expect(same("darwin", "/Users/me/caf\u00e9", "/Users/me/cafe\u0301")).toBe(true);
    expect(same("linux", "/home/me/projects/Beta", "/home/me/projects/beta")).toBe(false);
    expect(identityWithin(folderIdentity("/repo", "linux", (p) => p), folderIdentity("/repo/sub", "linux", (p) => p))).toBe(true);
    expect(identityWithin(folderIdentity("/repo", "linux", (p) => p), folderIdentity("/repository", "linux", (p) => p))).toBe(false);
    if (process.platform === "win32" || process.platform === "darwin") {
      const ctx = await startTestHost();
      track(() => ctx.stop());
      expect((await hostCall(ctx.base, "GET", "/status?project=beta")).status).toBe(200);
      const upper = await hostCall(ctx.base, "GET", "/status?project=BETA");
      expect(upper.status).toBe(409);
      expect(upper.body.code).toBe("FOLDER_IN_USE");
    } else {
      const ctx = await startTestHost();
      track(() => ctx.stop());
      expect((await hostCall(ctx.base, "GET", "/status?project=beta")).status).toBe(200);
      expect((await hostCall(ctx.base, "GET", "/status?project=BETA")).status).toBe(200);
      expect(ctx.host.project("beta").root).not.toBe(ctx.host.project("BETA").root);
    }
  });

  it("a project folder that is a link to another project's folder is refused as the same folder, in either order", async () => {
    for (const order of ["real first", "link first"]) {
      const ctx = await startTestHost();
      track(() => ctx.stop());
      const real = path.join(ctx.dir, "projects", "alpha");
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync(real, path.join(ctx.dir, "projects", "linked"), "junction");
      const [first, second] = order === "real first" ? ["alpha", "linked"] : ["linked", "alpha"];
      expect((await hostCall(ctx.base, "GET", `/status?project=${first}`)).status, order).toBe(200);
      const refused = await hostCall(ctx.base, "GET", `/status?project=${second}`);
      expect(refused.status, order).toBe(409);
      expect(refused.body.code).toBe("FOLDER_IN_USE");
      expect(refused.body.message).toContain(first);
      // The second name never opened, so it cannot have written a ledger entry or taken a writer lock.
      expect(ctx.host.project(first).ledger.status.writable).toBe(true);
    }
  });

  it("PP_CORE_PROJECT_ROOT gives every name one folder: the second name is refused, the first keeps writing", async () => {
    const repo = newRepo("override");
    const ctx = await startTestHost({ projectRootOverride: repo });
    track(() => ctx.stop());
    expect((await hostCall(ctx.base, "GET", "/status?project=alpha")).status).toBe(200);
    const second = await hostCall(ctx.base, "GET", "/status?project=beta");
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("FOLDER_IN_USE");
    const write = await hostCall(ctx.base, "POST", "/planning/start?project=alpha", { idea: "A notes app that syncs" });
    expect(write.status, JSON.stringify(write.body)).toBe(200);
  });
});

describe("one folder, one ledger writer", () => {
  it("a second host (a second app) on the same data folder opens every project read-only and its writes are refused", async () => {
    const ctx = await startTestHost();
    track(() => ctx.stop());
    await hostCall(ctx.base, "POST", "/planning/start?project=alpha", { idea: "A notes app that syncs" });
    const second = createCoreHost({ root: ctx.dir, bridge: false, keys: ctx.host.keys });
    track(() => second.close());
    const project = second.project("alpha");
    expect(project.ledger.status.writable).toBe(false);
    expect(() => asPersonRequest(() => project.ledger.append({ actor: person, type: "task.created", subject: "T-9", summary: "Planted", data: { title: "Planted" } }))).toThrow(/read-only/);
    expect(ctx.host.project("alpha").ledger.status.writable).toBe(true);
  });
});

describe("a git folder is used by one project", () => {
  it("the same git folder cannot be given to a second project: choosing it, dispatching on it and reading it all say so, and the first project's worktree is untouched", async () => {
    const { ctx, alpha } = await twoProjects();
    const a = await dispatch(ctx, alpha);
    const registry = path.join(alpha.repo, ".git", "perfect-planner", "worktrees.json");
    const registryBefore = fs.readFileSync(registry, "utf8");
    const betaBefore = ctx.host.project("beta").entries().length;
    fs.writeFileSync(path.join(a.worktree, "work-in-progress.txt"), "alpha's unfinished work\n");

    const chosen = await hostCall(ctx.base, "POST", "/tasks/repo?project=beta", { root: alpha.repo });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(409);
    expect(chosen.body.code).toBe("REPO_IN_USE");
    expect(chosen.body.message).toContain("alpha");

    // Even if project B's repo.json already names A's folder (written by hand, or by an older app), B gets nothing.
    fs.writeFileSync(path.join(ctx.host.project("beta").root, ".perfect-planner", "repo.json"), JSON.stringify({ root: alpha.repo }));
    const view = await hostCall(ctx.base, "GET", "/tasks?project=beta");
    expect(view.body.result.repo).toMatchObject({ ok: false });
    expect(view.body.result.repo.reason).toContain("alpha");
    const dispatched = await hostCall(ctx.base, "POST", "/tasks/T-1/dispatch?project=beta", {});
    expect(dispatched.status).toBe(409);
    expect(dispatched.body.message).toContain("alpha");
    for (const route of ["approve-test", "check", "merge"]) expect((await hostCall(ctx.base, "POST", `/tasks/T-1/${route}?project=beta`, { test: "L-000003", commit: "a".repeat(40) })).status, route).toBe(409);

    expect(fs.readFileSync(registry, "utf8")).toBe(registryBefore);
    expect(fs.readFileSync(path.join(a.worktree, "work-in-progress.txt"), "utf8")).toBe("alpha's unfinished work\n");
    expect(ctx.host.project("beta").entries().length).toBe(betaBefore);
    expect(ctx.host.project("beta").entries().some((e) => e.type === "worktree.created")).toBe(false);
  }, 120_000);

  it("a folder an older app already filled with project A's worktrees is not handed to project B, record or no record", async () => {
    const { ctx, alpha } = await twoProjects();
    await dispatch(ctx, alpha);
    const record = path.join(alpha.repo, ".git", "perfect-planner", "project.json");
    expect(fs.existsSync(record)).toBe(true);
    fs.rmSync(record);
    const chosen = await hostCall(ctx.base, "POST", "/tasks/repo?project=beta", { root: alpha.repo });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(409);
    expect(chosen.body.message).toContain("T-1");
    expect(fs.existsSync(record)).toBe(false);
    // The project that started those worktrees can still use the folder, and re-records itself.
    expect((await hostCall(ctx.base, "GET", "/tasks?project=alpha")).body.result.repo).toMatchObject({ ok: true, root: alpha.repo });
    expect((await hostCall(ctx.base, "POST", "/tasks/repo?project=alpha", { root: alpha.repo })).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(record, "utf8"))).toMatchObject({ key: "alpha" });
  }, 120_000);

  it("when A moves to another git folder, B may take the old one over; when A is gone but its worktrees are not, B may not", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const other = newRepo("alpha-second");
    // A chose its folder but never started a worker there, then chose a different one: the old folder is free.
    expect((await hostCall(ctx.base, "POST", "/tasks/repo?project=alpha", { root: other })).status).toBe(200);
    expect((await hostCall(ctx.base, "POST", "/tasks/repo?project=beta", { root: alpha.repo })).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(alpha.repo, ".git", "perfect-planner", "project.json"), "utf8"))).toMatchObject({ key: "beta" });

    // Now B has a worker running in that folder. Its record is rewritten to name a project that no longer exists.
    await dispatch(ctx, beta);
    const record = path.join(alpha.repo, ".git", "perfect-planner", "project.json");
    fs.writeFileSync(record, JSON.stringify({ folder: path.join(ctx.dir, "projects", "deleted"), key: "deleted", at: "2026-01-01T00:00:00Z" }));
    const registry = fs.readFileSync(path.join(alpha.repo, ".git", "perfect-planner", "worktrees.json"), "utf8");
    // A third project, new to this folder, is refused: the worktree was started by someone else and is kept as it is.
    await ctx.host.openProject("gamma");
    asPersonRequest(() => appendNumbered(ctx.host.project("gamma").ledger, { actor: person, type: "task.created", summary: "Save notes (gamma)", data: { title: "Save notes (gamma)" } }));
    const taken = await hostCall(ctx.base, "POST", "/tasks/repo?project=gamma", { root: alpha.repo });
    expect(taken.status, JSON.stringify(taken.body)).toBe(409);
    expect(taken.body.message).toMatch(/did not start \(T-1\)/);
    expect(fs.readFileSync(path.join(alpha.repo, ".git", "perfect-planner", "worktrees.json"), "utf8")).toBe(registry);
    expect(fs.existsSync(path.join(alpha.repo, ".perfect-planner", "worktrees", "T-1"))).toBe(true);
  }, 120_000);

  it("a damaged record is not guessed around: the folder is refused with the one file to move aside", async () => {
    const { ctx, alpha } = await twoProjects();
    const record = path.join(alpha.repo, ".git", "perfect-planner", "project.json");
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, "{ not json");
    const chosen = await hostCall(ctx.base, "POST", "/tasks/repo?project=beta", { root: alpha.repo });
    expect(chosen.status).toBe(409);
    expect(chosen.body.message).toContain(record);
    expect(fs.readFileSync(record, "utf8")).toBe("{ not json");
  }, 60_000);

  it("a symlink planted where the next worktree goes is refused, and nothing lands in the other project's repo", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    asPersonRequest(() => appendNumbered(ctx.host.project("alpha").ledger, { actor: person, type: "task.created", summary: "Second", data: { title: "Second" } }));
    const worktrees = path.join(alpha.repo, ".perfect-planner", "worktrees");
    fs.mkdirSync(worktrees, { recursive: true });
    const target = path.join(beta.repo, "stolen");
    const dangling = path.join(beta.repo, "not-yet");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(worktrees, "T-2"), "junction");
    const before = fs.readdirSync(beta.repo).sort();
    const refused = await hostCall(ctx.base, "POST", "/tasks/T-2/dispatch?project=alpha", {});
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    fs.rmSync(path.join(worktrees, "T-2"), { force: true });
    // A link to a folder that does not exist yet (Windows junctions need their target to exist).
    if (process.platform !== "win32") {
      fs.symlinkSync(dangling, path.join(worktrees, "T-2"), "dir");
      const second = await hostCall(ctx.base, "POST", "/tasks/T-2/dispatch?project=alpha", {});
      expect(second.status, JSON.stringify(second.body)).toBeGreaterThanOrEqual(400);
    }
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.existsSync(dangling)).toBe(false);
    expect(fs.readdirSync(beta.repo).sort()).toEqual(before);
    expect(git(beta.repo, "status", "--porcelain")).not.toMatch(/stolen|not-yet|T-2/);
    expect(git(beta.repo, "branch", "--list", "pp/*")).toBe("");
  }, 120_000);

  it("two projects choosing the same unused git folder at the same moment: exactly one gets it", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const shared = newRepo("shared");
    const [one, two] = await Promise.all([alpha, beta].map((side) => hostCall(ctx.base, "POST", `/tasks/repo?project=${side.key}`, { root: shared })));
    expect([one!.status, two!.status].sort()).toEqual([200, 409]);
    const loser = one!.status === 409 ? one! : two!;
    expect(loser.body.code).toBe("REPO_IN_USE");
    const winner = JSON.parse(fs.readFileSync(path.join(shared, ".git", "perfect-planner", "project.json"), "utf8")).key as string;
    expect([alpha.key, beta.key]).toContain(winner);
  }, 60_000);

  it("another spelling of A's git folder is still A's folder: a worktree of it, a link to it, a path with dots", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const a = await dispatch(ctx, alpha);
    const link = path.join(os.tmpdir(), `pp-iso-link-${path.basename(alpha.repo)}`);
    fs.symlinkSync(alpha.repo, link, "junction");
    track(() => fs.rmSync(link, { force: true }));
    const spellings = [a.worktree, link, `${alpha.repo}${path.sep}.${path.sep}`, path.join(alpha.repo, "..", path.basename(alpha.repo))];
    for (const root of spellings) {
      const res = await hostCall(ctx.base, "POST", "/tasks/repo?project=beta", { root });
      expect(res.status, `${root}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(res.body.code, root).toBe("REPO_IN_USE");
    }
    expect(fs.existsSync(path.join(ctx.host.project(beta.key).root, ".perfect-planner", "repo.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(ctx.host.project(beta.key).root, ".perfect-planner", "repo.json"), "utf8")).root).toBe(beta.repo);
  }, 120_000);

  it("a git folder written as a network path, another drive's path, a URL or a home shortcut is refused and nothing is recorded", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const record = path.join(beta.repo, ".git", "perfect-planner", "project.json");
    const before = fs.readFileSync(path.join(ctx.host.project(beta.key).root, ".perfect-planner", "repo.json"), "utf8");
    // The UNC and device spellings of core/exec's isLocalWindowsPath, plus POSIX and URL forms.
    const odd = ["\\\\server\\share\\repo", "//server/share/repo", "\\\\?\\UNC\\server\\share\\repo", "\\??\\C:\\repo", "C:foo", "C:\\repo", "~", "~/repo", "file:///etc", "../alpha", "", "   ", "\u0000"];
    for (const root of odd) {
      const res = await hostCall(ctx.base, "POST", `/tasks/repo?project=${beta.key}`, { root });
      expect(res.status, JSON.stringify(root)).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(root)).toBeLessThan(500);
    }
    expect(fs.readFileSync(path.join(ctx.host.project(beta.key).root, ".perfect-planner", "repo.json"), "utf8")).toBe(before);
    expect(JSON.parse(fs.readFileSync(record, "utf8"))).toMatchObject({ key: "beta" });
    expect(fs.existsSync(path.join(alpha.repo, ".git", "perfect-planner", "project.json"))).toBe(true);
  }, 60_000);

  it("a network path in a project's saved git folder is never looked at on Windows (UNC, device and mixed-slash spellings)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-iso-unc-"));
    track(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, ".perfect-planner"), { recursive: true });
    const saved = (root: string) => fs.writeFileSync(path.join(dir, ".perfect-planner", "repo.json"), JSON.stringify({ root }));
    const unc = ["\\\\host\\share\\repo", "//host/share/repo", "\\/host/share/repo", "/\\host/share/repo", "\\\\?\\UNC\\host\\share\\repo", "\\??\\UNC\\host\\share\\repo", "\\\\.\\pipe\\x", "\\rooted\\repo", "C:repo"];
    for (const root of unc) {
      saved(root);
      expect(chosenRepoRoot(dir, "win32"), root).toBeUndefined();
      expect(isNetworkPath(root, "win32"), root).toBe(true);
    }
    expect(isNetworkPath("C:\\work\\repo", "win32")).toBe(false);
    expect(isNetworkPath("D:/work/repo", "win32")).toBe(false);
    // A plain local folder is still found (the saved path must exist and not be a drive or the home folder).
    const repo = newRepo("saved");
    saved(repo);
    expect(chosenRepoRoot(dir)).toBe(repo);
  });

  // Dev-server ports are handed out per git folder (the registry lives in the repo), so two projects each get
  // 5200 for their first worker. Whichever dev server starts second cannot have it, and a worker that reaches
  // for its own port can reach the other project's server. Fixing it needs a host-wide reservation that
  // survives restarts (a port table in the app's data folder), which touches core/worktrees: left for step B.
  it.fails("known gap: two projects' workers are given different dev-server ports", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const a = await hostCall(ctx.base, "POST", `/tasks/T-1/dispatch?project=${alpha.key}`, {});
    const b = await hostCall(ctx.base, "POST", `/tasks/T-1/dispatch?project=${beta.key}`, {});
    expect(a.body.result.port).not.toBe(b.body.result.port);
  }, 60_000);

  it("task ids from the URL cannot name a path: no token file, brief or worktree is made outside the project", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const before = [alpha.repo, beta.repo, ctx.dir].map((dir) => fs.readdirSync(dir, { recursive: true }).length);
    for (const id of ["..%2F..%2Fbeta", "..%5C..%5Cbeta", "T-1%2F..%2F..", "T-1.a2", "T-99", "%2e%2e"]) {
      const res = await hostCall(ctx.base, "POST", `/tasks/${id}/dispatch?project=alpha`, {});
      expect(res.status, id).toBeGreaterThanOrEqual(400);
    }
    expect([alpha.repo, beta.repo, ctx.dir].map((dir) => fs.readdirSync(dir, { recursive: true }).length)).toEqual(before);
  }, 60_000);
});

describe("routes that take a folder", () => {
  it("the MVP scan folder cannot be aimed at another project: not with .., an absolute path, a backslash path or a link", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const alphaRoot = ctx.host.project(alpha.key).root;
    const betaRoot = ctx.host.project(beta.key).root;
    fs.mkdirSync(path.join(betaRoot, "src", "components"), { recursive: true });
    fs.writeFileSync(path.join(betaRoot, "src", "components", "Secret.jsx"), "export const Secret = 1;\n");
    fs.symlinkSync(betaRoot, path.join(alphaRoot, "link"), "junction");
    const before = ctx.host.project(alpha.key).entries().length;
    for (const target of [`..${path.sep}${beta.key}`, `../${beta.key}`, `..\\${beta.key}`, betaRoot, "/etc", "C:\\Windows", "link", "link/src", "src/../../beta"]) {
      const res = await hostCall(ctx.base, "POST", `/mvp/stage?project=${alpha.key}`, { mode: "existing", goal: "Scan it", path: target });
      expect(res.status, `${JSON.stringify(target)}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.code, target).toBe("BAD_PATH");
    }
    expect(ctx.host.project(alpha.key).entries().length).toBe(before);
    expect(JSON.stringify(ctx.host.project(alpha.key).entries())).not.toContain("Secret");
  }, 60_000);
});

describe("ledgers, owner pins and the files on disk", () => {
  async function restarted(ctx: Ctx) {
    await ctx.host.close();
    const host = createCoreHost({ root: ctx.dir, bridge: false, keys: ctx.host.keys });
    track(() => host.close());
    return host;
  }

  /** B's ledger file with project A's signed test.defined and test.approved lines pasted in, opened by a restarted host. */
  async function betaWithAlphasApproval() {
    const { ctx, alpha, beta } = await twoProjects();
    const a = await dispatch(ctx, alpha);
    await dispatch(ctx, beta);
    fs.mkdirSync(path.join(a.worktree, "tests"), { recursive: true });
    fs.writeFileSync(path.join(a.worktree, "tests", "save.check.mjs"), "process.exit(1);\n");
    git(a.worktree, "add", "-A");
    git(a.worktree, "commit", "-q", "-m", "Test first");
    const defined = await hostCall(ctx.base, "POST", "/tasks/T-1/test?project=alpha", { command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"] });
    await hostCall(ctx.base, "POST", "/tasks/T-1/approve-test?project=alpha", { test: defined.body.result.tasks[0].test.entry });
    const ledgerOf = (key: string) => path.join(ctx.host.project(key).root, ".perfect-planner", "ledger");
    const monthFile = (key: string) => path.join(ledgerOf(key), fs.readdirSync(ledgerOf(key)).filter((n) => /\.jsonl$/.test(n)).sort().at(-1)!);
    const approvals = fs.readFileSync(monthFile("alpha"), "utf8").split("\n").filter((line) => /"type":"test\.(defined|approved)"/.test(line));
    expect(approvals.length).toBeGreaterThanOrEqual(2);
    const host = await restarted(ctx);
    fs.appendFileSync(monthFile(beta.key), `${approvals.join("\n")}\n`);
    return { ctx, host, beta: await host.openProject(beta.key) };
  }

  it("project A's signed entries pasted into project B's ledger file break B's chain: B reports the damage and stops writing, so nothing is claimed, approved or merged on A's approval", async () => {
    const { host, beta } = await betaWithAlphasApproval();
    expect(beta.ledger.status.ok).toBe(false);
    expect(ledgerIntegrity(beta.ledger)).toMatchObject({ state: "damaged", writesStopped: true });
    expect(beta.ledger.status.writable).toBe(false);
    const before = beta.entries().length;
    // B's worker (a fresh token in the restarted host) cannot claim, and nothing signs in the person's name either.
    const token = beta.service.tokens.issue({ role: "worker", person: "owner", task: "T-1" });
    const { agent } = (await beta.service.call({ token }, "hello", { name: "Worker B" })) as { agent: string };
    await expect(beta.service.call({ token, agent }, "claim_task", { task: "T-1" })).rejects.toThrow();
    expect(() => asPersonRequest(() => appendNumbered(beta.ledger, { actor: person, type: "task.created", summary: "After the splice", data: { title: "After the splice" } }))).toThrow();
    expect(beta.entries().length).toBe(before);
    expect(beta.entries().some((e) => e.type === "task.claimed" || e.type === "task.done")).toBe(false);
    void host;
  }, 120_000);

  // The ledger marks an entry verified when its signature holds, "whatever else is wrong: authority is per
  // entry" (core/ledger). A's test.approved is signed by the person's key, which B trusts too, and nothing in
  // the signed bytes names the ledger it belongs to. Readers (gate.state, the Tasks screen) therefore still
  // show it as B's approval; only the broken chain, which stops every write, keeps it from being used.
  it.fails("known gap: readers do not count a signed approval pasted in from another project's ledger", async () => {
    const { beta } = await betaWithAlphasApproval();
    expect(beta.service.gate.state("T-1").approval).toBeUndefined();
  }, 120_000);

  it("project A's owner pin copied over B's is not trusted: B reports the pin as tampered and opens without an owner", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    for (const key of [alpha.key, beta.key]) expect((await hostCall(ctx.base, "POST", `/planning/start?project=${key}`, { idea: `A notes app (${key})` })).status).toBe(200);
    const genesis = (key: string) => ctx.host.project(key).entries()[0]!.hash;
    const pinA = path.join(ctx.dir, "owners", `${genesis("alpha")}.json`);
    const pinB = path.join(ctx.dir, "owners", `${genesis("beta")}.json`);
    expect(fs.existsSync(pinA) && fs.existsSync(pinB)).toBe(true);
    const host2 = await restarted(ctx);
    expect((await host2.openProject("beta")).owner.state).toBe("pinned");
    await host2.close();
    fs.copyFileSync(pinA, pinB);
    const host3 = createCoreHost({ root: ctx.dir, bridge: false, keys: ctx.host.keys });
    track(() => host3.close());
    const beta3 = await host3.openProject("beta");
    expect(beta3.owner.state).toBe("tampered");
    expect(beta3.owner.ownerKey).toBeUndefined();
  }, 120_000);

  it("project A's ledger copied over B's folder is noticed: B is 'replaced', not a fresh or trusted project", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    for (const key of [alpha.key, beta.key]) expect((await hostCall(ctx.base, "POST", `/planning/start?project=${key}`, { idea: `A notes app (${key})` })).status).toBe(200);
    const ledgerOf = (key: string) => path.join(ctx.host.project(key).root, ".perfect-planner", "ledger");
    const host2 = await restarted(ctx);
    await host2.close();
    fs.rmSync(ledgerOf("beta"), { recursive: true });
    fs.cpSync(ledgerOf("alpha"), ledgerOf("beta"), { recursive: true });
    fs.rmSync(path.join(ledgerOf("beta"), ".writer.lock"), { force: true });
    const host3 = createCoreHost({ root: ctx.dir, bridge: false, keys: ctx.host.keys });
    track(() => host3.close());
    const beta3 = await host3.openProject("beta");
    expect(beta3.owner.state).toBe("replaced");
  }, 120_000);
});

describe("placeholder secrets and environment", () => {
  it("a worktree gets placeholders, never the real value, and no project's value shows up in the other project's worktree, ledger or token files", async () => {
    const { ctx, alpha, beta } = await twoProjects();
    const a = await dispatch(ctx, alpha);
    const b = await dispatch(ctx, beta);
    expect(fs.readFileSync(path.join(a.worktree, ".env"), "utf8")).toBe("API_KEY=PLACEHOLDER\nPORT=3000\n");
    expect(fs.readFileSync(path.join(b.worktree, ".env"), "utf8")).toBe("API_KEY=PLACEHOLDER\nPORT=3000\n");
    const everywhere = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((d) => d.isFile() && !d.parentPath.includes(`${path.sep}.git${path.sep}`)).map((d) => path.join(d.parentPath, d.name));
    // The real values stay in the main checkouts' own .env; nothing the app wrote (worktrees, ledgers, tokens, briefs) carries them.
    const written = [...everywhere(a.worktree), ...everywhere(b.worktree), ...everywhere(path.join(ctx.dir, "projects"))];
    for (const file of written) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toContain("alpha-real-value");
      expect(text, file).not.toContain("beta-real-value");
    }
    for (const key of [alpha.key, beta.key]) expect(JSON.stringify(ctx.host.project(key).entries())).not.toMatch(/-real-value/);
  }, 60_000);
});
