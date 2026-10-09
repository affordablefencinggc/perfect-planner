import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJev, sameModel, spentFromLedger, createTypeSafeProvider, createKeychainJevProvider, precheckDiff, parseUnifiedDiff,
  isTestPath, setJevKey, hasJevKey, clearJevKey, createSystemKeychain, createMemoryKeychain, JEV_KEY_SERVICE, JEV_KEY_ACCOUNT,
} from "../src/core/jev/index.mjs";
import { windowsScript } from "../src/core/jev/keychain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Fake secrets are assembled at runtime so the repository secret scanner never sees a literal.
const FAKE_KEY = ["ts", "test", "k3y", "0123456789abcdef"].join("_");
const fakeOpenAiKey = () => "sk" + "-" + "A".repeat(32);

// ------------------------------------------------------------------ fakes
function fakeLedger({ now = () => new Date("2026-10-09T10:00:00Z") } = {}) {
  const list = [];
  const subs = new Set();
  let failNext = null;
  return {
    async append(input) {
      if (failNext) { const e = failNext; failNext = null; throw e; }
      if (!input.summary || !String(input.summary).trim()) throw Object.assign(new Error("summary"), { code: "LEDGER_RULE" });
      if ((input.type === "decision.made" || input.type === "correction" || /\.(blocked|reopened|rejected)$/.test(input.type)) && !input.reason) throw Object.assign(new Error("reason"), { code: "LEDGER_RULE" });
      const entry = Object.freeze({ n: `L-${String(list.length + 1).padStart(6, "0")}`, at: now().toISOString(), reason: null, evidence: [], refs: [], corrects: null, ...input, prev: list.at(-1)?.hash ?? null, hash: `h${list.length + 1}` });
      list.push(entry);
      for (const fn of subs) fn(entry);
      return entry;
    },
    entries: () => list.slice(),
    nextId: () => { throw new Error("unused"); },
    verify: () => ({ ok: true }),
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    close() {},
    failNextWith(error) { failNext = error; },
  };
}

function fakeProvider(respond, { cost = 0.01, estimate = 0 } = {}) {
  const calls = [];
  return {
    calls,
    name: "fake",
    estimateCost: () => estimate,
    async evaluate(request) {
      calls.push(request);
      const answers = typeof respond === "function" ? respond(request) : respond;
      return { model: request.model, answers, usage: { input_tokens: 100, output_tokens: 0 }, cost };
    },
  };
}

const confident = (request, overrides = {}) => {
  const answers = {};
  for (const [id, q] of Object.entries(request.questions)) {
    if (q.type === "noul") answers[id] = { type: "noul", noul: id === "trivial" || id === "weakens" ? 0.02 : 0.97 };
    else answers[id] = { type: "choice", choice: "approve", probabilities: { approve: 0.95 }, confidence: 0.9 };
  }
  return { ...answers, ...overrides };
};

const task = { id: "T-14", title: "Add login rate limit" };
const clauses = [{ ref: "P-2 §3.1", text: "Five failed logins lock the account for 15 minutes." }, { ref: "P-2 §3.2", text: "A lock is logged." }];

const cleanDiff = [
  "diff --git a/src/auth/limit.js b/src/auth/limit.js",
  "index 111..222 100644",
  "--- a/src/auth/limit.js",
  "+++ b/src/auth/limit.js",
  "@@ -1,3 +1,4 @@",
  " export function limit(count) {",
  "-  return false;",
  "+  if (count >= 5) return true;",
  "+  return false;",
  " }",
  "",
].join("\n");

// --------------------------------------------------------------- keychain
test("memory keychain: set, has and clear never return the key", async () => {
  const keychain = createMemoryKeychain();
  assert.equal(await hasJevKey({ keychain }), false);
  assert.equal(await setJevKey(FAKE_KEY, { keychain }), undefined);
  assert.equal(await hasJevKey({ keychain }), true);
  assert.equal(await keychain.read(JEV_KEY_SERVICE, JEV_KEY_ACCOUNT), FAKE_KEY);
  assert.equal(await clearJevKey({ keychain }), true);
  assert.equal(await hasJevKey({ keychain }), false);
  assert.equal(await clearJevKey({ keychain }), false);
});

test("invalid secrets are refused before any process starts", async () => {
  let spawned = 0;
  const keychain = createSystemKeychain({ platform: "linux", spawn: () => { spawned++; throw new Error("no"); } });
  for (const bad of ["", "short", "has space inside", "line\nbreak123", 42, "x".repeat(5000)]) {
    await assert.rejects(setJevKey(bad, { keychain }), { code: "KEYCHAIN_INVALID_SECRET" });
  }
  assert.equal(spawned, 0);
});

