# Profile chrome-bezel restoration — scoped change

## Requested outcome

Do not change the outline bezel colour when profile photographs are introduced; restore it to chrome.

## Source difference

- Every owner avatar now uses the shared uniform `var(--chrome-dark)` border.
- Per-owner identity colours no longer tint the outer profile bezel.
- Profile photographs and agent icons remain unchanged.

## Verification

- Production compilation passes.
- Screenshot viewing proof remains required before the ledger item can be crossed off.
