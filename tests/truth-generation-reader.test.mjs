import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import {
  readCurrentTruthGeneration,
  TruthGenerationReadError,
} from "../src/runtime/truthGenerationReader.js";

const GENERATED_AT = "2026-09-04T08:00:00.000Z";
const NOW = Date.parse("2026-09-04T09:00:00.000Z");
const artifactNames = [
  "truth-core-report.json",
  "completion-report.json",
  "completion-report.md",
  "evidence-bundle.html",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    census: { fileCount: 12, skipped: 0, digest: "a".repeat(64) },
    journal: { valid: true, entries: 25, concurrentWriters: 4 },
    proofRunner: { proven: true },
    sessionRegistry: { valid: true },
    confirmationStore: { failClosed: true, state: "waiting" },
    ...overrides,
  };
}

function fixture(options = {}) {
  const truthBytes = Buffer.from(
    options.truthText ?? JSON.stringify(options.report ?? report()),
  );
  const artifacts = artifactNames.map((name, index) => ({
    name,
    sha256:
      index === 0
        ? (options.truthHash ?? sha(truthBytes))
        : sha(Buffer.from(`artifact-${index}`)),
    size:
      index === 0
        ? (options.truthSize ?? truthBytes.byteLength)
        : Buffer.byteLength(`artifact-${index}`),
  }));
  const generationId = sha(
    Buffer.from(
      artifacts
        .map((artifact) => `${artifact.name}:${artifact.sha256}`)
        .join("\n"),
    ),
  );
  const pointer = {
    schemaVersion: 1,
    generationId,
    generatedAt: options.generatedAt ?? GENERATED_AT,
    directory: `generations/${generationId}`,
    artifacts,
    ...(options.pointer ?? {}),
  };
  return { pointer, truthBytes };
}

function jsonResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function adapter(fixtureValue) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "/generated/current-generation.json") {
      return jsonResponse(JSON.stringify(fixtureValue.pointer));
    }
    if (
      url ===
      `/generated/${fixtureValue.pointer.directory}/truth-core-report.json`
    ) {
      return jsonResponse(fixtureValue.truthBytes, {
        headers: {
          "content-length": String(fixtureValue.truthBytes.byteLength),
        },
      });
    }
    return jsonResponse("{}", { status: 404 });
  };
  return { calls, fetchImpl };
}

async function rejectedCode(run, code) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof TruthGenerationReadError);
    assert.equal(error.code, code);
    assert.ok(["invalid", "unavailable"].includes(error.state));
    return true;
  });
}

test("reads only the immutable current generation after verifying pointer, size, and SHA-256", async () => {
  const value = fixture();
  const source = adapter(value);
  const result = await readCurrentTruthGeneration({
    fetchImpl: source.fetchImpl,
    cryptoImpl: webcrypto,
    now: NOW,
  });

  assert.equal(result.state, "verified");
  assert.equal(result.generationId, value.pointer.generationId);
  assert.equal(result.report.census.fileCount, 12);
  assert.deepEqual(
    source.calls.map((call) => call.url),
    [
      "/generated/current-generation.json",
      `/generated/${value.pointer.directory}/truth-core-report.json`,
    ],
  );
  assert.ok(
    source.calls.every(
      ({ options }) =>
        options.cache === "no-store" &&
        options.redirect === "error" &&
        options.credentials === "same-origin",
    ),
  );
});

test("rejects path traversal, reordered entries, duplicate entries, and manifest identity substitution before artifact fetch", async () => {
  for (const mutate of [
    (value) => {
      value.pointer.directory = "generations/../truth-core-report.json";
    },
    (value) => {
      value.pointer.artifacts.reverse();
    },
    (value) => {
      value.pointer.artifacts[1] = { ...value.pointer.artifacts[0] };
    },
    (value) => {
      value.pointer.generationId = "f".repeat(64);
      value.pointer.directory = `generations/${value.pointer.generationId}`;
    },
  ]) {
    const value = fixture();
    mutate(value);
    const source = adapter(value);
    await rejectedCode(
      () =>
        readCurrentTruthGeneration({
          fetchImpl: source.fetchImpl,
          cryptoImpl: webcrypto,
          now: NOW,
        }),
      value.pointer.directory.includes("..") ||
        value.pointer.artifacts[0].name !== artifactNames[0] ||
        value.pointer.artifacts[1].name !== artifactNames[1]
        ? "pointer-malformed"
        : "generation-identity-mismatch",
    );
    assert.equal(source.calls.length, 1);
  }
});

