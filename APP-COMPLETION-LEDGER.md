> Current delivery sequence: [FINISH-LINE-2026-09-27.md](FINISH-LINE-2026-09-27.md). Historical evidence and all detailed acceptance criteria below remain binding.

# Perfect Planner completion ledger

Created 26 September 2026 at the user's request. Owner: Codex. Working source: `C:\repos\perfect-planner-master-audit\candidate459\app`. Test host: **DANS1 only**, through `tonys-test-pc`. This is the current execution queue; historical entries in BUILD-LEDGER.md remain preserved. The full acceptance criteria in FINISH-LINE-EXECUTION-PLAN.md remain binding.

## What completion means

One coherent, identified Windows candidate must support the real journey: select an app folder → connect an IDE agent → submit a plan → see its nodes → review and approve an exact change → run it → inspect the result → recover a failure → retry without losing history → reopen the app with the same truth.

All twelve F-gates must also pass their complete security, preservation, accounting, accessibility and release requirements. A build, test count, screenshot, connected socket or historical receipt does not close a gate by itself. Configuration is not execution; a reported outcome is not verified evidence.

**Current acceptance: 0 of 12 full gates closed. Overall app-completion percentage: not established.** This is not a claim that the app is 0% implemented. Implementation, automated verification and final acceptance are separate. Future progress reports must name completed ledger IDs and their evidence, not estimate completion from passing test counts.

## Current evidence and limitations

| Checkpoint | Observed result | Evidence and limits |
| --- | --- | --- |
| Recovery and onboarding | Complete candidate459 source/runtime recovered; missing-project setup route repaired; 32 focused UI tests and six browser steps passed | `../README.md`, `../evidence/onboarding-after.json`, `../evidence/onboarding-browser-2/results.json`. Earlier candidate only. |
| Native storage repair | Production admission, migrated session store, terminal reservations and bounded diagnostic writes connected | `../evidence/roadmap-01/lifetime-after-2/`: 93 passed, one ignored. Controlled failures; not physical disk exhaustion or sudden power loss. |
| Native Rust inventory | 191 passed, 32 ignored | `../evidence/roadmap-01/native-full-1/`. Ignored/fixture-dependent native acceptance remains open. |
| Storage error presentation | Before/after browser checks passed; error meaning preserved without exposing private native text | `../evidence/roadmap-01/storage-before/` and `storage-after/`; controlled component boundary, not native execution. |
| Actual native read/restart campaign | **PASS: 301 result-page reads, three launches, cleanup complete** | `../evidence/roadmap-01/native-lifetime-2/results.json`. Executable SHA256 `e2bcdf838ebe2ecea6274cd648f5aae464170822ef30d2a39855361b25d2c4fe`; helper manifest `b986cf95ee5b3fe6117c63b642e381d6affbb3babb581e6d95c6563b16a7dca1`. Disposable scripted registration; empty task-result population. Does not prove human picker consent, IDE connection or completed tasks. |
| Broad frontend inventory, first run | Node 1,444 passed, 88 failed, four skipped; UI 484 passed, two failed | `../evidence/roadmap-01/frontend-full-1/`. Git was absent from the runner PATH; other failures include stale fixtures, missing support files, native analyzer drift and atlas ownership gaps. Preserve this run. |
| Repaired broad inventory | **Interrupted / INFRA_FAILURE; not accepted** | DANS1 `C:\Users\danie\Documents\perfect-planner-tests\roadmap-20260926-01\frontend-full-2`. Log ends at test 1201, no final results file, no matching runner process remains. Termination cause/exit code unknown. Preserve output and rerun in a session-independent guarded job; partial successes are not a complete-suite pass. |
| Atlas repair | **Verified bounded ownership acceptance** | Exact ownership and mutation/refusal checks pass in `frontend-full-3`; verifier config moved outside product. No blanket ignore rule. L02 verified; F01 remains open pending final reconciliation. |

The running/finished native campaign above predates adoption of the Fast CDP skill in this chat. Preserve its actual proof scope; do not retroactively claim it met every new campaign-format requirement.

## Execution and status rules

- `OPEN`: acceptance not yet proved. `ACTIVE`: one owner is implementing or verifying it. `WAITING`: an identified external prerequisite is required. `VERIFIED`: the exact bounded acceptance below passed with current evidence. `FAILED`: a required check failed. Parent F-gates remain open until every associated requirement is verified together on the final candidate.
- Codex owns implementation, local source edits, DANS1 staging, tests and evidence. Human actions are limited to genuine native consent, IDE interaction or selected external service setup. They must never be represented by fixture booleans or a scripted approval click.
- Before editing: claim exact files in BUILD-LEDGER.md, preserve before-images, and identify affected ledger IDs. Reuse current work; do not rebuild historical implementations from scratch.
- Run the smallest meaningful before/fix/after campaign, then connected regressions. Run the complete inventory when the candidate is ready. Never relax an assertion simply to obtain PASS.
- Every failure records the first failing invariant, known cause or `unknown`, retained attempt/evidence, owner and next action. Fixes receive a new evidence directory; never overwrite the failed run.
- Final acceptance needs source hashes, executable/helper hashes, test results, meaningful screenshots and a scoped change report. Historical evidence is background unless exact relevant bytes and runtime dependencies still match.
- Run one active write owner per file. Independent final review is required; do not claim self-review as independent review.

## Ordered work ledger

Owner is Codex unless the row explicitly names a human or independent reviewer. Dependencies name task IDs; the F-gate dependencies in the original roadmap also apply. Every OPEN row requires inspection of existing implementation before deciding whether it needs code or only current qualification.

