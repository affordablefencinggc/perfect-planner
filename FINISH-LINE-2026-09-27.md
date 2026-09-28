# Perfect Planner: finish-line delivery plan

Revision 3 · 27 September 2026 · Implementation owner: Codex · Revised following Jev's request to split exits and prioritize retry repair before the real journey.

## Finish means this

On one identified Windows release candidate, a user opens a real repository, connects an agent, plans a change, sees the same tasks in chat/map/ledger, approves and executes scoped work, sees a truthful result, fixes a failed attempt without losing history, and reopens the app with that history intact. Two workers cannot silently overwrite each other's work. The combined result is tested before integration. Optional multi-model planning works through real providers with bounded rounds/costs and attributable review, including Jev once configured.

All existing F01–F12 and L01–L45 requirements remain binding. This plan changes order and reporting, not the definition of success. No full acceptance gate is currently closed. A usable core demonstration is an intermediate milestone, not “the app is finished.”

## What is established, and what is not

| Current evidence | Practical limit |
| --- | --- |
| DANS1 SSH, offline toolchain and native packaging work | Original installed application has not been replaced with a qualified final candidate |
| Boundaries copy: 1,515 baseline tests passed, four external-service checks skipped | Baseline ran directly, not through the complete approved Planner workflow |
| Full native supervisor executed an inert check, retained a result, replayed and read it | Scripted fixture approval; real human consent and IDE journey remain open |
| Large candidate snapshot and inert native execution qualified on over 50,000 files | Does not establish exclusive candidate custody or verified Boundaries tasks |
| Failed first check is retained; fresh retry campaigns 60 and 61 fail after intent | Current highest-priority defect; root cause unknown. Stage: dispatch. Preserve both originals |
| Sonar routes and orchestration round models have focused passing tests | No integrated live multi-provider orchestration, durable orchestration journal or finished chat UI |

## Seven milestones, in this order

Each milestone has one implementation owner, Codex. Jev reviews the plan and later the release evidence if reachable; user actions are limited to genuine native/account consent. Work within a milestone follows its dependencies. Do not start unrelated new features to avoid a failing exit check.

| Milestone | Deliverable and exact exit check | Dependencies / ledger coverage |
| --- | --- | --- |
| **M1 — Reliable execution and retry** | Find the dispatch failure, repair it, and run a fresh isolated native scenario: fail → retain failure → change candidate → explicit retry → retain success → duplicate/read/restart without relaunch. Show both attempts in the actual desktop. Keep 60/61 unresolved originals intact. Close final-candidate custody, producer authority and required-check aggregation so “verified” has a defensible meaning. | First. L01,L03–L09,L11,L20; F01–F04,F07. |
| **M2 — One real Boundaries journey** | Current package on DANS1: native folder selection → real IDE/MCP connection → small plan → matching task IDs in Plan/Ledger/Notes → scoped approved change on the disposable copy → actual check → visible result → restart. Negative run proves stale/revoked access is refused. Retain source/diff/result and Fast CDP evidence. No scripted approval substitutes for human consent. | M1; L16–L19,L31. |
| **M3 — Safe coordinated work** | Two actual workers: collision refused/serialized before writes, safe independent work proceeds, moved base invalidates proof, interrupted rehearsal preserves dirty/untracked/ignored work. Verify exact combined candidate. Exercise real secret/scanner gates, configured CI boundary, brief/acknowledgment deadlines and stall notification. Missing external services remain explicit unresolved requirements. | M1–M2; L12–L15,L21–L29; F05–F10. |
| **M4 — Chat, Sonar and Creation** | Build has normal single chat plus optional output/model split; draft/history survive layout and project changes. Goal yields ranked actionable Sonar paths, connected map/list and real adapter handoff. Creation shows only attributable activity with waiting/stale/failure states. No decorative “working” or fake connector buttons. | M2 and scoped activity from M3; L30–L36,L43–L44. |
| **M5 — Live orchestration with Jev** | At least two configured model participants receive the same approved brief; lead synthesizes referenced outputs; Jev reviews exact revision; one optimization round retains all earlier outputs and disagreements. Durable journal, exact recipient targeting, budget reservation/accounting, cancellation, timeout, duplicate handling and restart are exercised. Partial replies remain partial. Jev identity/provider must be resolved before this exit is accepted. | M2–M4; L45 and F02,F07,F10–F11. |
| **M6 — Whole-product acceptance** | Same revision's 155 obligations reconcile as 154 verified and one deliberate failure; retry preserves first failure. Execute all current route/button, two-project, large-map, keyboard/zoom, offline and corrupt/recovery matrices on DANS1. Run full current suites and classify every failure/skip/warning against requirements. Every result links to the exact source/runtime. | M1–M5; L10,L30–L36,L39–L40; F04,F11. |
| **M7 — Release and independent review** | Freeze one source manifest, build/verify executable and every helper, clean-install test, replay the real user journey, obtain independent findings and resolve them with affected retests. Close every F01–F12 criterion and L01–L45 acceptance or obtain an explicit user-approved scope change. Deliver candidate, rollback/preservation instructions and known limitations. Deployment remains a separate action. | M6; L37–L42; F12. |

