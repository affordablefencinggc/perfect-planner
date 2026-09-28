import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceAdapter } from "../src/runtime/workspaceAdapter.js";

test("the native workspace adapter wins inside Tauri even when WebView exposes showDirectoryPicker", () => {
  const adapter = resolveWorkspaceAdapter({
    __TAURI_INTERNALS__: {},
    crypto: globalThis.crypto,
    showDirectoryPicker() {},
  });

  assert.equal(adapter.mode, "native");
});

test("a normal browser uses its secure directory-handle adapter", () => {
  const adapter = resolveWorkspaceAdapter({
    crypto: globalThis.crypto,
    showDirectoryPicker() {},
  });

  assert.equal(adapter.mode, "browser");
});
