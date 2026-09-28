# Owner hover mini-profile — scoped change

## Requested outcome

When the mouse hovers over a person’s circular image, show a compact profile preview like a team messenger identity card.

## Source difference

- Human owner badges now reveal a floating mini-profile on hover.
- The preview contains a 58 px circular photograph, full owner name, role, and live activity state. The earlier message cue was removed by the subsequent uniform-icon refinement.
- The preview is positioned outside normal layout flow, so plan cards do not resize or shift.
- The card uses a white surface, thin chrome outline, and restrained shadow.
- Agent icons do not show a human profile card.

## Verification

- Production compilation passes.
- Screenshot viewing proof remains required before the ledger item can be crossed off.
