// Maps project work records onto the receipt rows that the imported-project
// workflow pages require. Each feature module in src/project/receipts/ exports
// `receiptDerivers`: { [receiptId]: (sections, context) => ({ state, detail }) | null }.
// Add one import + one spread line per feature below. A deriver returns null when
// nothing is recorded yet, which keeps the original "unanswered" receipt so that
// absence is never shown as success. Valid states: recorded, review, unanswered, stale, unavailable.
import { receiptDerivers as planReceiptDerivers } from "./receipts/plan.js";

const derivers = Object.freeze({
  // ...featureReceiptDerivers,
  ...planReceiptDerivers,
});

export function deriveWorkRecordReceipt(receiptId, records, context) {
  const derive = derivers[receiptId];
  if (!derive) return null;
  try { return derive(records?.sections ?? {}, context) ?? null; } catch { return { state: "unavailable", detail: "This record could not be read." }; }
}
