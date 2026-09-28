# Native session lifetime — required reliability repair

Status: baseline reproduced on DANS1 (Work453); successor storage primitive qualified (Work454), not integrated. The runtime repair remains open.

## Work454 — qualified primitive, not installed behavior

Work456 adds MigratedStore for existing legacy journals. Native composition derives the project from exact rootIdentity; migration validates every legacy record and transition, rejects duplicate/missing fields and partial/empty journals, retains the legacy exclusive lock throughout use, and binds the immutable import to the complete original bytes. Pending BEGIN and outstanding original/digest are preserved. Legacy bytes are checked before/after successor writes; changed legacy history is refused rather than reset. No legacy files are rewritten or removed. Missing/new-project admission remains separate and unimplemented here.

DANS1 Work456c: 61 Node +92 Rust tests pass, including five migration tests with an actual legacy Guard journal at510 records, continuation/reopen, pending preservation, old/new lock contention, malformed history and subsequent legacy changes. Work456 failed because a second handle could not read Windows-locked bytes; Work456b fixed product validation to read through its owning handle, but one test comparison still read before releasing the lock. Work456c corrects that test ordering. Both failed evidence directories remain intact. Final evidence ../../perfect-planner-remote-evidence-20260905/native-store-migration-456c/results.json; overlay1559e36e973b26ce967c82bb492f2d4fb59b2cbf693e52ba42ea1bf24ba0e1f1.

Migration is still not wired to runtime admission or DiagnosticSession. Next: new-project admission, terminal-write reservation and diagnostic lifecycle integration, then real native command/restart/disk/concurrency and installed-app qualification. This does not repair the installed limit yet or prove power-loss durability.

Work455 adds explicit rootIdentity to the imported state, current index and every event, and validates it before any store creation and on every record load. Three new DANS1 tests prove invalid identity creates no store, a different identity cannot reopen or mutate existing history, and a substituted foreign-root head/event cannot be adopted. Selected regression: 61 Node +87 Rust tests pass. Evidence ../../perfect-planner-remote-evidence-20260905/native-store-binding-455/results.json; overlay f7b08130989e8f1c32a7490eea8c2446dd331ed2340873fe95a6d8cee94b4010. Root binding is implemented in the primitive only. Guard/diagnostic integration, legacy migration, terminal reservation and installed qualification remain open. Existing unbound Work454 test artifacts are preserved and are not automatically migrated or accepted.

`native_session_store.rs` retains an immutable imported state and hash-linked event files, with a small replaceable current-state index and an exclusive owner lock. Seven disk-backed tests pass on DANS1: 300 BEGIN/SETTLED cycles with reopen (600 events), preserved original request/digest, interrupted index publication, concurrent opens, partial successor retention, corrupt/missing import handling, and explicit historical corruption detection. Selected regression total: 61 Node +84 Rust tests, zero failures. Evidence: ../../perfect-planner-remote-evidence-20260905/native-store-454/results.json and logs. Overlay SHA-256: 4892e47e4599acf90c5181241ded2c00d31c537200a58505445e4358537ec8f9.

Ordinary open verifies current state and its immediate predecessor, not all historical files; `audit_history` is the explicit full-chain check. Simulated interruption after event persistence is not power-loss durability proof. The primitive is not called by Guard or DiagnosticSession, and the installed binary is unchanged.

Next integration gates: bind the exact root identity explicitly; validate and preserve the entire legacy journal before migration; migrate diagnostics without deleting evidence; reserve terminal-write capacity before dispatch; qualify restart, disk-full, concurrency and original-request recovery through actual Guard paths. Then package and test the installed native app. Do not mark the 255-read lifetime defect fixed from primitive tests.

Measured:255 normal result reads succeed; read256 returns NATIVE_DRAFT_SESSION_LIMIT before dispatch. The journal contains510 records/81,880 bytes and510 diagnostic files; the run took48,434ms with controlled supervisor receipts. A separate case retains the original request/digest through254 reads after its initial obligation, but the ceiling also refuses reopening that exact original. Repeated reads cannot clear an unsettled BEGIN.61 Node and80 Rust tests pass, including these known-defect assertions; a test PASS here does not mean acceptable lifetime capacity. Evidence ../../perfect-planner-remote-evidence-20260905/native-capacity-453/results.json and native_draft_commands.log.

## Problem and ownership

`native_draft_commands.rs` owns the shared native session journal and diagnostic files. Draft inspection/submission, check preparation and historical result reads all consume this store. `native_task_result_commands.rs` uses the same guard even for read-only pages. The renderer must not work around limits by selecting another project, resetting storage or opening an untracked host.

Current bounds are510 session records,256KiB journal bytes,510 existing diagnostic entries and roughly2MiB diagnostic bytes. Normal settled requests add BEGIN and SETTLED plus two immutable diagnostic files. Batching reduces consumption but cannot provide a long-lived storage lifecycle.

## Required replacement behavior

1. Separate bounded active recovery state from retained historical evidence. Routine reads must not replay or enumerate every past operation as usage grows.
2. Serialize same-project admission using an owner-held cross-process lock. Keep different projects isolated. Never clear an unresolved BEGIN, outstanding original request or its exact digest to gain space.
3. Preserve existing journal and diagnostic bytes during migration. Validate their complete transition sequence, identity, bounds and outstanding obligation before accepting a successor. Malformed, partially written or conflicting legacy data must remain available for explicit recovery, not be silently reinitialized.
4. Publish successor state atomically with durable readback and an exact link to its predecessor. Restart at every migration/rollover boundary must choose the same authoritative state or refuse safely. Never dispatch between an uncertain predecessor and successor.
5. Admission reserves space for its terminal disposition and diagnostic evidence before starting the host. Disk-full/write/flush failures before dispatch must not launch anything; uncertain failures after dispatch must retain the unresolved operation.
6. Retention is not deletion. Existing evidence stays inspectable/exportable. Any future pruning needs an explicit policy and verified recoverable export; this repair does not authorize removing history.
7. Surface storage pressure separately from task failure or corruption. Explain what is retained, what could not be saved, and the next recovery action. A resource bound must not be displayed as a successful check or a new task verdict.

## Verification required before shipping

- Capture the current ceiling with disk-backed state and controlled supervisor receipts; do not count this as real process execution or installed-app acceptance.
- Run beyond the old ceiling with real file persistence and repeated reopen; prove request accounting and retained history exactly match.
- Preserve an outstanding original through the transition, and refuse mismatched originals afterward.
- Exercise concurrent opens, interrupted BEGIN, partial writes, missing successor records, corrupted legacy history, duplicate publication, lost reply and restart.
- Measure per-request storage work at increasing history sizes, not just a single successful rollover.
- Rebuild the actual native host package and run installed Tauri through the same paths. Keep controlled transport tests separate.

Work454 is the candidate storage format, not acceptance of the full lifecycle. A larger hard-coded ceiling alone does not satisfy these requirements.
