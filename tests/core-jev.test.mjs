import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readdir, readFile, mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createJev, sameModel, spentFromLedger, createTypeSafeProvider, createKeychainJevProvider, precheckDiff, parseUnifiedDiff,
  isTestPath, setJevKey, hasJevKey, clearJevKey, createSystemKeychain, createMemoryKeychain, JEV_KEY_SERVICE, JEV_KEY_ACCOUNT,
  queuedFromLedger, inScope, isUnsafePath, SECRET_RULES, ESTIMATE_CHARS_PER_TOKEN, ESTIMATE_SAFETY_FACTOR,
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
    if (script.includes("::Exists(")) return store.has("k") ? { code: 0 } : { code: 3 };
    if (script.includes("::Delete(")) return store.delete("k") ? { code: 0 } : { code: 3 };
    return { code: 1, stderr: "unexpected script" };
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
    assert.equal(await keychain.exists(JEV_KEY_SERVICE, account), false);
    await keychain.store(JEV_KEY_SERVICE, account, value);
    assert.equal(await keychain.exists(JEV_KEY_SERVICE, account), true);
    assert.equal(await keychain.read(JEV_KEY_SERVICE, account), value);
    await keychain.store(JEV_KEY_SERVICE, account, value + "-2");
    assert.equal(await keychain.read(JEV_KEY_SERVICE, account), value + "-2");
  } finally {
    assert.equal(await keychain.remove(JEV_KEY_SERVICE, account), true);
  }
  assert.equal(await keychain.read(JEV_KEY_SERVICE, account), null);
  assert.equal(await keychain.remove(JEV_KEY_SERVICE, account), false);
  assert.equal(await keychain.exists(JEV_KEY_SERVICE, account), false);
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
  assert.equal(unchecked.verdict, "gaps", "never approved without a fails-first run");
  assert.ok(unchecked.notes.some((n) => n.rule === "fails-first-required"));

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

// ------------------------------------------------------- review fixes (C065)
const diffInput = { task, diff: cleanDiff, testOutput: "ok 1", clauses, files: ["src/auth/"], buildModel: "claude-opus-5-5" };

test("review.verdict and budget.warning carry the structured data the board replays", async () => {
  const ledger = fakeLedger();
  const provider = fakeProvider((r) => confident(r), { cost: 8.5 });
  provider.name = "TypeSafe";
  const jev = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 0 } });
  const result = await jev.reviewDiff(diffInput);
  const entry = ledger.entries().find((e) => e.type === "review.verdict");
  assert.deepEqual(
    { kind: entry.data.kind, verdict: entry.data.verdict, modelVerdict: entry.data.modelVerdict, model: entry.data.model, provider: entry.data.provider, cost: entry.data.cost, confidence: entry.data.confidence },
    { kind: "diff", verdict: "approve", modelVerdict: "approve", model: "jev-latest", provider: "TypeSafe", cost: 8.5, confidence: result.confidence },
  );
  assert.ok(Array.isArray(entry.data.notes));
  const warning = ledger.entries().find((e) => e.type === "budget.warning");
  assert.deepEqual(warning.data, { percent: 85, spent: 8.5, cap: 10, month: "2026-10" });
  // Local rejects carry data too, with no model or provider.
  await jev.reviewDiff({ ...diffInput, files: ["src/elsewhere/"] });
  const reject = ledger.entries().at(-1);
  assert.equal(reject.data.verdict, "reject");
  assert.equal(reject.data.model, null);
  assert.equal(reject.data.provider, null);
  assert.equal(reject.data.notes[0].rule, "out-of-scope");
  assert.equal(entry.data.outcome, "approve");
  assert.equal(reject.data.outcome, "reject");
});

test("spentFromLedger prefers data.cost and falls back to the cost: tag", () => {
  const at = "2026-10-03T00:00:00Z";
  const entries = [
    { type: "review.verdict", actor: { kind: "jev", id: "jev" }, at, data: { cost: 1.5 }, evidence: ["cost:99"] },
    { type: "review.verdict", actor: { kind: "jev", id: "jev" }, at, evidence: ["cost:0.25"] },
    { type: "review.verdict", actor: { kind: "agent", id: "a" }, at, data: { cost: 50 } },
  ];
  assert.equal(spentFromLedger(entries, "2026-10"), 1.75);
});

