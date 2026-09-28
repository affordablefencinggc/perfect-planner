# Perfect Planner foundation gap audit

Status: clean-room architecture audit, 2026-09-03  
Reference: `danielsivyer4567/perfect-planner-desktop` (read-only inspection through the signed-in GitHub page)  
Safety rule: the reference repository is untrusted input. No source, package configuration, executable, build artifact, or history is imported or run. Requirements below are independently rewritten from observed behavior.

## Brutal truth

The current clean-room project is a strong planning demonstrator with unusually broad deterministic engines and tests. It is not yet the finished desktop control plane.

Its largest missing foundation is a native authority boundary. Today the shipped surface is React/Vite/Sites, while privileged work is implemented mainly as JavaScript/Node modules or represented by UI fixtures. A browser cannot be trusted to grant filesystem access, launch bounded processes, hold OS secrets, supervise workers across restarts, arbitrate concurrent writers, or sign and update a desktop application.

The correct direction is not to copy or port the old application wholesale. Keep the current React interface and clean-room engines. Add a thin Tauri/Rust authority layer behind typed, deny-by-default commands, then replace fixtures one authority at a time.

## What is already real

| Address | Foundation | Current truth |
|---|---|---|
| FND-00A | Clean-room rule | Present: the ledger explicitly forbids copying executable/source material. |
| FND-00B | Product map and stable numbering | Present: five-stage journey, Index, component dossiers, Mermaid atlas, B/T/C/F/SRC references. |
| FND-00C | Deterministic planning engines | Present: blueprint, rulebook, architecture, folder, collision, allocation, proof, debt, CI derivation, evidence, and release calculations have focused tests. |
| FND-00D | Local development authorities | Partial: guarded same-origin Node transports, atomic stores, locks, journals, session registry, proof runner, screenshot evidence, identity vault, and draft mailbox exist. |
| FND-00E | Operational UI | Partial: Plan, Blueprint, Structure, Components, Index, Ledger, Integrity, Evidence, and Release surfaces exist, but significant runtime data remains fixture-backed. |
| FND-00F | Static release | Present but deliberately limited: a verifiable Sites package exists and correctly does not claim native authority. |

## Missing or incomplete foundations

### 1. Native trust boundary — P0

| Address | Requirement rewritten as a clean-room contract | Current state | Completion proof |
|---|---|---|---|
| FND-01A | Create the Tauri desktop shell around the existing React client without moving business rules into the UI. | Partial: minimal Tauri shell and unbundled release compilation exist; installed-app launch proof remains | Windows app launches the production client with no development server. |
| FND-01B | Define a versioned shared command/result schema for every privileged operation; reject unknown fields and schema versions. | Partial: the runtime-snapshot seam is exact and versioned; every future privileged command still requires its own schema | Contract tests exercise valid, stale, malformed, and future-version messages. |
| FND-01C | Expose only exact Tauri commands; deny wildcard filesystem, shell, process, network, screen, updater, and device permissions. | Partial: the first capability permits only `runtime_snapshot`; no privileged command exists yet | Generated capability files and native tests prove every undeclared operation is denied. |
| FND-01D | Enforce path containment, canonicalisation, link refusal, byte/time/process ceilings, exact executable identity, and no-shell invocation in native code. | Node implementation only | Native adversarial tests cover escapes, aliases, links, injection, overflow, timeout, and child fan-out. |
| FND-01E | Apply a strict desktop CSP and security headers: no remote script, object, base, unsafe evaluation, arbitrary connect, camera, microphone, geolocation, USB, or payment access. | Partial: strict local-only CSP and disabled device policies are configured and tested; packaged WebView inspection remains | Packaged WebView security inspection matches the frozen policy. |
| FND-01F | Store secrets and device identity in the OS credential vault; the UI receives opaque handles and redacted receipts only. | Partial Windows/Node custody | Restart and memory-boundary tests show raw secrets never enter browser state, logs, journals, or bundles. |
| FND-01G | Add native database/journal migrations with monotonic schema versions, backup, crash-safe atomic replacement, and downgrade refusal. | Partial file stores | Kill/restart and old-schema fixtures recover without fabricated green state. |
| FND-01H | Add structured native diagnostics, redaction, crash reports, retention, and user-controlled export. | Missing | A simulated crash produces a secret-free support bundle linked to exact app/run versions. |

