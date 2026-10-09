// Maps project work records onto the receipt rows that the imported-project
// workflow pages require. Each feature module in src/project/receipts/ exports
// `receiptDerivers`: { [receiptId]: (sections, context) => ({ state, detail }) | null }.
// Add one import + one spread line per feature below. A deriver returns null when
// nothing is recorded yet, which keeps the original "unanswered" receipt so that
// absence is never shown as success. Valid states: recorded, review, unanswered, stale, unavailable.
import { receiptDerivers as planReceiptDerivers } from "./receipts/plan.js";

import { receiptDerivers as collisionReceiptDerivers } from "./receipts/collision.js";
import { receiptDerivers as allocationReceiptDerivers } from "./receipts/allocation.js";

import { receiptDerivers as proofReceiptDerivers } from "./receipts/proof.js";

import { receiptDerivers as indexBuildReceiptDerivers } from "./receipts/indexBuild.js";
import { receiptDerivers as ledgerReceiptDerivers } from "./receipts/ledger.js";

const derivers = Object.freeze({
  ...collisionReceiptDerivers,
  ...allocationReceiptDerivers,
  ...proofReceiptDerivers,
  ...indexBuildReceiptDerivers,
  ...ledgerReceiptDerivers,
  // ...featureReceiptDerivers,
  ...planReceiptDerivers,
  // LEDGER-TASKS has two sources: the approved plan snapshot wins once one is
  // saved; before that, the saved task-draft presence from the Ledger answers it.
  "LEDGER-TASKS": (sections, context) => planReceiptDerivers["LEDGER-TASKS"](sections, context)
    ?? ledgerReceiptDerivers["LEDGER-TASKS"](sections, context),
});

export function deriveWorkRecordReceipt(receiptId, records, context) {
  const derive = derivers[receiptId];
  if (!derive) return null;
  try { return derive(records?.sections ?? {}, context) ?? null; } catch { return { state: "unavailable", detail: "This record could not be read." }; }
}
