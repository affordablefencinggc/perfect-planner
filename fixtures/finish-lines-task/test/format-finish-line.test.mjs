import test from "node:test";
import assert from "node:assert/strict";
import { formatFinishLine } from "../src/format-finish-line.mjs";

test("formats the required title, status, and owner", () => {
  assert.equal(
    formatFinishLine({ title: "R26 release", status: "ready", owner: "Ari" }),
    "R26 release - ready (owner: Ari)",
  );
});

test("trims values and labels a missing or blank owner unassigned", () => {
  assert.equal(
    formatFinishLine({ title: "  Run checks  ", status: "  done  ", owner: "   " }),
    "Run checks - done (owner: unassigned)",
  );
  assert.equal(
    formatFinishLine({ title: "Ship", status: "ready" }),
    "Ship - ready (owner: unassigned)",
  );
});

test("rejects a missing work item with a descriptive TypeError", () => {
  assert.throws(() => formatFinishLine(), { name: "TypeError", message: /work item/i });
  assert.throws(() => formatFinishLine(null), { name: "TypeError", message: /work item/i });
});

test("rejects a blank title with a descriptive TypeError", () => {
  assert.throws(
    () => formatFinishLine({ title: "   ", status: "ready" }),
    { name: "TypeError", message: /title/i },
  );
});

test("rejects a blank status with a descriptive TypeError", () => {
  assert.throws(
    () => formatFinishLine({ title: "R26", status: "   " }),
    { name: "TypeError", message: /status/i },
  );
});