# core/gate — the acceptance-test gate

Enforces specs 5.1–5.5, 6.2 and 2.4: a task cannot start until its done-when
test exists, fails on the current code and is approved, and cannot finish
until that test passes after merge. The gate is stateless; every answer is
replayed from `ledger.entries()` (`deriveState`).

## Lifecycle

```
define -> confirmFailsFirst (must FAIL) -> [Jev verdict] -> approve -> canStart
  -> worker commits -> prove (runs in the worktree at HEAD, must be clean)
  -> Jev diff review: mergeAndVerify  -> test.passed (afterMerge), merge.done, task.done
                      reject          -> review.verdict, task.reopened (T-14 -> T-14.a2)
```

Redefining a test (a new `test.defined`) voids the baseline, Jev verdict and
approval tied to the previous definition. A reopened attempt (`T-14.a2`)
inherits the test, baseline and approval of earlier attempts; worktree and
merge results, `merge.done` and `task.done` are per attempt.

## API

```ts
import { TestGate, gateRule } from "../gate/index";

const gate = new TestGate({ ledger, timeoutMs?, run?, now? });
ledger.addRule(gateRule());                       // refuses task.claimed until approved (5.1)

gate.define(taskId, command, actor, refs?)        // test.defined
await gate.confirmFailsFirst(taskId, cwd)         // ok only when the test fails today
gate.approve(taskId, owner, { jevVerdict?: "approve" | string[], jev?: Actor })
gate.canStart(taskId)                             // { ok, reason }
await gate.prove(taskId, worktreePath)            // { ok, run, commit } | { ok: false, output }
await gate.mergeAndVerify(taskId, { repoRoot, branch, integrationBranch, actor })
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

Test commands run through the platform shell; on timeout the whole process
tree is killed (`taskkill /T /F` on Windows, process group kill elsewhere).
They see only an allow-listed environment (`TEST_ENV_ALLOW`: PATH, temp and home
folders, locale and similar), so API keys and tokens in the user's shell never
reach agent-written tests; extra variables must be passed explicitly.

Only a clean non-zero exit proves the test fails first. A timeout, a crash, or a
command that could not start is recorded as an inconclusive baseline (`data.conclusive: false`) and approval stays refused.
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
