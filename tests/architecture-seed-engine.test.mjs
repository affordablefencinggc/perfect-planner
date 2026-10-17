import assert from "node:assert/strict";
import test from "node:test";

import { deriveDiscoveryReview, nextDiscoveryReviewData } from "../src/project/discoveryReviewModel.js";
import { readWorkRecords, writeSection } from "../src/project/projectWorkRecords.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";
import { applyArchitectureSeed, architectureSeedProgress, blankArchitectureDraft, readDraftField, suggestArchitectureSeed, writeDraftField } from "../src/engine/architectureSeedEngine.js";
import { evaluateArchitectureRulebook } from "../src/engine/rulebookEngine.js";

const AT = "2026-09-04T11:00:00.000Z";

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}

// A Tauri desktop repo like the one in the gap report: Tauri files observed, A03/A04/A06/A07 answered.
function tauriFixture({ answers = { A03: "React UI in src, Rust commands in src-tauri; the Rust side owns saved files.", A04: "Local JSON files on the user's computer; single user; no sign-in.", A06: "Tauri capabilities deny by default; no secrets in the app.", A07: "npm start for development and a signed Tauri installer for release." }, discoveryState = "generated" } = {}) {
  const rootIdentity = "a".repeat(64);
  const session = createImportedProjectSession({
    name: "Perfect Planner", adapter: "native", now: AT,
    registration: { access: "metadata-read-only", canonicalRoot: "C:\\dev\\perfect-planner", registryRevision: 6, rootIdentity, workspaceId: "perfect-planner" },
    census: { digest: "b".repeat(64), fileCount: 764, generatedEpochMs: Date.parse(AT), registryRevision: 6, rootIdentity, skipped: [], totalBytesHashed: 100, workspaceId: "perfect-planner" },
    discovery: {
      state: discoveryState, generatedAt: AT, counts: { observed: 6, signals: 4, unanswered: 1 },
      categories: [
        { id: "A01", state: "observed", findings: [{ id: "S001" }, { id: "S002" }] },
        { id: "A02", state: "observed", findings: [{ id: "S010" }, { id: "S012" }, { id: "S013" }] },
        { id: "A03", state: "observed", findings: [{ id: "S020" }, { id: "S022" }, { id: "S023" }] },
        { id: "A04", state: "signal", findings: [{ id: "S031" }] },
        { id: "A05", state: "observed", findings: [{ id: "S040" }] },
        { id: "A06", state: "signal", findings: [{ id: "S051" }] },
        { id: "A07", state: "observed", findings: [{ id: "S060" }, { id: "S062" }] },
      ],
    },
  });
  const storage = memoryStorage();
  let data = null;
  for (const [id, note] of Object.entries(answers)) {
    data = nextDiscoveryReviewData(session, data, id, "answered", { note, now: () => AT });
  }
  if (data) writeSection(session.projectId, "discoveryReview", data, { storage });
  return deriveDiscoveryReview(session, readWorkRecords(session.projectId, storage));
}

test("Tauri files suggest the least-privilege Tauri template and platform, with the scan as source", () => {
  const seed = suggestArchitectureSeed(tauriFixture());
  assert.equal(seed.available, true);
  assert.equal(seed.template.id, "tauri-local-desktop");
  assert.equal(seed.template.platform, "tauri");
  assert.equal(seed.template.source.id, "S012");
  assert.match(seed.template.source.label, /folder scan/i);
  assert.deepEqual(seed.useCases.map((item) => item.id), ["desktop-distribution"]);
});

test("discovery answers seed the matching decisions and name their source area", () => {
  const seed = suggestArchitectureSeed(tauriFixture());
  const field = (path) => seed.fields[path];
  assert.equal(field("decisions.data.choice").value, "Local JSON files on the user's computer; single user; no sign-in.");
  assert.equal(field("decisions.data.choice").source.id, "A04");
  assert.equal(field("decisions.data.choice").source.label, "From your discovery answer A04 (Data, tenancy & auth)");
  assert.equal(field("decisions.identity-auth.choice").source.id, "A04");
  assert.equal(field("decisions.platform.rationale").source.id, "A03");
  assert.equal(field("nonFunctional.securityTarget").source.id, "A06");
  assert.equal(field("answers.capabilityPolicy").source.id, "A06");
  // The person's answer beats the scan for how the app ships.
  assert.equal(field("decisions.deployment-distribution.choice").source.id, "A07");
  assert.equal(field("decisions.platform.choice").source.id, "S012");
  assert.match(field("decisions.platform.evidence").value, /src-tauri\/tauri\.conf\.json/);
  // Nothing the scan or answers do not cover is invented.
  for (const path of Object.keys(seed.fields)) assert.ok(!path.startsWith("scenarios."), path);
  assert.equal(field("nonFunctional.performanceBudget"), undefined);
  assert.equal(field("decisions.state-sync.choice"), undefined);
});

