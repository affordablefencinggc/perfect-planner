# core/relay — the one-chat relay (spec §4.2, §4.3, §4.5)

A worker's question gets the next `Q-n` and lands in its person's main chat.

1. An earlier decision by the same person, with the identical question (case, punctuation and
   option order ignored) answers it at once: `question.answered` by the system,
   citing the `D-n`.
2. Otherwise an optional `SettledAnswerer` may answer: `JevReviewer` does so
   only for multiple-choice questions, only from the approved plan's clauses,
   and only at or above its approve confidence. The ledger lets Jev write only
   `review.verdict`, so the relay writes the answer as the system, citing
   Jev's verdict entry and naming Jev in `data.source`.
3. Otherwise it waits in `digest(person)`: open questions, blocking first.
   Questions answered automatically (steps 1 and 2) also appear there, marked
   `autoAnswered: true`, until the main chat has seen them once.
4. `answer(by, person, Q, text)` writes `question.answered`, wakes any
   `waitFor(Q)` and queues the answer for `answersFor(worker)`. When `by` is a
   person (or the system), it first writes `decision.made` (`D-n`, with the
   question key so step 1 can reuse it). The main chat is an agent, so its
   answers are information only; step 1 only trusts entries that pass
   `isAuthoritative`.

A blocking question pauses only its asker (`blockingFor`). `pauseAll` writes one
`task.blocked` per active task (or every open task when none is active) with
`data.pauseAll`; `resumeAll` writes `task.progress` with `data.resumeAll` for
exactly the tasks it paused. Question and answer text is passed through
`redactSecrets` (core/jev/redact) before it is written. All state is rebuilt from the ledger on
construction and kept current through `ledger.subscribe`.