function scriptedSpawn(script) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    const call = { command, args, options, stdin: "" };
    calls.push(call);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      on() {},
      end(input) {
        call.stdin = String(input ?? "");
        const reply = script(call);
        setImmediate(() => {
          if (reply.error) { child.emit("error", reply.error); return; }
          if (reply.stdout) child.stdout.emit("data", Buffer.from(reply.stdout));
          if (reply.stderr) child.stderr.emit("data", Buffer.from(reply.stderr));
          child.emit("close", reply.code ?? 0);
        });
      },
    };
    return child;
  };
  return { spawn, calls };
}

const decodePs = (args) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");

test("windows backend: Credential Manager via PowerShell, secret only on stdin as base64", async () => {
  const store = new Map();
  const { spawn, calls } = scriptedSpawn((call) => {
    const script = decodePs(call.args);
    if (script.includes("::Write(")) { store.set("k", Buffer.from(call.stdin, "base64").toString("utf8")); return { code: 0 }; }
    if (script.includes("::Read(")) return store.has("k") ? { code: 0, stdout: Buffer.from(store.get("k")).toString("base64") } : { code: 3 };
    return store.delete("k") ? { code: 0 } : { code: 3 };
  });
  const keychain = createSystemKeychain({ platform: "win32", spawn });
  assert.equal(await hasJevKey({ keychain }), false);
  await setJevKey(FAKE_KEY, { keychain });
  assert.equal(await hasJevKey({ keychain }), true);
  assert.equal(await clearJevKey({ keychain }), true);
  assert.equal(await clearJevKey({ keychain }), false);
  for (const call of calls) {
    assert.equal(call.command, "powershell.exe");
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env, undefined, "no secret-bearing env is passed");
    assert.ok(!call.args.join(" ").includes(FAKE_KEY));
    const script = decodePs(call.args);
    assert.ok(!script.includes(FAKE_KEY));
    assert.match(script, /CredWriteW|CredReadW/);
    assert.match(script, /\$target = 'perfect-planner\/jev-api-key'/);
  }
  assert.equal(calls[1].stdin, Buffer.from(FAKE_KEY).toString("base64"));
});

test("windows script uses generic credentials and P/Invoke without the secret", () => {
  const script = windowsScript("store", "perfect-planner/jev-api-key", "jev-api-key");
  assert.match(script, /Add-Type -TypeDefinition @'/);
  assert.match(script, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.match(script, /advapi32\.dll/);
  assert.doesNotMatch(script, /Get-Clipboard|\$env:/i);
});

test("macOS backend: security -i with the command on stdin, find/delete by service and account", async () => {
  let saved = null;
  const { spawn, calls } = scriptedSpawn((call) => {
    if (call.args[0] === "-i") { saved = /-w "((?:[^"\\]|\\.)*)"/.exec(call.stdin)[1].replace(/\\(.)/g, "$1"); return { code: 0 }; }
    if (call.args[0] === "find-generic-password") return saved ? { code: 0, stdout: saved + "\n" } : { code: 44, stderr: "The specified item could not be found in the keychain." };
    if (call.args[0] === "delete-generic-password") { const had = saved !== null; saved = null; return had ? { code: 0 } : { code: 44 }; }
    return { code: 1 };
  });
  const keychain = createSystemKeychain({ platform: "darwin", spawn });
  const tricky = 'ab"cd\\ef' + "0123";
  await keychain.store(JEV_KEY_SERVICE, JEV_KEY_ACCOUNT, tricky);
  assert.equal(await keychain.read(JEV_KEY_SERVICE, JEV_KEY_ACCOUNT), tricky);
  assert.equal(await clearJevKey({ keychain }), true);
  assert.equal(await hasJevKey({ keychain }), false);
  assert.equal(await clearJevKey({ keychain }), false);
  assert.equal(calls[0].command, "security");
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.match(calls[0].stdin, /^add-generic-password -U -s "perfect-planner" -a "jev-api-key" -l ".+" -w ".+"\n$/);
  for (const call of calls) assert.ok(!call.args.join(" ").includes(tricky));
  assert.deepEqual(calls[1].args, ["find-generic-password", "-s", "perfect-planner", "-a", "jev-api-key", "-w"]);
});

