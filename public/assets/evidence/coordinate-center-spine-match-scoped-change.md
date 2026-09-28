# T46 · Reference-matched Coordinate centre spine

## Reference contract

The supplied original Perfect Planner image defines the centre composition:

- one narrow, pale chromium spine centred on a warm beige field;
- wide phase capsules centred over the spine;
- compact work-package cards alternating left and right;
- short dashed connectors ending at small white vertebrae;
- generous negative space between the cards;
- no full-width mind-map branches in the default Coordinate view.

## Scoped code difference

- `src/styles.css` only.
- Coordinate canvas width is bounded to 1040 px.
- Phase capsules are 420 × 76 px.
- Work-package cards are 450 px wide and approximately 154 px high with current content.
- The alternating grid is `460px 120px 460px`.
- The spine is 4 px pale steel with white junctions and short green dashed connectors.
- Card padding, typography, counters, owner ring, border, and shadow were tightened to match the original visual density.

## Screenshot proof

- `coordinate-center-spine-match.png`
- Browser measurement: 5 phase capsules, 10 alternating work-package cards, 420 px phase bezel, 450 px package cards, 1040 px centre canvas.
- UI tests: 6/6 passed.
- Production build: passed.