| ID / gate | Status | Work and exact acceptance | Depends on | Required verification |
| --- | --- | --- | --- | --- |
| L01 / F01 | ACTIVE | Freeze one complete source manifest; compare local and DANS1 hashes; identify built candidate and all helper files; reconcile pending edits and every test failure | — | Manifest comparison, full inventory, CDP baseline of current shell; E01 |
| L02 / F01 | VERIFIED | Restore omitted support files and complete exact artifact ownership; no missing or ambiguous product artifacts; separate verifier files from product | L01 | Atlas census plus mutation/refusal checks; no blanket ignore rule; E02 |
| L03 / F02 | ACTIVE | Audit one versioned task/run/result contract binding project, ledger revision, task, attempt, candidate, producer, scope, time, verdict and artifact hashes | L01 | Schema/authority review; E03 |
| L04 / F02 | OPEN | Refuse duplicate/conflicting IDs, stale revisions, foreign projects, missing provenance and out-of-order outcomes across actual transports | L03 | Adversarial contract tests and visible truthful errors through CDP; E03 |
| L05 / F03 | VERIFIED | Remove the old 255-read lifetime failure; retain project state through 301 actual result reads and two process restarts | Recorded candidate above | Native campaign `native-lifetime-2`; independent of real task-execution acceptance |
| L06 / F03 | OPEN | Run one exact admitted task through durable admitted/running/terminal records, including a deliberate failing check | L03–L04 | Actual native runner, receipt/artifact audit, CDP result view; E04 |
| L07 / F03 | OPEN | Interrupt before/after grant consumption, launch and receipt publication; lost replies and duplicate delivery cannot relaunch automatically | L06 | Controlled process termination/restart campaign and retained original recovery; E05 |
| L08 / F03 | OPEN | Exercise storage refusal, partial writes, damaged state and bounded output on an isolated test volume; preserve unresolved work | L06 | Injected failures plus actual isolated capacity failure where supported; separately label simulation; E05 |
| L09 / F04 | OPEN | Show the actual failed numbered task, check, evidence, cause/unknown, owner and next action immediately in Operations | L06 | Native CDP → authoritative result → screenshot and receipt comparison; E06 |
| L10 / F04 | OPEN | Execute 155 controlled obligations and reconcile exactly 154 verified / one explained failure from one ledger revision | L09 | Real controlled executions, complete receipt population and CDP totals/paging; E07 |
| L11 / F04 | OPEN | Fix and retry the failed obligation; retain first failure; totals stay correct after reload, restart and project switch | L10 | Exact original/attempt comparison and CDP transitions; E07 |
| L12 / F05 | OPEN | Refuse or serialize overlapping write/interface claims before admission; safe read/read remains possible | L03, L06 | Two independently scoped workers plus authority receipts; CDP collision display; E08 |
| L13 / F05 | OPEN | Changed base, dependency, scope or revision invalidates stale assignment/grant and affected proof | L12 | Mutation/admission tests and CDP blocked-state recovery; E08 |
| L14 / F06 | OPEN | Refuse ancestor/junction substitution and unregistered recovery stores; register discovery before side effects | L03, L06 | Native path/identity regressions, exact store allowlist; E09 |
| L15 / F06 | OPEN | Preserve dirty, untracked and ignored work during interrupted rehearsal; discover recovery after restart; no automatic destructive cleanup | L14 | Real disposable Git/worktree transactions, artifact hashes and CDP recovery view; E09 |
| L16 / F07 | WAITING | User selects a real folder through the native picker and explicitly approves its scoped registration/census | L01 | Human native action on DANS1; CDP checks resulting project identity; E10 |
| L17 / F07 | WAITING | Pair the packaged public helper with a real IDE agent using native consent; verify exact project and granted scope | L16 | Human native approval and IDE handoff, public-helper exchange receipt, CDP connection state; E10 |
| L18 / F07 | OPEN | Submit a small plan through the real agent; same authoritative tasks appear in Plan, Ledger and Developer Notes | L17, L03 | Actual agent exchange plus CDP nodes/ledger/readback/reload; E10 |
| L19 / F07 | OPEN | Exercise revoke, reconnect, unavailable service, stale response and bounded call timeout without cross-project leakage | L17 | Real helper/native fault campaign and CDP errors; E11 |
| L20 / F07 | OPEN | Cancellation/timeout settles only after verified descendant cleanup; uncertainty stays visible and blocks replacement work | L06, L19 | Native process containment evidence and CDP uncertainty view; E11 |
| L21 / F08 | OPEN | Safe secret fixtures are caught before push by actual local gates; failed/unavailable checks block | L15 | Real disposable repository/hooks, no real credentials; CDP guard status; E12 |
| L22 / F08 | OPEN | Qualify the configured external ClamShield adapter with actual scan coverage; no decorative healthy state | L19 | Selected scanner/runtime identity and safe fixtures; E12 |
| L23 / F08 | OPEN | Missing engine, partial scan, stale receipt and timeout never become PASS or grant delivery | L22 | Adversarial adapter tests and CDP truthful blocked states; E12 |
| L24 / F09 | OPEN | Rehearse two actual changes together against the current target and verify the combined candidate | L12–L15, L21–L23 | Real disposable repository and exact candidate hashes; CDP merge queue; E13 |
| L25 / F09 | OPEN | Target movement invalidates proof; cancellation/rejection retains every candidate and unfinished change | L24 | Interrupted transaction/current-target tests and CDP recovery; E13 |
| L26 / F09 | OPEN | Keep local proof, queued CI, accepted CI and production receipts separate; live CI only after service selection | L24 | Local contract tests plus actual configured CI receipt when available; E13 |
| L27 / F10 | OPEN | Revision-bound compact worker briefs include every obligation; authority-owned tool grants enforce scope | L03, L12, L17 | Obligation population comparison and restricted-worker tests; E14 |
| L28 / F10 | OPEN | Authenticate delivery/acknowledgment and enforce separate action deadlines; heartbeat is not progress | L27 | Lost/delayed/replayed message and stalled-worker tests; CDP responsibility display; E14 |
| L29 / F10 | OPEN | Independent supervisor reports stalls; selected notification service distinguishes acceptance from actual delivery | L28 | Supervisor fault campaign; real approved delivery test when configured; E14 |
| L30 / F11 | OPEN | Inventory every current route and visible control; each acts as labelled or explains a genuine unavailable prerequisite | L01; close after L09, L18 | Fast CDP page/action matrix below; E15 |
| L31 / F11 | OPEN | Large-repository intake, cancellation/resume, size limits and stale/revoked folder access preserve project truth | L16 | Native intake + Fast CDP status/error/recovery assertions; E16 |
| L32 / F11 | OPEN | Plan/map geometry, selection and node identity remain correct on large plans and reload | L18, L10 | Fast CDP geometry, hit testing, identity and reload checks; E16 |
| L33 / F11 | OPEN | Menus, drawers, keyboard focus, zoom and readable layouts work in supported viewport sizes | L30 | Fast CDP exact focus/geometry checks and before/after images; E15 |
| L34 / F11 | OPEN | Project switching, browser history, offline/loading and restored/corrupt metadata never show foreign or sample data as live | L19, L30 | Fast CDP two-project interruption/isolation matrix; E17 |
| L35 / F11 | OPEN | Operations logs, errors and evidence are selectable/copyable/exportable with truthful failures and bounded artifacts | L09 | Fast CDP log selection/export checks within explicit test scope; E17 |
| L36 / F11 | OPEN | Simple and Advanced views share project identity, ledger state and protections; no hidden authority changes | L30 | Fast CDP view-switch truth and permission comparisons; E17 |
| L37 / F12 | OPEN | Build one final candidate from reconciled source; verify executable plus every helper file before/after transfer | L01–L36 | Offline locked DANS1 build, complete manifests and source comparison; E18 |
| L38 / F12 | OPEN | Clean install/launch, native picker/IPC, approved clipboard behavior and zoom work on the final candidate | L37 | Native user journey with Fast CDP proof of observable state; E18 |
| L39 / F12 | OPEN | Final candidate survives concurrency, offline/network errors, restart, corrupt data and disk failures | L37 | Full native survival campaign and Fast CDP state assertions; E19 |
| L40 / F12 | OPEN | Run all current tests, packaging, accessibility and performance checks; resolve or explicitly reject every skip/warning against release criteria | L37–L39 | Current complete result inventory, performance measurements and evidence hashes; E19 |
| L41 / F12 | OPEN | Independent review of changed authority, recovery, UI and evidence; fix findings and rerun affected journeys | L40 | Independent reviewer findings and verified dispositions; E20 |
| L42 / F12 | OPEN | Complete the real user journey on the exact final candidate; close all F01–F12 criteria and record release decision | L41 and all F-gates | Human walkthrough, native receipts, Fast CDP evidence and signed-off completion record; E20 |

## Fast CDP contract for every UI checkpoint

Skill: `C:\Users\danie\.codex\skills\fast-cdp\SKILL.md` **on DANS1**; method: `references\method.md`. Both read on 26 September 2026. The skill was found remotely, not installed locally. Re-read it if its hash changes. The skill's reference launcher contains an execution-policy bypass flag: use the established encoded SSH/Node path without that flag; do not change or bypass host policy.

1. Run `ssh tonys-test-pc hostname`; require exactly `dans1` after normalization. Missing SSH, runtime or workspace is an infrastructure blocker, never a reason to run tests locally.
2. Stage the intended source/build and compare SHA256 at both ends before execution. Prefer the project's existing raw-CDP runner. If absent, adapt the remote reference method; no Playwright/Puppeteer/Selenium substitution.
3. Use one remote Node process, one persistent WebSocket, a serialized sequential opcode array and loopback-only CDP. Verify listening process ownership and launch arguments before attaching. Keep each scenario's observable boundary distinct.
4. Wait for exact DOM/engine predicates with deadlines using an event-driven observer. Do not substitute fixed sleeps or generic network-idle guesses. Batch related geometry/visibility/state assertions in one evaluation closure.
5. For a UI repair, reproduce the specific failure first; retain before image/result, apply the fix, then capture the same state/viewport after it. Stop at the first failed invariant; classify product versus infrastructure failure.
6. Browser-only fixtures cannot prove native IPC, OS picker consent, executable identity, IDE handoff, process containment or external delivery. Native WebView CDP can observe/render and invoke permitted test paths, but cannot stand in for human approval. Mark each campaign's boundary explicitly.
7. Dispose every created browser context and close only captured, identity-verified processes/listeners in `finally`. Cleanup failure means campaign failure. Retain disposable project evidence and unresolved originals; do not delete user work.

Each unique `E##/attempt-##/results.json` must contain: `ledgerIds`, host, UTC times, Node/browser versions, source manifest digest, executable/helper digests when native, scenario/opcode inputs, planned/completed operations, per-op timings/receipts, first error, page/console errors, screenshot paths+SHA256, cleanup results, verdict (`PASS`, `FAIL`, `INFRA_FAILURE`) and limitations. Keep `opcodes.json`, logs, screenshots, `source-manifest.json` and `change.md` adjacent. A PASS with missing host/source/cleanup evidence is not acceptance.

The runner may perform disposable fixture setup, but it must label it as such. Never silently convert a fixture run into a claim about a live user's project.

