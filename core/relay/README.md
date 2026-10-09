# core/relay — the one-chat relay (spec §4.2, §4.3, §4.5)

A worker's question gets the next `Q-n` and lands in its person's main chat.

1. An earlier decision with the identical question (case, punctuation and
   option order ignored) answers it at once: `question.answered` by the system,
   citing the `D-n`.
2. Otherwise an optional `SettledAnswerer` may answer: `JevReviewer` does so
   only for multiple-choice questions, only from the approved plan's clauses,
   and only at or above its approve confidence.
3. Otherwise it waits in `digest(person)`: open questions, blocking first, plus
   what was answered automatically since the last check.
4. `answer(main, person, Q, text)` writes `decision.made` (`D-n`, with the
   question key so step 1 can reuse it) and `question.answered`, then wakes any
   `waitFor(Q)` and queues the answer for `answersFor(worker)`.

A blocking question pauses only its asker (`blockingFor`). `pauseAll` writes one
`task.blocked` per active task with `data.pauseAll`; `resumeAll` writes
`task.progress` with `data.resumeAll`. All state is rebuilt from the ledger on
construction and kept current through `ledger.subscribe`.
