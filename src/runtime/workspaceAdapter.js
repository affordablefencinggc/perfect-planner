import {
  censusRegisteredWorkspace,
  previewRegisteredWorkspace,
  isNativeWorkspaceRuntime,
  registerWorkspaceReadOnly,
  selectWorkspaceFolder,
} from "../native/workspaceCensus.js";
import { servedByLocalService } from "../native/runtimeSnapshot.js";
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
  // The installed app's window is served by its local service; with no folder picker (Linux) it still
  // opens a typed folder through that service, so it is a browser window and not "native unavailable".
  if (servedByLocalService(runtime)) return browserWorkspaceAdapter;
  return nativeWorkspaceAdapter;
}

export const defaultWorkspaceAdapter = resolveWorkspaceAdapter();