## Page/action matrix to instantiate in E15

For each surface enumerate actual rendered controls, expected action, permission prerequisite, normal outcome, refusal/error outcome, reload behavior, keyboard path, evidence and ledger ID. An initial inventory is not a passing test.

| Surface group | Minimum scenarios |
| --- | --- |
| Home and project switcher | Empty/demo/imported truth, current stage/owner/blocker, two-project switch and history |
| Blueprint, Structure, Components | Draft/approval/refresh, picker/census, cancel/resume, missing/revoked access and parent revision changes |
| Plan, Ledger and Index | Submitted node identity, review/history/reconciliation, search/navigation, large plan and stale data |
| Collisions, Allocation and Build | Competing claims, dependency changes, responsible worker, admission/refusal and run cancellation |
| Integrity, Evidence and Release | Actual source of proof, missing/stale/failed checks, artifact access and local/CI/production distinction |
| Top bar and drawers | Project/developer/calendar/more menus, agent connection, repository/inspector, escape/focus restoration |
| Operations | Logs, Errors, MCP, Branches, Merge, Delivery, Guards and current task/outcome tabs; failed draft read must not hide native history |
| Native shell | Launch/reopen, genuine folder consent, public-helper pairing, zoom and explicitly scoped clipboard behavior |

## Immediate execution order

1. Finish L01–L02: collect the broad rerun, resolve remaining regressions, verify the locally prepared atlas update and bind the complete candidate. Preserve the old and new runtime separately.
2. In parallel with human availability (without concurrent file writers), prepare E10 and continue L03–L09 against the actual native transport. Human availability for DANS1 was asked in chat; no answer has been assumed.
3. Complete the single real connected journey before the population campaign. Then L10–L15, remaining F07–F10, and the full UI matrix.
4. Freeze and qualify L37–L42; changes after freezing invalidate affected evidence and require another candidate, not a silent reuse of old PASS results.

## Failure and external-dependency register

| ID | State / owner | Known issue | Next concrete action |
| --- | --- | --- | --- |
| R01 | Historical failed attempt / Codex | First native CDP attempt attached before the WebView target existed | Preserved `native-lifetime-1`; target wait corrected; second campaign passed. Do not delete the first record. |
| R02 | Historical failed attempt / Codex | First storage-error normalizer changed a native recovery flag | Preserved `frontend-after-1`; fixed by retaining native flags; focused rerun passed. |
| R03 | OPEN / Codex | Initial broad Node inventory had 88 failures; full-2 stopped at test 1201 without a terminal report or live runner | Preserve the interruption record and logs. Rerun in a session-independent guarded job; categorize each remaining failure and link its repair/verification. |
| R04 | RESOLVED / Codex | First broad UI inventory had two stale navigation expectations | `frontend-full-3/ui.json`: all 486 UI tests pass against the frozen source. |
| R05 | RESOLVED / Codex | Atlas had unmapped entries, including a verifier-only config | Explicit ownership and mutation checks pass in full-3; verifier config relocated. L02 verified. |
| R06 | WAITING / human + Codex | Real native picker consent and IDE session not yet demonstrated | User acts on DANS1 when available; Codex verifies resulting scoped state and public-helper exchange. No credential changes required. |
| R07 | OPEN / Codex | 32 ignored Rust checks, compiler warnings and complete physical failure scenarios remain | Classify each skipped requirement; execute relevant native fixtures and record any external limits before F12. |
| R08 | WAITING when reached / human + Codex | Live CI, notification and external scanner configuration may be absent | Inventory selected services, prepare local adapters, obtain only genuinely missing configuration; never fabricate delivery/scan receipts. |

## Update record

- 2026-09-26: ledger created from the existing twelve-gate roadmap and observed current evidence. L05 is the sole verified execution row at creation; it accepts the precise read/restart regression, not all of F03. All twelve full gates remain open. Fast CDP skill and method found/read on DANS1 and incorporated into the ongoing verification contract.

## Qualified checkpoint — 26 September 2026

Source manifest: `../evidence/roadmap-01/qualified-source-manifest.json`, SHA256 `682d077a3e12113c5b30b3f36f93d5cee08b1b060dbe5cf0250773b93e802fbf`. All 1,205 source files matched locally and on DANS1 before build. This appended ledger update is a subsequent documentation change, not part of that frozen manifest.

| Evidence | Result | Acceptance boundary |
| --- | --- | --- |
| `frontend-full-3` | Node: 1,529 pass, two fail, six skip; UI: 486 pass | Original FAIL retained. Two Node failures were file-link fixture creation under the scheduled task's limited token. |
| `e09-link-fixtures-2` | 57 pass, zero skip | Same-source SSH rerun covers the two failures and packaging link refusal. No host security policy changed. Attempt 1 retained: 30 TAP passes but wrapper exit status missing, so not accepted. |
| `e16-handoff-1` | 24 pass, zero skip | Covers native census handoff and remaining merge-store link fixture. |
| `e04-dispatch-custody-1` | Three pass, zero skip | Real inert native child, durable intent/result and lost-reply custody. Approval is a controlled fixture, not human consent or installed execution. |
| `e11-containment-1` | 15 formerly ignored native checks pass | Actual Windows process containment, timeout/cancellation and output/resource limits. Does not close L20's integrated UI/recovery requirement. |
| `e16-census-1` | Native 10,052-file census passes | Exact count, ceiling and retained receipt; disposable scripted registration. L31 remains open for real intake/cancellation/resume. |
| `e15-shell-1` | Fast CDP 53/53; no page/console errors; cleanup verified | Empty-project setup and demo route/geometry checks. Not every control, accessibility path, native consent or IDE journey. |
| `roadmap-qualified-build-result.json` | DANS1 offline locked debug desktop build PASS | No installer or installed-app replacement. Source digest matches above. |
| `qualified-runtime-verification.json` | Executable and 190 helper files verified after transfer | New copy at `../qualified-runtime/`; older runtimes retained. Executable SHA256 `8c9acacdbd5ad072031c1598e50c1426ccfb5552436fbe735141f602051696a2`. |

The supplemental campaigns exercise all six skipped Node cases and both failing file-link fixtures from full-3. Counts overlap; do not add them together or relabel the original full-3 result PASS. The complete Rust inventory still has fixture-dependent cases and warnings requiring classification. The completed full-3 scheduled task was identity-checked and removed; evidence remains.

L02 is now VERIFIED; L05 remains VERIFIED for its recorded older executable. L01 remains ACTIVE for final change reconciliation. L03 is ACTIVE. All twelve full F-gates remain open.

### Next implementation boundary

The installed host constructs execution grant/observation custody but passes only result reads into its composition. The native dispatcher is exercised by tests but is not connected to that installed host. The desktop command surface exposes preparation/readback, without an installed review-to-execution journey. Historical zero-exit observations deliberately remain unverified and must not be upgraded to success merely to complete the UI.

Next: bind native review to the exact prepared contract, persist a single-use execution grant under native ownership, connect that grant to the actual contained runner, then present durable results and unresolved recovery in Operations. Qualify a deliberate failure and retry before the larger population campaign. Human picker/IDE actions remain separately required; human availability is not the only outstanding implementation dependency.

## 27 September 2026 — L03 prelaunch guard

Implemented exact Rust validation for private native review/recovery requests and binding to the native-owned prepared proposal head before helper launch. Retained before/fix evidence in `../evidence/roadmap-02/`: the new regression first failed on an injected actor field; after the fix all 18 supervisor tests passed, with two installed-fixture tests still ignored. The downstream Node protocol already validated requests; this closes the earlier Rust boundary without claiming an authority bypass existed. See `../evidence/roadmap-02/change.md` for scope and matching source hashes.

L03 stays ACTIVE. This prerequisite does not yet connect the desktop review action, grant consumption or native execution. No UI changes or new Fast CDP claims. The copied qualified runtime predates this source change. Next implementation remains the durable desktop review/recovery bridge, followed by single-use grant admission and actual runner/result integration.

## 27 September 2026 — desktop prepared-review bridge

Implemented `review_native_checks` and the visible **Review prepared checks…** action. Native configuration resolves the saved setup, binds the proposal/check heads, invokes the existing packaged review flow, and projects only the decision ID/status. The renderer cannot submit a decision or executable. Each original request is durably retained before dispatch; an exact completed repeat reads its retained result instead of reopening the dialog. Conflicting input, unknown reply or uncertain cleanup cannot silently launch a replacement. A stale success message is cleared when another action starts.