test("queued reviews survive a restart: rebuilt from the ledger and retried through a resolver", async () => {
  const ledger = fakeLedger();
  const provider = fakeProvider((r) => confident(r), { cost: 1 });
  const first = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 10 } });
  const queued = await first.reviewDiff(diffInput);
  assert.equal(queued.verdict, "queued");
  assert.equal(provider.calls.length, 0);

  // Restart: a fresh reviewer over the same ledger still knows the review is pending.
  assert.deepEqual(queuedFromLedger(ledger.entries()).map((q) => [q.task, q.phase, q.ledger]), [["T-14", "diff", queued.ledger]]);
  const restarted = createJev({ ledger, provider, budget: { monthlyCap: 100, spentThisMonth: 0 } });
  assert.deepEqual(restarted.pending().map((p) => ({ task: p.task, phase: p.phase, ledger: p.ledger, restored: p.restored })), [{ task: "T-14", phase: "diff", ledger: queued.ledger, restored: true }]);
  // Without a resolver there is no input to re-run, so it stays pending (no silent drop).
  assert.deepEqual(await restarted.retryQueued(), []);
  assert.equal(restarted.pending().length, 1);
  const asked = [];
  const drained = await restarted.retryQueued(async (item) => { asked.push(item); return diffInput; });
  assert.deepEqual(asked.map((a) => [a.task, a.phase, a.ledger]), [["T-14", "diff", queued.ledger]]);
  assert.equal(drained.length, 1);
  assert.equal(drained[0].verdict, "approve");
  assert.equal(restarted.pending().length, 0);
  assert.deepEqual(queuedFromLedger(ledger.entries()), [], "a later verdict settles the queued one");
  // A resolver that answers for the wrong task is refused and the review stays pending.
  const again = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 10 } });
  await again.reviewDiff(diffInput);
  const third = createJev({ ledger, provider, budget: { monthlyCap: 100, spentThisMonth: 0 } });
  await assert.rejects(third.retryQueued(async () => ({ ...diffInput, task: { id: "T-99" } })), /expected T-14/);
  assert.equal(third.pending().length, 1);
});

test("budget warning is written even when the month starts over 80% or over the cap", async () => {
  const ledger = fakeLedger();
  const provider = fakeProvider((r) => confident(r));
  const jev = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 12 } });
  assert.equal((await jev.reviewDiff(diffInput)).verdict, "queued");
  assert.equal((await jev.reviewDiff(diffInput)).verdict, "queued");
  const warnings = ledger.entries().filter((e) => e.type === "budget.warning");
  assert.equal(warnings.length, 1, "warned once, though no paid call was made");
  assert.equal(warnings[0].data.percent, 120);
  assert.equal(provider.calls.length, 0);

  const ledger2 = fakeLedger();
  const nearly = createJev({ ledger: ledger2, provider, budget: { monthlyCap: 10, spentThisMonth: 9 } });
  await nearly.reviewDiff(diffInput);
  const entries = ledger2.entries();
  assert.equal(entries.filter((e) => e.type === "budget.warning").length, 1);
  assert.ok(entries.findIndex((e) => e.type === "budget.warning") < entries.findIndex((e) => e.data?.verdict === "approve"), "warning precedes the paid call");
});

