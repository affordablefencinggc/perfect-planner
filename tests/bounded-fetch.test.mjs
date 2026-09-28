import assert from "node:assert/strict";
import test from "node:test";
import { boundedFetch, BoundedFetchError } from "../src/runtime/boundedFetch.js";

test("bounded fetch returns a settled response and forwards a cancellation signal", async () => {
  let signal;
  const response = await boundedFetch("/ok", {}, {
    fetchImpl: async (_resource, init) => {
      signal = init.signal;
      return new Response("ok");
    },
    timeoutMs: 100,
  });
  assert.equal(await response.text(), "ok");
  assert.equal(signal instanceof AbortSignal, true);
});

test("bounded fetch refuses a transport that never settles", async () => {
  let signal;
  await assert.rejects(
    () => boundedFetch("/hang", {}, {
      fetchImpl: (_resource, init) => {
        signal = init.signal;
        return new Promise(() => {});
      },
      timeoutMs: 5,
    }),
    (error) => error instanceof BoundedFetchError && error.code === "REQUEST_TIMEOUT",
  );
  assert.equal(signal.aborted, true);
});

test("bounded fetch preserves explicit cancellation and validates its hard ceiling", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => boundedFetch("/cancelled", {}, { signal: controller.signal }),
    (error) => error.code === "REQUEST_ABORTED",
  );
  await assert.rejects(
    () => boundedFetch("/bad", {}, { timeoutMs: 0 }),
    (error) => error.code === "TIMEOUT_INVALID",
  );
});