## Immediate execution queue

### Current checkpoint board

| Checkpoint | State / last observed result | Blocker | Owner / next action |
| --- | --- | --- | --- |
| M1 baseline | OPEN; source and runtime manifests exist for individual campaigns, not one reconciled latest candidate | Later Sonar/orchestration files differ from packaged runtime | Codex: freeze and compare the exact repair input before edits; record differences without rebuilding unrelated work |
| M1a diagnosis | ACTIVE; campaigns60/61 both fail at retry dispatch after durable intent | Underlying cause unclassified | Codex: trace the retained diagnostic and wrapper cause taxonomy; obtain diagnostic review before a third fresh reproduction |
| M1b–d repair and desktop proof | QUEUED | Root cause and trustworthy final result semantics | Codex: regression, fix, fresh native journey, then current desktop proof |
| M2 real journey | QUEUED; Boundaries copy and direct baseline available | M1 and genuine native/IDE consent | Codex prepares package/session; user supplies consent only when ready |
| M3–M7 | QUEUED; existing bounded evidence retained | Earlier connected exits | Codex follows the checkpoint sequence; no feature expansion ahead of M2 |

Before closing each checkpoint, record: exact source and runtime hashes, one sentence describing observable acceptance, actual evidence path, observed result, retained failure history, reviewer/disposition when required, and the next checkpoint. Status is OPEN, ACTIVE, WAITING, FAILED or ACCEPTED. Tests that cover a different candidate are historical evidence. Missing evidence cannot close a checkpoint.

The baseline freeze is part of F01 and happens **before M1 repair**, not at M2 packaging. Later M2a and M7a repeat identity checks for their respective candidates. Diagnostic review after the two existing retry failures is mandatory before another reproduction; this is already triggered, not a future rule.

### Individually closable checkpoints

Each checkpoint closes only with its named evidence; partial completion does not close its parent milestone.

### First work package: exact retry acceptance checklist

Work only through this list until the native retry is demonstrably repaired. All tests run on DANS1 in fresh isolated fixtures. Each checkbox gets its own evidence reference and remains unchecked until observed.

