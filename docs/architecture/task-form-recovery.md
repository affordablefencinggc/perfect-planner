# Unfinished task editor recovery

Status: storage prerequisite254, single-tab connection255, two-tab recovery256, explicit saved-editor reconciliation257 and ordinary Save/Discard SPA navigation258 are verified in their recorded scope. UI258 passed375 Node/227 UI tests and347 browser operations each for Save and Discard on identical source. Memory-level pending ownership and explicit outcome review do not prove durable process crash/power-loss recovery, all multi-tab interleavings or native release. Latest evidence: `C:/repos/perfect-planner-remote-evidence-20260905/ui-task-form-258-save/README.md`.

## Preserve intent without approving it

### UI259 original Save contract (implementation in progress)

A checkpoint is not evidence that Save was requested. New Saves need a distinct durable original request in the existing draft database, retaining request identity, full binding, original base Ledger, parsed task and exact checkpoint. Acknowledged preparation precedes dispatch. Ledger revision, head and the original receipt commit atomically; retries use that original identity, never a newly generated task request. A matching historical task alone cannot establish attribution.

The additive database upgrade preserves legacy records without inventing intent for them. Reads validate exact records and bindings; failed/corrupt reads block recovery mutations and approval while leaving export available. Completed originals remain retained. Explicit withdrawal of an uncommitted request must be a durable terminal transition serialized with commit, so a delayed caller cannot save it afterward. Editor reconciliation is separately acknowledged only after exact history readback; it does not rewrite a peer's terminal disposition. Current-parent edits and historical receipt reads are distinct: a saved original can be inspected after successors, but an uncommitted request cannot silently adopt a different census or base.

Connected UI acceptance, still open: startup reads all same-root originals (including older inventory), with a loading/error gate before restore, reapply, new Save or approval. Normal Save creates a stable ID before preparation and retains that ID across uncertain replies. There is no fallback to legacy `saveTask` when the durable API is unavailable. Retry uses the original stored request, not visible edited fields. Pending original offers explicit retry or withdrawal; committed original offers exact historical reconciliation; withdrawn original closes its captured checkpoint without erasing raw text. Export remains available throughout. Mutation buttons cannot bypass a still-pending SPA operation. Storage notifications trigger checked reads, not success claims.

After asynchronous reconciliation the UI must recheck mount, project binding and exact captured form identity before clearing visible text. A different/newer form remains untouched. Reconciliation is allowed to finish and retain durable acknowledgment while a page is absent. Legacy unfinished forms without an original Save request stay labelled as legacy recovery with no invented attribution. Before/after proof must repeat the real new-task postcommit reload, show its exact original receipt, preserve task count and both histories, and explicitly restore a writable editor without submitting a new task.

Current storage bound is32 retained originals and64MiB per project scan with terminal capacity reserved. Reaching the bound refuses safely; it does not prune history. A preserve-first capacity/retention workflow remains a usability obligation before full-app completion. Browser storage is not a backup, protected authority or proof of power-loss survival.

Unresolved integration case: the exact-next-terminal acknowledgment cannot finish an original checkpoint1 Save once the same editor has advanced to checkpoint2. Do not relax exact evidence or discard newer text. Add an explicit newer-editor-preserved acknowledgment after validating the complete recovery history, exact original checkpoint, retained later checkpoint and committed Ledger receipt (or immutable withdrawal). It closes only the original Save request, not the newer editor or its approval blocker. Reserve bounded space for this evidence before dispatch. Forking later input can prevent future overlap but is not a recovery path for existing records.

UI256 qualification added375 Node/196 UI test executions and303 real browser operations on identical source. Isolated unfinished-only approval refusal and real same-context two-tab copy/stale-save/reapply/isolation passed. UI257 subsequently repairs the save-versus-peer-discard reconciliation loop, with scoped evidence below. Process crash/power-loss and native release are not proved.

The saved task Ledger remains the task record. Recovery stores a separate unfinished editor form, including whitespace and incomplete file-scope or dependency text that cannot yet pass task validation. A checkpoint is not a saved task, approval, completion or backup. Never enter credentials; local browser storage may be cleared or evicted.

Each editor session has its own unpredictable ID and immutable, bounded checkpoint history. Every checkpoint includes exact project/root/census, base Ledger revision and a monotonically increasing editor revision. Competing sessions cannot silently replace each other. An expected-revision mismatch refuses rather than merging or discarding text.

