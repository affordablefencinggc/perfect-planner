# F02 — task outcome contract proposal

Status: draft for implementation/review; not a current protocol or acceptance claim.

## Existing seam

`src/node/proofRunner.mjs` creates a hashed proof artifact and appends a prove event after completion. Its planId/itemId, exit and artifact hash are useful inputs, but cannot establish exact current task accounting: no ledger revision, candidate content identity, immutable acceptance-set identity, admitted attempt record, or durable interrupted-attempt state is carried through this path. Do not replace these existing checks or present the UI's local draft as an approved execution grant.

## Required authoritative binding

Each admitted attempt must capture a validated project/registered-root identity, immutable ledger revision and digest, numbered task ID and task-spec digest, candidate tree/content digest, acceptance-set digest, attempt ID/number, authenticated producer/session and grant reference. The host resolves paths and executable/check definitions; browser and worker requests do not supply arbitrary executable or storage authority.

Define exact serialized schemas before coding. Use existing project IDs and canonical hashing conventions. Distinguish transport source claims from authority-verified provenance; a caller-provided `trusted: true` is not evidence.

## Lifecycle

1. Persist admission with the exact required check IDs before execution can begin.
2. Record started attempt and producer identity. If recording fails, do not execute.
3. Record each check outcome and artifact digest, including nonzero exit, timeout, denied execution and cancellation. Never turn missing output into exit zero.
4. Terminal attempt verdict is verified only when every required check has a matching accepted result for the same binding and required cleanup is proved. Any required failure prevents verification. Missing/corrupt/conflicting records retain an explicit unresolved outcome.
5. After restart, admission without a proved terminal result is interrupted/unverified. A heartbeat cannot close it. Reconciliation may inspect the original process/candidate; it cannot infer success from absence of a process.
6. Retrying creates a new immutable attempt. Older failures remain visible. While retrying, show running plus prior failure history, not a falsely final success. A new task/candidate/acceptance revision invalidates applicability of older success.

Persist append-only events with exact sequence and prior-hash validation using reviewed store primitives. Confirm the reused store's confinement, crash/partial-write and concurrency properties rather than assuming them from a hash chain. No cleanup is implicitly authorized.

## UI projection

Projection inputs are the immutable displayed task population and a validated receipt collection for its binding. Output one mutually exclusive current category per active task: pending, running, verified, failed, blocked or unverified. Archived tasks are separately counted, with their history retained. Total must equal the sum of those six categories; missing receipts must never reduce the denominator.

Define and test precedence for duplicate/conflicting records, stale candidate results, expired grants and retry attempts before wiring the UI. Invalid authority or missing coverage cannot be accepted as a definitive failed/verified count. Display historical errors separately from current attempt verdicts.

A failed task detail must contain: task number/name; observed failing check and result; original project/revision/candidate/attempt; evidence reference; known cause with evidence or `unknown`; accountable owner; expected next action; and preservation status (verified location, claimed plan or unknown, never conflated).

## Integration sequence

- C018/authority: validate admission and extend the actual runner's lifecycle without widening command permissions.
- C031/native service: expose bounded project-bound receipt reads with cancellation, provenance and error redaction.
- C038/workflow: validate receipt applicability against the ledger and project an exhaustive outcome list.
- Shell/Operations single writer: connect the projection, immediately surface unresolved tasks, and link task details/history. Generic logs remain diagnostic-only.

## Acceptance cases

155 admitted numbered obligations; controlled actual executions produce 154 complete acceptance sets and one nonzero required check. Totals reconcile and the failure is visible without log searching. Retry the failed obligation, retain its original failure, then establish 155 verified only after the new complete acceptance set passes. Repeat with restart between admission/start/result, conflicting duplicate, wrong project, changed task revision, changed candidate, partial result persistence, missing required check, output limit, timeout and cancellation with unfinished cleanup.

No synthetic receipt injection alone closes F03/F04. Schema/unit fixtures are supporting evidence; the required acceptance journey uses the real runner, durable store, transport and UI.