### 2. Runtime authorities — P0

| Address | Requirement rewritten as a clean-room contract | Current state | Completion proof |
|---|---|---|---|
| FND-02A | Discover approved local plan/board endpoints from a bounded range or registry without spawning competing servers or trusting page-origin requests. | Missing | Native discovery accepts exact localhost identity and refuses foreign host/origin/PID substitution. |
| FND-02B | Register repository/workspace roots explicitly and bind every plan, worker, file claim, branch, and proof artifact to a canonical project identity. | Partial: native app-local canonical registration now requires explicit approval and refuses silent workspace-ID rebinding; downstream plan/worker/proof binding remains | Restarted app reconstructs the same identities and refuses moved/substituted roots until re-approved. |
| FND-02C | Supervise worker sessions with durable heartbeats, ACTIVE/STALE/GONE states, grace periods, monotonic fencing, reaping, sleep/resume handling, and recovery events. | Node store exists | Two processes plus crash/restart prove stale owners cannot resume or release a newer lease. |
| FND-02D | Perform a native, metadata-only, read-only repository census through expiring, run-bound, single-use capability. | Partial: native registered-root census now has fixed file/per-file/total-byte ceilings, refuses links, hashes eligible files, and returns no contents; expiry and single-use run tokens remain | Capability replay, expiry, identity change, unsupported claims, and partial census all fail closed. |
| FND-02E | Canonicalise exact-file, directory-tree, resource, API, database, and physical-alias claims before comparing them. | Engine exists | Cross-platform collision fixtures produce identical canonical keys and no caller-controlled authority. |
| FND-02F | Make collision decisions durable, immutable, census-bound, hash-chained, compare-and-swap protected, and independent of browser storage. | Node authority exists | Native concurrent claimant tests prove only one exact revision commits. |
| FND-02G | Issue conflict tickets naming both plan/node identities, evidence, disposition, order, expiry, and resolution authority. | Partial model/UI | Ticket replay, fabricated approval, changed census, and missing participant approval are refused. |
| FND-02H | Implement the orchestrator run state machine: create, preflight, dependency-ready, claim, heartbeat, validate, reconcile, release gate, deliver, blocked, failed, completed. | Planning models only | Native end-to-end run survives restart and cannot skip a state or exceed attempt limits. |
| FND-02I | Bind every node claim to allowed files, dependencies, worker identity, lease token, attempt number, baseline, and current policy digest. | Partial | Wrong worker/file/baseline/policy/lease submissions remain uncommitted and visibly blocked. |
| FND-02J | Implement a durable local control-plane outbox/inbox with claim, retry, acknowledgement, dead-letter, idempotency, expiry, and delivery receipts. | Missing | Crash at every delivery transition produces one logical message and an auditable final disposition. |
| FND-02K | Implement the approval bridge separately from connectors; release admission only after verified delivery/acknowledgement to the registered originating identity. | Missing | Route expiry, revocation, task mismatch, identity mismatch, retry, and duplicate delivery are tested. |
| FND-02L | Keep connectors/MCP adapters transport-only: they may carry drafts or evidence but cannot expand capability, approve work, resolve collisions, or mark completion. | Policy mapped | Fake connector fixtures cannot alter authoritative state without a valid native command and receipt. |

### 3. Project, file, and edit authority — P0/P1

