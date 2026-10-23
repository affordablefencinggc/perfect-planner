// Leaf module: starting programs safely. Imports nothing from other core modules, so ledger,
// worktrees and gate can all use it without a cycle.
export { ExecutableNotFoundError, findExecutable, gitExecutable, isLocalWindowsPath, isWithin, NO_CWD_SEARCH_ENV, protectRoots, registeredRoots } from "./executable";
export type { ExecutableIo } from "./executable";
export { keyStoreTool, system32Tool, systemRoot, type KeyStoreTool, type KeyStoreToolOptions } from "./systemTools";
export { bwrapArgs, containedRunner, gitDirsFor, resetSandboxStatus, sandboxStatus, shQuote, toolchainDirs, CONTAINED_HEADER, NOT_CONTAINED_HEADER, type ContainedRunner, type ContainedRunnerOptions, type SandboxPolicy, type SandboxStatus } from "./sandbox";
