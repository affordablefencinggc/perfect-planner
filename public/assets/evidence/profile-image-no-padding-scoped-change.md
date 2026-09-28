# Person profile image with no padding — scoped change

## Requested outcome

Show only the circular person photograph: no white padding, double outline, or surrounding halo.

## Source difference

- Human `.profile-avatar` badges now remove border, background, and box shadow entirely.
- Danie’s supplied portrait is cropped more tightly so the source card’s own outer ring is outside the visible circle.
- The 32 × 32 px badge size remains unchanged.
- Agent icons retain their separate chrome identity treatment.

## Verification

- Production compilation passes.
- Screenshot viewing proof remains required before the ledger item can be crossed off.
