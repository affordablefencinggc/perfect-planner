# core/gate — the acceptance-test gate

Enforces specs 5.1–5.5, 6.2 and 2.4: a task cannot start until its done-when
test exists, is approved by a person and then fails on the current code, and
cannot finish until that exact test passes after merge. The gate is stateless; every answer is
replayed from `ledger.entries()` (`deriveState`).

## Lifecycle

```
define -> [Jev verdict] -> approve (a person; pins the test files) -> confirmFailsFirst (must FAIL) -> canStart
  -> worker commits -> prove (runs in the worktree at HEAD, must be clean, test files unchanged)
  -> diff review: approveDiff (Jev or a person) -> mergeAndVerify (a person) -> test.passed (afterMerge), merge.done, task.done
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

`task.done` is written by the gate only (actor `system:gate`, with `data.approvedBy`
naming the person who merged); `gateRule()` refuses it from anyone else.

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
await gate.mergeAndVerify(taskId, { repoRoot, branch, integrationBranch, actor, prepare? })
gate.reject(taskId, reviewer, notes, { verdict? }) // { ok, newTaskId }; cites an existing verdict if given
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
It merges only when the branch tip has an approving diff verdict, and the merge
actor must be a person. When the diff touches package files (package.json,
lockfiles, .npmrc), tool configuration (`*.config.*`, tsconfig, rc files) or test
support (tests/, helpers/, fixtures/, mocks/, `*.test.*`, files beside a pinned
test), Jev's approval is not enough: a person has to approve that diff.

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
| `review.verdict` | Jev on the test (`scope:test`), or a diff rejection (`scope:diff`) | `{ scope, verdict, ... }` |
| `test.approved` | `approve` | `{ test, definition }` |
| `merge.done`, `task.done` | `mergeAndVerify` pass | `{ commit, ... }` |
| `task.reopened` | `reject`, written by the gate (system) | `{ attempt, notes, verdict }` |

Evidence mirrors the data as `kind:value` strings (`test:`, `definition:`,
`phase:`, `commit:`, `exit:`, `duration-ms:`).
