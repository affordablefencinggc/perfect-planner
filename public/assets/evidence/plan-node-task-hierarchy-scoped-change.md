# Plan-node task hierarchy — scoped change

## Requested outcome

Make side-node task numbers bold black, task names thinner black, and checklist boxes square dark grey.

## Source difference

- Node and checklist task IDs now use an 800-weight near-black monospace treatment.
- Node and checklist task names now use a thinner 400–500-weight black treatment.
- Unchecked proof boxes now use square 1 px corners and a dark neutral-grey border.
- Verified boxes preserve the existing green proof state so completion truth remains visible.

## Verification

- Production compilation passes.
- Screenshot viewing proof is still required before the ledger item can be crossed off.
