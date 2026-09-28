# T50 · Consistent chrome lightened by 50%

## Requirement

Keep the uniform chrome treatment and make it 50% lighter.

## Scoped code difference

- `src/styles.css`
  - Mixed the previous neutral steel `#7f868a` halfway toward white, producing `#bfc3c5`.
  - Applied the same value to `--chrome`, `--chrome-dark`, the constant bezel edge, and the centre spine.
  - Preserved white card faces, beige dots, spacing, and selection shadows.

## Proof

- `coordinate-consistent-light-chrome.jpg`
- Rendered chrome value: `#bfc3c5` / `rgb(191, 195, 197)`.
- 6/6 UI tests passed.
- Production build passed.

