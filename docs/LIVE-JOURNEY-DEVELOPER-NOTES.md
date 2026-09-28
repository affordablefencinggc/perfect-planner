# One live journey with Developer Notes

User-selected milestone: connect agent → submit small plan → see nodes → approve one change → see durable result. Everything else is deferred unless it blocks this journey.

## What the user should watch

Use the actual installed Planner with its Plan canvas visible, Antigravity alongside, and Developer Notes open from the lower-right button. The user gives the agent a single small change request. Stop at each authorization boundary. Each exchange gets a concise submitted summary, actual tool/action references, observed errors, a labelled hypothesis if the cause is unknown, next action and verification references. A proposed fix is never displayed as verified without independent outcome evidence. Deliberately fail one check, retry explicitly, restart and retain both results.

## Work457 implementation and current limits

DeveloperNotes is mounted in PerfectPlannerShell as a separate non-modal right drawer. Manual reviewed summaries use existing project-scoped Operations event storage, redaction, subscriptions and explicit pending/unsaved state. Fields: exchange reference, request, response/actions, observations, explanation, error, proposed solution and evidence reference. Notes are always labelled unverified local summaries, not authenticated agent reports. Newest notes appear first. No raw transcript collection, model-provider call or claim to inspect private reasoning.

DANS1:4 component tests pass for focus/close, persistence failure, project separation, validation and known secret-pattern redaction.20/20 Fast CDP operations pass in developer-notes-457c/text-aware-proof, cleanup true, using the actual component and browser IndexedDB across reload. Screenshot inspected. Background is explicitly explanatory, not a live plan. This is not installed/full-shell proof; shell positioning/collisions still need checking in the combined candidate.

Failed runs preserved. Initial focus assertion compared trailing whitespace. Browser waiting then exposed that the shared helper omits characterData mutations and missed React saving-to-saved text updates. Local campaign adapter now observes characterData; the shared runner was not edited. Rapid form updates use functional state updates, and browser input/submission occur in separate operations. Test PASS does not establish automatic exchange capture.

## Remaining acceptance — same milestone, not new feature expansion

- [ ] Project-bound authenticated exchange-note submission from the connected IDE agent. Reject foreign/replayed/conflicting exchange records; acknowledged receipt before advancing. A skill alone is not enforcement, and a missing note must visibly stay missing.
- [ ] Include session/turn sequence, producer identity, task/action/result references and explicit capture coverage. Tool receipts cannot be described as a complete prompt/reply transcript.
- [ ] Rebuild/install combined candidate on DANS1 and verify notes beside the real canvas without covering required controls. Preserve manual notes as separately attributed, unverified records.
- [ ] Provide a user-visible live viewing path to DANS1, not a screenshot gallery presented as live. No arbitrary new browser tabs or local product testing.
- [ ] Run the small approved change, deliberate failure, explicit retry and restart with retained results and notes. Only then mark this journey complete.

## Connected reports and desktop qualification — 14 September

The source now exposes `planner_report_exchange` through the packaged MCP helper. Native proposal-and-notes consent is explicit; read-only connections cannot submit notes. Reports bind to project, registered root/revision, authenticated session, exchange ID and session sequence. The owner retains redacted reports separately from manual notes. Exact canonical retries are idempotent; conflicting IDs cannot replace the original. A failed acknowledgment remains outcome-unknown. Reports never approve or verify task work.

Developer Notes reads those records through `read_agent_exchange_notes`, with its Tauri command permission registered. The panel refreshes every five seconds while open; browsing older reports pauses following. Read failures retain the displayed record with a stale warning. Coverage is explicitly reported-exchanges-only: MCP does not expose unreported IDE conversations, and no enforcement of every IDE turn is claimed.

Verified on DANS1:

- Four authenticated report/store tests and five UI tests pass. These cover save/reopen, retry/conflict, foreign/read-only/revoked refusal, redaction and visible read failure.
- Native regression rerun: 27 reported passes, 12 ignored. One existing packaged-fixture test returns early when its fixture is absent; these counts do not establish installed transport proof.
- 16/16 raw-CDP browser checks pass, with cleanup complete, in developer-exchange-458b/final-proof.
- New desktop candidate `com.perfectplanner.qualification459` built with the updated helper and module package. Actual packaged Tauri WebView: 12/12 steps pass, including native note permission/read, display and page reload. Sender was a controlled authenticated Node test session, not the public helper or Antigravity. Process and CDP cleanup confirmed. Evidence: developer-notes-desktop-459/proof/results.json and launch-result.json.
- Desktop executable SHA-256: `68ea9d40130626acaf64b26b8bf61caad99194d66a86b9c16594df9defa76ecf`. Package pin: `b986cf95ee5b3fe6117c63b642e381d6affbb3babb581e6d95c6563b16a7dca1`.

Failures retained: initial noncanonical fingerprint readback (fixed); missing explicit Node fixture; browser expression errors; missing workflow in staged build (copied exact source workflow, no integrity check disabled). No production user data or installed app was overwritten.

Current status: report feature implemented and native display qualified. Still open: actual Antigravity → packaged helper report delivery, automatic/missing-turn enforcement, user-visible live session, and the approved change/failure/retry/process-restart journey. Page reload is not a process crash test. Do not mark the whole milestone complete.
