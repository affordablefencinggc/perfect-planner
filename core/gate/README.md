# core/gate — the acceptance-test gate

Enforces specs 5.1–5.5, 6.2 and 2.4: a task cannot start until its done-when
test exists, is approved by a person and then fails on the current code, and
cannot finish until that exact test passes after merge. The gate is stateless; every answer is
replayed from `ledger.entries()` (`deriveState`).

## Lifecycle

```
define -> [Jev verdict] -> approve (a person; pins the test files) -> confirmFailsFirst (must FAIL) -> canStart
  -> worker commits -> prove (runs in the worktree at HEAD, must be clean, test files unchanged)
  -> diff review: approveDiff (Jev or a person) -> approveMerge (a person, signed) -> mergeAndVerify -> test.passed (afterMerge), merge.done, task.done
                  reject                         -> review.verdict, task.reopened (T-14 -> T-14.a2)
```

Nothing an agent defines is run before a person approves it.

## The approved test is pinned

Approval records the command and a sha256 of every test file: arguments of the
command that are files in the checkout (`node check.mjs`, `vitest run tests/x.test.ts`)
plus any listed with `define(..., { files })`. Line endings are ignored, so a CRLF
checkout matches. A test whose files can't be found is not approvable.
`confirmFailsFirst`, `prove` and `mergeAndVerify` re-hash those files (on disk and in
the checked-out commit) before running, and refuse, recording `tampered:<file>`,
when any differ. Every proof entry carries the approved pin, and only passes with
that pin count towards finishing. To change the test, define it again and get it
approved again.

The test command runs with a PATH that cannot lead into the project (`testEnv`): only
absolute, local, resolvable folders outside the run folder, the repo's checkout, every
worktree git lists and the roots the host passes as `protect`, checked as written and as
real paths, with the app's own Node folder first (`PP_NODE_BINARY`, else this Node). The
program its first word starts (`resolveCommand`, after any `NAME=value` and `exec`/`env`)
is refused when it sits inside one of those folders, as written or through a link, or
when shell syntax hides which program it is. Programs named later in the command are only
looked up through that PATH; an explicit path later in the command is not checked.

`task.done` is written by the gate only (actor `system:gate`, with `data.approvedBy`
naming the person who merged); `gateRule()` refuses it from anyone else.

Jev can review the test before the person approves it (`approve(..., { jevVerdict })`,
whose gaps refuse the approval) or afterwards (`reviewTest`). Gaps found after
approval stop work: `canStart`, `prove` and `mergeAndVerify` refuse until Jev records
"approve" or the test is redefined and approved again.

`requireJevTestReview` (a `TestGate` option and `gateRule({ requireJevTestReview })`,
default `false`) makes work wait until Jev has approved the current test, not only
until open gaps are cleared. Decided policy (the owner's choice, 2026-10-09): Jev's
test review is optional until a Jev key is configured and required after, so the app
turns this on whenever Jev is set up.

Redefining a test (a new `test.defined`) voids the baseline, Jev verdict and
approval tied to the previous definition. A reopened attempt (`T-14.a2`)
inherits the test, baseline and approval of earlier attempts; worktree and
merge results, `merge.done` and `task.done` are per attempt.

## API

```ts
import { TestGate, gateRule } from "../gate/index";

const gate = new TestGate({ ledger, timeoutMs?, run?, now? });
ledger.addRule(gateRule());                       // refuses task.claimed until approved and failing (5.1), task.done unless from the gate

gate.define(taskId, command, actor, refs?, { files? }) // test.defined
gate.approve(taskId, person, { cwd, jevVerdict?: "approve" | string[], jev?: Actor }) // pins the test files in cwd
await gate.confirmFailsFirst(taskId, cwd)         // ok only when the approved test fails today
gate.canStart(taskId)                             // { ok, reason }
await gate.prove(taskId, worktreePath)            // { ok, run, commit } | { ok: false, output }
gate.approveDiff(taskId, reviewer, commit?)       // Jev or a person; default commit: last worktree run
gate.approveMerge(taskId, person, commit?)        // the person's own signed entry; default commit: the approved diff
await gate.mergeAndVerify(taskId, { repoRoot, branch, integrationBranch, actor, prepare? })
gate.reviewTest(taskId, jev, "approve" | gaps)    // Jev's test review, before or after approval; gaps stop work
gate.reject(taskId, reviewer, notes, { verdict? }) // { ok, newTaskId }; verdict cites a signed diff rejection already written
gate.assertCanFinish(taskId, headSha)             // throws GateError (mirror of the ledger's 2.4 check)
gate.state(taskId)                                // GateState
await runTestCommand(command, cwd, { timeoutMs }) // { passed, exitCode, timedOut, durationMs, outputTail }
```

Outcomes and refusals return `{ ok: false, reason }`; malformed input throws
`GateError`; ledger refusals throw `LedgerError`.

`mergeAndVerify` merges into a temporary detached worktree of the integration
branch (`git merge --no-ff`), runs the test there, and only on a pass moves the
integration branch: `git merge --ff-only` in its checkout if it is checked out
(refused when that checkout has uncommitted changes or has moved), else
`git update-ref` with the expected old value. Conflicts and failures leave
the integration branch untouched. The temporary worktree is always removed.
It merges only when the branch tip has an approving diff verdict and a merge
approval for that exact tip in the person's own signed entry (`approveMerge`,
`review.verdict` with `scope:merge`). Passing a person as `actor` is not approval:
the gate refuses unless that person signed the approval, and writes the signer on
`merge.done` and `task.done`. A verdict counts only when the ledger verified its
signature: a person's own entry, or the gate's entry recording Jev's verdict
(`approveDiff(taskId, jev)` writes it as `system:gate` with `data.reviewer`). A
`review.verdict` that merely names Jev as its actor is unsigned and ignored, as
are unsigned test verdicts (Jev's `scope:test` verdicts are also recorded by the
gate), test results, merges, done and reopen entries.

