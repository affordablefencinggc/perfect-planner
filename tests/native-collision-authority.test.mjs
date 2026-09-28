import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createNativeCollisionAuthorityAdapter,
  validateNativeCollisionAuthorityReceipt,
} from "../src/native/collisionAuthority.js";
import { appendLedgerEntry } from "../src/engine/collisionEngine.js";

const digest = (letter = "a") => letter.repeat(64);

async function receipt({ planId = "PP-TEST", censusDigest = digest(), ids = [] } = {}) {
  let ledger = [];
  for (const id of ids) {
    ledger = await appendLedgerEntry(ledger, "collision.order-approved", {
      collisionId: id,
      censusDigest,
    }, { actor: "local-desktop-user", timestamp: "2026-09-04T00:00:00.000Z" });
  }
  return {
    schemaVersion: 1,
    commandRevision: 1,
    planId,
    censusDigest,
    authority: "native-journal",
    authorityTransport: "tauri-ipc-v1",
    authoritative: true,
    revision: ledger.length,
    headHash: ledger.at(-1)?.hash ?? "GENESIS",
    approvedIds: ids,
    ledger,
    capabilities: [
      "collision-authority:inspect",
      "collision-authority:approve",
      "collision-authority:commit",
    ],
  };
}

test("static releases receive no native collision adapter", () => {
  assert.equal(createNativeCollisionAuthorityAdapter({ runtime: {} }), null);
});

test("native adapter invokes exact versioned commands and strips untrusted collision extras", async () => {
  const invocations = [];
  const invoke = async (command, payload) => {
    invocations.push({ command, payload });
    return receipt({ ids: command.endsWith("approve") ? ["COL-001"] : [] });
  };
  const adapter = createNativeCollisionAuthorityAdapter({
    runtime: { __TAURI_INTERNALS__: {} },
    invoke,
  });
  await adapter.inspect({ planId: "PP-TEST", censusDigest: digest() });
  await adapter.approve({
    planId: "PP-TEST",
    censusDigest: digest(),
    expectedRevision: 0,
    expectedHeadHash: "GENESIS",
    collision: {
      id: "COL-001",
      kind: "file",
      surface: "src/contracts/plan.ts",
      severity: "hard-stop",
      reason: "not part of the native mutation schema",
      first: { planId: "PLAN-A", taskId: "B01", access: "write", extra: true },
      then: { planId: "PLAN-B", taskId: "B02", access: "write" },
      contingency: "serialize, freeze, and rescan",
      left: { secret: "must not cross IPC" },
    },
  });
  assert.deepEqual(invocations[0], {
    command: "collision_authority_inspect",
    payload: { request: { schemaVersion: 1, planId: "PP-TEST", censusDigest: digest() } },
  });
  assert.deepEqual(invocations[1], {
    command: "collision_authority_approve",
    payload: { request: {
      schemaVersion: 1,
      planId: "PP-TEST",
      censusDigest: digest(),
      expectedRevision: 0,
      expectedHeadHash: "GENESIS",
      explicitUserApproval: true,
      collision: {
        id: "COL-001",
        surface: "src/contracts/plan.ts",
        severity: "hard-stop",
        first: { planId: "PLAN-A", taskId: "B01", access: "write" },
        then: { planId: "PLAN-B", taskId: "B02", access: "write" },
        contingency: "serialize, freeze, and rescan",
      },
    } },
  });
  assert.equal(JSON.stringify(invocations).includes("secret"), false);
});

test("native receipt validation refuses schema drift and capability expansion", async () => {
  const valid = await receipt();
  assert.equal(validateNativeCollisionAuthorityReceipt(valid).authorityTransport, "tauri-ipc-v1");
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.schemaVersion = 2; },
    (value) => { value.authorityTransport = "http"; },
    (value) => { value.authoritative = false; },
    (value) => { value.capabilities.push("filesystem:write"); },
    (value) => { value.censusDigest = "not-a-digest"; },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => validateNativeCollisionAuthorityReceipt(changed));
  }
});

test("Tauri manifest grants only app-local collision journal commands", async () => {
  const capability = JSON.parse(await readFile(new URL("../src-tauri/capabilities/main-collision-authority.json", import.meta.url), "utf8"));
  assert.deepEqual(capability.permissions, [
    "allow-collision-authority-inspect",
    "allow-collision-authority-approve",
    "allow-collision-authority-commit",
  ]);
  assert.match(capability.description, /no project-folder mutation/i);
  assert.doesNotMatch(JSON.stringify(capability.permissions), /shell|process|filesystem:|http:/i);
});