test("rejects stale and future pointers before loading any artifact", async () => {
  const stale = fixture({ generatedAt: "2026-09-02T08:00:00.000Z" });
  const staleSource = adapter(stale);
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: staleSource.fetchImpl,
        cryptoImpl: webcrypto,
        now: NOW,
      }),
    "pointer-stale",
  );
  assert.equal(staleSource.calls.length, 1);

  const future = fixture({ generatedAt: "2026-09-04T10:00:00.000Z" });
  const futureSource = adapter(future);
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: futureSource.fetchImpl,
        cryptoImpl: webcrypto,
        now: NOW,
      }),
    "pointer-future",
  );
  assert.equal(futureSource.calls.length, 1);
});

test("rejects malformed pointers and oversized pointer responses", async () => {
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: async () => jsonResponse('{"schemaVersion":1}'),
        cryptoImpl: webcrypto,
        now: NOW,
      }),
    "pointer-malformed",
  );
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: async () =>
          jsonResponse("{}", { headers: { "content-length": "9000" } }),
        cryptoImpl: webcrypto,
        now: NOW,
        maxPointerBytes: 128,
      }),
    "pointer-oversized",
  );
});

test("rejects report size and hash mismatches without parsing substituted content", async () => {
  const wrongSize = fixture({ truthSize: 1 });
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: adapter(wrongSize).fetchImpl,
        cryptoImpl: webcrypto,
        now: NOW,
      }),
    "artifact-size-mismatch",
  );

  const wrongHash = fixture({ truthHash: "b".repeat(64) });
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: adapter(wrongHash).fetchImpl,
        cryptoImpl: webcrypto,
        now: NOW,
      }),
    "artifact-hash-mismatch",
  );
});

test("rejects reports that exceed the configured ceiling before the report request", async () => {
  const value = fixture();
  const source = adapter(value);
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: source.fetchImpl,
        cryptoImpl: webcrypto,
        now: NOW,
        maxArtifactBytes: value.truthBytes.byteLength - 1,
      }),
    "artifact-oversized",
  );
  assert.equal(source.calls.length, 1);
});

test("rejects invalid report JSON, mismatched generation time, and incomplete report schema", async () => {
  for (const value of [
    fixture({ truthText: "not-json" }),
    fixture({ report: report({ generatedAt: "2026-09-04T07:59:59.000Z" }) }),
    fixture({ report: report({ journal: { valid: true } }) }),
  ]) {
    const expected =
      value.truthBytes.toString() === "not-json"
        ? "artifact-malformed"
        : JSON.parse(value.truthBytes).generatedAt !== GENERATED_AT
          ? "generation-time-mismatch"
          : "artifact-malformed";
    await rejectedCode(
      () =>
        readCurrentTruthGeneration({
          fetchImpl: adapter(value).fetchImpl,
          cryptoImpl: webcrypto,
          now: NOW,
        }),
      expected,
    );
  }
});

test("fails closed when fetch, Web Crypto, JSON content, or a generation artifact is unavailable", async () => {
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: null,
        cryptoImpl: webcrypto,
        now: NOW,
      }),
    "fetch-unavailable",
  );
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: async () => jsonResponse("{}"),
        cryptoImpl: null,
        now: NOW,
      }),
    "crypto-unavailable",
  );
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        cryptoImpl: webcrypto,
        now: NOW,
      }),
    "response-invalid",
  );

  const value = fixture();
  let calls = 0;
  await rejectedCode(
    () =>
      readCurrentTruthGeneration({
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? jsonResponse(JSON.stringify(value.pointer))
            : jsonResponse("{}", { status: 404 });
        },
        cryptoImpl: webcrypto,
        now: NOW,
      }),
    "artifact-unavailable",
  );
});