Source-bound evidence in `../evidence/roadmap-02/`:

- `review-bridge-native-2`: 99 pass, zero failures, one installed fixture ignored; includes six new disk-backed review tests. Controlled supervisor replies do not prove human consent.
- `review-bridge-frontend-2`: 62 Node tests and 51 UI tests pass, covering exact receipt fields, capability mutation/refusal, artifact ownership and repeated/failed review interactions.
- `e15-review-3`: Fast CDP 18/18, zero page/console errors, cleanup verified. Explicit mock IPC component fixture; not a native dialog or real approval. Earlier failed harness import/duplicate-React attempts retained as `e15-review-1` and `e15-review-2`.
- `local-source-comparison.json`: all 1,206 source files match DANS1. Frozen manifest SHA256 `dc849e01dcac3c5d65f3529d481dbef7d18924efc143ee278026b9fd312c61b9`.
- `roadmap-review-build-result.json`: locked offline debug desktop build passes; executable SHA256 `00e92e4f8a54abdbd3dde1361d10ca9b00059dde00bab2dbf1a0b357981f5fa8`. Transfer verification recorded separately. No installed-app replacement.

L03 remains ACTIVE. Remaining work is substantive: a usable recovery path for interrupted native review sessions, the native-owned single-use execution grant and contained runner connection, authoritative result projection, and the real installed human/IDE journey. Current uncertainty deliberately blocks replacement reviews; it is not complete recovery. All full F-gates remain open. This documentation update follows the frozen build manifest.

## 27 September 2026 — recover a durably saved review after interruption

Added `recover_native_check_review` and **Recover saved review**. The renderer preserves the exact original request across reload, offers it for copying when cache storage fails, and refuses to replace a different unresolved original. Native recovery accepts only the exact retained request and terminal decision. A pending session can settle only when its original diagnostic binding/hash and supervisor evidence prove process exit, descendant cleanup and settled I/O. Recovery launches no helper, opens no dialog, changes no confirmation and grants no execution permission. Missing decisions and uncertain cleanup remain blocked and retain their evidence.

Evidence: `../evidence/roadmap-03/review-recovery-native-1` has nine passing disk-backed native review tests; `review-recovery-frontend-1` has 63 Node and 52 UI passes; `e15-review-4` has 26/26 Fast CDP operations, zero page/console errors and verified cleanup. Fast CDP used a controlled IPC fixture and proves the UI reload/recovery path only. `local-source-comparison.json` verifies all 1,206 files against manifest SHA256 `92e046c5df6d0a9339c8c9d2b306bc1aa5130a1d7e8fd14e0696fa294643d240`. Archive transfer SHA256: `62acd3846fb0f56c48037f5aaf2677f20dfa53bf81d51864003ce3b5f7fd58de`.

This is bounded recovery of an already saved decision, not completion of all interrupted-review recovery. A lost helper reply with no native result still requires exact host-side reconciliation, including matching its confirmation and verifying any old dialog is closed. No state reset or invented cancellation was added. L03/L07 remain active/open as applicable. The copied `review-runtime` predates this recovery source change; no new executable is claimed for this slice.

Next connected work: exact host-side original-to-confirmation reconciliation for missing decisions; then compose existing `taskProposalReview`, enrollment/session custody, single-use grants and `taskNativeDispatch` with the production Windows contained executor. Do not use the inert test executor or its trusted-gesture fixture as the installed authority. Final acceptance still requires a real IDE/native journey and all twelve gates.

## 27 September 2026 — stable helper review identity and durable closure

Native review now supplies the digest of the retained original through `review-original-request`. The helper binds that digest to an immutable confirmation ID; a repeated original cannot display again. The private `recover-original-request` command matches that confirmation to the retained proposal/check contract, verifies exact presentation closure and returns its terminal decision or uses existing native secret custody to cancel a pending confirmation. This is not an execution grant.

The installed presenter now retains its validated destroyed-window receipt after process cleanup, bound to the exact executable, request, proposal, checks and displayed content. Restart can verify closure from those bytes. Missing, damaged or foreign receipts fail closed; decision-authority tokens remain in memory and are never restored from the closure file.

DANS1 evidence in `../evidence/roadmap-04/`: 84 helper/confirmation/protocol/adapter tests pass (`review-original-host-2`); 18 supervisor tests pass with two installed fixtures ignored (`review-original-supervisor-2`); nine native review tests pass (`review-original-native-2`). Preserved the first native failure: test hashing used struct field order instead of the canonical retained JSON value; corrected expected serialization without changing production hashing. No UI changed in this slice, so no new Fast CDP UI claim.

Updated package contains 193 verified files, including newly required transitive modules. Manifest SHA256 `49b9811fb190182b0efa71c5f8e7db404e608e088b7f050a5492f771caf5f6bb`. Frozen source manifest `195329d491859e5dbc22ede22a042fdd72dc205abc381766ed0305e79f2d8e0d`. Locked offline desktop build passed: executable `2a4708bb6420fc7e51b413352606b56a3aaa02debdbe24110723b83031c49382`; copied checkpoint is `../original-runtime/`, with transfer verification retained separately. Product sources match DANS1; later ownership/ledger annotations are documentation deltas.

Still incomplete: the desktop recovery fallback for missing native result files must call the new helper reconciliation command under durable session ownership, validate its exact result and settle only with proven cleanup. The existing desktop recovery action still handles saved results only. Helper recovery refuses unresolved closure or incompatible retained contract state; it does not clear uncertain live processes. The execution-grant/runner/result connection and actual human/IDE journey remain open. L03 and L07 are not complete, and no full F-gate is closed.

### 2026-09-27 — missing-result review reconciliation checkpoint
Native recovery now calls the private recover-original-request only for the exact settled outstanding original. It does not redisplay a review and refuses pending cleanup, changed originals, corrupt results or a foreign terminal confirmation. DANS1 native regression: 105 passed, zero failed, one ignored. Source manifest 341bc8aba7ca529e829459b9048bfbc874fd909f11993e035e931a883ee2b29c. Desktop build PASS; executable e4f1cc901a60069fa902bace3c470f81aadae965b91142988423071b5aeacb89 copied to ../reconcile-runtime with all 193 helper files hash-verified. Evidence ../evidence/roadmap-05. Controlled transport tests are not installed human recovery proof. No UI changes or new Fast CDP claim. Pending sessions without reliable cleanup remain blocked. L03/L07 and full completion gates remain open; next is native execution grant/runner integration and the installed journey.


### 2026-09-27 — reviewed execution grant admission
Added taskProposalReview.issueAssignedGrant: holds current proposal/contract/approval/enrollment/session custody while observing the candidate and deriving the full grant binding. Callers cannot supply candidate/executable/policy bindings. Rechecks session freshness after observation; issuance remains separate from consumption and launch. Existing dispatch scenarios now use this admission path instead of issuing directly from a fixture binding.
DANS1 grant-admission-1: 62 tests passed, zero failed/skipped. e04-grant-dispatch-1: three actual native child execution/retained-result/lost-reply tests passed, zero skipped. Source manifest 6d74c4456d1abbc3e71738ca3d4fd93e53071fd9c8791cde0276049b969076aa; changed source/test hashes compared locally. Evidence ../evidence/roadmap-06. Approval remains a controlled fixture; this does not prove human consent or installed execution. No renderer change or new Fast CDP claim. The latest copied runtime remains reconcile-runtime and predates this helper source change; package refresh is required with installed runner integration. L03/L06/L07 remain open.


### 2026-09-27 — native execution limits aligned with reviewed contracts
Found and fixed a production mismatch: task contracts support independent stdout/stderr caps, timeout up to 300000ms, and up to 2MiB per stream/combined; the runner previously used one stream cap and rejected timeout above 120000ms and stream caps above 1MiB. New run_captured_limits preserves independent budgets, enforces the combined ceiling and keeps the symmetric wrapper for existing callers. CPU/process/memory containment remains enforced.
DANS1 execution-limits-1: 17 actual native containment tests passed, zero failed/ignored, including unequal stdout/stderr budgets and a short child admitted with maximum reviewed limits. This proves configured maximum admission, not a five-minute endurance run. execution-limits-invalid-1: pre-launch invalid-limit test passed. Source SHA256 a739beb21b664a0c92d224e09455d97bf8d93a79f948ebb9887581fa06f97416 verified locally; evidence ../evidence/roadmap-07. No UI change, Fast CDP claim, runtime rebuild or installed execution claim. Next: private native execution specification/transport and its final executable/candidate binding. L03/L06 remain open.


