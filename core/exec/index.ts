// Leaf module: starting programs safely. Imports nothing from other core modules, so ledger,
// worktrees and gate can all use it without a cycle.
export { ExecutableNotFoundError, findExecutable, gitExecutable, isWithin, NO_CWD_SEARCH_ENV } from "./executable";
