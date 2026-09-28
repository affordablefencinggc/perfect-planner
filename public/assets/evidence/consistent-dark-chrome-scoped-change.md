# T49 · Consistent dark-chrome finish

## Requirement

Keep the chrome colour consistently dark instead of changing brightness around each bezel.

## Scoped code difference

- `src/styles.css`
  - Locked `--chrome`, `--chrome-dark`, and the bezel edge to neutral steel `#7f868a`.
  - Replaced the multi-stop brightness gradient with a constant-colour steel edge.
  - Replaced the spine highlight gradient with the same constant dark steel.
  - Preserved white card interiors and the dotted beige canvas.

## Measured render proof

- Card edge: `rgb(127, 134, 138)` at both gradient stops.
- Phase capsule edge: `rgb(127, 134, 138)` at both gradient stops.
- Spine: solid `rgb(127, 134, 138)` with no background image.

## Proof

- `coordinate-consistent-dark-chrome.jpg`
- 6/6 UI tests passed.
- Production build passed.

