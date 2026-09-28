# T48 · Readable dotted planning canvases

## Requirement

Increase text inside planning cards by approximately 40%, create more space between canvas divs, restore the subtle dotted beige canvas, remove the blue selected-card outline, and provide full-page up/down movement for long plans.

## Scoped code difference

- `src/components/BlueprintWorkspace.css`
  - Increased Blueprint headers, gate cards, panel copy, contract rows, evidence rows, folder rows, and rulebook map typography by approximately 40%.
  - Increased card height, padding, list gaps, panel gaps, and map spacing to prevent crowding.
  - Restored the subtle 18 px dotted beige canvas.
- `src/styles.css`
  - Increased phase, node, checklist, proof-counter, and mind-map typography.
  - Increased phase separation to 96 px and work-package separation to 48 px.
  - Replaced the selected-node blue outline with a neutral chrome edge shadow.
  - Added the dotted canvas treatment to Plan and whole-plan map surfaces.
- `src/PerfectPlannerShell.jsx`
  - Added accessible up/down page controls that move the long plan by almost one viewport at a time.

## Measured render proof

- Blueprint gate heading: `14px` (previously `10px`).
- Blueprint contract heading: `11px` (previously `8px`).
- Blueprint panel gap: `22px` (previously `14px`).
- Plan checklist text: `11px` (previously `8px`).
- Work-package gap: `48px` (previously `22px`).
- Phase gap: `96px` (previously `52px`).
- Selected card outline: `none`; neutral multi-layer edge shadow present.
- Page-down control changed the live plan scroll position.

## Proof

- `blueprint-readable-dotted-canvas.jpg`
- `plan-readable-dotted-paged-canvas.jpg`
- 6/6 UI tests passed.
- Production build passed.