test("signal-only findings and the misleading hosting file are not treated as facts", () => {
  const seed = suggestArchitectureSeed(tauriFixture({ answers: {} }));
  const sources = Object.values(seed.fields).map((item) => item.source.id);
  for (const id of ["S031", "S051", "S023", "S062"]) assert.ok(!sources.includes(id), id);
  assert.equal(seed.fields["decisions.deployment-distribution.choice"].source.id, "S012");
});

test("no scan or a stale scan offers nothing and says why", () => {
  assert.equal(suggestArchitectureSeed(null).available, false);
  assert.match(suggestArchitectureSeed(null).reason, /Scan the app folder/);
  const stale = suggestArchitectureSeed(tauriFixture({ answers: {}, discoveryState: "stale" }));
  assert.equal(stale.available, false);
  assert.match(stale.reason, /out of date/);
});

test("applying a seed never overwrites typed values and never makes the draft publishable", () => {
  const seed = suggestArchitectureSeed(tauriFixture());
  let draft = blankArchitectureDraft();
  draft = writeDraftField(draft, "decisions.data.choice", "SQLite file I chose myself");
  const { draft: seeded, filled } = applyArchitectureSeed(draft, seed);
  assert.equal(readDraftField(seeded, "decisions.data.choice"), "SQLite file I chose myself");
  assert.ok(!filled.includes("decisions.data.choice"));
  assert.equal(seeded.suggestions["decisions.data.choice"], undefined);
  assert.equal(seeded.templateId, "tauri-local-desktop");
  assert.equal(seeded.platform, "tauri");
  assert.deepEqual(seeded.useCases, ["desktop-distribution"]);
  assert.equal(readDraftField(seeded, "decisions.identity-auth.choice"), "Local JSON files on the user's computer; single user; no sign-in.");
  assert.equal(seeded.suggestions["decisions.identity-auth.choice"].source.id, "A04");
  assert.equal(readDraftField(seeded, "scenarios.data-loss.trigger"), "");
  const progress = architectureSeedProgress(seeded);
  assert.equal(progress.suggested, filled.filter((path) => !["templateId", "platform", "useCases:desktop-distribution"].includes(path)).length);
  assert.ok(progress.suggested >= 7);
  assert.equal(progress.total, 24 + 25 + 6 + 4);
  assert.equal(progress.empty, progress.total - progress.suggested - 1);
  // Proposals are not decisions: the rulebook still blocks the seeded draft.
  const assessment = evaluateArchitectureRulebook({ templateId: seeded.templateId, templateVersion: 1, platform: seeded.platform, useCases: seeded.useCases, answers: seeded.answers, scenarios: seeded.scenarios, decisions: seeded.decisions, nonFunctional: seeded.nonFunctional });
  assert.equal(assessment.ready, false);
});

test("a chosen template and use cases are kept; seeding twice changes nothing", () => {
  const seed = suggestArchitectureSeed(tauriFixture());
  const draft = { ...blankArchitectureDraft(), templateId: "realtime-collaboration", useCases: ["collaboration"] };
  const once = applyArchitectureSeed(draft, seed).draft;
  assert.equal(once.templateId, "realtime-collaboration");
  assert.equal(once.platform, "tauri");
  assert.deepEqual(once.useCases, ["collaboration"]);
  assert.equal(once.answers.capabilityPolicy, undefined);
  const twice = applyArchitectureSeed(once, seed);
  assert.deepEqual(twice.filled, []);
  assert.deepEqual(twice.draft, once);
});

test("an edited suggestion stops counting as a suggestion", () => {
  const seed = suggestArchitectureSeed(tauriFixture());
  const { draft } = applyArchitectureSeed(blankArchitectureDraft(), seed);
  const before = architectureSeedProgress(draft).suggested;
  const edited = writeDraftField(draft, "decisions.data.choice", "Changed by me");
  assert.equal(architectureSeedProgress(edited).suggested, before - 1);
});
