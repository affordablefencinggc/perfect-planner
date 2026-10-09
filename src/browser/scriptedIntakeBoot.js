// Imported first by main.jsx so the scripted picker exists before the workspace adapter is chosen.
// __PP_SCRIPTED_INTAKE__ is set by vite.config.mjs: true on the dev server or in a build made with
// PP_TEST_INTAKE=1, false in every release build (where this whole branch and its import are removed).
import { installScriptedIntake } from "./scriptedIntake.js";

if (typeof __PP_SCRIPTED_INTAKE__ !== "undefined" && __PP_SCRIPTED_INTAKE__ === true) {
  installScriptedIntake(globalThis, { enabled: true });
}