### 2026-09-27 — strict native execution adapter
Added native_task_execution.rs to validate the host execution specification, recheck executable SHA256, hold executable write/delete denial and directory rename denial through native execution, enforce independent output caps, and return the existing native observation shape. Wrong hashes, outside-root cwd and extra authority fields are refused. Failed exit 7 is preserved with cleanup; invalid UTF-8 is refused rather than rewritten into evidence. Candidate bytes and grant admission remain separate host responsibilities; this adapter is not an execution endpoint or a filesystem sandbox.
DANS1 execution-adapter-2: five tests passed, one inert child entry ignored as a standalone test (invoked within the actual adapter tests). execution-resources-1: 13 resource regressions passed. execution-atlas-1 passed exact artifact ownership. Full source manifest 69f825116a19ea99a4d4eeec5a1201e782d4a6f0176cc94e39e456eb9b3b1a2c. Changed native source hashes matched locally. Evidence ../evidence/roadmap-08. No installed runtime rebuild or Fast CDP claim. The adapter still needs the supervisor-owned execution transport and the installed worker enrollment/grant path; L03/L06 remain open.


### 2026-09-27 — production native execution process bridge
Connected the Node nativeTaskExecutionAdapter to the real Rust adapter through a separate bounded local stdio mode. The existing grant-backed dispatch forwards durable expiry; the bridge re-observes candidate contents, verifies native host bytes and checks expiry again natively after pinning the task executable, immediately before launch. It preserves native output/cleanup schema for the existing durable result custody. Git process bounds remain unchanged; task transport allows five-minute checks plus bounded startup/settlement and JSON framing.
DANS1 execution-bridge-dispatch-2: four tests passed, zero skipped, including actual production-adapter/native-stdio execution, retained failed results and lost-reply no-relaunch, plus expired-grant/changed-candidate refusal. execution-bridge-native-1: five native tests passed (one inert child entry excluded from direct invocation). execution-bridge-regressions-2: nine shared transport, schema and ownership checks passed. Full source manifest 7d98fe678332f2f0a3d301ad66b2e77c6270dee51e09fcf35880fd8e171a7508; native bridge binary 011db49155d18c2703d91a5d18d1c65cbab9f9b29e9b435faec729e106dd466b. Relevant source bytes compared locally. Evidence ../evidence/roadmap-09. A stalled wildcard build-log transfer was stopped after identifying its live SCP/SSH processes; explicit bounded copies succeeded.
Approval/enrollment in these campaigns remain controlled fixtures. The CLI build is a test binary, not a packaged GUI release. Candidate snapshots are not an exclusive filesystem lease. Next is installed-host worker enrollment and execution-command composition, followed by real consent/UI execution and result acceptance. No Fast CDP claim; L03/L06/L07 and full gates remain open.


### 2026-09-27 — installed owner execution composition
Installed host now composes a private taskExecution capability for a selected reviewed contract: project-derived durable worker/session/enrollment/grant/result paths, reviewed authenticated enrollment, grant issue/consume, actual native dispatch, original inspection and worker release. Construction remains read-only. Dispatch prepares and verifies result storage before intent/launch. Shutdown closes admission, drains pending work and retains unresolved cleanup state. Credentials remain private host data; existing broker read/proposal scopes were not widened.
First installed-execution-1 failed 1 of 5 scenarios: observation-directory initialization was absent from the previously read-only custody constructor, leaving result publication unresolved. Failed evidence retained. After correction, installed-execution-2 passed all five native integration scenarios, including owner-created worker/enrollment, real execution, linked owner reads, no-replay and deliberate adapter failure with uncertainty retained. installed-host-composition-2 passed 22 host/ownership tests. Unchanged review/grant authority sources passed 62 connected checks in installed-execution-regressions-1. Final source manifest e0ddc15beeb1e596c9e9ad65646aafa908ba57fbabe79944710375a1fe13765b; changed source hashes matched locally. Evidence ../evidence/roadmap-10.
The integrated fixture uses controlled approval/registration and test session tokens, not human consent or production DPAPI enrollment acceptance. Native bridge binary remains 011db49155d18c2703d91a5d18d1c65cbab9f9b29e9b435faec729e106dd466b. No refreshed packaged GUI or UI execution controls yet. Next: private execution request protocol/native command custody and the UI workflow, then Fast CDP and installed human acceptance. L03/L06/L07 and full gates remain open.


### 2026-09-27 — durable execution requests and shutdown verification
The private installed owner retains the exact selected request before side effects, keeps worker credentials out of request/result files, returns immutable terminal receipts on retry/reopen, and blocks unresolved originals rather than launching again. Shutdown now closes admission and waits for the whole request operation, including result persistence and worker release; uncertainty remains explicit.
DANS1 execution-requests-native-1: all six production Node/Rust integration scenarios passed against source manifest de10a9f0c66860e8ebdfda7a92a9e9c7b12972fa541058484d4d1134707cbc7f. Final shutdown/configuration changes: execution-requests-host-2 passed 27 tests, zero skipped; execution-requests-native-2 passed the one selected durable-request integration test. The latter is a focused rerun, not a repeat of all six scenarios. Final manifest fe99922e89f06056da25357c315b63c838c6d20e5f011927de80f2b5bf124f8e; five affected implementation/test files matched locally. Evidence ../evidence/roadmap-11.
Approval/enrollment remain controlled fixtures. Missing terminal-result reconciliation, private command routing, native supervisor/Tauri wiring, packaged runtime refresh and actual installed human/IDE acceptance remain open. No UI modification or new Fast CDP claim. L03/L06/L07 and all full completion gates remain open.

### 2026-09-27 — private execution command and supervisor integration
The private host now accepts exact execute-check and recover-check-execution requests only when an installed owner capability exists. Payloads cannot supply paths, worker credentials, actors or policy. Replies project only the exact terminal receipt and redact internal exceptions. The shared host lifecycle drains admitted execution requests and closes the owner, including attached-stream shutdown; uncertain cleanup cannot become clean completion.
Native supervisor admission requires both proposal and contract heads to match its native-owned selection. Execute-check has a bounded 420-second transport envelope for the existing five-minute check maximum plus admission/settlement; other command deadlines remain 150 seconds. This is timeout configuration evidence, not a five-minute endurance qualification.
DANS1 execution-commands-host-2: 70 passed, zero failed/skipped. execution-commands-native-1: 19 supervisor tests passed, two existing packaged-fixture tests ignored. execution-commands-native-dispatch-1: one focused actual Node/Rust scenario passed through composed command dispatch, retaining exit 7 and identical receipts across retry/reopen with no new grant revision. Full source manifest 511f9e681e19e6f5b9218d5ffb20af29c90f28d8fb4f9d1d8489d3f1f54ff396; all seven changed source/test files matched locally. Evidence ../evidence/roadmap-12.
The actual command scenario uses controlled approval/registration fixtures and the existing native CLI test binary; it does not exercise the newly compiled supervisor through a packaged GUI. Tauri execution commands, renderer controls, missing-result reconciliation, refreshed package and actual human/IDE acceptance remain incomplete. No UI change or new Fast CDP claim. Full completion gates remain open.

### 2026-09-27 — durable desktop execution command and renderer adapter
Added execute_native_check and recover_native_check_execution under the existing native-owned setup and registration. The exact request contains task/check/attempt and recorded confirmation identity, never executable paths, credentials, policy or approval decisions. Native storage retains the original before dispatch, verifies the helper receipt against its canonical original digest, retains terminal results and refuses implicit replay. Explicit recovery can settle a pending session only from exact durable supervisor cleanup evidence; it reads cached results or issues the read-only helper recovery command. Missing or uncertain cleanup stays blocked.
The initial native run failed (2 pass / 5 fail): outstanding-request state was changed before BEGIN, violating the existing journal invariant. Corrected ordering retains request identity in diagnostic intent before BEGIN, then carries outstanding state into SETTLED. The failed evidence is preserved. A subsequent seven-test slice passed; final full native draft/session/review/preparation regression passed 113 tests, zero failed, one existing ignored test. Final native_check_execution.rs SHA256 2f111c07de092d25dcac2f10ee8ecf0a84cef108e698ebaade73ca98db72106c.
The renderer adapter now validates execution/recovery payloads and terminal replies. Fixed an existing review mismatch: native emits recoveredSession:false on normal review, while the renderer previously rejected that field. Capability/command inventories explicitly include only the two new scoped endpoints. Initial host suite had 100 pass / 2 failures because the static ACL analyzer still listed the previous permissions; corrected exact inventory passes all 102 checks, including permission-expansion rejection. Host source manifest cba48d0d313fc879b0e52957b47eb968d9dae40d9a06ef4d699e6e682ce9f7f2; final native test changes are independently pinned above. All changed source/test bytes compared locally. Evidence ../evidence/roadmap-13 includes failed and corrected campaigns.
Native endpoint tests use controlled supervisor receipts; they are not proof of packaged GUI execution or human approval. Visible execution/result controls, missing helper-result reconciliation, runtime packaging, Fast CDP and installed human/IDE acceptance remain open. No UI change or new browser-proof claim in this checkpoint. L03/L06/L07 and full completion gates remain open.

