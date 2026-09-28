# T45 · Coordinate opens on the execution spine

## Behavioural correction

- Selecting **Coordinate** always opens the primary top-down spine.
- A remembered `phase=P1` or another previous phase focus can no longer replace the Coordinate landing view.
- The expanded whole-plan phase map remains available only by deliberately selecting a silver phase capsule.
- Phase focus is removed from the address whenever the user leaves the Plan workspace.

## Preserved visual contract

- Five numbered phase capsules sit over one central chromium-steel spine.
- Ten numbered work-package cards alternate left and right.
- Every visible task keeps separate code-difference and screenshot-proof boxes.
- The head orchestrator remains perched above P1 and active workers remain attached to package perimeters.
- Collision and Allocation retain their purpose-built control surfaces; they are not misleadingly restyled as linear plan pages.

## Scoped code difference

- `src/PerfectPlannerShell.jsx`: adds one guarded workspace-navigation function and scopes phase deep links to the Plan workspace.
- `tests-ui/perfect-planner-shell.test.jsx`: proves that Coordinate converts `?workspace=plan&phase=P1` to `?workspace=plan` and restores the execution spine.

## Current proof

- Screenshot: `coordinate-spine-default.png`
- Browser state: 5 phase capsules, 10 work packages, 80 paired proof boxes, primary Plan region present, secondary phase-map region absent.
- UI tests: 6/6 passed.
- Production build: passed.