test("linux backend: secret-tool store/lookup/clear with the secret on stdin", async () => {
  let saved = null;
  const { spawn, calls } = scriptedSpawn((call) => {
    if (call.args[0] === "store") { saved = call.stdin; return { code: 0 }; }
    if (call.args[0] === "lookup") return saved ? { code: 0, stdout: saved } : { code: 1 };
    if (call.args[0] === "clear") { saved = null; return { code: 0 }; }
    return { code: 1 };
  });
  const keychain = createSystemKeychain({ platform: "linux", spawn });
  await setJevKey(FAKE_KEY, { keychain });
  assert.equal(calls[0].command, "secret-tool");
  assert.deepEqual(calls[0].args.filter((a) => !a.startsWith("--label")), ["store", "service", "perfect-planner", "account", "jev-api-key"]);
  assert.equal(calls[0].stdin, FAKE_KEY);
  assert.equal(await hasJevKey({ keychain }), true);
  assert.equal(await clearJevKey({ keychain }), true);
  assert.equal(await hasJevKey({ keychain }), false);
  for (const call of calls) assert.ok(!call.args.join(" ").includes(FAKE_KEY));
});

test("missing keychain tools and services give clear UNAVAILABLE errors", async () => {
  const enoent = scriptedSpawn(() => ({ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) })).spawn;
  for (const platform of ["win32", "darwin", "linux"]) {
    const keychain = createSystemKeychain({ platform, spawn: enoent });
    await assert.rejects(hasJevKey({ keychain }), (e) => e.code === "KEYCHAIN_UNAVAILABLE" && /not found/.test(e.message));
    await assert.rejects(setJevKey(FAKE_KEY, { keychain }), { code: "KEYCHAIN_UNAVAILABLE" });
  }
  await assert.rejects(hasJevKey({ keychain: createSystemKeychain({ platform: "freebsd", spawn: enoent }) }), { code: "KEYCHAIN_UNAVAILABLE" });
  const noDbus = scriptedSpawn(() => ({ code: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" })).spawn;
  await assert.rejects(setJevKey(FAKE_KEY, { keychain: createSystemKeychain({ platform: "linux", spawn: noDbus }) }), { code: "KEYCHAIN_UNAVAILABLE" });
});

test("keychain failures never echo the secret", async () => {
  const echo = scriptedSpawn((call) => ({ code: 5, stderr: `boom ${Buffer.from(call.stdin, "base64").toString("utf8")} boom` })).spawn;
  await assert.rejects(setJevKey(FAKE_KEY, { keychain: createSystemKeychain({ platform: "win32", spawn: echo }) }), (e) => {
    assert.equal(e.code, "KEYCHAIN_FAILED");
    assert.ok(!e.message.includes(FAKE_KEY));
    assert.match(e.message, /\[redacted\]/);
    return true;
  });
});

test("real OS keychain round trip (PP_TEST_REAL_KEYCHAIN=1 only)", { skip: process.env.PP_TEST_REAL_KEYCHAIN !== "1" }, async () => {
  // Uses a separate test account so the owner's stored Jev key is never touched.
  const keychain = createSystemKeychain();
  const account = "jev-api-key-selftest";
  const value = `selftest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await keychain.store(JEV_KEY_SERVICE, account, value);
    assert.equal(await keychain.read(JEV_KEY_SERVICE, account), value);
    await keychain.store(JEV_KEY_SERVICE, account, value + "-2");
    assert.equal(await keychain.read(JEV_KEY_SERVICE, account), value + "-2");
  } finally {
    assert.equal(await keychain.remove(JEV_KEY_SERVICE, account), true);
  }
  assert.equal(await keychain.read(JEV_KEY_SERVICE, account), null);
  assert.equal(await keychain.remove(JEV_KEY_SERVICE, account), false);
});

// --------------------------------------------------------------- provider
function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return { status: reply.status ?? 200, ok: (reply.status ?? 200) < 300, json: async () => { if (reply.body === undefined) throw new Error("no json"); return reply.body; } };
  };
  return { fetchImpl, calls };
}

const nouls = { ok: { type: "noul", instructions: "Is it ok?" } };
const okBody = { model: "jev-1.13.0", answers: { ok: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 2_000_000, output_tokens: 5 } };

test("provider posts the documented System One request with the key only in the Authorization header", async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: okBody }]);
  const provider = createTypeSafeProvider({ getApiKey: async () => FAKE_KEY, fetchImpl });
  const result = await provider.evaluate({ model: "jev-latest", state: { a: 1 }, questions: nouls });
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { state: { a: 1 }, model: "jev-latest", questions: nouls });
  assert.ok(!calls[0].init.body.includes(FAKE_KEY));
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.cost, 0.084, "2M input tokens at $0.042/Mtok");
  assert.ok(provider.estimateCost({ state: "x".repeat(4000), questions: nouls }) > 0);
});

test("provider maps HTTP errors, retries 429/529 and never leaks the key", async () => {
  const sleep = async () => {};
  const mk = (replies) => createTypeSafeProvider({ getApiKey: async () => FAKE_KEY, fetchImpl: fakeFetch(replies).fetchImpl, sleep });
  const req = { state: "s", questions: nouls };
  for (const [replies, code] of [[[{ status: 401, body: {} }], "PROVIDER_AUTH"], [[{ status: 422, body: { detail: [{ loc: ["questions"] }] } }], "PROVIDER_INVALID_REQUEST"], [[{ status: 529 }, { status: 529 }, { status: 529 }], "PROVIDER_BUSY"], [[{ status: 500 }], "PROVIDER_FAILED"], [[{ body: { answers: {} , usage: { input_tokens: 1 } } }], "PROVIDER_BAD_RESPONSE"], [[{ body: { answers: { ok: { type: "noul", noul: 0.5 } } } }], "PROVIDER_BAD_RESPONSE"], [[{}], "PROVIDER_BAD_RESPONSE"], [[new Error("down"), new Error("down"), new Error("down")], "PROVIDER_UNREACHABLE"]]) {
    await assert.rejects(mk(replies).evaluate(req), (e) => e.code === code && !e.message.includes(FAKE_KEY));
  }
  const retried = fakeFetch([{ status: 429 }, { body: okBody }]);
  const result = await createTypeSafeProvider({ getApiKey: async () => FAKE_KEY, fetchImpl: retried.fetchImpl, sleep }).evaluate(req);
  assert.equal(retried.calls.length, 2);
  assert.equal(result.answers.ok.noul, 0.9);
});

test("provider refuses without a stored key, without calling the network", async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: okBody }]);
  await assert.rejects(createTypeSafeProvider({ getApiKey: async () => null, fetchImpl }).evaluate({ state: "s", questions: nouls }), { code: "PROVIDER_NO_KEY" });
  assert.equal(calls.length, 0);
});

test("provider endpoint is configurable but must be https (http only for localhost)", async () => {
  assert.throws(() => createTypeSafeProvider({ getApiKey: async () => FAKE_KEY, settings: { baseUrl: "http://api.typesafe.ai" } }), { code: "PROVIDER_CONFIG" });
  assert.throws(() => createTypeSafeProvider({ getApiKey: async () => FAKE_KEY, settings: { baseUrl: "https://u:p@x.example" } }), { code: "PROVIDER_CONFIG" });
  assert.throws(() => createTypeSafeProvider({ getApiKey: async () => FAKE_KEY, settings: { pricePerMillionInputTokens: -1 } }), { code: "PROVIDER_CONFIG" });
  assert.equal(createTypeSafeProvider({ getApiKey: async () => FAKE_KEY, settings: { baseUrl: "http://127.0.0.1:8787/" } }).endpoint, "http://127.0.0.1:8787/v1/systemone");
  assert.equal(createTypeSafeProvider({ getApiKey: async () => FAKE_KEY, settings: { baseUrl: "https://proxy.example/typesafe/", path: "v1/systemone" } }).endpoint, "https://proxy.example/typesafe/v1/systemone");
});

// --------------------------------------------------------------- prechecks
test("diff parser handles modified, added, deleted and renamed files with line numbers", () => {
  const diff = [
    cleanDiff.trimEnd(),
    "diff --git a/docs/new.md b/docs/new.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/docs/new.md",
    "@@ -0,0 +1,2 @@",
    "+# New",
    "+--- not a header",
    "diff --git a/tests/old.test.mjs b/tests/old.test.mjs",
    "deleted file mode 100644",
    "--- a/tests/old.test.mjs",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-assert.ok(true);",
    "diff --git a/src/a.js b/src/b.js",
    "similarity index 100%",
    "rename from src/a.js",
    "rename to src/b.js",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [["src/auth/limit.js", "modified"], ["docs/new.md", "added"], ["tests/old.test.mjs", "deleted"], ["src/b.js", "renamed"]]);
  assert.deepEqual(files[0].hunks[0].lines.filter((l) => l.kind === "+").map((l) => l.newLine), [2, 3]);
  assert.equal(files[1].hunks[0].lines[1].text, "--- not a header");
  assert.equal(files[3].oldPath, "src/a.js");
});

test("prechecks: scope, deleted tests, removed assertions, skips and secrets", () => {
  assert.equal(precheckDiff({ diff: cleanDiff, files: ["src/auth/"] }).ok, true);
  assert.equal(precheckDiff({ diff: cleanDiff, files: ["src/auth/**"] }).ok, true);
  assert.equal(precheckDiff({ diff: cleanDiff, files: ["src\\auth\\limit.js"] }).ok, true);
  const out = precheckDiff({ diff: cleanDiff, files: ["src/other.js"] });
  assert.equal(out.ok, false);
  assert.equal(out.notes[0].rule, "out-of-scope");
  assert.equal(precheckDiff({ diff: cleanDiff }).notes[0].rule, "scope-missing");

  const weakened = [
    "diff --git a/tests/limit.test.mjs b/tests/limit.test.mjs",
    "--- a/tests/limit.test.mjs",
    "+++ b/tests/limit.test.mjs",
    "@@ -10,4 +10,4 @@",
    "   assert.equal(limit(4), false);",
    "-  assert.equal(limit(5), true);",
    "+  assert.ok(limit(5) !== undefined);",
    "-  expect(log).toHaveBeenCalled();",
    "+test.skip(\"later\", () => {});",
    "",
  ].join("\n");
  const w = precheckDiff({ diff: weakened, files: ["tests/"] });
  assert.deepEqual(w.notes.map((n) => [n.rule, n.line]), [["assertion-removed", 11], ["assertion-removed", 12], ["test-skipped", 12]]);

  const moved = ["diff --git a/tests/x.test.mjs b/tests/x.test.mjs", "--- a/tests/x.test.mjs", "+++ b/tests/x.test.mjs", "@@ -1,2 +1,2 @@", "-  assert.equal(a, 1);", "   const b = 2;", "+  assert.equal(a, 1);", ""].join("\n");
  assert.equal(precheckDiff({ diff: moved, files: ["tests/x.test.mjs"] }).ok, true);

  const deleted = ["diff --git a/tests/x.test.mjs b/tests/x.test.mjs", "deleted file mode 100644", "--- a/tests/x.test.mjs", "+++ /dev/null", "@@ -1 +0,0 @@", "-test('x', () => {});", ""].join("\n");
  assert.equal(precheckDiff({ diff: deleted, files: ["tests/"] }).notes[0].rule, "test-deleted");

  const secret = fakeOpenAiKey();
  const leaky = ["diff --git a/src/auth/limit.js b/src/auth/limit.js", "--- a/src/auth/limit.js", "+++ b/src/auth/limit.js", "@@ -1 +1,2 @@", " x", `+const k = "${secret}";`, ""].join("\n");
  const s = precheckDiff({ diff: leaky, files: ["src/auth/"] });
  assert.equal(s.notes[0].rule, "secret-added");
  assert.equal(s.notes[0].line, 2);
  assert.ok(!JSON.stringify(s).includes(secret));
  assert.equal(isTestPath("src/a.spec.ts"), true);
  assert.equal(isTestPath("src/test_util.js"), false);
});

// --------------------------------------------------------------- reviewer
test("independence: same or Jev-family building model uses the alternate, else escalates without a call", async () => {
  assert.equal(sameModel("jev-latest", "jev-1.13.0"), true);
  assert.equal(sameModel("jev-latest", "JEV-preview"), true);
  assert.equal(sameModel("jev-latest", "claude-opus-5-5"), false);
  const ledger = fakeLedger();
  const primary = fakeProvider((r) => confident(r));
  const alt = fakeProvider((r) => confident(r));
  const jev = createJev({ ledger, provider: primary, alternateProvider: alt, budget: { monthlyCap: 10, spentThisMonth: 0 }, models: { primary: "jev-latest", alternate: "other-judge-1" } });
  const r1 = await jev.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "claude-opus-5-5" });
  assert.equal(r1.model, "jev-latest");
  const r2 = await jev.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "jev-latest" });
  assert.equal(r2.model, "other-judge-1");
  assert.equal(alt.calls[0].model, "other-judge-1");

  const solo = createJev({ ledger, provider: primary, budget: { monthlyCap: 10, spentThisMonth: 0 } });
  const before = primary.calls.length;
  const r3 = await solo.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "jev-1.13.0" });
  assert.equal(r3.verdict, "escalate");
  assert.equal(r3.notes[0].rule, "independence");
  const r4 = await solo.reviewTest({ task, clauses, testSource: "assert.ok(x)" });
  assert.equal(r4.verdict, "escalate");
  assert.equal(primary.calls.length, before);
});

test("approve writes review.verdict with model, cost, confidence and reason", async () => {
  const ledger = fakeLedger();
  const provider = fakeProvider((r) => confident(r), { cost: 0.0042 });
  const jev = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 0 } });
  const result = await jev.reviewDiff({ task, diff: cleanDiff, testOutput: "ok 1", clauses, files: ["src/auth/"], buildModel: "claude-opus-5-5" });
  assert.deepEqual({ verdict: result.verdict, model: result.model, cost: result.cost }, { verdict: "approve", model: "jev-latest", cost: 0.0042 });
  assert.ok(result.confidence >= 0.9 * 0.94 - 1e-9 && result.confidence <= 0.9);
  assert.ok(Object.isFrozen(result));
  const [entry] = ledger.entries();
  assert.equal(entry.type, "review.verdict");
  assert.equal(entry.subject, "T-14");
  assert.deepEqual(entry.actor, { kind: "jev", id: "jev", model: "jev-latest" });
  assert.deepEqual(entry.refs, ["P-2 §3.1", "P-2 §3.2"]);
  for (const tag of ["phase:diff", "verdict:approve", "model:jev-latest", "cost:0.0042"]) assert.ok(entry.evidence.includes(tag), tag);
  assert.ok(entry.evidence.some((e) => e.startsWith("confidence:0.")));
  assert.ok(entry.reason.trim());
  assert.equal(result.ledger, entry.n);
  const request = provider.calls[0];
  assert.deepEqual(Object.keys(request.questions).sort(), ["clause_0", "clause_1", "verdict", "weakens"]);
  assert.match(request.questions.clause_1.instructions, /`clauses\[1\]\.text`/);
  assert.equal(request.state.diff, cleanDiff);
});

test("deterministic prechecks reject without spending budget", async () => {
  const ledger = fakeLedger();
  const provider = fakeProvider((r) => confident(r));
  const jev = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 0 } });
  const leaky = cleanDiff.replace("+  return false;", `+  const key = "${fakeOpenAiKey()}";`);
  const result = await jev.reviewDiff({ task, diff: leaky, clauses, files: ["src/auth/"], buildModel: "claude-opus-5-5" });
  assert.equal(result.verdict, "reject");
  assert.equal(result.cost, 0);
  assert.equal(result.model, null);
  assert.equal(provider.calls.length, 0);
  assert.equal(jev.budget().spent, 0);
  const entry = ledger.entries()[0];
  assert.ok(entry.evidence.includes("note:secret-added:src/auth/limit.js:3"));
  assert.ok(!JSON.stringify(ledger.entries()).includes(fakeOpenAiKey()));
  const out = await jev.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/elsewhere/"], buildModel: "claude-opus-5-5" });
  assert.equal(out.verdict, "reject");
  assert.equal(out.notes[0].rule, "out-of-scope");
});

test("missing clause coverage or weakened safety rejects a diff with notes", async () => {
  const ledger = fakeLedger();
  const provider = fakeProvider((r) => confident(r, { clause_1: { type: "noul", noul: 0.05 } }));
  const jev = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 0 } });
  const result = await jev.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "claude-opus-5-5" });
  assert.equal(result.verdict, "reject");
  assert.equal(result.modelVerdict, "reject");
  assert.match(result.notes.map((n) => n.note).join(" "), /P-2 §3\.2/);
  const weak = createJev({ ledger, provider: fakeProvider((r) => confident(r, { weakens: { type: "noul", noul: 0.95 } })), budget: { monthlyCap: 10, spentThisMonth: 0 } });
  assert.equal((await weak.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "x" })).verdict, "reject");
});

test("low confidence escalates to the owner and never approves", async () => {
  const ledger = fakeLedger();
  const escalations = [];
  const provider = fakeProvider((r) => confident(r, { verdict: { type: "choice", choice: "approve", probabilities: {}, confidence: 0.4 } }));
  const jev = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 0 }, onEscalate: (e) => escalations.push(e) });
  const result = await jev.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "claude-opus-5-5" });
  assert.equal(result.verdict, "escalate");
  assert.equal(result.modelVerdict, "approve");
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].task.id, "T-14");
  assert.ok(ledger.entries()[0].evidence.includes("verdict:escalate"));
  // A noul near 0.5 is also low certainty.
  const unsure = createJev({ ledger, provider: fakeProvider((r) => confident(r, { clause_0: { type: "noul", noul: 0.62 } })), budget: { monthlyCap: 10, spentThisMonth: 0 } });
  assert.equal((await unsure.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "x" })).verdict, "escalate");
});

test("budget: warning once per month at 80%, queue at 100%, nothing auto-approved", async () => {
  let clock = new Date("2026-10-09T10:00:00Z");
  const now = () => clock;
  const ledger = fakeLedger({ now });
  const provider = fakeProvider((r) => confident(r), { cost: 3 });
  const jev = createJev({ ledger, provider, now, budget: { monthlyCap: 10, spentThisMonth: 5 } });
  const input = { task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "claude-opus-5-5" };
  assert.equal((await jev.reviewDiff(input)).verdict, "approve"); // 8 of 10
  let warnings = ledger.entries().filter((e) => e.type === "budget.warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].subject, "jev-budget:2026-10");
  assert.equal((await jev.reviewDiff(input)).verdict, "approve"); // 11 of 10
  assert.equal(ledger.entries().filter((e) => e.type === "budget.warning").length, 1, "warned once per month");
  const queued = await jev.reviewDiff(input);
  assert.equal(queued.verdict, "queued");
  assert.equal(queued.cost, 0);
  assert.equal(provider.calls.length, 2);
  assert.equal(ledger.entries().at(-1).type, "review.verdict");
  assert.ok(ledger.entries().at(-1).evidence.includes("verdict:queued"));
  assert.deepEqual(jev.pending().map((p) => p.task), ["T-14"]);
  assert.deepEqual(await jev.retryQueued(), []);

  jev.setBudget({ monthlyCap: 100 });
  const drained = await jev.retryQueued();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].verdict, "approve");
  assert.equal(jev.pending().length, 0);

  clock = new Date("2026-11-02T10:00:00Z");
  assert.equal(jev.budget().month, "2026-11");
  assert.equal(jev.budget().spent, 0);
  jev.setBudget({ monthlyCap: 3.5 });
  await jev.reviewDiff(input); // 3 of 3.5 in November
  warnings = ledger.entries().filter((e) => e.type === "budget.warning");
  assert.deepEqual(warnings.map((w) => w.subject), ["jev-budget:2026-10", "jev-budget:2026-11"]);
});

test("pre-call estimate that would exceed the cap queues the review", async () => {
  const ledger = fakeLedger();
  const provider = fakeProvider((r) => confident(r), { estimate: 2 });
  const jev = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 9 } });
  assert.equal((await jev.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "x" })).verdict, "queued");
  assert.equal(provider.calls.length, 0);
});

test("spend is derived from this month's ledger review entries when not supplied", async () => {
  const ledger = fakeLedger();
  const first = createJev({ ledger, provider: fakeProvider((r) => confident(r), { cost: 4 }), budget: { monthlyCap: 10, spentThisMonth: 0 } });
  await first.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "x" });
  assert.equal(spentFromLedger(ledger.entries(), "2026-10"), 4);
  assert.equal(spentFromLedger(ledger.entries(), "2026-09"), 0);
  const restarted = createJev({ ledger, provider: fakeProvider((r) => confident(r)), budget: { monthlyCap: 10 } });
  assert.equal(restarted.budget().spent, 4);
  assert.throws(() => createJev({ ledger, provider: fakeProvider({}), budget: {} }), /monthlyCap/);
});

test("reviewTest: fails-first, coverage gaps, trivial tests and approval", async () => {
  const ledger = fakeLedger();
  const provider = fakeProvider((r) => confident(r));
  const jev = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 0 } });
  const base = { task, clauses, testSource: "test('locks', () => { assert.equal(limit(5), true); });", buildModel: "claude-opus-5-5" };

  const passesAlready = await jev.reviewTest({ ...base, preRun: { command: "node --test tests/limit.test.mjs", exitCode: 0 } });
  assert.equal(passesAlready.verdict, "reject");
  assert.equal(passesAlready.notes[0].rule, "passes-before-work");
  assert.equal(provider.calls.length, 0);
  assert.equal((await jev.reviewTest({ ...base, testSource: "  " })).verdict, "reject");
  assert.equal((await jev.reviewTest({ ...base, clauses: [] })).verdict, "reject");

  const ok = await jev.reviewTest({ ...base, preRun: { exitCode: 1 } });
  assert.equal(ok.verdict, "approve");
  assert.deepEqual(Object.keys(provider.calls[0].questions).sort(), ["clause_0", "clause_1", "trivial", "verdict"]);
  assert.equal(provider.calls[0].state.testSource, base.testSource);
  assert.ok(ledger.entries().at(-1).evidence.includes("phase:test"));

  const unchecked = await jev.reviewTest(base);
  assert.equal(unchecked.notes[0].rule, "fails-first-unchecked");

  const gapProvider = fakeProvider((r) => confident(r, { clause_1: { type: "noul", noul: 0.03 } }));
  const gaps = await createJev({ ledger, provider: gapProvider, budget: { monthlyCap: 10, spentThisMonth: 0 } }).reviewTest({ ...base, preRun: { exitCode: 1 } });
  assert.equal(gaps.verdict, "gaps");
  assert.match(gaps.notes[0].note, /P-2 §3\.2/);

  const trivialProvider = fakeProvider((r) => confident(r, { trivial: { type: "noul", noul: 0.96 } }));
  assert.equal((await createJev({ ledger, provider: trivialProvider, budget: { monthlyCap: 10, spentThisMonth: 0 } }).reviewTest({ ...base, preRun: { exitCode: 1 } })).verdict, "reject");
});

test("provider failures, malformed answers and truncation all escalate and are recorded", async () => {
  const ledger = fakeLedger();
  const failing = { name: "x", async evaluate() { throw Object.assign(new Error("TypeSafe rejected the stored API key"), { code: "PROVIDER_AUTH" }); } };
  const failed = await createJev({ ledger, provider: failing, budget: { monthlyCap: 10, spentThisMonth: 0 } }).reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "x" });
  assert.equal(failed.verdict, "escalate");
  assert.equal(failed.notes[0].rule, "provider-error");
  assert.match(failed.notes[0].note, /PROVIDER_AUTH/);

  const malformed = fakeProvider(() => ({ verdict: { type: "choice", choice: "maybe", confidence: 0.9 } }));
  const bad = await createJev({ ledger, provider: malformed, budget: { monthlyCap: 10, spentThisMonth: 0 } }).reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "x" });
  assert.equal(bad.verdict, "escalate");
  assert.equal(bad.notes.at(-1).rule, "provider-bad-answer");

  const big = cleanDiff.replace("+  return false;", "+  return false; // " + "y".repeat(500));
  const truncated = await createJev({ ledger, provider: fakeProvider((r) => confident(r)), budget: { monthlyCap: 10, spentThisMonth: 0 }, maxStateChars: 200 }).reviewDiff({ task, diff: big, clauses, files: ["src/auth/"], buildModel: "x" });
  assert.equal(truncated.verdict, "escalate");
  assert.ok(truncated.notes.some((n) => n.rule === "truncated"));
  assert.equal(ledger.entries().filter((e) => e.type === "review.verdict").length, 3);
});

test("a refused ledger write fails the review instead of returning an unrecorded verdict", async () => {
  const ledger = fakeLedger();
  const jev = createJev({ ledger, provider: fakeProvider((r) => confident(r)), budget: { monthlyCap: 10, spentThisMonth: 0 } });
  ledger.failNextWith(Object.assign(new Error("chain broken"), { code: "LEDGER_CHAIN_BROKEN" }));
  await assert.rejects(jev.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "x" }), { code: "LEDGER_CHAIN_BROKEN" });
});

test("end to end: keychain-backed TypeSafe provider keeps the key out of the ledger", async () => {
  const keychain = createMemoryKeychain();
  await setJevKey(FAKE_KEY, { keychain });
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    const { questions } = JSON.parse(init.body);
    const answers = {};
    for (const [id, q] of Object.entries(questions)) answers[id] = q.type === "noul" ? { type: "noul", noul: id === "weakens" ? 0.01 : 0.99 } : { type: "choice", choice: "approve", probabilities: { approve: 0.97, reject: 0.03 }, confidence: 0.93 };
    return { status: 200, ok: true, json: async () => ({ model: "jev-1.13.0", answers, usage: { input_tokens: 1200, output_tokens: 8 } }) };
  };
  const ledger = fakeLedger();
  const jev = createJev({ ledger, provider: createKeychainJevProvider({ keychain, fetchImpl }), budget: { monthlyCap: 5, spentThisMonth: 0 } });
  const result = await jev.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "claude-opus-5-5" });
  assert.equal(result.verdict, "approve");
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.cost, (1200 * 0.042) / 1e6);
  assert.equal(fetchCalls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.ok(!JSON.stringify(ledger.entries()).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
  await clearJevKey({ keychain });
  const noKey = await jev.reviewDiff({ task, diff: cleanDiff, clauses, files: ["src/auth/"], buildModel: "claude-opus-5-5" });
  assert.equal(noKey.verdict, "escalate");
  assert.match(noKey.notes[0].note, /PROVIDER_NO_KEY/);
});

test("jev sources never read the clipboard or environment for a key and stay cross-platform", async () => {
  const dir = path.join(here, "..", "src", "core", "jev");
  for (const name of await readdir(dir)) {
    const source = await readFile(path.join(dir, name), "utf8");
    assert.doesNotMatch(source, /clipboard|Get-Clipboard|pbpaste|xclip|xsel/i, name);
    assert.doesNotMatch(source, /process\.env/, name);
    assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)/, name);
    assert.doesNotMatch(source, /shell:\s*true/, name);
  }
});