### 2026-09-27 — visible check execution, recovery and refreshed runtime
The check panel now offers explicit task/check selection and run controls only after a matching native approval. It retains the execution request before invoking native code, refuses a replacement while an outcome is unknown, blocks setup/review mutations during unresolved execution, and restores the exact request after reload. Recovery calls only the read-only native recovery method. Result reads must match grant/run, artifact/intent and task/check/attempt identity. Failed exit and successful-but-unverified result are distinct; neither completes the task. Cache-write failure prevents launch, and late replies cannot populate another project generation.
DANS1 execution-ui-after-1: 64 Node checks and 57 UI checks passed, zero skipped. Fast CDP e16-execution-1 captured the before state (7 operations); e16-execution-2 passed all 29 operations for approval gating, failed exit, explicit next attempt, lost reply, no stale result, reload and exact recovery with zero execution calls on recovery. Screenshots inspected; both campaigns completed cleanup with no retained browser process/listener. Browser IPC was explicitly mocked; these are component interaction proofs, not real native consent or full installed acceptance. Source manifest 78416835b6f0ebd4e545f766e805efd2f6a36da3ddc67273bdf3385060f2f235.
A source SCP transfer stalled before tests started. Its exact live SCP/SSH/shell identities were verified and stopped; fresh bounded transfer and SHA-256 comparison succeeded before verification. No tests were inferred from that stalled operation.
Refreshed package has 195 files, pin e0494ab454533777c198cae86ca4ad3ffa0d84d33764501163eab81a4630f0ca. Offline locked desktop build passed on DANS1; executable d700f55e8cf028d67c1ac34e0ee780dc3a3f3dafff72029ed273d8c389923447 copied to ../execution-runtime, with executable, manifest and every packaged file verified locally. Prior runtimes retained. execution-runtime-dispatch-1 passed the actual native execution/failure/reopen scenario against this new executable; approval and registration still use controlled fixtures. Build is task-specific and does not replace the original installed application.
Evidence ../evidence/roadmap-14. Next: installed native journey using the refreshed package, real approval/IDE interaction, and unresolved helper-result reconciliation. Full F-gates and L03/L06/L07 remain open. These annotations follow the frozen source manifest.

## 27 September 2026 — current native launch and MCP trial preparation
Latest execution runtime launched and rendered on DANS1; captured-process cleanup passed. Evidence ../evidence/roadmap-15. Fresh-profile qualification failed: WebView restored the old test project despite fresh APPDATA/LOCALAPPDATA environment directories. Original launch-only PASS retained; assessment explicitly limits it. Correct actual browser/native state isolation before the copied-user-repository MCP trial. Repository clarification pending; no copy or pairing performed. All full gates remain open.

Follow-up: native-current-smoke-2 corrects WebView storage isolation with an explicit unique profile. Latest actual desktop opens with no project and null renderer registry; three smoke operations and cleanup pass. Evidence ../evidence/roadmap-15/isolated. Native store isolation and actual copied-repository intake remain to verify. No full gate closed.

## 27 September 2026 — recover retained execution without replay
Fixed request-terminal recovery when the native observation/link and released worker survive but terminal publication is missing. Actual native before run failed; after run recovered identical receipt with unchanged grant revision 4. Related regressions: 59 pass, no skip. Evidence ../evidence/roadmap-16/change.md and source-bound reports. Controlled receipt removal, not physical crash. Packaged desktop helper update remains required; no full gate closed.

Recovery build checkpoint: source manifest 9deff1f9...; desktop d99d5b9a... and 195-file helper package 56a4518c... built, copied and verified as ../recovery-runtime. Native launch with explicit fresh WebView profile passed; evidence ../evidence/roadmap-16/native-recovery-smoke-1. This ledger annotation is after the frozen manifest. Actual native consent/MCP/copied-user-repository journey remains incomplete.

## 27 September 2026 — current native plan persistence
Actual recovery-runtime desktop on DANS1: 13 native campaign steps PASS, two launches, cleanup verified. Disposable scripted registration/census; two-task proposal submitted through actual Tauri command, exact ledger/head readback before and after restart, duplicate original idempotent at revision 1, conflicting original refused, original plan unchanged. Evidence ../evidence/roadmap-17/results.json and hashed screenshots. Screenshots show shell only. This is not real folder consent, IDE/MCP pairing, task-card rendering, execution or full Fast CDP acceptance. L03/L04/L18 remain open for their full scope.

## 27 September 2026 — actual native shared-plan UI
Actual packaged Ledger Read shared plan action displayed native revision 1 and both persisted task IDs/titles. Seven raw-CDP operations passed; second campaign adds visible-row geometry and properly framed, hash-verified screenshots. Cleanup passed. Evidence ../evidence/roadmap-18/change.md and visible-2. No mocked IPC; still scripted project registration, no MCP/human pairing. Local reconciliation/map and complete telemetry remain open; full L18/L30 and all F-gates remain open.

## 27 September 2026 — native shared-plan reconciliation and map
Actual packaged UI: 23 operations passed, no captured page/console errors, cleanup complete. Shared native T0001/T0002 reviewed and saved as unapproved local revision 1; Plan map retains both identities and dependency; clicking T0001 opens its linked Ledger acceptance detail. Evidence ../evidence/roadmap-19/change.md and screenshots. Controlled disposable registration/local review only; no human execution approval or MCP pairing. Full review-history and process-restart-after-local-save acceptance remain open. No F-gate closed.

## 27 September 2026 — repository npm check preparation
Identified installed fixed-profile restriction blocking non-Planner repositories. Added separate npm-project-checks-v1 data preparation/evidence with exact scripts and retained manifest/lock pins; no execution. DANS1 26 checks passed, source hashes verified. Evidence ../evidence/roadmap-20/change.md. Native selection, review, protocol, renderer and actual execution integration remain pending; current packaged runtime still fixed-profile. This is an additional L06/L17/L30 integration requirement, not a completion claim.

## 27 September 2026 — script evidence bound into native review
Installed prepared selection carries immutable policy evidence into native review display. npm checks require matching repository-script evidence; wrong policy digest or post-construction mutation cannot change the captured display. DANS1 80 checks passed with controlled presenter; hashes verified. Evidence ../evidence/roadmap-21/change.md. Actual dialog, generic native/protocol/UI provisioning and packaged execution remain open. No full gate closed.

### 2026-09-27 — Native repository profile integration (roadmap-22)
Native setup accepts the fixed Perfect Planner or npm repository profile, retains the selected profile in the hashed setup and rejects unknown profiles. Preparation receipts must match the saved profile; mismatch retains the unresolved original until a matching response. DANS1: 115 native tests pass (1 ignored), 19 supervisor tests pass (2 ignored), 61 Node tests pass. Returned source hashes matched local files. Evidence: ../evidence/roadmap-22. Controlled transport/disk-backed proof, not human picker, native approval, desktop selector or public MCP acceptance. Packaged recovery runtime remains unchanged. Repository path/URL from user still required before copying Boundaries. Full acceptance gates remain open.


### 2026-09-27 — Repository check desktop controls (roadmap-23)
Desktop can select existing npm scripts; native inspection returns saved profile/assignments, and execution menu derives exact check IDs from that saved setup after reopen. DANS1: 66 Node, 58 UI, 116 native checks pass (one ignored native fixture); 31 Fast CDP operations pass with mocked IPC, clean telemetry and cleanup. New packaged runtime ../repository-runtime: executable 184fb6c5..., 195-file helper 05d32020..., source 5b42f745... . Actual native launch/shell smoke passes; copied artifact fully hash-verified. Evidence ../evidence/roadmap-23/change.md. Native setup/review/execution of a generic repository, public MCP journey and all full acceptance gates remain open. User Boundaries path/URL remains outstanding. Goal active.


