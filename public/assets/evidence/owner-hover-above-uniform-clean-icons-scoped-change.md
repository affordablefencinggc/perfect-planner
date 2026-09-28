# Owner hover above with uniform clean icons — scoped change

## Requested outcome

Display owner previews above their icons, make every person icon clean and identically sized without white padding, and remove the unwanted click-to-message text.

## Source difference

- Hover previews now anchor above the person icon using a bottom offset.
- All plan-card human images retain the same 32 × 32 px circular frame.
- The three-photo mock sprite is cropped more tightly per person so each face fills its circle without white margins.
- Danie’s individual image retains its tight no-padding crop.
- The `CLICK TO MESSAGE` line is removed from profile previews.

## Verification

- Production compilation passes.
- Screenshot viewing proof remains required before the ledger item can be crossed off.
