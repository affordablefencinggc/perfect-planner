# T44 · Unified stainless header and expanded P1 map

## User-visible change

- Replaced the beige top bar with one light polished stainless-steel header.
- Moved the workspace context row inside that header so the page has one header region, not two stacked headers.
- Increased header labels, status information, navigation text, and icons by approximately 30%.
- Reused the former beige header colour as the main workspace background.
- Increased horizontal and vertical space around phase rows, phase bezels, branch lanes, and work-package cards.

## Scoped code difference

- `src/PerfectPlannerShell.jsx`: wraps primary navigation and current-workspace context in the same `header.topbar`; removes the duplicate context region from `main.app-main`.
- `src/styles.css`: introduces one 118 px header contract, polished steel layers, larger header typography/icons, beige main canvas, and wider/taller phase-map geometry.

## Screenshot proof

- `plan-p1-stainless-header-spacing.png`
- Captured from `/?workspace=plan&phase=P1` after the production build.
- The browser reported a 118 px unified header, the main workspace beginning immediately below it, and no document-level overflow.

## Verification

- UI test suite: 5/5 passed.
- Production build: passed.
- Visual check: header is one DOM region; current workspace context is inside it; P1 map retains two explicit child packages with expanded spacing.