- [ ] **R0 — Freeze input:** record local/remote source hashes and executable/helper identities; list every difference between repair input and latest source.
- [ ] **R1 — Preserve failures:** confirm campaigns60/61 original requests, intents and diagnostics remain retained; no relaunch, clearing or invented terminal state.
- [ ] **R2 — Explain failure:** identify the failing operation and a testable cause from code/diagnostics; record competing explanations and a diagnostic review before a third reproduction.
- [ ] **R3 — Reproduce narrowly:** a focused test fails on the identified defect using pre-fix source, with expected and observed behavior recorded.
- [ ] **R4 — Fix narrowly:** the same test passes with the correction; related dispatch/recovery regressions pass, without weakening assertions.
- [ ] **R5 — Record first failure:** a fresh actual native check returns deliberate exit7; durable result and task/attempt identity agree.
- [ ] **R6 — Explicit retry:** change the disposable candidate and submit a new request/attempt; execution returns the expected result and retains a distinct candidate identity.
- [ ] **R7 — Preserve history:** first failure remains byte-identical and discoverable alongside the retry; no count silently excludes it.
- [ ] **R8 — Replay safely:** duplicate requests and reads return retained outcomes without another launch or journal mutation.
- [ ] **R9 — Reopen safely:** restart the owner and repeat reads/recovery; unresolved attempts remain unresolved and do not relaunch.
- [ ] **R10 — Display accurately:** actual desktop shows both attempts, their correct task association and current result; Fast CDP captures reload and failure details.
- [ ] **R11 — Separate execution from verification:** candidate custody, producer authority and all required checks are individually demonstrated before any result is labelled verified. Otherwise the UI retains result-unverified.

R0–R4 close M1a; R5–R9 close M1b; R11 closes M1c; R10 closes M1d. No further implementation expansion is needed to discover whether this work package passes.

- **M1a:** identify dispatch root cause with a failing regression and safe diagnostic evidence. **M1b:** fixed native failure/retry/replay/restart scenario passes, preserving original attempts. **M1c:** custody, producer and all-required-check rules reject changed or incomplete candidates. **M1d:** actual desktop displays both attempts and truthful current state.
- **M2a:** exact package prepared and hashes checked. **M2b:** genuine folder/IDE approval and project-bound connection verified. **M2c:** real agent plan, approved disposable Boundaries change and actual check result agree across UI and receipts. **M2d:** restart/revoke/reconnect preserve truth.
- **M3a:** collision and stale-base admission tests with two workers. **M3b:** interrupted worktree recovery preserves dirty/untracked/ignored files. **M3c:** actual secret and scanner gates cover missing/partial/stale cases. **M3d:** combined-candidate proof and configured CI separation. **M3e:** scoped briefs, acknowledgments, deadlines, stall detection and real notification delivery evidence.
- **M4a:** single/split chat retains project drafts/history. **M4b:** Sonar map/list route selection and real connector handoff. **M4c:** Creation activity reflects actual events, including stale and blocked states.
- **M5a:** durable journal, budget reservations and provider identities. **M5b:** two live model proposals and source-bound lead synthesis. **M5c:** configured Jev review and one preserved optimization round. **M5d:** timeout/cancel/restart/duplicate and partial-response tests.
- **M6a:** exact 155-obligation result accounting and retained retry. **M6b:** complete page/action and accessibility matrix. **M6c:** two-project, large-repo/map and survival matrix. **M6d:** complete current suites, performance measurements and disposition of every skip/warning.
- **M7a:** frozen source/runtime/helper hashes and clean install. **M7b:** independent code/evidence review and finding dispositions. **M7c:** exact final-candidate user walkthrough and all-gate release record.

### Mandatory gate coverage

F01 → M2a/M7a baseline and final manifests; F02 → M1c/M5a identity and transitions; F03 → M1b plus M6c interrupted writes, disk refusal and restart; F04 → M1d/M6a exact accounting; F05 → M3a conflicts and stale scope; F06 → M3b including ancestor/junction substitution, store allowlist and discovery-before-side-effects; F07 → M2b–d plus M1b bounded native calls, revocation and descendant settlement; F08 → M3c actual credential/policy/scanner gates; F09 → M3d combined candidate, moved target and retained rejection; F10 → M3e scoped worker communication and independent supervision; F11 → M4 plus M6b–c every existing route/import/keyboard/zoom/export/Simple–Advanced criterion; F12 → M6c–d/M7 clean install, concurrency, corruption, disk/network failures, complete suites, independent review and real journey. Original detailed F criteria remain the acceptance checklist for each mapping.

