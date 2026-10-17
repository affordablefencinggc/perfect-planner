// Journey steps for the core loop screens, one module per screen under
// scripts/e2e-core-screens/. Each module exports `steps`: [{ name, run(page, at, { re, waitFor }) }].
// Run with npm run test:e2e (they follow the v1 journey in scripts/e2e-v1-journey.mjs).
import { steps as planning } from "./e2e-core-screens/planning.mjs";
import { steps as mvp } from "./e2e-core-screens/mvp.mjs";
import { steps as decisions } from "./e2e-core-screens/decisions.mjs";
import { steps as people } from "./e2e-core-screens/people.mjs";
import { steps as lookup } from "./e2e-core-screens/lookup.mjs";
import { steps as connect } from "./e2e-core-screens/connect.mjs";

export const coreScreenSteps = [...connect, ...planning, ...mvp, ...decisions, ...people, ...lookup];