When the diff touches anything that can change what the approved test checks,
Jev's approval is not enough and a person has to approve that diff: package
files (package.json, lockfiles, .npmrc), tool configuration (`*.config.*`,
tsconfig, rc files), setup and teardown files, test support (tests/, helpers/,
support/, fixtures/, mocks/, `*.test.*`, files beside a pinned test), files named
in the test command or in package.json scripts, and every file the pinned test
files import, followed transitively. That last rule includes the code under test
when the test imports it directly, so such tasks always need a person's review.

**Never expose `approveDiff` with a Jev reviewer, `reviewTest` or `approveMerge` on an
MCP or agent route.** They sign for any in-process caller: `approveDiff(taskId, jev)` and `reviewTest` are
written by the gate's own key, and `approveMerge(taskId, person)` is signed with
that person's key, so whoever can call them approves. Only the app's own person-facing
flows (the person approving in the UI, or the gate after it has Jev's verdict from
Jev itself) may call them. Any route an agent can reach must refuse them, and
`core/` routes need a test proving it.

This list is a heuristic and cannot be complete: a test can read files by
computed paths, spawn programs, load plugins by name or depend on environment the
gate does not trace. It decides only whether Jev alone may approve the diff. The
backstop is the person's signed merge approval, which every merge needs: the
person approving a merge should look at the whole diff, not only the files flagged
here.

`.perfect-planner/` holds the ledger and worker tokens and is never committed.
The gate adds it to `.git/info/exclude` when it runs, `prove` refuses a commit whose
index has anything under it (a `git add -f`, say), and `mergeAndVerify` refuses a
branch where any commit since it left the integration branch touched it, even if a
later commit removed it again.

The task's own `node_modules` is never used for the merge check, because it is
ignored by git and a worker could edit it unseen. When the candidate's package
files match the integration checkout's, that checkout's `node_modules` is linked
in (a junction on Windows); otherwise a clean `npm ci` (or `npm install` without
a lockfile) runs in the candidate. `prepare(candidateDir)` replaces this. The link
is removed before the candidate, so the real dependencies are never deleted. The
test still runs code, so it could write through the link; the gate does not
sandbox it.

Test commands run through the platform shell; on timeout the whole process
tree is killed (`taskkill /T /F` on Windows, process group kill elsewhere).
They see only an allow-listed environment (`TEST_ENV_ALLOW`: PATH, temp and home
folders, locale and similar), so API keys and tokens in the user's shell never
reach agent-written tests; extra variables must be passed explicitly.

Only a clean non-zero exit proves the test fails first. A timeout, a crash, or a
command that could not start is recorded as an inconclusive baseline (`data.conclusive: false`) and the task cannot start.
Before running, the gate looks the program up on PATH (and PATHEXT on Windows) in
the test's own environment, so a missing program is caught without relying on the
shell's exit code or its localised error message; exit 126/127, 9009 and cmd's
"is not recognized" are still treated as not run.

## Entries written

| Entry | When | data |
|---|---|---|
| `test.defined` | `define` | `{ test }` |
| `test.failed` / `test.passed` | baseline, worktree and merge runs | `{ test, definition, phase, afterMerge, commit }` |
| `review.verdict` | Jev on the test (`scope:test`, written by the gate), a diff approval or rejection (`scope:diff`), a person's merge approval (`scope:merge`) | `{ scope, verdict, ... }` |
| `test.approved` | `approve` | `{ test, definition }` |
| `merge.done`, `task.done` | `mergeAndVerify` pass | `{ commit, ... }` |
| `task.reopened` | `reject` | `{ attempt, notes }` |

Evidence mirrors the data as `kind:value` strings (`test:`, `definition:`,
`phase:`, `commit:`, `exit:`, `duration-ms:`).
