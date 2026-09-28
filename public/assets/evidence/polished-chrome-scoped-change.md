# T47 · Neutral polished-chrome canvas system

## Requirement

Replace the navy-grey-looking bezels with a neutral stainless/chrome finish while retaining the white card faces and beige canvas.

## Scoped code difference

- `src/styles.css`
  - Replaced the blue-grey chrome variables with neutral light, mid, and dark steel values.
  - Added a multi-stop polished chrome bezel gradient to the spine, capsules, cards, and vertebrae.
  - Kept card interiors white and the canvas beige.

## Proof

- `coordinate-polished-chrome.png`
- 6/6 UI tests passed.
- Production build passed.

