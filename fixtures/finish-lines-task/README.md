# Finish-Line Formatter Fixture

This disposable, offline-only repository is prepared for a real Planner task. It contains no account data, credentials, network dependencies, or database.

## Task

Implement `formatFinishLine(work)` in `src/format-finish-line.mjs`.

- Return `<trimmed title> - <trimmed status> (owner: <trimmed owner>)`.
- If owner is missing or blank, use `unassigned`.
- Reject a missing work item, blank title, or blank status with a `TypeError` whose message names the missing value.
- Do not change the acceptance tests or add dependencies.

Run the acceptance check with `node --test`.