test("fails-first: no run caps at gaps; crashed, unrunnable or code-less runs reject without a call", async () => {
  const ledger = fakeLedger();
  const provider = fakeProvider((r) => confident(r));
  const jev = createJev({ ledger, provider, budget: { monthlyCap: 10, spentThisMonth: 0 } });
  const base = { task, clauses, testSource: "test('locks', () => { assert.equal(limit(5), true); });", buildModel: "claude-opus-5-5" };
  for (const preRun of [{ exitCode: 127, command: "nod --test" }, { exitCode: 126 }, { exitCode: 9009 }, { error: "spawn ENOENT" }, { exitCode: 1, signal: "SIGKILL" }, { exitCode: null, timedOut: true }, {}, { exitCode: "1" }, { exitCode: 1.5 }]) {
    const r = await jev.reviewTest({ ...base, preRun });
    assert.equal(r.verdict, "reject", JSON.stringify(preRun));
    assert.equal(r.notes[0].rule, "fails-first-invalid", JSON.stringify(preRun));
  }
  assert.equal(provider.calls.length, 0);
  assert.equal((await jev.reviewTest({ ...base, preRun: { exitCode: 1 } })).verdict, "approve");
  const none = await jev.reviewTest(base);
  assert.equal(none.verdict, "gaps");
  assert.equal(none.modelVerdict, "approve");
  // A model reject without a fails-first run is not softened to gaps.
  const rejecting = createJev({ ledger, provider: fakeProvider((r) => confident(r, { trivial: { type: "noul", noul: 0.97 } })), budget: { monthlyCap: 10, spentThisMonth: 0 } });
  assert.equal((await rejecting.reviewTest(base)).verdict, "reject");
});

test("pre-call estimate is conservative (3 chars per token with a 1.5x factor)", () => {
  assert.equal(ESTIMATE_CHARS_PER_TOKEN, 3);
  assert.equal(ESTIMATE_SAFETY_FACTOR, 1.5);
  const provider = createTypeSafeProvider({ getApiKey: async () => FAKE_KEY, settings: { pricePerMillionInputTokens: 1_000_000 } });
  const state = { diff: "x".repeat(2994) };
  const chars = JSON.stringify({ state, questions: nouls }).length;
  assert.equal(provider.estimateCost({ state, questions: nouls }), Math.ceil((chars / 3) * 1.5));
  assert.ok(provider.estimateCost({ state, questions: nouls }) >= chars / 2, "at least one token per 2 characters");
});

test("scope check refuses '..', absolute and drive-letter paths", () => {
  assert.equal(inScope("src/../package.json", ["src/**"]), false);
  assert.equal(inScope("src/auth/../../package.json", ["src/"]), false);
  assert.equal(inScope("../outside.js", ["src/**"]), false);
  assert.equal(inScope("/etc/passwd", ["src/**"]), false);
  assert.equal(inScope("C:/Windows/x.js", ["src/**"]), false);
  assert.equal(inScope("src/a.js", ["src/../**"]), false, "a climbing scope entry matches nothing");
  assert.equal(inScope("./src//a.js", ["src/**"]), true);
  assert.equal(isUnsafePath("src\\..\\x"), true);
  const climbing = ["diff --git a/src/../package.json b/src/../package.json", "--- a/src/../package.json", "+++ b/src/../package.json", "@@ -1 +1 @@", "-{}", "+{\"x\":1}", ""].join("\n");
  const out = precheckDiff({ diff: climbing, files: ["src/**"] });
  assert.equal(out.ok, false);
  assert.equal(out.notes[0].rule, "out-of-scope");
  assert.equal(out.notes[0].file, "src/../package.json");
});

test("the task's own approved test may change assertions but is still checked for skips", async () => {
  const own = [
    "diff --git a/tests/limit.test.mjs b/tests/limit.test.mjs",
    "--- a/tests/limit.test.mjs",
    "+++ b/tests/limit.test.mjs",
    "@@ -10,3 +10,4 @@",
    "   assert.equal(limit(4), false);",
    "-  assert.equal(limit(5), true);",
    "+  assert.equal(limit(5), \"locked\");",
    "+test.skip(\"later\", () => {});",
    "   done();",
    "",
  ].join("\n");
  assert.deepEqual(precheckDiff({ diff: own, files: ["tests/"] }).notes.map((n) => n.rule), ["assertion-removed", "test-skipped"]);
  assert.deepEqual(precheckDiff({ diff: own, files: ["tests/"], taskTests: ["tests/limit.test.mjs"] }).notes.map((n) => n.rule), ["test-skipped"]);
  assert.deepEqual(precheckDiff({ diff: own, files: ["tests/"], taskTests: ["tests/other.test.mjs"] }).notes.map((n) => n.rule), ["assertion-removed", "test-skipped"]);
  assert.deepEqual(precheckDiff({ diff: own, files: ["tests/"], taskTests: ["tests/x/../limit.test.mjs"] }).notes.map((n) => n.rule), ["assertion-removed", "test-skipped"], "a climbing taskTests entry exempts nothing");
  const editOnly = own.replace('+test.skip("later", () => {});\n', "").replace("@@ -10,3 +10,4 @@", "@@ -10,3 +10,3 @@");
  const provider = fakeProvider((r) => confident(r));
  const jev = createJev({ ledger: fakeLedger(), provider, budget: { monthlyCap: 10, spentThisMonth: 0 } });
  const r = await jev.reviewDiff({ task, diff: editOnly, clauses, files: ["tests/"], taskTests: ["tests/limit.test.mjs"], buildModel: "x" });
  assert.equal(r.verdict, "approve");
  assert.equal(provider.calls.length, 1);
  const without = await jev.reviewDiff({ task, diff: editOnly, clauses, files: ["tests/"], buildModel: "x" });
  assert.equal(without.verdict, "reject");
  assert.equal(without.notes[0].rule, "assertion-removed");
});