Explicit saved/discarded/superseded disposition appends a terminal checkpoint retaining the full form. These reasons record caller intent; they do not independently prove a Ledger save. A terminal editor ID cannot resume writing. No automatic pruning or deletion at quota limits is allowed.

The first implementation is bounded to 256 checkpoints and 4 MiB per project/root, with room reserved for terminal dispositions of unfinished sessions. Callers must coalesce pending keystrokes rather than append an immutable snapshot for every keypress. A durable acknowledgment applies only to the exact checkpoint read back. The UI must explain uncheckpointed text, storage limits and export; this bound is not a promise of unlimited editing history.

## Connected UI acceptance

1. Inspect recovery before reporting the editor safe or allowing approval. Never persist an initial blank form over retained work.
2. Present retained unfinished sessions with base revision and binding. Restore is explicit and makes the editor dirty. Export remains available without restoring.
3. Old-census work stays readable and exportable. Never silently rebind it or reuse its expected Ledger revision. Different roots/projects remain isolated.
4. Checkpoint changed text in order. Show a saving state until committed readback; failure retains visible text and an explicit warning. Do not claim an unsaved keystroke is recoverable before acknowledgment.
5. Restoring a retained session creates a separate checkpointed copy and leaves the original unfinished. Restore must not implicitly terminalize a session that another tab may still be using. Closing an original is a separate explicit disposition of its exact reviewed version, with a warning about other open editors. If a peer closes the current session, retain visible text and show the conflict immediately; explicit continuation forks that text under a new editor ID at the same base Ledger revision, never silently rebasing it.
6. Saving still uses the Ledger's expected revision. Resolve the matching recovery checkpoint only after the Ledger save succeeds. A crash between save and resolution leaves recoverable duplicate intent, not lost text; do not auto-resubmit it after restart.
7. If a newer local checkpoint appears while a save or disposition is pending, do not clear that newer form. Reapplying against a new Ledger revision requires explicit comparison, not an automatic revision bump.
8. Relevant unfinished recovery or an unreadable recovery store prevents a checked approval. A different project's drafts do not block the active project. Historical resolved records are not unfinished obligations.

### UI257 reconciliation acceptance (verified in scope)

DANS1 UI257c passed375 Node/216 UI test executions and322 browser operations. The controlled two-tab completion delay reproduced the old reconciliation loop; the repaired UI verified saved Ledger7, retained the exact discarded checkpoint unchanged and restored a writable editor. Focused tests cover historical successors, unavailable/mismatched readback and unchanged/newer remounts during explicit reconciliation. Ordinary save/discard remount synchronization remains open; this is not full interruption or native-release proof.

A Ledger save and another tab's editor disposition can both succeed. Their receipts record different facts: saving a task does not authorize rewriting an immutable `discarded` editor record. Retain the full returned Ledger snapshot with its acknowledged editor checkpoint until explicit reconciliation completes.

Reconciliation must read that exact historical Ledger revision, validate its full binding and canonical contents against the retained snapshot, then validate the editor identity, exact next terminal revision, raw form and base Ledger revision. A later Ledger successor does not invalidate the historical save and must not be overwritten. Missing, malformed or mismatched readback refuses with visible text retained. An already terminal disposition remains unchanged and is disclosed alongside the proven save. Clearing the local pending editor requires a final identity check after all asynchronous reads; newer text is never cleared. These checks do not make the two stores one atomic transaction or prove survival of power loss.

## Required evidence

UI258 pending-operation acceptance: Save/Discard owns an exact project/root/census and captured form independently of a mounted screen. Navigation must not release that ownership. A returning screen shows the pending action immediately and refuses duplicate mutation. Completed saves retain their exact snapshot/checkpoint for explicit reconciliation; completed discards retain their exact terminal record for acknowledgment. Outcomes remain observable when no screen was mounted at completion. No late callback clears newer text or another binding. This memory-level ownership is not durable restart recovery or proof of power-loss safety.

- Strict shape and byte/count bounds; incomplete raw text preserved exactly.
- Actual IndexedDB reopen after reload, two independent editor IDs, simultaneous same-revision writes with one winner, stale write refusal and terminal history retention.
- Corrupt state refuses without replacing it; quota and blocked-open failures remain explicit. State-changing tests use synthetic data only.
- Actual user typing, reload, explicit restoration, comparison and save through the real UI; stale census/base, multi-tab changes and interrupted save/disposition.
- Matching before/after screenshots and checked source hashes from DANS1. Storage-unit/API evidence alone does not prove the connected editor workflow.
