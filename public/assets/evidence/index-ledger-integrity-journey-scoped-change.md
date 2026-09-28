# T52 · Index, ledger, integrity, and journey readability

## Index

- Alphabet rail fills the visible scroll height rather than stretching to the entire register.
- Register cards occupy approximately 40% of the available index width.
- Search and filter controls have clear, larger headings.
- Every entry exposes a numeric completion percentage and named worker.
- Top metrics have a separate responsive lane and no longer overlap navigation at 2327×1192.

## Ledger

- Source rows are larger and now show completion, worker, and trace separately.
- Build commitments have wider spacing and expand into full evidence dossiers.
- Expanded dossiers disclose owner, Git/commit truth, screenshot reference, scoped difference, code errors, CI state, and task/file claims.
- Missing evidence remains visibly missing; the UI does not invent a green result.

## Integrity

- Guarantee panels are capped at 560 px rather than forming long full-width strips.
- Session, explanation, wave, and lane typography is enlarged for scanning.
- Truth panels retain the wider summary role while operational panels remain compact.

## Evidence journey

- Cards are more than twice the previous height, with substantially more row spacing and a 55% wider spine lane.
- Dotted beige canvas is restored.
- Calendar scrubber supports Months, Weeks, and Days and controls a full-width silver time line.
- Up/down controls sit directly on the centre spine.
- Every card shows people and touched-file counts and expands to exact declared file paths and screenshot state.

## Proof

- `index-full-height-completion.png`
- `ledger-expanded-proof-dossier.png`
- `integrity-readable-compact-panels.png`
- `evidence-calendar-expanded-journey.png`
- Browser checks at 2327×1192: no metric/navigation overlap; alphabet rail equals visible index-body height; SRC-058 is 65% by Danie + Codex; J02 expands to two exact files.
- UI tests: 6/6 passed.
- Production build: passed.
