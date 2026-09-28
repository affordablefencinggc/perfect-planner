# Centred plan-page controls — scoped change

## Requested outcome

Move the plan-page navigation to the dead centre of the visible page, raise it from its previous near-bottom position, and reduce the arrow buttons by 50%.

## Source difference

- Sticky vertical placement changed from `calc(100vh - 210px)` to `calc(50vh - 34px)`.
- The control remains horizontally centred on the plan spine through automatic side margins.
- Arrow buttons changed from 34 × 34 px to 17 × 17 px.
- Arrow icons changed from 18 × 18 px to 9 × 9 px.
- The containing chrome capsule was tightened to match the smaller controls.

## Verification

- Production compilation passes.
- Screenshot viewing proof remains required before this ledger item can be crossed off.
