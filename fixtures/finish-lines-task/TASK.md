# Planner task: Finish-Line summary formatter

Implement the pure `formatFinishLine(work)` function described in README.md.

- `work` must be a non-null object.
- `title` and `status` must be strings with non-whitespace content; trim both before formatting.
- `owner` is optional; trim it when it is a non-blank string, otherwise display `unassigned`.
- Throw a `TypeError` for a missing work item, blank title, or blank status. The error message must name the missing value.
- Preserve the acceptance tests and do not add dependencies.

Run the acceptance check with `node --test`.

The task is complete when the implementation and passing test output are attributable to the assigned worker, the owner approves the proposed change, and Planner records the passing result and final task state.