| Address | Requirement rewritten as a clean-room contract | Current state | Completion proof |
|---|---|---|---|
| FND-03A | Make the numbered folder contract the authoritative planned structure before build begins. | Engine/store/UI exist | Native app publishes and reloads an exact approved revision. |
| FND-03B | Materialise approved folders parent-first through an explicit human operation; never invent files, jump waves, or mutate outside the selected root. | Engine only | Disposable project test proves exact created paths and safe rollback receipt. |
| FND-03C | Enforce distinctive domain naming, glossary ownership, reserved terms, stable aliases, and semantic collision checks (`user-action-audit` versus `job-site-audit`). | Partial | Ambiguous names block publication with suggested domain-qualified alternatives. |
| FND-03D | Enforce per-node read/write/create/delete scopes; a plausible but unplanned filename is still denied. | Policy/claims partial | Wrong-file and near-name mutation tests are killed before the write boundary. |
| FND-03E | Index every accepted file, folder, interface, decision, proof, screenshot, person, task, dependency, and outcome as it is created. | UI index/registries partial | One search resolves the current canonical record and all historical aliases without filesystem rescans. |
| FND-03F | Add a stoppable desktop-lifetime watcher with batching, stable IDs, deletion/restoration, rename handling, ignored roots, link refusal, and backpressure. | Engine watcher partial | Large rename/delete/recreate campaign reconciles once without duplicate ownership. |
| FND-03G | Support Git mode, private local mode, and hybrid mode behind the same plan/claim/proof contracts. Git is an adapter, not the authority. | UI/contract only | The same two-worker collision scenario passes in Git and no-Git fixtures. |
| FND-03H | Finish encrypted draft exchange for no-Git collaboration: recipient keys, bounded mailbox/file transport, one-time acceptance, expiry, revocation, and redacted receipts. | Cryptographic Node flow exists | Two OS identities exchange a plan draft while unauthorised identities and replay fail. |
| FND-03I | Add safe import/export and project backup: signed/hash-manifested bundle, schema migration, duplicate detection, and explicit conflict resolution. | Evidence bundle only | Fresh-machine restore reproduces identifiers and refuses altered or older authoritative state. |

### 4. Proof, evidence, and release — P0/P1

| Address | Requirement rewritten as a clean-room contract | Current state | Completion proof |
|---|---|---|---|
| FND-04A | Capture screenshots through current Chrome and Edge transports using isolated disposable profiles, exact targets, bounded settling, pixel validation, cleanup, and hashes. | Node workflow; no live adapters | Both browsers produce fresh accepted proof; reused sessions, blank frames, stale files, and target changes fail. |
| FND-04B | Keep capture separate from human viewing; use named, short-lived, one-time challenges bound to exact bytes and a concrete observation. | Workflow/UI exist | Wrong viewer, replay, expiry, changed bytes, and unchecked gesture cannot attest. |
| FND-04C | Run approved verification commands directly without a shell and distinguish local bounded proof from production OS-isolated proof. | Node runner exists | Native platform adapter proves exact memory, CPU, process, timeout, environment, and output ceilings. |
| FND-04D | Derive CI gates from bounded workflows, query exact provider/repository/ref/SHA/check identities, and leave absent/unsupported truth grey. | Derivation and injected adapter exist | Live approved-provider fixture matches exact SHAs and redacts credentials. |
| FND-04E | Rehearse the intended merged state in an isolated disposable worktree and preserve a recovery receipt when cleanup cannot complete. | Node implementation exists | Real selected Git project proves conflict, success, cleanup, and retained-recovery paths. |
| FND-04F | Hash-chain evidence records for before/after/verification screenshots, command output, diff, OCR, console, network, files, logs, approvals, and reviewers. | Partial journals/bundles | Any removal, reordering, substitution, or mismatched identity breaks verification. |
| FND-04G | Compute completion as a conjunction of current task state, current collision census, valid leases, exact proof, human attestations, CI, review, and delivery—not rounded percentages. | Engine/report partial | One stale prerequisite changes release from green to blocked with the exact reference. |
| FND-04H | Produce a self-contained, read-only completion/handover bundle with manifest, open work, failures, evidence, diffs, screenshots, provenance, and verification instructions. | Bundle exists | Independent offline verifier detects one-byte alteration and can identify every unresolved item. |
| FND-04I | Implement release packaging, Windows code signing, provenance/SBOM, signed updater, rollback channel, migration compatibility, and release CI. | Missing | Clean-machine install/update/rollback verifies signatures and preserves/rejects data according to policy. |

### 5. Real UI wiring and operator recovery — P1

