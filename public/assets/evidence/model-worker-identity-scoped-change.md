# T51 · Model-aligned SVG workers

## Visible difference

- Replaced the single generic raster worker with model-specific SVG characters for GPT, Claude, Gemini, Llama, and Grok.
- The perched head orchestrator is explicitly GPT by OpenAI for the current Codex build context.
- Every plan package carries a stable `model` assignment and a visible model badge.
- Active packages use the directional running SVG, ready/queued/completed packages use the waiting SVG, and blocked/risk packages use the dead-still SVG.
- Worker labels state model, provider, owner, and current activity.
- The whole-plan map uses the same identity contract as the execution spine.

## Exact implementation scope

- `src/modelWorkerAssets.js` — central model/provider/asset/state registry.
- `src/plannerWorkspaceData.js` — stable model assignment for B01–B12.
- `src/PerfectPlannerShell.jsx` — model-aware worker, head orchestrator, labels, and badges.
- `src/styles.css` — native SVG sizing without duplicate sprite animation.
- `public/assets/model-workers/` — 20 local SVG state assets plus manifest, attribution, brand notice, and MIT licence.

## Proof

- Screenshot: `model-worker-identity-alignment.png`
- Package model order: GPT, Gemini, Llama, GPT, GPT, Llama, Claude, Gemini, Grok, GPT.
- Active B07 resolves to `/assets/model-workers/running-right/openai-gpt.svg`.
- Production build passed.
- UI tests passed 6/6.

## Licence and identity boundary

The icons are stored locally with their supplied attribution, brand-use notice, manifest, and LobeHub MIT licence. Product marks identify providers only; they do not imply endorsement.