test("precheck secret rules are identical to the repository scanner's rules", async () => {
  const source = await readFile(path.join(here, "..", "scripts", "verify-secrets.mjs"), "utf8");
  const start = source.indexOf("const patterns = [");
  const block = source.slice(start, source.indexOf("];", start));
  const scanner = [...block.matchAll(/^\s*\["([a-z-]+)", \/(.+)\/([a-z]*)\],?\s*$/gm)].map((m) => [m[1], new RegExp(m[2], m[3]).source, m[3].replace("g", "")]);
  assert.ok(scanner.length >= 9, "scanner rules were found");
  assert.deepEqual(SECRET_RULES.map(([name, re]) => [name, re.source, re.flags]), scanner);
});

test("hasJevKey asks the keychain whether an item exists without reading the secret (Windows, macOS)", async () => {
  const win = scriptedSpawn((call) => (decodePs(call.args).includes("::Exists(") ? { code: 0 } : { code: 1, stderr: "read was called" }));
  assert.equal(await hasJevKey({ keychain: createSystemKeychain({ platform: "win32", spawn: win.spawn }) }), true);
  assert.equal(win.calls.length, 1);
  const script = decodePs(win.calls[0].args);
  assert.match(script, /\[PerfectPlannerCred\]::Exists\(\$target\)/);
  assert.doesNotMatch(script.split("'@").at(-1), /::Read\(|Out\.Write/, "the exists operation prints nothing");
  const winMissing = scriptedSpawn(() => ({ code: 3 }));
  assert.equal(await hasJevKey({ keychain: createSystemKeychain({ platform: "win32", spawn: winMissing.spawn }) }), false);

  const mac = scriptedSpawn((call) => (call.args.includes("-w") || call.args.includes("-g") ? { code: 1 } : { code: 0, stdout: 'keychain: "login.keychain-db"\nattributes:\n' }));
  assert.equal(await hasJevKey({ keychain: createSystemKeychain({ platform: "darwin", spawn: mac.spawn }) }), true);
  assert.deepEqual(mac.calls[0].args, ["find-generic-password", "-s", "perfect-planner", "-a", "jev-api-key"]);
  const macMissing = scriptedSpawn(() => ({ code: 44 }));
  assert.equal(await hasJevKey({ keychain: createSystemKeychain({ platform: "darwin", spawn: macMissing.spawn }) }), false);
});

test("macOS store escapes quote and backslash for security -i exactly", async () => {
  const tricky = 'ab"cd\\ef' + "0123";
  const { spawn, calls } = scriptedSpawn((call) => (call.args[0] === "-i" ? { code: 0 } : { code: 0, stdout: tricky + "\n" }));
  await createSystemKeychain({ platform: "darwin", spawn }).store(JEV_KEY_SERVICE, JEV_KEY_ACCOUNT, tricky);
  assert.ok(calls[0].stdin.endsWith(' -w "ab\\"cd\\\\ef0123"\n'), "quote and backslash are each escaped with one backslash");
  // A read-back mismatch (security -i parsed the escapes differently) is a hard failure, never silent.
  const wrong = scriptedSpawn((call) => (call.args[0] === "-i" ? { code: 0 } : { code: 0, stdout: 'ab\\"cd\\\\ef0123\n' }));
  await assert.rejects(createSystemKeychain({ platform: "darwin", spawn: wrong.spawn }).store(JEV_KEY_SERVICE, JEV_KEY_ACCOUNT, tricky), { code: "KEYCHAIN_FAILED" });
});

test("approvals record a reason built from the answers", async () => {
  const ledger = fakeLedger();
  const jev = createJev({ ledger, provider: fakeProvider((r) => confident(r)), budget: { monthlyCap: 10, spentThisMonth: 0 } });
  await jev.reviewDiff(diffInput);
  const reason = ledger.entries().at(-1).reason;
  assert.match(reason, /All 2 cited clauses implemented \(min p=0\.97\); no weakening \(p=0\.02\)/);
  assert.match(reason, /Verdict confidence 0\.9/);
  await jev.reviewTest({ task, clauses, testSource: "assert.ok(limit(5))", buildModel: "x", preRun: { exitCode: 1 } });
  assert.match(ledger.entries().at(-1).reason, /All 2 cited clauses would be caught by the test/);
});

test("Noul answers escalate only inside the unclear band (default 0.25 < p < 0.75), configurable", async () => {
  const run = async (p, options = {}) => (await createJev({ ledger: fakeLedger(), provider: fakeProvider((r) => confident(r, { clause_0: { type: "noul", noul: p } })), budget: { monthlyCap: 10, spentThisMonth: 0 }, ...options }).reviewDiff(diffInput)).verdict;
  assert.equal(await run(0.78), "approve");
  assert.equal(await run(0.76), "approve");
  assert.equal(await run(0.7), "escalate");
  assert.equal(await run(0.5), "escalate");
  assert.equal(await run(0.3), "escalate");
  assert.equal(await run(0.2), "reject", "a clear 'not implemented' rejects rather than escalating");
  assert.equal(await run(0.7, { noulCertainty: 0.3 }), "approve");
  assert.equal(await run(0.9, { noulCertainty: 0.9 }), "escalate");
  assert.throws(() => createJev({ ledger: fakeLedger(), provider: fakeProvider({}), budget: { monthlyCap: 1 }, noulCertainty: 2 }), /noulCertainty/);
});

test("queued entries name no model on the actor; the would-be reviewer is data.intendedModel", async () => {
  const ledger = fakeLedger();
  const jev = createJev({ ledger, provider: fakeProvider((r) => confident(r)), budget: { monthlyCap: 10, spentThisMonth: 10 } });
  const result = await jev.reviewDiff(diffInput);
  assert.equal(result.verdict, "queued");
  assert.equal(result.model, null);
  assert.equal(result.intendedModel, "jev-latest");
  const entry = ledger.entries().find((e) => e.type === "review.verdict");
  assert.deepEqual(entry.actor, { kind: "jev", id: "jev" });
  assert.equal(entry.data.model, null);
  assert.equal(entry.data.intendedModel, "jev-latest");
  assert.equal(entry.data.provider, null);
  assert.equal(entry.data.outcome, "queued");
  assert.equal(entry.data.verdict, "reject", "the ledger's two-way verdict never says approve for a queued review");
  assert.ok(entry.evidence.includes("model:none"));
});

// The strict ledger lives on core/ledger until both branches merge. Use it from
// the tree when present, else from that branch via git; skip only when neither exists.
async function loadRealLedger() {
  const local = path.join(here, "..", "src", "core", "ledger", "index.mjs");
  try { await access(local); return { mod: await import(pathToFileURL(local).href), cleanup: async () => {} }; } catch { /* not merged yet */ }
  const repoRoot = path.join(here, "..");
  let files;
  try { files = execFileSync("git", ["ls-tree", "-r", "--name-only", "core/ledger", "src/core/ledger"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter((f) => f.endsWith(".mjs")); } catch { return null; }
  if (!files.length) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), "pp-jev-ledger-src-"));
  for (const file of files) {
    const target = path.join(dir, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, execFileSync("git", ["show", `core/ledger:${file}`], { cwd: repoRoot, encoding: "utf8" }));
  }
  return { mod: await import(pathToFileURL(path.join(dir, "src", "core", "ledger", "index.mjs")).href), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const realLedger = await loadRealLedger();

async function withRealLedger(fn) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pp-jev-ledger-"));
  const now = () => new Date("2026-10-09T10:00:00Z");
  const ledger = await realLedger.mod.openLedger(repo, { now });
  try {
    await ledger.append({ actor: { kind: "person", id: "owner" }, type: "task.created", subject: "T-1", summary: "Add login rate limit" });
    return await fn(ledger, now);
  } finally {
    await ledger.close?.();
    await rm(repo, { recursive: true, force: true });
  }
}
const realSkip = { skip: realLedger ? false : "core/ledger is not available" };
test.after(async () => { await realLedger?.cleanup(); });

test("against the real strict ledger: paid reviews and budget warnings are accepted and fill the board", realSkip, async () => {
  await withRealLedger(async (ledger, now) => {
    let answers = (r) => confident(r);
    const provider = fakeProvider((r) => answers(r), { cost: 3 });
    provider.name = "TypeSafe";
    const jev = createJev({ ledger, provider, now, budget: { monthlyCap: 10, spentThisMonth: 0 } });
    const input = { ...diffInput, task: { id: "T-1" } };
    const approved = await jev.reviewDiff(input);
    answers = (r) => confident(r, { clause_1: { type: "noul", noul: 0.05 } });
    assert.equal((await jev.reviewDiff(input)).verdict, "reject");
    answers = (r) => confident(r, { verdict: { type: "choice", choice: "approve", probabilities: {}, confidence: 0.4 } });
    assert.equal((await jev.reviewDiff(input)).verdict, "escalate");
    answers = () => ({ verdict: { type: "choice", choice: "maybe", confidence: 0.9 } });
    assert.equal((await jev.reviewDiff(input)).verdict, "escalate");
    const board = ledger.board();
    const reviews = board.tasks["T-1"].reviews;
    assert.deepEqual(reviews.map((r) => [r.kind, r.verdict, r.model, r.provider, r.cost]), [
      ["diff", "approve", "jev-latest", "TypeSafe", 3],
      ["diff", "reject", "jev-latest", "TypeSafe", 3],
      ["diff", "reject", "jev-latest", "TypeSafe", 3],
      ["diff", "reject", "jev-latest", "TypeSafe", 3],
    ]);
    assert.equal(reviews[0].confidence, approved.confidence);
    assert.equal(reviews[3].confidence, 0, "a call with no usable answer records confidence 0");
    assert.deepEqual(ledger.entries().filter((e) => e.type === "review.verdict").map((e) => e.data.outcome), ["approve", "reject", "escalate", "escalate"]);
    assert.equal(board.budgetWarnings.length, 1);
    assert.equal(board.budgetWarnings[0].percent, 90);
    assert.equal(spentFromLedger(ledger.entries(), "2026-10"), 12);
  });
});

// Known cross-module conflict, reported to the integrator: the strict ledger requires
// every Jev review.verdict to name a model, provider and confidence, but local precheck
// rejects, budget-queued reviews and independence escalations make no model call. Jev
// will not invent a model for them, so the ledger refuses those entries (and the review
// throws rather than returning an unrecorded verdict). Resolve in core/ledger, e.g. by
// accepting data.outcome "queued"/"escalate"/precheck rejects without a model.
test("against the real strict ledger: outcomes with no model call are recorded", { ...realSkip, todo: realLedger ? "needs a core/ledger rule for review.verdict entries without a model call" : false }, async () => {
  await withRealLedger(async (ledger, now) => {
    const jev = createJev({ ledger, provider: fakeProvider((r) => confident(r)), now, budget: { monthlyCap: 10, spentThisMonth: 10 } });
    assert.equal((await jev.reviewDiff({ ...diffInput, task: { id: "T-1" }, files: ["src/elsewhere/"] })).verdict, "reject");
    assert.equal((await jev.reviewDiff({ ...diffInput, task: { id: "T-1" } })).verdict, "queued");
    assert.deepEqual(queuedFromLedger(ledger.entries()).map((q) => q.task), ["T-1"]);
  });
});
