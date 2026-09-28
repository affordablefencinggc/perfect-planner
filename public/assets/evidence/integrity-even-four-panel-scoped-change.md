# Integrity four-panel layout — scoped change

## Requested outcome

Keep the existing Integrity content, but present Session truth, Positive parallel map, Proof-pack integrity, and Completion contract as four evenly sized panels.

## Source difference

- `src/PerfectPlannerShell.jsx`: groups the four operational guarantees inside one dedicated layout boundary.
- `src/styles.css`: applies an equal 2 × 2 grid, equal 460 px rows, equal column widths, consistent 18 px gaps, and removes per-panel maximum-width differences inside the grid.
- The Local truth core remains separate and does not distort the four-panel block.
- Narrow screens retain a single-column readable fallback.

## Verification

- Production compilation passes.
- Screenshot proof remains required before the ledger item may be crossed off.
