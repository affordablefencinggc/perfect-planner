# core/jev — TypeSafe Jev (spec §6)

Jev is TypeSafe's judge (`jev-latest` at `https://api.typesafe.ai/v1/systemone`),
called with the same request shape as Looplet: `state` plus choice
`questions`, answered as `answers[name] = { choice, confidence }`. Jev scores;
Perfect Planner decides with fixed rules (`REVIEW_POLICY = "pp-review-v1"`).

- `reviewTest` (§6.2): rejects a test that does not fail first without calling
  Jev; otherwise asks whether every cited clause is checked and whether it can
  pass trivially.
- `reviewDiff` (§6.3): fixed checks first (files outside `allowedFiles`,
  deleted or weakened assertions, `.skip`/`.only`, secrets), with line notes;
  then Jev on clause coverage, weakened tests and scope.
- Verdicts: `approve` only with no gaps and every answer at or above
  `approveConfidence` (0.8); below `escalateBelow` (0.6) or in between with no
  gaps it is `escalate` (to the main chat, §6.9); a failed call is
  `unavailable`; over the monthly cap it is `queued` (§6.7).
- Independence (§6.4, §6.9): every review names who built the work (`author`,
  with model). Work built by Jev, by the reviewing model (settings or the
  model Jev reports it ran), or by a builder whose model is missing or only
  self-declared (`unverified:`) is never
  approved; it escalates to the main chat (`independenceProblem`).
- Every review writes one `review.verdict` with model, Jev's reported model,
  policy, cost (estimated when Jev does not report one), confidence and notes
  (§6.8). Spend crossing 80% and 100% of `monthlyLimit` writes `budget.warning`.

Everything sent to TypeSafe (diff lines of every kind, file names, test
output, test source, clause and question text) passes through `redactSecrets`
first.

## Reading Jev's reply

What the worker wrote (clause text, test source, diff lines, file names, test
output) is data. Every question starts with `DATA_ONLY`, which says so, and
Perfect Planner never reads a verdict out of free text. A reply counts only
when `answerProblem` finds, for every question, an answer whose `choice` is
exactly one of that question's own choices (`hasOwnProperty`, so `approve`,
`YES`, `"all "` and `toString` all fail), a `confidence` between 0 and 1 (or
none), and a model name. A thrown transport error, a reply of the wrong shape or
a bad answer is recorded as `unavailable` (`malformed` or `request_failed`),
never as an approval and never as spend.

A test longer than `MAX_TEXT` or a diff longer than `MAX_DIFF` is not sent
cut: Jev would vouch for text it did not read, so the review `escalate`s to a
person without a call and says so on the ledger.

## Where it is wired (host layer)

`core/host/routes/tasks.ts` asks Jev when a key is saved: Approve test asks
`reviewTest` once the test is approved and fails first, and Approve diff asks
`reviewDiff` before the person signs. `core/host/routes/jev-review.ts` builds
the inputs (test source, `git diff base tip`, the builder's actor) and the plain
words shown on the Tasks screen. Jev "gaps" on a diff send the task back with
Jev's reasons; every other non-approval refuses the step and says why. Merge
needs a Jev diff approval at that commit and the person's. The Jev call has its
own deadline (`JEV_DEADLINE_MS`), and the monthly cap is the smaller of the
reviewer's own limit and what is left of the person's monthly budget.

## The key (§6.6)

`createOsKeyProvider()` reads the TypeSafe key from the OS secure store, the
same entry PR #2's Settings writes: service `PerfectPlanner/JevReviewerKey`,
account `jev`.

| OS | Store | Tool |
|---|---|---|
| Windows | Credential Manager, generic credential | PowerShell P/Invoke of `CredReadW`/`CredWriteW` |
| macOS | login keychain | `/usr/bin/security` (`-i` for saving) |
| Linux | Secret Service | `secret-tool` (libsecret) |

The key travels only on stdin and stdout, never on a command line. It comes
back as a `SecretKey` that prints, logs and serialises as `[redacted]`; only
the transport calls `reveal()` to build the Authorization header, and error
text is scrubbed. Nothing reads the clipboard or the environment. PR #2's
native side saves on Windows only today; `save`/`clear` here work on all three
and can back the macOS and Linux Settings field until the native side does.