1. Inspect the dispatch wrapper's unclassified cause from campaign 61 using code and bounded diagnostics. Do not print arbitrary private messages or rerun unresolved originals.
2. Write a focused regression for the identified defect, fix it, then one fresh full-supervisor retry campaign. If it fails, retain it and revise the diagnosis; repeating the same run is not progress.
3. Wire the proven retry/result path into the current desktop and verify both attempts with Fast CDP. Close custody/aggregation/producer gaps before upgrading result-unverified to verified.
4. Prepare the exact M2 package and one consolidated user session for folder/IDE/native approval. Continue independent fixes while awaiting genuine consent.
5. Finish the M2 demonstration before expanding orchestration UI. Keep existing Sonar/orchestration code, but do not mistake isolated reducers for completed features.

## Rules that stop another endless loop

- Freeze feature scope at L01–L45. New ideas go into a later-release backlog unless the user explicitly changes this plan. No existing requirement is silently dropped.
- Work in connected slices. Every implementation checkpoint identifies the visible journey it closes and its remaining dependency. Avoid another isolated utility unless the next integration needs it.
- Keep one current status table: milestone, exit check, last observed result, exact blocker, owner, next action. Historical logs remain evidence, not the active queue.
- After two unsuccessful fresh campaigns on the same invariant, stop blind retries. Request a diagnostic/design review with preserved evidence and a specific competing explanation before another run.
- Targeted regression plus connected journey first. Run the full inventory at M6 and after material release changes, not after every reversible edit.
- Do not add historical test totals or infer an overall percentage. Report milestones accepted out of seven and requirement-specific evidence. Currently **0/7 milestones accepted**.
- No calendar completion promise yet: M1's root cause and real provider setup are unresolved. After M2, record an evidence-based estimate for remaining milestones, including external waiting time separately.

## Dependencies to resolve once

| Dependency | Owner / next action | Blocks |
| --- | --- | --- |
| Jev identity and integration | Resolved for external plan review: TypeSafe systemone, jev-latest returned jev-1.13.0. Product-side configuration remains to integrate without copying credentials into Planner source | M5 product integration |
| DANS1 native folder/IDE consent | Codex prepares exact candidate; user performs a consolidated genuine approval session | M2 acceptance |
| Model provider configuration and spending limits | Inventory supported adapters without reading saved credentials; obtain only missing provider selection/authorization | M5 live dispatch |
| Scanner, CI and notification services | Inventory existing authorized configurations, expose specific missing service choices | Relevant M3/full-release criteria |

## Reviewer request and acceptance

Review packet: [docs/JEV-FINISH-LINE-REVIEW.md](docs/JEV-FINISH-LINE-REVIEW.md). Reviewer must challenge sequencing, omissions, vague exits and unnecessary scope, and identify the shortest credible route to the first real user demonstration. Record findings with severity, milestone, recommended change and acceptance test. Incorporate accepted changes in revision 2 with a disposition for every finding.

**Review status: revision 1 reviewed; revision 2 revised, not yet approved.** Actual response: plan_verdict=revise; immediate_priority=retry_then_journey; staging=split_exits; scope_preserved returned noul=0.41 without textual findings. Evidence: ../evidence/roadmap-66/jev-request.json and jev-response.json. The API supplied classifications only; no narrative findings were returned. Codex's response was to split milestone exits and explicitly map every mandatory gate above. These amendments are Codex's interpretation, not invented Jev quotations. Plan review is distinct from final implementation/release review.

**Latest disposition:** revision 3 was reassessed through jev-1.13.0; response retained at ../evidence/roadmap-67/jev-response.json. It again selected revise / split_exits / retry_then_journey and returned noul=0.58 for scope preservation. No narrative findings were supplied. The immediate package has subsequently been expanded into R0–R11 above. This last amendment has not been reassessed. Jev approval remains outstanding; do not reinterpret its numeric output as release certification. Avoid repeated classification calls without more actionable review criteria.
