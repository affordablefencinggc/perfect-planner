// Leaf module: starting programs safely. Imports nothing from other core modules, so ledger,
// worktrees and gate can all use it without a cycle.
export { ExecutableNotFoundError, findExecutable, gitExecutable, isLocalWindowsPath, isWithin, NO_CWD_SEARCH_ENV } from "./executable";
export { keyStoreTool, type KeyStoreTool, type KeyStoreToolOptions } from "./systemTools";
