---
name: perfect-planner-connect
description: Connect to Perfect Planner and work its ledger loop. Use when the user says "check in with Perfect Planner", pastes a Perfect Planner connect line, or when a perfect-planner-core MCP server or a Perfect Planner task brief is present.
---

# Perfect Planner: connect and work the loop

Perfect Planner coordinates coding agents through one strict, append-only ledger.
You talk to it only through the `perfect-planner-core` MCP tools. Every call you
make is recorded as you, an agent. The person approves plans, tests, diffs and
merges in the app; you never can, and you never try.

## 1. Connect

Check whether the `perfect-planner-core` tools are available to you (for example
`mcp__perfect-planner-core__hello`).

**They are available:** go to step 2.

**They are not:**

1. If the user pasted a line that starts with `node` and contains `connect.mjs`
   (or `claude mcp add perfect-planner-core`), run it yourself in the project
   folder with your shell tool. It registers the server for this folder and
   replaces an older registration, so it is safe to run again.
2. If they did not, ask them for exactly this, in one message:
   "In Perfect Planner, click **Connect agent**, then **Connect agent** again in
   the panel, and paste the line it shows here."
3. After the line has run, the tools appear only in a new session. Tell the user:
   "Done. Restart Claude Code in this folder (or run /mcp and reconnect
   perfect-planner-core), then say: check in with Perfect Planner."
   Then stop.

Never print, log, commit or repeat the token (`pp_c_…` or `pp_w_…`) back to the
user. It is a private key for this one connection.

If a call fails with `UNAUTHORIZED: This token is not valid…`, the app was
restarted or the person disconnected you. Ask for a fresh connect line (step 1.2).

## 2. Check in

Call `hello` once, with your name and the model you run:

```
hello({ name: "Claude Code", model: "<your model id>" })
```

The answer tells you your `role`:

- `main`: you are the person's **main chat**. Follow section 3.
- `worker`: you were launched on one task. Follow section 4.
- anything else: you can read the board (`list_tasks`, `lookup`) and nothing more.

Tell the user in one line which role you got.

## 3. Main chat loop

You are the one conversation the person talks to. Workers send their questions
to you.

- Call `check_inbox` when you start, between steps of anything you do, and
  whenever the user asks what is going on. Blocking questions come first.
- For each open question (`Q-n`):
  - If the plan, an earlier decision (`D-n`) or the code clearly answers it,
    call `answer({ question: "Q-n", text })` and cite what you relied on
    (`lookup` any reference first so you quote it exactly).
  - If it needs the person's judgement (product choice, scope, money, security,
    anything not already decided), ask the user here in plain words with the
    options, then pass their reply on with `answer`. Say that their final say
    becomes a decision only when they record it in Perfect Planner.
- Your `answer` is information for the worker, never a decision. Do not present
  it as approved.
- Use `list_tasks` for the board and `lookup` for any reference
  (`§3.1`, `P-2 §3.1`, `T-14`, `Q-3`, `D-3`, `R-1`, `L-000231`).
- You do not claim tasks. To get work started, the person dispatches a worker
  from the task's page in Perfect Planner.

## 4. Worker loop

Your token covers exactly one task. The app also wrote a brief for it (shown
when the worker was dispatched, and saved under `.perfect-planner/briefs/` in
the project). Read the brief first: it names the task, the clauses it
implements, the folder (worktree) and branch you must work in, and whether a
done-when test already exists.

Then, in order:

1. **Read the task.** `lookup` the task (`T-n`) and every clause it cites. Work
   only in the worktree folder named in the brief. Do not touch other tasks,
   other branches or files outside that folder.
2. **Test first.**
   - No test yet: write a test that fails on today's code and will pass once
     the task is done. Commit it. Call
     `propose_test({ task, command, files })` with the one-line command (run
     from the worktree root) and the test file paths. Then stop building and
     wait: the person approves the test in Perfect Planner and the app runs it
     to see it fail.
   - Test proposed but not approved: wait, or propose a better one.
   - Test approved: never edit, rename, skip or weaken it or its files. Perfect
     Planner refuses work that changes an approved test.
3. **Claim.** When `list_tasks` shows your task with `testApproved: true`, call
   `claim_task({ task })`. Claim only the task your token covers. If the claim
   is refused, read the message, do what it says, and do not retry in a loop.
4. **Build in small commits.** After each meaningful step, call
   `report_progress({ task, text })` with one plain line.
5. **Questions go through the relay, never around it.** When you need a
   decision, call `ask_main({ task, question, options?, blocking? })`. Use
   `blocking: true` only when you cannot continue without the answer; that
   pauses only you. Use `wait_seconds` (up to 600) to wait for the answer in
   the same call, otherwise call `check_inbox` later. If an earlier decision
   already answers it, the answer comes back at once.
6. **Proof.** When the approved test passes for you, commit everything, then
   `attach_proof({ task, kind: "commit", link: "<full commit hash>" })`. Add a
   `test-run`, `screenshot` or `page` proof if useful. Proof is not "done":
   Perfect Planner runs the approved test itself, and the person reviews the
   diff and merges.
7. **Blocked or stuck.** If you cannot continue (missing access, the task is
   wrong, the test cannot pass for a reason outside the task), call
   `release_task({ task, reason, blocked: true })` with a specific reason. If
   you are simply stopping, release without `blocked`. Your token stops
   working for that task after a release.

If a call returns `PAUSED`, stop work and call `check_inbox` until you are
resumed or your question is answered.

## Never

- Never write, fake or imply an approval, a decision, a merge or "done". Only
  the person does those, in Perfect Planner.
- Never call Perfect Planner's HTTP API directly, and never edit anything under
  `.perfect-planner/` (ledger, briefs, keys) by hand. The MCP tools are your
  only way in.
- Never claim a task your token does not cover, or work outside your worktree.
- Never put secrets (keys, tokens, `.env` contents) in progress lines, questions,
  proof or commits. Proof that looks like a secret is refused.
- Never ask the person a question directly when you are a worker: use
  `ask_main`, so the one main chat sees every question.

## Errors

| Code | Meaning | Do |
|---|---|---|
| `UNAUTHORIZED` | Token unknown, revoked, or `hello` not called | Call `hello`; if it still fails, ask for a new connect line |
| `FORBIDDEN` | Tool is for another role, or another task | Stay in your role and your task |
| `CONFLICT` | Not claimed, already held, or already done | Read the message; do not force it |
| `PAUSED` | Work is paused, or you wait on a blocking question | `check_inbox` later |
| `REFUSED` | A ledger rule said no (for example the test is not approved) | Do what the message says |
| `INVALID` | Bad input | Fix the input; task ids look like `T-14`, questions like `Q-3` |