### 2026-09-27 — Actual repository profile preparation and native UI (roadmap-24)
Actual packaged 184fb6c5... desktop: 16 preparation/restart/exact-retry/foreign-reference steps pass; contract revision 1 remains identical. Nine real UI operations pass, showing native-saved repository profile and npm-tests for T0001/T0002, with execution disabled before approval. Retained script evidence and package digest validated. No mocked IPC; fixture registration/setup were scripted. Both campaigns exited 0, cleanup and screenshot hashes verified. Evidence ../evidence/roadmap-24/change.md. Native consent, actual npm execution, public MCP pairing, real user repository and all full acceptance gates remain open. Goal active.


### 2026-09-27 — Native presenter crash repaired (roadmap-25)
Actual review exposed a production helper crash: test-only COMPUTERNAME assertion ran before --presenter while minimal environment omitted that variable. Moved qualification guard after production-mode dispatch; retained strict display validation and DANS1 test host guards. Five parser tests and exact before/after process probes pass. New ../presenter-fixed-runtime (exe c97e1865..., helper 46dda3fd...) hash-verified. Actual packaged preparation/review timeout/exact retry/restart recovery: 21 steps, three launches, exit 0, cleanup pass; no approval or execution. Evidence ../evidence/roadmap-25/change.md. Separate observed gap: READY_MISMATCH before dispatch leaves a pending native review session; preserved and awaiting proof-bound recovery. Real human review, repository execution and public MCP journey remain open. Goal active.


### 2026-09-27 — review startup refusal (roadmap-26)
New reviews with proven pre-dispatch READY refusal and settled processes now return NOT_STARTED and allow a later explicit retry. Uncertain/dispatched originals remain protected. DANS1 15 focused Rust tests pass; source hash verified. Evidence ../evidence/roadmap-26/change.md. Historical pending-session recovery, packaged acceptance and public MCP journey remain open. No full gate closed.


### 2026-09-27 — historical review refusal recovery (roadmap-27)
Actual packaged desktop recovers the preserved pre-dispatch startup refusal without creating approval or redispatching. Ten native operations/two launches PASS; restart recovery idempotent, original/proof preserved, unrelated dispatched failure remains pending. 123 native, 67 Node, 58 UI tests pass. Artifact ../startup-recovery-runtime fully hash-verified. Evidence ../evidence/roadmap-27/change.md. All full acceptance gates remain open; no human consent, repository execution or MCP pairing claim.


### 2026-09-27 — review UI recovery and changed selection (roadmap-28)
Definitive NOT_STARTED recovery permits changed review selection after refresh; later uncertain attempts cannot reuse older completion. 67 Node, 63 UI, 40 controlled Fast CDP operations and 13 actual packaged native UI operations pass. Artifact ../review-selection-runtime 1f95177a... verified. Evidence ../evidence/roadmap-28/change.md. No human native approval, repository execution or public MCP pairing proof; full acceptance gates remain open.


### 2026-09-27 — repository lifecycle compatibility (roadmap-29)
Generic npm preparation accepts declared pre/post scripts and native review carries exact ordered lifecycle data. DANS1 116 focused tests plus actual npm fixture ordering pass. New packaged fixture: 21 preparation/review cancellation/restart steps pass; exact retained script evidence verified. Artifact ../lifecycle-runtime e8466316... copied and hash-verified. Evidence ../evidence/roadmap-29/change.md. No human approval, real repository execution or MCP pairing; full acceptance gates remain open.


### 2026-09-27 — actual public helper protocol (roadmap-30)
Current packaged helper passes actual stdio/Windows-pipe connection, shutdown/stale-config refusal, native plan reads, proposal and exact retry tests on DANS1. Five explicit integration tests pass; private test admission on a scripted fixture, not human pairing. Failed initial fixture campaign preserved; corrected fresh campaign verifies no duplicate task. Evidence ../evidence/roadmap-30/change.md. Full L17–L19 and all F-gates remain open pending real user/IDE/UI journey.


### 2026-09-27 — public MCP Developer Notes (roadmap-31)
Actual packaged helper saves report, retries without duplication and preserves original after conflicting replacement; owner readback confirms one not-verified record. Controlled test admission on prior fixture; no live IDE/native consent or UI acceptance claim. Evidence ../evidence/roadmap-31/change.md. All full gates remain open.

### 2026-09-27 — read-only notes and owner restart (roadmap-32)
Actual packaged helper cannot add/replace notes under read-only admission. Owner returns identical retained data, and restarted owner reads original not-verified report. One explicit test PASS after corrected protocol-envelope comparison. Evidence ../evidence/roadmap-32/change.md. Controlled fixture; full gates remain open.

### 2026-09-27 — Developer Notes read states (roadmap-33)
Unknown counts remain unknown until read; pending controls disabled; older-report browsing discloses paused refresh. Seven component tests PASS on DANS1. Evidence ../evidence/roadmap-33/change.md. Source change only, packaged/native acceptance pending; full gates remain open.

### 2026-09-27 — Notes desktop package (roadmap-34)
Roadmap-33 source built on DANS1 into notes-runtime, executable 17c6e69d... with unchanged helper6397027b... . Copy hashes/lengths verified. Evidence ../evidence/roadmap-34/change.md. Native UI acceptance pending; full gates open.

### 2026-09-27 — actual native Notes UI (roadmap-35)
New desktop passes 10 native Fast CDP operations for actual owner read, refresh and close, with visible revised guidance and verified screenshot. Evidence ../evidence/roadmap-35/change.md. Disposable existing project, empty report store, no mocked IPC. Populated MCP report rendering and all full gates remain open.

### 2026-09-27 — MCP report visible in actual desktop (roadmap-36)
Packaged helper writes report into the desktop fixture; actual native Notes displays its exact identity/text and not-verified label after owner restart. One integration test and 10 native Fast CDP operations PASS. Evidence ../evidence/roadmap-36/change.md. Private test admission; no human IDE pairing or task execution. Full gates remain open.

### 2026-09-27 — full frontend inventory and repairs (roadmap-37)
Complete current inventory: Node1556 pass/3 fail/7 skip, UI501 pass. Resolved atlas omission, generated event-ID redaction collision and stale Sites packaging; deterministic before failure preserved,61 connected regressions PASS. Evidence ../evidence/roadmap-37/change.md. Seven fixture-dependent skips and final packaging remain open; no full gate closed.

### 2026-09-27 — explicit native skip qualification (roadmap-38)
Six native dispatch tests pass with verified fixture+notes bridge; fresh10052-file native census and full discovery/structure handoff pass. Evidence ../evidence/roadmap-38/change.md. Seven broad-run skips now have explicit bounded evidence, not human consent or full L06/L07/L31 acceptance. Full gates open.

### 2026-09-27 — regression fixes packaged (roadmap-39)
DANS1 built matching desktop/helper with event-ID/atlas fixes; copy hashes verified. regression-runtime a303365e... /4dc157cd... . Evidence ../evidence/roadmap-39/change.md. Latest candidate native qualification still required; full gates open.

### 2026-09-27 — current candidate report preservation (roadmap-40)
New matching desktop/helper passes real MCP read-only report refusal/restart and10 native report UI operations. Evidence ../evidence/roadmap-40/change.md. Controlled fixture admission, no human pairing or full execution acceptance. All full gates open.

### 2026-09-27 — full native inventory (roadmap-41)
Current native library230 tests pass;37 ignored recorded. Explicit containment17 tests also pass, covering process/resource/output/cancellation limits. Evidence ../evidence/roadmap-41/change.md. Remaining fixture cases and3 compiler warnings not waived; full gates remain open.

### 2026-09-27 — broker stop and session isolation (roadmap-42)
Seven current-package integration cases pass for busy project isolation, stale handles, wrong executable rejection, idle/background heartbeat and revocation. Evidence ../evidence/roadmap-42/change.md. Full human/UI failure journey and acceptance gates remain open.

### 2026-09-27 — near-limit native snapshot (roadmap-43)
Current packaged host returns complete881279-byte110-task test ledger in one exact snapshot; canonical hash and bytes match, no approval/execution, cleanup complete. Evidence ../evidence/roadmap-43/change.md. Large native transport proof only; full gates remain open.

