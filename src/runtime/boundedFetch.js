const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export class BoundedFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BoundedFetchError";
    this.code = code;
  }
}

export async function boundedFetch(resource, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof fetchImpl !== "function") {
    throw new BoundedFetchError("TRANSPORT_UNAVAILABLE", "Network transport is unavailable.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new BoundedFetchError("TIMEOUT_INVALID", "Network timeout is invalid.");
  }
  const upstreamSignal = options.signal ?? init.signal;
  if (upstreamSignal?.aborted) {
    throw new BoundedFetchError("REQUEST_ABORTED", "Network request was cancelled.");
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(upstreamSignal?.reason);
  upstreamSignal?.addEventListener?.("abort", onAbort, { once: true });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new BoundedFetchError("REQUEST_TIMEOUT", `Network request timed out after ${timeoutMs} ms.`));
      controller.abort("timeout");
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve(fetchImpl(resource, { ...init, signal: controller.signal })),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof BoundedFetchError) throw error;
    if (upstreamSignal?.aborted) {
      throw new BoundedFetchError("REQUEST_ABORTED", "Network request was cancelled.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener?.("abort", onAbort);
  }
}