| Address | Requirement rewritten as a clean-room contract | Current state | Completion proof |
|---|---|---|---|
| FND-05A | Replace fixture authority data with typed query adapters and explicit loading, unknown, denied, stale, empty, error, and recovered states. | Mostly fixture-backed | Disconnect/restart/denial tests never display fabricated zero or green. |
| FND-05B | Make the orchestrator feed display real worker events, decisions, delivery receipts, failures, and next safe action; keep it closed until clicked. | Visual behavior only | A native run updates the feed and survives app restart without duplicating events. |
| FND-05C | Bind worker animation to authoritative state: running legs only with a live lease, green trail only from accepted progress, full lap only after verified completion. | Visual behavior only | Lease expiry freezes the worker and prevents the success lap from closing. |
| FND-05D | Make every card and percentage traceable to its canonical record, owner/model/session, touched files, dependencies, screenshots, diffs, errors, CI, and approval receipts. | Partial | Selecting any visible metric opens the exact source dossier. |
| FND-05E | Add permission and recovery UX for root registration, secret access, screenshot capture, process proof, folder creation, connector login, stale locks, retained worktrees, and failed migrations. | Missing | Each denial has a safe explanation and retry path without broadening authority. |
| FND-05F | Add truthful global runtime health: app/native versions, schema, connected authorities, watchers, active runs, queued delivery, stale sessions, storage, and update channel. | Partial visual metrics | Health screen is sourced only from signed/native snapshots and marks unavailable data unknown. |
| FND-05G | Preserve the clean, spacious chrome/beige visual system while meeting keyboard, focus, screen-reader, reduced-motion, contrast, zoom, and responsive requirements. | Partial | Automated accessibility plus keyboard and 200% zoom visual proof pass all core workspaces. |

### 6. Certification and operations — P1/P2

| Address | Requirement rewritten as a clean-room contract | Current state | Completion proof |
|---|---|---|---|
| FND-06A | Add Rust unit/contract tests for every native command and pure admission predicate. | Missing | Native test suite has explicit success and refusal cases for every command. |
| FND-06B | Add desktop integration tests covering WebView-to-native IPC, restart, crash, sleep/resume, multi-process contention, permission denial, and upgrades. | Missing | Packaged-app suite passes on supported Windows versions. |
| FND-06C | Extend mutation testing from predicates to native authority implementations and state transitions. | Predicate campaign exists | Deliberately weakened capability, lease, collision, journal, and release checks are killed. |
| FND-06D | Maintain an adversarial hazard matrix for path aliases, symlinks/junctions, case folding, stale identities, PID reuse, replay, clock changes, partial writes, and corrupted storage. | Partial | Every hazard links to a numbered test and expected fail-closed result. |
| FND-06E | Define performance budgets for startup, index/search, census, large plans, watchers, screenshots, proof commands, memory, and bundle size. | Rulebook only | Benchmarks run in release CI and regressions block promotion. |
| FND-06F | Define support, privacy, retention, deletion, telemetry-off default, incident response, dependency review, licence review, and vulnerability disclosure. | Partial policy | Release checklist links each policy to its enforcing code/test or marks it unimplemented. |
| FND-06G | Support at least Windows first with an explicit compatibility matrix; keep macOS/Linux unknown until their native adapters, signing, path rules, and tests exist. | Missing | Release UI and metadata never imply an untested platform. |

## Recommended build order

1. **Wave 1 — shell and contracts:** FND-01A through FND-01H. Freeze IPC schemas and capability policy before wiring features.
2. **Wave 2 — identities and truth stores:** FND-02B, FND-02C, FND-02D, FND-02F, FND-03A, FND-04F.
3. **Wave 3 — coordination:** FND-02E, FND-02G, FND-02H, FND-02I, FND-02J, FND-02K, FND-02L.
4. **Wave 4 — project operations:** FND-03B through FND-03I, including the no-Git/private draft path.
5. **Wave 5 — proof and release:** FND-04A through FND-04I.
6. **Wave 6 — replace fixtures:** FND-05A through FND-05G. No presentation should claim more than the authorities can prove.
7. **Wave 7 — certify:** FND-06A through FND-06G, then clean-machine release rehearsal.

The first implementation slice should be intentionally small: launch the current client in Tauri, expose one versioned `runtime_snapshot` command, add deny-by-default permissions/CSP, and prove that the static client cannot call an undeclared native operation. That establishes the trustworthy seam every later authority needs.