### 2026-09-27 — native test evidence correction (roadmap-44)
Two roadmap41 pass entries skipped assertions when fixtures were absent. Made prerequisites explicit and ran both actual packaged cases successfully. Evidence ../evidence/roadmap-44/change.md. Raw230 result remains historical; do not infer230 exercised checks. Full gates open.

### 2026-09-27 — current tests, settlement and capacity finding (roadmaps47–49)
Full frontend1562 Node PASS/8 native-dependent skips and502 UI PASS. New descendant-settlement native package:19 containment,5 execution,45 Node, six actual packaged integration checks PASS; default native228 PASS/41 explicit ignores. Evidence ../evidence/roadmap-47/change.md and ../evidence/roadmap-48/change.md. Population46b FAIL atT0128 due128-record enrollment limit;127 results retained, first120 reopened. Capacity repair49 in progress; no original removed or verified-task/full-gate claim. Latest copied package ../finalization-runtime. Boundaries identification/human native admission remain pending.

Roadmap49 capacity checkpoint: actual128-record failure reproduced and repaired to bounded2048 records;28 enrollment/grant tests PASS. OriginalT0128 and127 observations preserved. Evidence ../evidence/roadmap-49/change.md. Packaged integration/recovery/full155-execution proof still open. No full gate closed.

### 2026-09-27 — preserved pre-grant recovery (roadmap50)
ActualT0128 original now retains not-started proof/receipt without launch or journal clearing. Node64/UI19/native9/packaged8/FastCDP29 PASS; UI proof explicitly mocked IPC. Combined desktop ../recovery-runtime/built-recovery50 copied/hash-verified. Population resume137/155 running, old127 observations retained unchanged. Evidence ../evidence/roadmap-50/change.md. Full acceptance gates and real user repository journey remain open.

Roadmap50 final result:155retained outcomes,154zero exits/1deliberatefailure,8pages/journal620 exact reopen/replay PASS. All success outcomes remain result-unverified; noL10/fullgateclosure. Roadmap51 copies identified Property Boundary Viewer source to DANS1 boundaries-copy-20260927-51,3265files hash-verified with local changes; shipped Planner module reads test/build metadata. Evidence ../evidence/roadmap-51/change.md. Native consent/realMCP journey remains pending; original repo unchanged.

### 2026-09-27 — copied real-repository baseline (roadmap52)
DANS1 Boundaries copy provisioned and passes1515tests/typecheck/CIcompile;4live-service skips and build warnings retained. Source package/lock unchanged. Evidence ../evidence/roadmap-52/change.md. Direct baseline only, not Planner/MCP execution or native registration; full gates remain open.

Roadmap53: existing stale agent callback isolation verified by three added regression cases; 21 related UI tests PASS on DANS1. Initial bug hypothesis corrected, no production fix. Evidence ../evidence/roadmap-53/change.md. No full gate closure.

Roadmap54: current packaged native Notes and agent session UI18/18 PASS on scripted retained project. No live IDE claimed; native read returned no sessions. Evidence ../evidence/roadmap-54/change.md. Full acceptance remains open.

Roadmap55 / L06,L31 prerequisite: real Boundaries copy candidate capture failed old output/file/byte bounds. Bounded repair includes ignored dependencies;50176files/965899676bytes captured twice with exact digest.21 intermediate regressions and6 final candidate checks PASS. Evidence ../evidence/roadmap-55/change.md. New desktop build running; full native execution/deadline integration and real folder/IDE acceptance open.

Roadmap55 final package ../candidate-runtime55 built/copied/hash-verified; native UI18/18 PASS on retained scripted project. All processes terminal. Real Boundaries capture prerequisite repaired; actual admission/execution and full gates remain open.

Roadmap56 / L06,L20: outer native execution timeout now covers bounded candidate captures+check+settlement; before failure retained,19native supervisor tests PASS/3fixture ignores. Evidence ../evidence/roadmap-56/change.md. Actual large native execution and full gate acceptance open.

Roadmap57 / L06,L07: current deadline56 packaged execution/recovery8PASS/1population skip. Preserved failure and lost-reply recovery; no duplicate launch. Evidence ../evidence/roadmap-57/change.md. Small private fixture only; full supervisor/large-candidate/human workflow and full gates open.

Roadmap58 / L06,L07,L31 prerequisite: large candidate50177files/966MB actual inert native execution plus owner-reopen replay PASS; complete identity bound, four grant events unchanged. Evidence ../evidence/roadmap-58/change.md. Scripted disposable copy, no user code or human consent; all full gates open.

Roadmap59 / L06,L07 prerequisite: actual full Rust supervisor plus packaged host execute/replay/recover/result-read PASS, native disposable registry/census, scripted inert approval. No duplicate journal events, exact receipt readback, unverified authority preserved. Evidence ../evidence/roadmap-59/change.md. Full user journey, large combined supervisor case and all F-gates remain open.

Roadmap60 / L07,L11 new failure: full supervisor retry retains intent but no result; first failure preserved. Exact current candidate still matches, seven-event journal unchanged. Root cause unknown, diagnostic retention gap identified. Evidence ../evidence/roadmap-60/change.md. Owner Codex; do not relaunch unresolved original. No gate closure.

### 2026-09-27 — Creation workstations (user request; roadmap62)

L43 / F04,F05 — OPEN. Add a Creation section under Build showing a workstation for each assigned worker: task, latest observed action and time, waiting/blocker state, and linked output/preview where actually available. Preserve authoritative project/task/attempt attribution and history. Motion must follow fresh observed work, not a timer or heartbeat alone; disconnected/stale workers must stop looking busy. Show agent reports separately from independently observed execution and verified completion.

Owner: Codex. Dependencies: L03-L04 identity and ordering, L06 durable execution, L09 truthful failures, L12 worker claims, L17 real agent connection. Acceptance: DANS1 Fast CDP checks working-to-waiting/blocked/disconnected/finished transitions against retained events; reload and project switch preserve isolation; absent output and stale observations are explicit; keyboard access and reduced-motion are usable. Record actual live worker proof separately from controlled fixture tests. Design requirement recorded; implementation and acceptance remain open.

### 2026-09-27 — Goal-first route planning (user request; roadmap63)

L44 / F02,F04,F07 — OPEN. Replace terminal missing-input summaries with visible goal/current task, ranked alternative routes, sourced Sonar research where available, a navigable mind map, and prepared scoped connector/import actions. Rank by existing access, usefulness, effort, cost and privacy, explaining unknowns rather than inventing numeric confidence. Each missing input requires a next action or an explicitly unavailable route plus fallback. Finish planning possible with current information before requesting access; after access, revise affected branches without discarding decisions.

Owner: Codex. Dependencies: L03-L04 contracts; L16-L17 genuine connection/consent; L43 Creation activity. Acceptance: no-data screenshot scenario produces usable ranked paths; unavailable/revoked connectors show working alternatives; actions use verified adapters and exact project/task scope; grants and actual outcomes are distinct; branch selections survive reload and project isolation; DANS1 Fast CDP verifies keyboard navigation, selection, authorization handoff, refusal and fallback. Design: docs/task-route-planning.md. No current Sonar research, live connector setup or UI implementation claimed.

### 2026-09-27 — Normal chat/build with optional orchestration (roadmap64)

L45 / F02,F05,F07,F11 — OPEN. Build defaults to one main chat and supports a resizable output split and optional model grid. Add orchestration planning and peer-review tools inside that flow: shared goal, separately attributed proposals, lead synthesis, bounded optimization feedback rounds, side-by-side results and Jev reviewer integration when configured. Preserve all rounds and disagreements. Composer targets and shared context are explicit; failure/timeout of a participant cannot appear as agreement. Provider connections and costs are real, never simulated. User screenshot specifies interaction layout; preserve Planner visual identity.

Owner: Codex. Dependencies: L03-L04 attribution, L17 connection, L27-L29 worker coordination, L43 workstations, L44 Sonar routes. Acceptance: DANS1 tests normal and split chat, draft/history preservation, selected-recipient dispatch, partial failure, timeout/cancel, bounded rounds/budget, review revision binding, reload/project isolation and keyboard resizing. Actual multi-provider proof remains separate from deterministic fixtures. Detailed contract: docs/build-chat-orchestration.md. Jev's adapter identity remains unconfigured, not invented.

