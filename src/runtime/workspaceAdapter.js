import {
  censusRegisteredWorkspace,
  previewRegisteredWorkspace,
  isNativeWorkspaceRuntime,
  registerWorkspaceReadOnly,
  selectWorkspaceFolder,
} from "../native/workspaceCensus.js";
import {
  browserWorkspaceAdapter,
  isBrowserWorkspacePickerAvailable,
} from "../browser/workspaceCensus.js";

const nativeWorkspaceAdapter = Object.freeze({
  mode: "native",
  previewRegisteredWorkspace,
  censusRegisteredWorkspace,
  registerWorkspaceReadOnly,
  selectWorkspaceFolder,
});

export function resolveWorkspaceAdapter(runtime = globalThis) {
  if (isNativeWorkspaceRuntime(runtime)) return nativeWorkspaceAdapter;
  if (isBrowserWorkspacePickerAvailable(runtime)) return browserWorkspaceAdapter;
  return nativeWorkspaceAdapter;
}

export const defaultWorkspaceAdapter = resolveWorkspaceAdapter();
