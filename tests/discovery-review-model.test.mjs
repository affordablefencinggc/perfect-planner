import assert from "node:assert/strict";
import test from "node:test";

import { deriveDiscoveryReview, nextDiscoveryReviewData } from "../src/project/discoveryReviewModel.js";
import { deriveImportedProjectWorkflowModel } from "../src/project/importedProjectWorkflowModel.js";
import { deriveProjectHomeModel } from "../src/project/projectHomeModel.js";
import { readWorkRecords, writeSection } from "../src/project/projectWorkRecords.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";

const AT = "2026-09-04T11:00:00.000Z";
const LATER = "2026-09-05T09:00:00.000Z";

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}

function project({ generatedAt = AT, discoveryState = "generated" } = {}) {
  const rootIdentity = "a".repeat(64);
  return createImportedProjectSession({
    name: "Customer Atlas",
    adapter: "native",
    now: AT,
    registration: { access: "metadata-read-only", canonicalRoot: "C:\\private\\Customer Atlas", registryRevision: 6, rootIdentity, workspaceId: "customer-atlas" },
    census: { digest: "b".repeat(64), fileCount: 12, generatedEpochMs: Date.parse(AT), registryRevision: 6, rootIdentity, skipped: [], totalBytesHashed: 100, workspaceId: "customer-atlas" },
    discovery: {
      state: discoveryState,
      generatedAt,
      counts: { observed: 1, signals: 1, unanswered: 6 },
      categories: [
        { id: "A01", state: "observed", findings: [{ id: "S001" }] },
        { id: "A02", state: "signal", findings: [{ id: "S013" }] },
      ],
    },
  });
}

const OPEN_IDS = ["A02", "A03", "A04", "A05", "A06", "A07", "A08"];

function decideAll(session, storage, ids = OPEN_IDS) {
  let data = null;
  for (const id of ids) {
    data = nextDiscoveryReviewData(session, data, id, id === "A08" ? "answered" : id === "A06" ? "not-applicable" : "confirmed", { note: id === "A08" ? "No workers yet." : "", now: () => AT });
  }
  writeSection(session.projectId, "discoveryReview", data, { storage, now: () => AT });
  return readWorkRecords(session.projectId, storage);
}

test("with no review recorded, every signal or empty area stays open", () => {
  const review = deriveDiscoveryReview(project(), null);
  assert.equal(review.state, "review");
  assert.equal(review.required, 7);
  assert.equal(review.decided, 0);
  assert.equal(review.items.find((item) => item.id === "A01").needsDecision, false);
  assert.equal(deriveDiscoveryReview(null).state, "unanswered");
});

test("deciding every open area records discovery in both workflow and home models", () => {
  const storage = memoryStorage();
  const session = project();
  const partial = decideAll(session, storage, OPEN_IDS.slice(0, 3));
  assert.equal(deriveDiscoveryReview(session, partial).state, "review");
  assert.equal(deriveImportedProjectWorkflowModel(session, "plan", partial).requirements.find((item) => item.id === "REC-DISCOVERY").state, "review");
  assert.equal(deriveProjectHomeModel(session, partial).stage.id, "discovery-review");

  const records = decideAll(session, storage);
  const review = deriveDiscoveryReview(session, records);
  assert.equal(review.state, "recorded");
  assert.equal(review.items.find((item) => item.id === "A08").decision.note, "No workers yet.");

  const plan = deriveImportedProjectWorkflowModel(session, "plan", records);
  assert.equal(plan.requirements.find((item) => item.id === "REC-DISCOVERY").state, "recorded");
  assert.equal(plan.questions.find((item) => item.id === "A08").state, "recorded");
  assert.notEqual(plan.nextAction.reason, plan.requirements.find((item) => item.id === "REC-DISCOVERY").detail);

  const home = deriveProjectHomeModel(session, records);
  assert.notEqual(home.stage.id, "discovery-review");
  assert.equal(home.stage.id, "architecture");
  assert.equal(home.summary.discovery.state, "available");
  assert.equal(home.blockers.some((item) => item.scope === "discovery"), false);
  // Without records the same project still needs review: nothing is inferred.
  assert.equal(deriveProjectHomeModel(session).stage.id, "discovery-review");
});

test("a newer scan makes an earlier review stop counting", () => {
  const storage = memoryStorage();
  const records = decideAll(project(), storage);
  const rescanned = project({ generatedAt: LATER });
  const review = deriveDiscoveryReview(rescanned, records);
  assert.equal(review.state, "review");
  assert.equal(review.decided, 0);
  assert.equal(review.outdated, true);
  assert.equal(deriveImportedProjectWorkflowModel(rescanned, "plan", records).requirements.find((item) => item.id === "REC-DISCOVERY").state, "review");
  assert.equal(deriveProjectHomeModel(rescanned, records).stage.id, "discovery-review");
  // Deciding against the new scan starts fresh instead of carrying old answers over.
  const next = nextDiscoveryReviewData(rescanned, records.sections.discoveryReview.data, "A02", "confirmed", { now: () => LATER });
  assert.deepEqual(Object.keys(next.categories), ["A02"]);
  assert.equal(next.snapshot.generatedAt, LATER);
});

test("answers need text, unknown decisions are refused, and undo clears a decision", () => {
  const session = project();
  assert.throws(() => nextDiscoveryReviewData(session, null, "A02", "answered", { note: "   " }), /ANSWER_REQUIRED/);
  assert.throws(() => nextDiscoveryReviewData(session, null, "A02", "approved"), /DECISION_INVALID/);
  assert.throws(() => nextDiscoveryReviewData(project({ discoveryState: "stale" }), null, "A02", "confirmed"), /NOT_CURRENT/);
  const decided = nextDiscoveryReviewData(session, null, "A02", "confirmed", { now: () => AT });
  const cleared = nextDiscoveryReviewData(session, decided, "A02", null);
  assert.deepEqual(cleared.categories, {});
  // A hand-edited record with an empty answer does not count as a decision.
  const records = { sections: { discoveryReview: { revision: 1, recordedAt: AT, data: { ...decided, categories: { A02: { decision: "answered", note: "" } } } } } };
  assert.equal(deriveDiscoveryReview(session, records).items.find((item) => item.id === "A02").decision, null);
});
